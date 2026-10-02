@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 18+ с nodejs.org
  pause
  exit /b 1
)
start "" http://localhost:3000
node server.js
pause
