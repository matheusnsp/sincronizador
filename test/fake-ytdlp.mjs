#!/usr/bin/env node
// yt-dlp de mentira pros testes. O comportamento vem da variável FAKE_YT.
import fs from 'node:fs';
const args = process.argv.slice(2);
const url = args[args.length - 1];
const video = args.includes('res,fps,vcodec:h264');
if (process.env.FAKE_YT_LOG) fs.appendFileSync(process.env.FAKE_YT_LOG, JSON.stringify(args) + '\n');
if (url.includes('bloqueado')) {
  console.error('ERROR: [youtube] abc: Sign in to confirm you’re not a bot.');
  process.exit(1);
}
if (args.includes('-J')) {
  console.log(JSON.stringify(video
    ? { title: 'Pregação teste', duration: 20, ext: 'mp4', vcodec: 'avc1.64001f', height: 1080, fps: 30, filesize: 1234 }
    : { title: 'Pregação teste', duration: 20, ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize_approx: 999 }));
} else {
  const arq = video ? process.env.FAKE_YT_VIDEO : process.env.FAKE_YT_AUDIO;
  if (arq) fs.createReadStream(arq).pipe(process.stdout);
  else process.stdout.write(video ? 'VIDEO-FALSO' : 'AUDIO-FALSO');
}
