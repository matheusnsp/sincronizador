@echo off
rem Roda o sincronizador neste Windows. De dois cliques neste arquivo.
cd /d "%~dp0"
where node >nul 2>nul || (echo Instalando o Node... & winget install -e --id OpenJS.NodeJS.LTS)
where yt-dlp >nul 2>nul || (echo Instalando o yt-dlp... & winget install -e --id yt-dlp.yt-dlp)
where node >nul 2>nul || (echo Feche esta janela e abra o arquivo de novo para concluir a instalacao. & pause & exit /b 1)
where yt-dlp >nul 2>nul || (echo Feche esta janela e abra o arquivo de novo para concluir a instalacao. & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev
set LOCAL=1
set PORT=3000
start "" http://localhost:3000
node server.js
pause
