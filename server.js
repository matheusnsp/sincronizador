// Servidor do sincronizador: entrega o site, confere a senha e baixa do YouTube com o yt-dlp.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(RAIZ, 'public');
const PORTA = Number(process.env.PORT || 3000);
const SENHA = process.env.SENHA || '';
const SEGREDO = process.env.SEGREDO_COOKIE || crypto.randomBytes(32).toString('hex');
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const VALIDADE = 30 * 24 * 3600; // 30 dias

if (!SENHA) {
  console.error('Defina a variável de ambiente SENHA antes de iniciar o servidor.');
  process.exit(1);
}

// Cookies do YouTube (opcional), pra quando o YouTube bloqueia o servidor ou o vídeo é privado.
// Vêm de um "Secret File" do Render (/etc/secrets/cookies.txt) ou da variável YT_COOKIES.
let arquivoCookies = null;
{
  const segredo = process.env.YT_COOKIES_ARQUIVO || '/etc/secrets/cookies.txt';
  let conteudo = '';
  if (fs.existsSync(segredo)) conteudo = fs.readFileSync(segredo, 'utf8');
  else if (process.env.YT_COOKIES) conteudo = process.env.YT_COOKIES.replace(/\\n/g, '\n');
  if (conteudo.trim()) {
    // o yt-dlp regrava o arquivo de cookies, então ele usa uma cópia numa pasta temporária
    arquivoCookies = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-')), 'cookies.txt');
    fs.writeFileSync(arquivoCookies, conteudo, { mode: 0o600 });
  }
}

const VENDOR = {
  '/vendor/mediabunny.mjs': 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs',
  '/vendor/mediabunny-aac-encoder.mjs': 'node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.min.mjs',
};
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const FORMATOS = {
  audio: ['-f', 'bestaudio[ext=m4a]/bestaudio'],
  // só a imagem, na maior resolução; entre iguais, prefere H.264 (toca em todo lugar)
  video: ['-f', 'bestvideo[ext=mp4]/bestvideo', '-S', 'res,fps,vcodec:h264'],
};

function assinar(texto) {
  return crypto.createHmac('sha256', SEGREDO).update(texto).digest('hex');
}
function iguais(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function logado(req) {
  const m = /(?:^|;\s*)sessao=(\d+)\.([0-9a-f]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  return Number(m[1]) > Date.now() / 1000 && iguais(m[2], assinar(m[1]));
}
function json(res, status, corpo, cabecalhos = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos });
  res.end(JSON.stringify(corpo));
}
function lerCorpo(req, limite = 10000) {
  return new Promise((ok, erro) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > limite) { erro(new Error('grande demais')); req.destroy(); }
    });
    req.on('end', () => ok(dados));
    req.on('error', erro);
  });
}

/** Só aceita links do YouTube (o yt-dlp abriria qualquer site). */
export function linkDoYoutube(texto) {
  let u;
  try { u = new URL(String(texto).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'youtube-nocookie.com') return null;
  u.protocol = 'https:';
  return u.toString();
}

function mensagemDoErro(stderr) {
  const t = stderr || '';
  if (/Sign in to confirm|not a bot|HTTP Error 429|Too Many Requests|Failed to extract any player response|page needs to be reloaded/i.test(t)) {
    return 'O YouTube bloqueou o servidor (ele recusa servidores na nuvem). Configure os cookies do YouTube no Render (veja o README).';
  }
  if (/Private video|members-only|Join this channel/i.test(t)) {
    return 'Esse vídeo é privado ou só pra membros. Configure no Render os cookies de uma conta com acesso ou envie o arquivo à mão.';
  }
  if (/Video unavailable|This video is not available|removed/i.test(t)) return 'O YouTube diz que esse vídeo não está disponível.';
  if (/live event will begin|is live|Premieres in/i.test(t)) return 'Essa transmissão ainda não terminou. Espere o YouTube processar a gravação.';
  if (/Requested format is not available/i.test(t)) return 'O YouTube não ofereceu um formato que sirva pra esse vídeo.';
  if (/ENOENT/.test(t)) return 'O yt-dlp não está instalado no servidor.';
  const ultima = t.trim().split('\n').filter(Boolean).pop() || 'erro desconhecido';
  return 'Não consegui baixar do YouTube: ' + ultima.replace(/^ERROR:\s*/, '').slice(0, 300);
}

function argumentos(extra, url) {
  const a = ['--no-playlist', '--no-warnings', '--no-progress', '--no-cache-dir'];
  if (arquivoCookies) a.push('--cookies', arquivoCookies);
  return [...a, ...extra, '--', url];
}

function rodarJson(extra, url) {
  return new Promise((ok, erro) => {
    const p = spawn(YTDLP, argumentos(['-J', ...extra], url), { stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '', falha = '';
    p.stdout.on('data', (c) => (saida += c));
    p.stderr.on('data', (c) => (falha += c));
    p.on('error', (e) => erro(new Error(mensagemDoErro(String(e)))));
    p.on('close', (cod) => {
      if (cod !== 0) return erro(new Error(mensagemDoErro(falha)));
      try { ok(JSON.parse(saida)); } catch { erro(new Error('O yt-dlp devolveu uma resposta que não entendi.')); }
    });
  });
}

function resumo(j) {
  return {
    ext: j.ext || null,
    tamanho: j.filesize || null,
    tamanhoAproximado: j.filesize || j.filesize_approx || null,
    codec: j.vcodec && j.vcodec !== 'none' ? j.vcodec : j.acodec || null,
    altura: j.height || null,
    fps: j.fps || null,
    kbps: j.tbr ? Math.round(j.tbr) : null,
  };
}

async function rotaInfo(res, url) {
  try {
    const [a, v] = await Promise.all([
      rodarJson(FORMATOS.audio, url),
      rodarJson(FORMATOS.video, url).catch(() => null),
    ]);
    json(res, 200, {
      titulo: a.title || 'Vídeo do YouTube',
      duracao: a.duration || null,
      audio: resumo(a),
      video: v ? resumo(v) : null,
    });
  } catch (e) {
    json(res, 502, { erro: e.message });
  }
}

function rotaBaixar(req, res, url, tipo) {
  const p = spawn(YTDLP, argumentos([...FORMATOS[tipo], '-o', '-'], url), { stdio: ['ignore', 'pipe', 'pipe'] });
  let falha = '', comecou = false, acabou = false;
  p.stderr.on('data', (c) => { if (falha.length < 20000) falha += c; });
  p.on('error', (e) => { falha += String(e); });
  p.stdout.once('data', (primeiro) => {
    comecou = true;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(primeiro);
    p.stdout.pipe(res, { end: false });
  });
  p.on('close', (cod) => {
    acabou = true;
    if (!comecou) return json(res, 502, { erro: mensagemDoErro(falha) });
    // se o yt-dlp falhou no meio, derruba a conexão pro navegador perceber que veio incompleto
    if (cod !== 0) res.destroy(); else res.end();
  });
  res.on('close', () => { if (!acabou) p.kill('SIGKILL'); });
}

function servirArquivo(res, arquivo, cache) {
  fs.readFile(arquivo, (erro, dados) => {
    if (erro) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(dados);
  });
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const rota = u.pathname;
  try {
    if (rota === '/healthz') { res.writeHead(200); return res.end('ok'); }

    if (rota === '/api/login' && req.method === 'POST') {
      let senha = '';
      try { senha = JSON.parse(await lerCorpo(req)).senha || ''; } catch {}
      await new Promise((r) => setTimeout(r, 400)); // freia quem tenta adivinhar
      if (!iguais(senha, SENHA)) return json(res, 401, { erro: 'Senha errada.' });
      const expira = Math.floor(Date.now() / 1000) + VALIDADE;
      const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `sessao=${expira}.${assinar(String(expira))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VALIDADE}${seguro}`,
      });
    }
    if (rota === '/api/sair' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }

    if (rota.startsWith('/api/')) {
      if (!logado(req)) return json(res, 401, { erro: 'Entre com a senha.' });
      if (rota === '/api/sessao') return json(res, 200, { ok: true });
      if (req.method === 'GET' && (rota === '/api/youtube/info' || rota === '/api/youtube/baixar')) {
        const url = linkDoYoutube(u.searchParams.get('url') || '');
        if (!url) return json(res, 400, { erro: 'Esse link não parece ser do YouTube.' });
        if (rota === '/api/youtube/info') return rotaInfo(res, url);
        const tipo = u.searchParams.get('tipo');
        if (!Object.hasOwn(FORMATOS, tipo)) return json(res, 400, { erro: 'Tipo inválido.' });
        return rotaBaixar(req, res, url, tipo);
      }
      return json(res, 404, { erro: 'Não encontrado.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (Object.hasOwn(VENDOR, rota)) return servirArquivo(res, path.join(RAIZ, VENDOR[rota]), 'public, max-age=86400');
    const relativo = rota === '/' ? 'index.html' : decodeURIComponent(rota).replace(/^\/+/, '');
    const arquivo = path.resolve(PUBLICO, relativo);
    if (!arquivo.startsWith(PUBLICO + path.sep)) { res.writeHead(403); return res.end(); }
    return servirArquivo(res, arquivo, 'no-cache');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro no servidor.' });
    else res.destroy();
  }
});

servidor.listen(PORTA, () => {
  console.log(`Sincronizador no ar na porta ${PORTA}` + (arquivoCookies ? ' (com cookies do YouTube)' : ''));
});
