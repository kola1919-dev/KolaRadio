/**
 * Одноразовый скрипт создания главного администратора.
 * Запусти: node setup.js
 *
 * Пароль НЕ хранится в коде — создаётся здесь и хешируется через bcrypt.
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const USERS_FILE = path.join(__dirname, 'users.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

(async () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   🔐  KolaRadio — Первичная настройка  🔐    ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');

  if (fs.existsSync(USERS_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(existing) && existing.length > 0) {
        console.log('  ⚠️  users.json уже существует.');
        console.log('  📋 Пользователи:');
        existing.forEach(u => {
          console.log(`     • ${u.username}${u.isRoot ? ' (главный)' : ''}`);
        });
        console.log('');
        const answer = await ask('  Перезаписать ВСЁ? Введи YES: ');
        if (answer.trim() !== 'YES') {
          console.log('  ❌ Отменено.');
          rl.close();
          process.exit(0);
        }
      }
    } catch (e) {
      console.log('  ⚠️  users.json повреждён, пересоздаём.');
    }
  }

  console.log('  Создаём главного администратора.');
  console.log('  (имеет все права, не может быть удалён)');
  console.log('');

  const username = (await ask('  Логин: ')).trim();
  if (username.length < 3) {
    console.log('  ❌ Логин минимум 3 символа.');
    rl.close();
    process.exit(1);
  }

  const password = await ask('  Пароль (минимум 6 символов): ');
  if (password.length < 6) {
    console.log('  ❌ Пароль слишком короткий.');
    rl.close();
    process.exit(1);
  }

  const password2 = await ask('  Повтори пароль: ');
  if (password !== password2) {
    console.log('  ❌ Пароли не совпадают.');
    rl.close();
    process.exit(1);
  }

  // 🔐 cost 12 — надёжное шифрование
  const hash = bcrypt.hashSync(password, 12);

  const users = [{
    username,
    password: hash,  // ← только хеш, пароля нет
    permissions: ['listen', 'upload', 'delete', 'control', 'manage'],
    isRoot: true,
    createdAt: Date.now()
  }];

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');

  console.log('');
  console.log('  ✅ Готово! Главный админ создан: ' + username);
  console.log('  🔐 Пароль зашифрован (bcrypt, cost 12).');
  console.log('  📁 Сохранён в: users.json');
  console.log('');
  console.log('  💡 Теперь запускай: node server.js');
  console.log('');

  rl.close();
})();