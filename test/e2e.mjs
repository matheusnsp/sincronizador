// Teste ponta a ponta: sobe o servidor com um yt-dlp falso, abre o site no Chromium,
// sincroniza arquivos gerados pelo ffmpeg e confere o MP4 exportado.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Envelope, sugerirDiferenca } from '../public/nucleo.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(RAIZ, 'test/tmp');
const PORTA = 34599;
const BASE = `http://127.0.0.1:${PORTA}`;
const TAXA = 48000;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);

// ---- arquivos de teste ----
// Um "culto" de 40 s. O Drive gravou de 3,2 s a 33,2 s; o YouTube, de 0,855 s em diante.
// Então tDrive = tYoutube − 2,345 s.
function mestre(segundos) {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(segundos * TAXA);
  let vol = 0.5, ate = 0;
  for (let i = 0; i < out.length; i++) {
    if (i >= ate) { vol = rnd() < 0.3 ? 0.01 : 0.2 + rnd() * 0.6; ate = i + Math.floor((0.05 + rnd() * 0.4) * TAXA); }
    out[i] = (rnd() * 2 - 1) * vol;
  }
  return out;
}
function salvarWav(arquivo, amostras) {
  const b = Buffer.alloc(44 + amostras.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + amostras.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(TAXA, 24);
  b.writeUInt32LE(TAXA * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(amostras.length * 2, 40);
  for (let i = 0; i < amostras.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(amostras[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(arquivo, b);
}
const M = mestre(40);
const camera = M.slice(Math.round(3.2 * TAXA), Math.round(33.2 * TAXA)).map((v, i) => v * 0.3 + Math.sin(i * 0.9) * 0.01);
const mesa = M.slice(Math.round(0.855 * TAXA));
salvarWav(`${TMP}/camera.wav`, camera);
salvarWav(`${TMP}/mesa.wav`, mesa);
const fonte = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30'];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '60', '-pix_fmt', 'yuv420p'];
// Drive: imagem + som da câmera
ff(...fonte, '-i', `${TMP}/camera.wav`, ...h264, '-c:a', 'libopus', '-b:a', '64k', '-t', '30', `${TMP}/drive.mp4`);
// YouTube: som da mesa (só áudio) e imagem (só vídeo), como o yt-dlp entrega
ff('-i', `${TMP}/mesa.wav`, '-c:a', 'libopus', '-b:a', '96k', `${TMP}/yt-som.webm`);
ff(...fonte, ...h264, '-t', '39', '-an', '-movflags', '+frag_keyframe+empty_moov', `${TMP}/yt-imagem.mp4`);
// Drive só com som (pro sentido YouTube → Drive)
ff('-i', `${TMP}/camera.wav`, '-c:a', 'libopus', '-b:a', '96k', `${TMP}/drive-som.webm`);

// ---- servidor ----
const servidor = spawn('node', ['server.js'], {
  cwd: RAIZ,
  env: {
    ...process.env, PORT: PORTA, SENHA: 'teste', YTDLP_BIN: path.join(RAIZ, 'test/fake-ytdlp.mjs'),
    FAKE_YT_AUDIO: `${TMP}/yt-som.webm`, FAKE_YT_VIDEO: `${TMP}/yt-imagem.mp4`,
  },
  stdio: 'inherit',
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const md5Video = (arq) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', arq, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
const pacotes = (arq) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time,flags', '-of', 'csv', arq]).toString();
function envelopeDoArquivo(arq) {
  const bruto = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', arq, '-map', '0:a', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const amostras = new Float32Array(bruto.buffer, bruto.byteOffset, bruto.length / 4);
  const e = new Envelope();
  e.adicionar(amostras, 16000, 0);
  return { env: e.concluir(), amostras };
}

let navegador;
const erros = [];
try {
  navegador = await chromium.launch();
  const pagina = await navegador.newPage({ viewport: { width: 1200, height: 1100 } });
  pagina.on('pageerror', (e) => erros.push(String(e)));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  await pagina.addInitScript(() => {
    // o seletor de arquivo de verdade não abre num teste: grava num arquivo temporário do navegador
    window.showSaveFilePicker = async (o) => {
      const dir = await navigator.storage.getDirectory();
      window.__saida = await dir.getFileHandle('saida-' + Date.now() + '.mp4', { create: true });
      window.__nome = o.suggestedName;
      return window.__saida;
    };
  });
  const lerSaida = async (destino) => {
    const dados = await pagina.evaluate(async () => {
      const arq = await window.__saida.getFile();
      const b = new Uint8Array(await arq.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    });
    fs.writeFileSync(destino, Buffer.from(dados, 'base64'));
  };
  const atrasoNaTela = async () => {
    const t = await pagina.inputValue('#atraso');
    return Number(t.replace('−', '-').replace(',', '.').replace(' s', ''));
  };
  const exportarE = async (destino) => {
    await pagina.evaluate(() => { document.getElementById('exportar-estado').textContent = ''; });
    await pagina.click('#exportar');
    await pagina.waitForFunction(() => /Pronto|Não consegui|cancelada/.test(document.getElementById('exportar-estado').textContent), null, { timeout: 120000 });
    const texto = await pagina.textContent('#exportar-estado');
    assert.match(texto, /Pronto/, texto);
    await lerSaida(destino);
  };

  // ---- login ----
  await pagina.goto(BASE);
  await pagina.fill('#senha', 'errada');
  await pagina.click('#login button');
  await pagina.waitForFunction(() => document.getElementById('login-erro').textContent.includes('Senha errada'));
  await pagina.fill('#senha', 'teste');
  await pagina.click('#login button');
  await pagina.waitForSelector('#app:not([hidden])');
  console.log('✓ login');

  // ---- cenário 1: imagem do Drive + som do YouTube (link) ----
  await pagina.fill('#yt-link', 'https://www.youtube.com/watch?v=teste');
  await pagina.click('#yt-buscar');
  await pagina.setInputFiles('#drive-arquivo', `${TMP}/drive.mp4`);
  await pagina.waitForFunction(() => document.getElementById('sugestao').textContent.includes('Sugestão'), null, { timeout: 60000 });
  const sugestao1 = await pagina.textContent('#sugestao');
  const a1 = await atrasoNaTela();
  console.log('  ', sugestao1);
  assert.ok(Math.abs(a1 + 2.345) <= 0.005, `atraso sugerido ${a1}, esperado −2,345`);
  assert.match(sugestao1, /confiança alta/);
  await pagina.screenshot({ path: `${TMP}/tela-1.png`, fullPage: true });
  await exportarE(`${TMP}/saida-1.mp4`);
  assert.equal(await pagina.evaluate(() => window.__nome), 'drive-sincronizado.mp4');
  assert.equal(md5Video(`${TMP}/saida-1.mp4`), md5Video(`${TMP}/drive.mp4`), 'a imagem tem que sair idêntica');
  assert.equal(pacotes(`${TMP}/saida-1.mp4`), pacotes(`${TMP}/drive.mp4`), 'os tempos da imagem têm que sair iguais');
  const codec1 = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name,duration', '-of', 'csv=p=0', `${TMP}/saida-1.mp4`]).toString().trim();
  assert.match(codec1, /^aac,/);
  assert.ok(Math.abs(Number(codec1.split(',')[1]) - 30) < 0.1, 'o som tem a duração do vídeo: ' + codec1);
  const d1 = sugerirDiferenca(envelopeDoArquivo(`${TMP}/saida-1.mp4`).env, envelopeDoArquivo(`${TMP}/drive.mp4`).env);
  console.log(`   som novo × som da câmera: ${(d1.segundos * 1000).toFixed(1)} ms`);
  assert.ok(Math.abs(d1.segundos) <= 0.006, 'o som novo tem que bater com o da câmera');
  console.log('✓ Drive → YouTube: sugestão, imagem idêntica, som alinhado');

  // ajuste manual: botões e campo
  await pagina.click('[data-passo="0.1"]');
  await pagina.click('[data-passo="-0.001"]');
  assert.ok(Math.abs((await atrasoNaTela()) - (a1 + 0.099)) < 1e-9);
  await pagina.fill('#atraso', '1,5');
  await pagina.press('#atraso', 'Enter');
  assert.equal(await pagina.inputValue('#atraso'), '+1,500 s');
  console.log('✓ ajuste manual');

  // ---- cenário 2: imagem do YouTube (baixada pelo link) + som do Drive ----
  await pagina.setInputFiles('#drive-arquivo', `${TMP}/drive-som.webm`);
  await pagina.waitForFunction(() => document.getElementById('direcao-aviso').textContent.includes('Imagem do YouTube pronta'), null, { timeout: 60000 });
  assert.equal(await pagina.isChecked('input[name=direcao][value=yt]'), true, 'troca sozinho pra imagem do YouTube');
  await pagina.waitForFunction(() => document.getElementById('sugestao').textContent.includes('Sugestão'), null, { timeout: 60000 });
  const a2 = await atrasoNaTela();
  console.log('  ', await pagina.textContent('#sugestao'));
  assert.ok(Math.abs(a2 - 2.345) <= 0.005, `atraso sugerido ${a2}, esperado +2,345`);
  await pagina.screenshot({ path: `${TMP}/tela-2.png`, fullPage: true });
  await exportarE(`${TMP}/saida-2.mp4`);
  assert.equal(md5Video(`${TMP}/saida-2.mp4`), md5Video(`${TMP}/yt-imagem.mp4`), 'a imagem tem que sair idêntica');
  const s2 = envelopeDoArquivo(`${TMP}/saida-2.mp4`);
  const pico = s2.amostras.subarray(0, 2.2 * 16000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(pico < 0.001, `o começo tem que ser silêncio (pico ${pico})`);
  // a saída tem o som no tempo do YouTube: tem que bater com o som da mesa
  const d2 = sugerirDiferenca(s2.env, envelopeDoArquivo(`${TMP}/yt-som.webm`).env);
  console.log(`   som novo × som do YouTube: ${(d2.segundos * 1000).toFixed(1)} ms`);
  assert.ok(Math.abs(d2.segundos) <= 0.006, 'o som do Drive tem que bater com o do YouTube');
  console.log('✓ YouTube → Drive: baixa a imagem, sugestão, silêncio no começo, som alinhado');

  // ---- YouTube bloqueado: mensagem clara e plano B ----
  await pagina.fill('#yt-link', 'https://youtu.be/bloqueado');
  await pagina.click('#yt-buscar');
  await pagina.waitForFunction(() => document.getElementById('yt-estado').textContent.includes('bloqueou o servidor'));
  await pagina.setInputFiles('#yt-arquivo', `${TMP}/yt-som.webm`);
  await pagina.setInputFiles('#drive-arquivo', `${TMP}/drive.mp4`);
  await pagina.check('input[name=direcao][value=drive]');
  await pagina.waitForFunction(() => document.getElementById('sugestao').textContent.includes('Sugestão'), null, { timeout: 60000 });
  assert.ok(Math.abs((await atrasoNaTela()) + 2.345) <= 0.005);
  console.log('✓ bloqueio do YouTube e envio à mão');

  const semCodec = erros.filter((e) => !/DEMUXER_ERROR|Failed to load resource|MEDIA_ERR|NotSupported/i.test(e));
  assert.deepEqual(semCodec, [], 'erros no console');
  console.log('\nTudo certo.');
} catch (e) {
  console.error('\nFALHOU:', e.message, '\nconsole:', erros);
  process.exitCode = 1;
} finally {
  await navegador?.close();
  servidor.kill();
}
