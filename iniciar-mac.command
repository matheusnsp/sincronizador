#!/bin/bash
# Roda o sincronizador neste Mac. Dê dois cliques neste arquivo.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

faltando=""
command -v node >/dev/null || faltando="$faltando node"
command -v yt-dlp >/dev/null || faltando="$faltando yt-dlp"

if [ -n "$faltando" ]; then
  if command -v brew >/dev/null; then
    echo "Instalando:$faltando"
    brew install $faltando || { echo "Não consegui instalar:$faltando"; read -r -p "Aperte Enter pra fechar."; exit 1; }
  else
    echo "Falta instalar:$faltando"
    echo "1. Instale o Homebrew: abra https://brew.sh e copie o comando da página pra este Terminal."
    echo "2. Depois dê dois cliques neste arquivo de novo."
    read -r -p "Aperte Enter pra fechar."
    exit 1
  fi
fi

versao=$(node -p "process.versions.node.split('.')[0]")
if [ "$versao" -lt 22 ]; then
  echo "O Node instalado é antigo (versão $versao). Atualize com: brew upgrade node"
  read -r -p "Aperte Enter pra fechar."
  exit 1
fi

# o YouTube muda sempre: mantém o yt-dlp em dia (sem travar se estiver sem internet)
command -v brew >/dev/null && brew upgrade yt-dlp >/dev/null 2>&1

[ -d node_modules ] || npm install --omit=dev || { read -r -p "Aperte Enter pra fechar."; exit 1; }

(sleep 2 && open "http://localhost:3000") &
LOCAL=1 PORT=3000 node server.js
read -r -p "O sincronizador parou. Aperte Enter pra fechar."
