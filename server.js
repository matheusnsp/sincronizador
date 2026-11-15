// Servidor do sincronizador: entrega o site, confere a senha e baixa do YouTube com o yt-dlp.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(RAIZ, 'public');
const PORTA = Number(process.env.PORT || 3000);
const SENHA = process.env.SENHA || '';
const SEGREDO = process.env.SEGREDO_COOKIE || crypto.randomBytes(32).toString('hex');
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const VALIDADE = 30 * 24 * 3600; // 30 dias
const DRIVE = process.env.DRIVE_BASE || 'https://drive.usercontent.google.com'; // só muda nos testes

if (!SENHA) {
  console.error('Defina a variável de ambiente SENHA antes de iniciar o servidor.');
  process.exit(1);
}

// Cookies do YouTube (opcional), pra quando o YouTube bloqueia o servidor ou o vídeo é privado.
// Vêm de um "Secret File" do Render (/etc/secrets/cookies.txt) ou da variável YT_COOKIES.
let arquivoCookies = null;
let linhasDeCookies = 0;
{
  const segredo = process.env.YT_COOKIES_ARQUIVO || '/etc/secrets/cookies.txt';
  let conteudo = '';
  if (fs.existsSync(segredo)) conteudo = fs.readFileSync(segredo, 'utf8');
  else if (process.env.YT_COOKIES) conteudo = process.env.YT_COOKIES.replace(/\\n/g, '\n');
  if (conteudo.trim()) {
    // o yt-dlp regrava o arquivo de cookies, então ele usa uma cópia numa pasta temporária
    arquivoCookies = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-')), 'cookies.txt');
    fs.writeFileSync(arquivoCookies, conteudo, { mode: 0o600 });
    linhasDeCookies = conteudo.split('\n').filter((l) => l.trim() && !l.startsWith('# ')).length;
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
    return 'O YouTube bloqueou o servidor (ele recusa servidores na nuvem). Você pode baixar por fora e escolher o arquivo aqui embaixo.';
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

// Jeitos de pedir o vídeo ao YouTube. Se o primeiro falhar, o servidor tenta o próximo.
const MODOS = [
  [],
  ['--extractor-args', 'youtube:player_client=tv,web_safari,mweb,web_embedded,android_vr'],
];

function argumentos(extra, url, modo = 0) {
  const a = ['--no-playlist', '--no-warnings', '--no-progress', '--no-cache-dir', ...MODOS[modo]];
  if (arquivoCookies) a.push('--cookies', arquivoCookies);
  return [...a, ...extra, '--', url];
}

function versaoDe(comando) {
  try {
    const r = spawnSync(comando, ['--version'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  } catch { return null; }
}
let ambiente = null;
/** Texto pra ajudar a descobrir por que o YouTube recusou (aparece na tela junto do erro). */
function detalhes(erros) {
  ambiente ??= { ytdlp: versaoDe(YTDLP), deno: versaoDe('deno') };
  const linhas = [
    `Cookies do YouTube: ${arquivoCookies ? `lidos (${linhasDeCookies} cookies)` : 'não configurados'}`,
    `yt-dlp: ${ambiente.ytdlp || 'não encontrado'} · Deno: ${ambiente.deno || 'não encontrado'}`,
  ];
  erros.forEach((e, i) => {
    const ultimas = String(e || '').trim().split('\n').filter((l) => /ERROR/.test(l)).slice(-2).join(' | ') || String(e || '').trim().split('\n').pop() || 'sem mensagem';
    linhas.push(`Tentativa ${i + 1}: ${ultimas.slice(0, 400)}`);
  });
  return linhas.join('\n');
}

function rodarJson(extra, url, modo = 0) {
  return new Promise((ok, erro) => {
    const p = spawn(YTDLP, argumentos(['-J', ...extra], url, modo), { stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '', falha = '';
    const falhar = (bruto) => erro(Object.assign(new Error(mensagemDoErro(bruto)), { bruto }));
    p.stdout.on('data', (c) => (saida += c));
    p.stderr.on('data', (c) => (falha += c));
    p.on('error', (e) => falhar(String(e)));
    p.on('close', (cod) => {
      if (cod !== 0) return falhar(falha);
      try { ok(JSON.parse(saida)); } catch { falhar('O yt-dlp devolveu uma resposta que não entendi.'); }
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
  const erros = [];
  let primeira = null;
  for (let modo = 0; modo < MODOS.length; modo++) {
    try {
      const a = await rodarJson(FORMATOS.audio, url, modo);
      const v = await rodarJson(FORMATOS.video, url, modo).catch(() => null);
      return json(res, 200, {
        titulo: a.title || 'Vídeo do YouTube',
        duracao: a.duration || null,
        audio: resumo(a),
        video: v ? resumo(v) : null,
        modo,
      });
    } catch (e) {
      primeira ??= e.message;
      erros.push(e.bruto || e.message);
      console.error(`[youtube] tentativa ${modo + 1} falhou: ${String(e.bruto || e.message).trim().slice(0, 1000)}`);
    }
  }
  json(res, 502, { erro: primeira, detalhe: detalhes(erros) });
}

function rotaBaixar(req, res, url, tipo, modo) {
  const p = spawn(YTDLP, argumentos([...FORMATOS[tipo], '-o', '-'], url, modo), { stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (!comecou) {
      console.error(`[youtube] download falhou: ${falha.trim().slice(0, 1000)}`);
      return json(res, 502, { erro: mensagemDoErro(falha), detalhe: detalhes([falha]) });
    }
    // se o yt-dlp falhou no meio, derruba a conexão pro navegador perceber que veio incompleto
    if (cod !== 0) res.destroy(); else res.end();
  });
  res.on('close', () => { if (!acabou) p.kill('SIGKILL'); });
}

/** Tira o código do arquivo de um link do Google Drive. Devolve null se não for um link de arquivo. */
export function idDoDrive(texto) {
  let u;
  try { u = new URL(String(texto).trim()); } catch { return null; }
  if (!['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(u.hostname.toLowerCase())) return null;
  const m = /\/(?:file|document|presentation|spreadsheets)\/d\/([\w-]{10,})/.exec(u.pathname);
  const id = m ? m[1] : u.searchParams.get('id');
  return id && /^[\w-]{10,}$/.test(id) ? id : null;
}

function nomeDoArquivo(cabecalho) {
  const estrela = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cabecalho || '');
  if (estrela) { try { return decodeURIComponent(estrela[1]); } catch {} }
  const simples = /filename\s*=\s*"?([^";]+)"?/i.exec(cabecalho || '');
  return simples ? simples[1] : 'arquivo-do-drive';
}

function erroDoDrive(status, html) {
  if (status === 404) return 'Não achei esse arquivo no Drive. Confira o link.';
  if (/Too many users|quota|limite de download|excedeu/i.test(html)) {
    return 'O Drive bloqueou o download desse arquivo por excesso de acessos. Tente mais tarde ou baixe o arquivo e escolha ele aqui.';
  }
  if (status === 401 || status === 403 || /accounts\.google\.com|ServiceLogin|Sign in|Fazer login/i.test(html)) {
    return 'Esse arquivo do Drive não está público. Compartilhe como “Qualquer pessoa com o link” ou baixe o arquivo e escolha ele aqui.';
  }
  return 'O Drive não liberou o download desse arquivo. Baixe o arquivo e escolha ele aqui.';
}

/** Busca um arquivo público do Drive e repassa pro navegador, sem gravar em disco. */
async function rotaDrive(req, res, id) {
  const controle = new AbortController();
  res.on('close', () => controle.abort());
  try {
    let alvo = `${DRIVE}/download?id=${id}&export=download&confirm=t`;
    let r;
    for (let tentativa = 0; ; tentativa++) {
      r = await fetch(alvo, { signal: controle.signal, redirect: 'follow' });
      const tipo = r.headers.get('content-type') || '';
      const anexo = /attachment/i.test(r.headers.get('content-disposition') || '');
      if (r.ok && (anexo || !/text\/html/i.test(tipo))) break;
      const html = await r.text();
      // arquivo grande: o Drive mostra um aviso de "não foi possível verificar vírus" com um formulário
      const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"/i.exec(html);
      if (!r.ok || !form || tentativa > 0) return json(res, 502, { erro: erroDoDrive(r.status, html) });
      const proximo = new URL(form[1].replace(/&amp;/g, '&'), DRIVE);
      if (proximo.origin !== new URL(DRIVE).origin) return json(res, 502, { erro: erroDoDrive(r.status, '') });
      for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) proximo.searchParams.set(m[1], m[2]);
      alvo = proximo.toString();
    }
    const cabecalhos = {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      'X-Nome': encodeURIComponent(nomeDoArquivo(r.headers.get('content-disposition'))),
    };
    const tamanho = r.headers.get('content-length');
    if (tamanho && !r.headers.get('content-encoding')) cabecalhos['Content-Length'] = tamanho;
    res.writeHead(200, cabecalhos);
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (res.headersSent) res.destroy();
    else if (!controle.signal.aborted) json(res, 502, { erro: 'Não consegui falar com o Google Drive. Tente de novo.' });
  }
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
        const modo = Number(u.searchParams.get('modo') || 0);
        if (!Number.isInteger(modo) || modo < 0 || modo >= MODOS.length) return json(res, 400, { erro: 'Modo inválido.' });
        return rotaBaixar(req, res, url, tipo, modo);
      }
      if (req.method === 'GET' && rota === '/api/drive/baixar') {
        const link = u.searchParams.get('url') || '';
        if (/\/folders\//.test(link)) return json(res, 400, { erro: 'Esse link é de uma pasta do Drive. Cole o link do arquivo.' });
        const id = idDoDrive(link);
        if (!id) return json(res, 400, { erro: 'Esse link não parece ser de um arquivo do Google Drive.' });
        return rotaDrive(req, res, id);
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
