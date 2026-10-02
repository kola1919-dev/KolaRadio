const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3000;

const MUSIC_DIR = path.join(__dirname, 'music');
const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ============================================================
//  ПОЛЬЗОВАТЕЛИ
// ============================================================
//
//  Права:
//    listen   — слушать радио (обязательно)
//    upload   — загружать музыку
//    delete   — удалять треки
//    control  — управлять воспроизведением
//    manage   — управлять пользователями
//
//  ВАЖНО: главная страница (index.html) доступна БЕЗ авторизации.
//  Только админка (/admin, /admin/panel, /admin/users) требует вход.
//  Пароли хранятся ТОЛЬКО в виде bcrypt-хешей в users.json.
//
// ============================================================

const ALL_PERMISSIONS = ['listen', 'upload', 'delete', 'control', 'manage'];

let users = [];

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    console.error('');
    console.error('  ⚠️  users.json не найден!');
    console.error('  📖 Запусти: node setup.js');
    console.error('');
    process.exit(1);
  }
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    console.error('❌ Ошибка чтения users.json:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(users) || users.length === 0) {
    console.error('');
    console.error('  ⚠️  users.json пуст.');
    console.error('  📖 Запусти: node setup.js');
    console.error('');
    process.exit(1);
  }

  const rootUser = users.find(u => u.isRoot === true);
  if (rootUser && (!Array.isArray(rootUser.permissions)
      || rootUser.permissions.length < ALL_PERMISSIONS.length)) {
    rootUser.permissions = [...ALL_PERMISSIONS];
    saveUsers();
    console.log('🔧 Восстановлены права главного админа: ' + rootUser.username);
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

loadUsers();

// ============================================================
//  СОСТОЯНИЕ РАДИО
// ============================================================

let playlist = [];
let currentIndex = 0;
let startedAt = Date.now();
let isPlaying = false;
let clients = [];

function loadPlaylist() {
  playlist = fs.readdirSync(MUSIC_DIR)
    .filter(f => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f))
    .map(f => ({ file: f, title: f.replace(/\.[^.]+$/, '') }));
}
loadPlaylist();

// ============================================================
//  MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MUSIC_DIR),
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = originalName.replace(/[^\wа-яА-ЯёЁ0-9.\- _()]+/g, '_');
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ============================================================
//  MIDDLEWARE
// ============================================================

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);
app.use(session({
  name: 'kola.sid',
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
}));

// Блокируем доступ к системным файлам
app.use((req, res, next) => {
  const blocked = ['users.json', 'server.js', 'package.json', 'setup.js', 'package-lock.json'];
  const p = req.path.toLowerCase();
  if (blocked.some(f => p.endsWith(f) || p.includes('/' + f))) {
    return res.status(404).end();
  }
  next();
});

// ---------- Проверки ----------
function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    return res.redirect('/login');
  }
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    if (!req.session.user.permissions.includes(perm)) {
      return res.status(403).json({ error: 'Нет прав: ' + perm });
    }
    next();
  };
}

// ============================================================
//  ПУБЛИЧНЫЕ СТРАНИЦЫ (без логина!)
// ============================================================

// 🌐 ГЛАВНАЯ — ДОСТУПНА ВСЕМ БЕЗ ЛОГИНА
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🌐 Публичные API для плеера
app.get('/api/state', (req, res) => res.json(getState()));
app.get('/api/playlist', (req, res) => {
  loadPlaylist();
  res.json(playlist);
});
app.get('/stream', (req, res) => {
  if (playlist.length === 0) return res.status(404).end();
  const track = playlist[currentIndex];
  if (!track) return res.status(404).end();
  const filePath = path.join(MUSIC_DIR, track.file);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const client = { res };
  clients.push(client);
  res.write(`data: ${JSON.stringify(getState())}\n\n`);
  req.on('close', () => { clients = clients.filter(c => c !== client); });
});

// Сообщить о конце трека — публично
app.post('/api/ended', (req, res) => {
  if (isPlaying) nextTrack();
  res.json({ ok: true });
});

// ============================================================
//  АДМИНКА (только с логином)
// ============================================================

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin/panel');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin', (req, res) => {
  res.redirect('/admin/panel');
});

app.get('/admin/panel', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-panel.html'));
});

app.get('/admin/users', requireAuth, (req, res) => {
  if (!req.session.user.permissions.includes('manage')) return res.redirect('/admin/panel');
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ============================================================
//  API: АВТОРИЗАЦИЯ
// ============================================================

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  req.session.user = {
    username: user.username,
    permissions: user.permissions,
    isRoot: !!user.isRoot
  };
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Ошибка сессии' });
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  res.json(req.session.user);
});

// ============================================================
//  API: ПОЛЬЗОВАТЕЛИ
// ============================================================

app.get('/api/users', requirePerm('manage'), (req, res) => {
  res.json(users.map(u => ({
    username: u.username,
    permissions: u.permissions,
    isRoot: !!u.isRoot,
    createdAt: u.createdAt
  })));
});

app.post('/api/users', requirePerm('manage'), (req, res) => {
  const { username, password, permissions } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Логин минимум 3 символа' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  }
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Такой логин уже есть' });
  }
  const perms = Array.isArray(permissions)
    ? permissions.filter(p => ALL_PERMISSIONS.includes(p))
    : ['listen'];
  if (!perms.includes('listen')) perms.unshift('listen');

  users.push({
    username,
    password: bcrypt.hashSync(password, 10),  // 🔐 хеш
    permissions: perms,
    isRoot: false,
    createdAt: Date.now()
  });
  saveUsers();
  res.json({ ok: true });
});

app.patch('/api/users/:username', requirePerm('manage'), (req, res) => {
  const user = users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (user.isRoot) return res.status(400).json({ error: 'Нельзя менять главного админа' });

  const { permissions, password } = req.body || {};
  if (Array.isArray(permissions)) {
    const perms = permissions.filter(p => ALL_PERMISSIONS.includes(p));
    if (!perms.includes('listen')) perms.unshift('listen');
    user.permissions = perms;
  }
  if (password && password.length >= 4) {
    user.password = bcrypt.hashSync(password, 10);  // 🔐 хеш
  }
  saveUsers();
  res.json({ ok: true });
});

app.delete('/api/users/:username', requirePerm('manage'), (req, res) => {
  const idx = users.findIndex(u => u.username === req.params.username);
  if (idx === -1) return res.status(404).json({ error: 'Не найден' });
  if (users[idx].isRoot) return res.status(400).json({ error: 'Нельзя удалить главного админа' });
  if (users[idx].username === req.session.user.username) {
    return res.status(400).json({ error: 'Нельзя удалить себя' });
  }
  users.splice(idx, 1);
  saveUsers();
  res.json({ ok: true });
});

// ============================================================
//  API: УПРАВЛЕНИЕ (только для админки)
// ============================================================

app.post('/api/upload', requirePerm('upload'), upload.array('files'), (req, res) => {
  loadPlaylist();
  broadcast();
  res.json({ ok: true, playlist });
});

app.post('/api/upload-url', requirePerm('upload'), async (req, res) => {
  try {
    let { url, title } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Не передана ссылка' });
    url = url.trim();

    let parsed;
    try { parsed = new URL(url); } catch {
      return res.status(400).json({ error: 'Некорректная ссылка' });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ error: 'Только http/https' });
    }

    let fileName = decodeURIComponent(path.basename(parsed.pathname)) || 'track';
    if (!/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fileName)) {
      fileName = (title ? title.replace(/[^\wа-яА-ЯёЁ0-9.\- _()]+/g, '_') : 'track') + '.mp3';
    }
    if (title && title.trim()) {
      fileName = title.trim().replace(/[^\wа-яА-ЯёЁ0-9.\- _()]+/g, '_') +
                 (path.extname(fileName) || '.mp3');
    }

    let filePath = path.join(MUSIC_DIR, fileName);
    let base = path.parse(fileName).name;
    let ext = path.parse(fileName).ext;
    let n = 1;
    while (fs.existsSync(filePath)) {
      filePath = path.join(MUSIC_DIR, `${base}_${n}${ext}`);
      n++;
    }

    console.log('⬇️  Скачиваю:', url);
    const response = await axios({
      method: 'GET', url, responseType: 'stream',
      timeout: 60000, maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (KolaRadio)' }
    });

    const len = parseInt(response.headers['content-length'] || '0', 10);
    if (len && len > 200 * 1024 * 1024) {
      response.data.destroy();
      return res.status(413).json({ error: 'Файл больше 200 МБ' });
    }

    await pipeline(response.data, fs.createWriteStream(filePath));
    console.log('✅ Сохранено:', path.basename(filePath));
    loadPlaylist();
    broadcast();

    res.json({ ok: true, file: path.basename(filePath), playlist });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    res.status(500).json({ error: 'Не удалось скачать: ' + err.message });
  }
});

app.delete('/api/track/:name', requirePerm('delete'), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const currentFile = playlist[currentIndex] ? playlist[currentIndex].file : null;
  const removingCurrent = currentFile === name;

  const p = path.join(MUSIC_DIR, name);
  if (fs.existsSync(p)) fs.unlinkSync(p);

  loadPlaylist();

  if (removingCurrent) {
    isPlaying = false;
    currentIndex = 0;
    console.log('⏹ Удалён текущий трек — воспроизведение остановлено');
  } else {
    const newIndex = playlist.findIndex(t => t.file === currentFile);
    if (newIndex >= 0) currentIndex = newIndex;
    else if (currentIndex >= playlist.length) currentIndex = 0;
  }

  broadcast();
  res.json({ ok: true, stopped: removingCurrent, state: getState() });
});

app.post('/api/play/:index', requirePerm('control'), (req, res) => {
  const i = parseInt(req.params.index, 10);
  if (i >= 0 && i < playlist.length) {
    currentIndex = i;
    startedAt = Date.now();
    isPlaying = true;
    broadcast();
  }
  res.json(getState());
});

app.post('/api/toggle', requirePerm('control'), (req, res) => {
  isPlaying = !isPlaying;
  if (isPlaying) startedAt = Date.now();
  broadcast();
  res.json(getState());
});

app.post('/api/stop', requirePerm('control'), (req, res) => {
  isPlaying = false;
  broadcast();
  res.json(getState());
});

app.post('/api/next', requirePerm('control'), (req, res) => { nextTrack(); res.json(getState()); });

app.post('/api/prev', requirePerm('control'), (req, res) => {
  if (playlist.length === 0) return res.json(getState());
  currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
  startedAt = Date.now();
  isPlaying = true;
  broadcast();
  res.json(getState());
});

// ============================================================
//  ВСПОМОГАТЕЛЬНОЕ
// ============================================================

function nextTrack() {
  if (playlist.length === 0) return;
  currentIndex = (currentIndex + 1) % playlist.length;
  startedAt = Date.now();
  isPlaying = true;
  broadcast();
}
function getState() {
  return {
    currentIndex, isPlaying, startedAt,
    track: playlist[currentIndex] || null,
    total: playlist.length,
    playlist
  };
}
function broadcast() {
  const data = `data: ${JSON.stringify(getState())}\n\n`;
  clients.forEach(c => { try { c.res.write(data); } catch(e){} });
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ iface: name, ip: net.address });
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║           🎵  KolaRadio запущено  🎵              ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log('  🌐 Публичная страница:  http://localhost:' + PORT);
  console.log('  ⚙️  Админка:            http://localhost:' + PORT + '/admin/panel');
  console.log('');
  if (ips.length > 0) {
    console.log('  🌐 Доступ с других устройств:');
    ips.forEach(({ iface, ip }) => {
      console.log(`     [${iface}]  http://${ip}:${PORT}`);
    });
    console.log('');
  }
  console.log('  ❌ Остановка: Ctrl + C');
  console.log('');
});