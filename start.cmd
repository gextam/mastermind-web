@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
start "" "http://localhost:8772/"
node server\server.js --port 8772
