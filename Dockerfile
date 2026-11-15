FROM node:22-slim

# ffmpeg, yt-dlp (com os extras que o YouTube exige) e o Deno, que o yt-dlp usa pra rodar o JavaScript do YouTube
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.js"]
