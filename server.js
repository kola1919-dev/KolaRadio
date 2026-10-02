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
const PORT = 3000;

const MUSIC_DIR = path.join(__dirname, 'music');
const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ============================================================
//  ПОЛЬЗОВАТЕЛИ
// ============================================================
//
//  Права:
//    listen   — слушать радио (доступ на главную страницу)
//    upload   — загружать музыку
//    delete   — удалять треки
//    control  — управлять воспроизведением
//    manage   — управлять пользователями
//
// ============================================================

const ALL_PERMISSIONS = ['listen', 'upload', 'delete', 'control', 'manage'];

// ============================================================
//  ПАРОЛЬ АДМИНА ПО УМОЛЧАНИЮ (СКРЫТ)
// ============================================================
//
//  Самого пароля в коде нет. Хранится только bcrypt-хеш ($2a$10$...),
//  разбитый на блоки и зашифрованный XOR'ом с ключом, который собирается
//  в рантайме из двух перемешанных массивов. При просмотре исходников,
//  выкачивании файла или поиске по строке вместо пароля видны только
//  случайные символы.
//
//  Меняется в users.json (или через интерфейс управления) — здесь
//  используется только при ПЕРВОМ запуске, когда файла ещё нет.
//
// ============================================================

const _K = [0x5a, 0x2f, 0xc3, 0x91, 0x7e, 0x0b, 0xd4, 0x36];
const _P = [3, 0, 6, 1, 5, 2, 7, 4];

const _ROOT_HASH_ENC = [
  'b568b50b3af3',
  '1208c331e31d',
  '53865019c632',
  '904e49f14439',
  'c723827d25a7',
  '624da534801a',
  '5ded7332d529',
  'a45d51b3061d',
  'd918904a24ba',
  '5d34c529a24a'
];

const DEFAULT_ROOT_HASH = (() => {
  const key = _P.map(i => _K[i]);
  let out = '';
  for (let i = 0; i < _ROOT_HASH_ENC.length; i++) {
    const chunk = _ROOT_HASH_ENC[i];
    for (let b = 0; b < chunk.length; b += 2) {
      out += String.fromCharCode(parseInt(chunk.substr(b, 2), 16) ^ key[out.length % key.length]);
    }
  }
  return out;
})();

let users = [];

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
      console.error('Ошибка чтения users.json:', e.message);
      users = [];
    }
  }
  if (!users.find(u => u.username === 'Kola_1919')) {
    users.push({
      username: 'Kola_1919',
      password: DEFAULT_ROOT_HASH,
      permissions: ['listen', 'upload', 'delete', 'control', 'manage'],
      isRoot: true,
      createdAt: Date.now()
    });
    saveUsers();
    console.log('👑 Создан главный админ: Kola_1919');
  }
  // На случай, если в старом users.json не было права listen
  let patched = false;
  users.forEach(u => {
    if (!u.permissions.includes('listen')) {
      u.permissions.unshift('listen');
      patched = true;
    }
  });
  if (patched) saveUsers();
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

// ВАЖНО: trust proxy + правильные куки, чтобы сессия работала по IP
app.set('trust proxy', 1);
app.use(session({
  name: 'kola.sid',
  secret: 'kola-' + require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: false  // у нас http, не https
  }
}));

// ---------- Проверки ----------
function requireAuth(req, res, next) {
  if (!req.session.user) {
    // Если это API — отдаём JSON, если страница — редирект
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
//  СТРАНИЦЫ
// ============================================================

// Страница входа (одна на всех)
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Главная — только для авторизованных с правом listen
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Редирект старого /admin
app.get('/admin', (req, res) => {
  res.redirect('/login');
});

// Панель админки
app.get('/admin/panel', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-panel.html'));
});

// Управление пользователями
app.get('/admin/users', requireAuth, (req, res) => {
  if (!req.session.user.permissions.includes('manage')) return res.redirect('/admin/panel');
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

// Выход
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
  // Принудительно сохраняем сессию перед ответом
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
    : ['listen']; // по умолчанию — только слушать

  // Всегда добавляем listen (иначе не сможет даже зайти)
  if (!perms.includes('listen')) perms.unshift('listen');

  users.push({
    username,
    password: bcrypt.hashSync(password, 10),
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
    user.password = bcrypt.hashSync(password, 10);
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
//  API: РАДИО (защищено авторизацией)
// ============================================================

app.get('/api/state', requireAuth, (req, res) => res.json(getState()));

app.get('/stream', requireAuth, (req, res) => {
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

app.get('/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const client = { res };
  clients.push(client);
  res.write(`data: ${JSON.stringify(getState())}\n\n`);
  req.on('close', () => { clients = clients.filter(c => c !== client); });
});

app.get('/api/playlist', requireAuth, (req, res) => {
  loadPlaylist();
  res.json(playlist);
});

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

app.post('/api/ended', requireAuth, (req, res) => {
  if (isPlaying) nextTrack();
  res.json({ ok: true });
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
  console.log('  📻 Слушать на этом ПК:  http://localhost:' + PORT);
  console.log('  ⚙️  Вход в админку:      http://localhost:' + PORT + '/admin/panel');
  console.log('');
  console.log('  👤 Главный админ:  Kola_1919  (пароль — в users.json / панели управления)');
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