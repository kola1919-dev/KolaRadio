@echo off
chcp 65001 >nul
title KolaRadio — Установка
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       🎵  KolaRadio — Установка  🎵          ║
echo ╚══════════════════════════════════════════════╝
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo ❌ Node.js не найден!
    echo.
    echo Скачай и установи LTS-версию: https://nodejs.org
    echo После установки запусти этот файл снова.
    echo.
    pause
    exit /b 1
)

echo ✅ Node.js найден:
node -v
echo.

echo 📦 Устанавливаю зависимости...
call npm install

if errorlevel 1 (
    echo.
    echo ❌ Ошибка установки зависимостей
    pause
    exit /b 1
)

echo.
echo ✅ Готово! Теперь запусти start.bat
echo.
pause