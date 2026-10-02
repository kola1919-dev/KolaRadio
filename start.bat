@echo off
chcp 65001 >nul
title KolaRadio — Сервер
cd /d "%~dp0"

:: Автоматически определяем локальный IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "IP=%%a"
    goto :gotIP
)
:gotIP
set "IP=%IP: =%"

cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║           🎵  KolaRadio запускается  🎵              ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   📻 Публичная страница (для слушателей):
echo      На этом ПК:     http://localhost:3000
echo      С телефона:     http://%IP%:3000
echo.
echo   ⚙️  Админка (управление музыкой):
echo      На этом ПК:     http://localhost:3000/admin
echo      С телефона:     http://%IP%:3000/admin
echo.
echo   💡 Телефон должен быть в той же Wi-Fi сети!
echo   ❌ Для остановки нажми Ctrl + C
echo.
echo ──────────────────────────────────────────────────────
echo.

node server.js

echo.
echo Сервер остановлен.
pause