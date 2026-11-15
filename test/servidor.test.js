import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 34567;
const BASE = `http://127.0.0.1:${PORTA}`;
let proc, cookie;

test.before(async () => {
  proc = spawn('node', ['server.js'], {
    cwd: RAIZ,
    env: { ...process.env, PORT: PORTA, SENHA: 'segredo', YTDLP_BIN: path.join(RAIZ, 'test/fake-ytdlp.mjs') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não subiu');
});
test.after(() => proc.kill());

test('sem senha o servidor não sobe', async () => {
  const p = spawn('node', ['server.js'], { cwd: RAIZ, env: { ...process.env, SENHA: '', PORT: PORTA + 1 }, stdio: 'ignore' });
  const cod = await new Promise((r) => p.on('close', r));
  assert.equal(cod, 1);
});

test('a página abre sem login, a API não', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/vendor/mediabunny.mjs')).status, 200);
  assert.equal((await fetch(BASE + '/api/sessao')).status, 401);
  assert.equal((await fetch(BASE + '/api/youtube/info?url=https://youtu.be/x')).status, 401);
  assert.equal((await fetch(BASE + '/api/youtube/baixar?tipo=audio&url=https://youtu.be/x')).status, 401);
});

test('não entrega arquivos fora da pasta pública', async () => {
  for (const c of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json']) {
    const r = await fetch(BASE + c);
    assert.notEqual(r.status, 200, c);
  }
});

test('senha errada é recusada, senha certa entra', async () => {
  const login = (senha) => fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ senha }) });
  assert.equal((await login('errada')).status, 401);
  const r = await login('segredo');
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(BASE + '/api/sessao', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(BASE + '/api/sessao', { headers: { cookie: cookie.slice(0, -1) + '0' } })).status, 401);
});

test('só aceita link do YouTube', async () => {
  for (const url of ['https://exemplo.com/video', 'file:///etc/passwd', '--exec=ls', 'https://youtube.com.exemplo.com/x']) {
    const r = await fetch(`${BASE}/api/youtube/info?url=${encodeURIComponent(url)}`, { headers: { cookie } });
    assert.equal(r.status, 400, url);
  }
});

test('info devolve título, duração e formatos', async () => {
  const r = await fetch(`${BASE}/api/youtube/info?url=${encodeURIComponent('https://www.youtube.com/watch?v=abc')}`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.titulo, 'Pregação teste');
  assert.equal(j.duracao, 20);
  assert.equal(j.audio.ext, 'm4a');
  assert.equal(j.audio.tamanho, null);
  assert.equal(j.audio.tamanhoAproximado, 999);
  assert.equal(j.video.altura, 1080);
  assert.equal(j.video.tamanho, 1234);
});

test('baixar entrega o áudio e o vídeo', async () => {
  const baixar = async (tipo) => (await fetch(`${BASE}/api/youtube/baixar?tipo=${tipo}&url=${encodeURIComponent('https://youtu.be/abc')}`, { headers: { cookie } })).text();
  assert.equal(await baixar('audio'), 'AUDIO-FALSO');
  assert.equal(await baixar('video'), 'VIDEO-FALSO');
  const r = await fetch(`${BASE}/api/youtube/baixar?tipo=outro&url=${encodeURIComponent('https://youtu.be/abc')}`, { headers: { cookie } });
  assert.equal(r.status, 400);
});

test('bloqueio do YouTube vira mensagem clara', async () => {
  for (const rota of ['info?', 'baixar?tipo=audio&']) {
    const r = await fetch(`${BASE}/api/youtube/${rota}url=${encodeURIComponent('https://youtu.be/bloqueado')}`, { headers: { cookie } });
    assert.equal(r.status, 502);
    assert.match((await r.json()).erro, /bloqueou o servidor/);
  }
});
