// Tela do sincronizador: fontes, ondas, ajuste do atraso, prévia e exportação.
import { analisar, exportar } from './midia.js';
import { formatarAtraso, lerAtraso, formatarTempo, formatarTamanho, nivelConfianca, TAXA_ENV } from './nucleo.js';

const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), senha: $('senha'), loginErro: $('login-erro'), app: $('app'), sair: $('sair'),
  direcaoAviso: $('direcao-aviso'), ajuste: $('ajuste'), exportacao: $('exportacao'),
  nomeImagem: $('nome-imagem'), nomeSom: $('nome-som'), ondas: $('ondas'), atraso: $('atraso'),
  sugerir: $('sugerir'), sugestao: $('sugestao'), video: $('video'), audio: $('audio'), tocar: $('tocar'),
  voltar: $('voltar'), relogio: $('relogio'), ouvirOriginal: $('ouvir-original'), previaAviso: $('previa-aviso'),
  exportar: $('exportar'), cancelar: $('cancelar'), exportarProgresso: $('exportar-progresso'), exportarEstado: $('exportar-estado'),
};
const radios = [...document.querySelectorAll('input[name=direcao]')];
// os dois cartões de fonte são iguais: cada um aceita link do YouTube ou arquivo
const cartao = {};
for (const q of ['a', 'b']) {
  cartao[q] = { link: $(q + '-link'), buscar: $(q + '-buscar'), arquivo: $(q + '-arquivo'), estado: $(q + '-estado'), progresso: $(q + '-progresso') };
}

// ---------- estado ----------
// som: arquivo com o áudio; imagem: arquivo com o vídeo (pode ser o mesmo).
// link/info: quando a fonte veio do YouTube. nome: o que aparece na tela.
const novaFonte = (numero) => ({ numero, som: null, imagem: null, onda: null, duracao: 0, link: null, info: null, baixandoVideo: null, nome: '' });
const fontes = { a: novaFonte(1), b: novaFonte(2) };
let direcao = 'a'; // qual fonte dá a imagem
let atraso = 0; // segundos somados ao tempo do som
let diferenca = null; // sugestão automática: tempo na fonte 1 = tempo na fonte 2 + diferenca
const vista = { inicio: 0, pps: 50 }; // tempo no começo da tela e pixels por segundo
let semVideo = false; // o navegador não toca a imagem: a prévia fica só com o som
let tocando = false;
let exportando = null;
let versao = { a: 0, b: 0 };

const outra = (q) => (q === 'a' ? 'b' : 'a');
const lados = () => ({ imagem: fontes[direcao], som: fontes[outra(direcao)] });
const nomeDe = (f) => `fonte ${f.numero}` + (f.nome ? ` (${f.nome.length > 40 ? f.nome.slice(0, 39) + '…' : f.nome})` : '');
const temAlgo = (f) => !!(f.som || f.imagem);
const podeDarImagem = (f) => !!(f.imagem || f.link);

// ---------- login ----------
async function api(caminho, opcoes) {
  const r = await fetch(caminho, opcoes);
  if (r.status === 401 && caminho !== '/api/login') { mostrarLogin(); throw new Error('Entre com a senha de novo.'); }
  return r;
}
function mostrarLogin() { el.app.hidden = true; el.login.hidden = false; el.senha.focus(); }
function mostrarApp() { el.login.hidden = true; el.app.hidden = false; redimensionar(); }

el.login.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginErro.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ senha: el.senha.value }) });
    if (!r.ok) throw new Error((await r.json()).erro || 'Não consegui entrar.');
    el.senha.value = '';
    mostrarApp();
  } catch (erro) { el.loginErro.textContent = erro.message; }
});
el.sair.addEventListener('click', async () => { await fetch('/api/sair', { method: 'POST' }); location.reload(); });

// ---------- utilidades ----------
function estado(elemento, texto, tipo = '') {
  elemento.textContent = texto;
  elemento.className = 'estado' + (tipo ? ' ' + tipo : '');
}
function progresso(barra, valor) {
  if (valor == null) { barra.hidden = true; return; }
  barra.hidden = false;
  if (valor < 0) barra.removeAttribute('value'); else barra.value = valor;
}

/** Guarda o envelope com um resumo (máximo a cada 64 ms) pra desenhar rápido. */
function criarOnda(env) {
  const R = 64;
  const resumo = new Float32Array(Math.ceil(env.length / R));
  for (let i = 0; i < env.length; i++) { const j = (i / R) | 0; if (env[i] > resumo[j]) resumo[j] = env[i]; }
  const ordenado = Float32Array.from(resumo).sort();
  const escala = ordenado[Math.floor(ordenado.length * 0.995)] || ordenado[ordenado.length - 1] || 1;
  return { env, resumo, R, escala: escala || 1 };
}
function picoDa(onda, i0, i1) {
  const { env, resumo, R } = onda;
  if (i1 <= i0) i1 = i0 + 1;
  if (i1 <= 0 || i0 >= env.length) return 0;
  i0 = Math.max(0, i0); i1 = Math.min(env.length, i1);
  let m = 0;
  if (i1 - i0 > 4 * R) {
    for (let j = (i0 / R) | 0, f = Math.ceil(i1 / R); j < f; j++) if (resumo[j] > m) m = resumo[j];
  } else {
    for (let i = i0; i < i1; i++) if (env[i] > m) m = env[i];
  }
  return m;
}

// ---------- fontes ----------
async function limparTemporarios() {
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const nome of dir.keys()) await dir.removeEntry(nome).catch(() => {});
  } catch {}
}

/** Baixa do servidor direto pra um arquivo temporário do navegador (sem ocupar memória). */
async function baixarDoServidor(caminho, nome, total, aoProgresso, sinal, falha) {
  const r = await api(caminho, { signal: sinal });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || falha);
  total = total || Number(r.headers.get('content-length')) || null;
  const leitor = r.body.getReader();
  let gravavel = null, alca = null, pedacos = null, recebido = 0;
  try {
    const dir = await navigator.storage.getDirectory();
    alca = await dir.getFileHandle(nome, { create: true });
    gravavel = await alca.createWritable();
  } catch { pedacos = []; }
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (gravavel) await gravavel.write(value); else pedacos.push(value);
      recebido += value.length;
      aoProgresso(recebido, total);
    }
  } catch (erro) {
    try { await gravavel?.abort(); } catch {}
    if (erro.name === 'AbortError') throw erro;
    throw new Error('O download parou no meio. Tente de novo.');
  }
  if (recebido === 0) throw new Error('O download veio vazio.');
  if (total && recebido < total) throw new Error('O download veio incompleto. Tente de novo.');
  let nomeOriginal = null;
  try { nomeOriginal = decodeURIComponent(r.headers.get('x-nome') || '') || null; } catch {}
  const arquivo = gravavel ? (await gravavel.close(), await alca.getFile()) : new File(pedacos, nome);
  return { arquivo, nomeOriginal };
}

async function baixarDoYoutube(link, tipo, nome, total, aoProgresso, sinal) {
  const r = await baixarDoServidor(`/api/youtube/baixar?tipo=${tipo}&url=${encodeURIComponent(link)}`, nome, total, aoProgresso, sinal,
    'O servidor não conseguiu baixar do YouTube.');
  return r.arquivo;
}

const linkDoDrive = (texto) => {
  try { return ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(new URL(texto).hostname.toLowerCase()); } catch { return false; }
};

/** Link público do Google Drive: o servidor busca o arquivo e o navegador guarda numa pasta temporária. */
async function buscarDrive(q, link) {
  const f = fontes[q], c = cartao[q];
  f.baixandoVideo?.abort();
  const minha = ++versao[q];
  Object.assign(f, { som: null, imagem: null, onda: null, duracao: 0, link: null, info: null, nome: '' });
  c.arquivo.value = '';
  c.buscar.disabled = true;
  atualizar();
  try {
    estado(c.estado, 'Procurando o arquivo no Drive…');
    progresso(c.progresso, -1);
    const r = await baixarDoServidor(`/api/drive/baixar?url=${encodeURIComponent(link)}`, `fonte-${q}-drive`, null, (n, t) => {
      if (minha !== versao[q]) return;
      estado(c.estado, `Baixando do Drive: ${formatarTamanho(n)}${t ? ' de ' + formatarTamanho(t) : ''}`);
      progresso(c.progresso, t ? Math.min(1, n / t) : -1);
    }, null, 'O servidor não conseguiu baixar do Drive.');
    if (minha !== versao[q]) return;
    versao[q]--; // carregarLado soma de novo
    f.nome = r.nomeOriginal || 'arquivo do Drive';
    await carregarLado(q, r.arquivo, f.nome);
  } catch (erro) {
    if (minha !== versao[q]) return;
    progresso(c.progresso, null);
    estado(c.estado, erro.message, 'erro');
  } finally {
    c.buscar.disabled = false;
  }
}

async function carregarLado(q, arquivoSom, rotulo) {
  const f = fontes[q], c = cartao[q];
  const minha = ++versao[q];
  f.som = f.imagem = f.onda = null; f.duracao = 0;
  diferenca = null;
  atualizar();
  estado(c.estado, `Lendo o som de ${rotulo}…`);
  progresso(c.progresso, 0);
  try {
    const r = await analisar(arquivoSom, { aoProgresso: (p) => { if (minha === versao[q]) progresso(c.progresso, p); } });
    if (minha !== versao[q]) return;
    f.duracao = r.duracao;
    f.som = r.temAudio ? arquivoSom : null;
    f.imagem = r.temVideo ? arquivoSom : null;
    f.onda = r.env ? criarOnda(r.env) : null;
    const extra = r.aviso ? ' ' + r.aviso : !r.temAudio ? ' Sem som: o ajuste vai ser manual.' : '';
    estado(c.estado, `${rotulo}: ${formatarTempo(r.duracao)} · ${r.descricao}.${extra}`, r.aviso || !r.temAudio ? '' : 'ok');
  } catch (erro) {
    if (minha !== versao[q]) return;
    estado(c.estado, erro.message, 'erro');
  } finally {
    if (minha === versao[q]) { progresso(c.progresso, null); atualizar(true); }
  }
}

async function buscarYoutube(q) {
  const f = fontes[q], c = cartao[q];
  const link = c.link.value.trim();
  if (!link) { estado(c.estado, 'Cole um link do YouTube ou do Google Drive.', 'erro'); return; }
  if (linkDoDrive(link)) return buscarDrive(q, link);
  f.baixandoVideo?.abort();
  const minha = ++versao[q];
  Object.assign(f, { som: null, imagem: null, onda: null, duracao: 0, link: null, info: null, nome: '' });
  c.arquivo.value = '';
  c.buscar.disabled = true;
  atualizar();
  try {
    estado(c.estado, 'Procurando o vídeo no YouTube…');
    progresso(c.progresso, -1);
    const r = await api(`/api/youtube/info?url=${encodeURIComponent(link)}`);
    const info = await r.json();
    if (!r.ok) throw new Error(info.erro || 'Não achei esse vídeo.');
    if (minha !== versao[q]) return;
    const total = info.audio.tamanhoAproximado;
    const som = await baixarDoYoutube(link, 'audio', `fonte-${q}-som.${info.audio.ext || 'm4a'}`, total, (n, t) => {
      if (minha !== versao[q]) return;
      estado(c.estado, `Baixando o som de “${info.titulo}”: ${formatarTamanho(n)}${t ? ' de ' + formatarTamanho(t) : ''}`);
      progresso(c.progresso, t ? Math.min(1, n / t) : -1);
    });
    if (minha !== versao[q]) return;
    versao[q]--; // carregarLado soma de novo
    Object.assign(f, { link, info, nome: info.titulo });
    await carregarLado(q, som, `“${info.titulo}”`);
  } catch (erro) {
    if (minha !== versao[q]) return;
    progresso(c.progresso, null);
    estado(c.estado, erro.message + ' Você também pode baixar por fora e escolher o arquivo aqui embaixo.', 'erro');
  } finally {
    c.buscar.disabled = false;
  }
}

for (const q of ['a', 'b']) {
  const c = cartao[q];
  c.buscar.addEventListener('click', () => buscarYoutube(q));
  c.link.addEventListener('keydown', (e) => { if (e.key === 'Enter') buscarYoutube(q); });
  c.arquivo.addEventListener('change', () => {
    const arq = c.arquivo.files[0];
    if (!arq) return;
    fontes[q].baixandoVideo?.abort();
    Object.assign(fontes[q], { link: null, info: null, nome: arq.name });
    carregarLado(q, arq, arq.name);
  });
}

/** Quando a imagem vem de um link do YouTube, baixa também o vídeo dele. */
async function baixarVideoDoYoutube(q) {
  const f = fontes[q];
  if (!f.link || f.imagem || f.baixandoVideo) return;
  const controle = new AbortController();
  f.baixandoVideo = controle;
  const minha = versao[q];
  const info = f.info.video;
  try {
    if (!info) throw new Error('O YouTube não ofereceu a imagem desse vídeo.');
    const total = info.tamanhoAproximado;
    const arq = await baixarDoYoutube(f.link, 'video', `fonte-${q}-imagem.${info.ext || 'mp4'}`, total, (n, t) => {
      estado(el.direcaoAviso, `Baixando a imagem do YouTube (${info.altura || '?'}p): ${formatarTamanho(n)}${t ? ' de ' + formatarTamanho(t) : ''}`);
    }, controle.signal);
    if (minha !== versao[q]) return;
    f.imagem = arq;
  } catch (erro) {
    if (erro.name !== 'AbortError' && minha === versao[q]) estado(el.direcaoAviso, erro.message + ` Você pode baixar o vídeo por fora e escolher o arquivo na fonte ${f.numero}.`, 'erro');
  } finally {
    if (f.baixandoVideo === controle) f.baixandoVideo = null;
    atualizar();
  }
}

// ---------- direção ----------
radios.forEach((r) => r.addEventListener('change', () => {
  if (!r.checked || r.value === direcao) return;
  direcao = r.value;
  definirAtraso(-atraso, false); // o que era "som depois" vira "som antes"
  atualizar(true);
}));

let chavePrevia = '';
function atualizar(novaFonte = false) {
  let { imagem, som } = lados();
  // se a fonte da imagem só tem som e a outra pode dar imagem, troca sozinho
  if (novaFonte && imagem.som && !podeDarImagem(imagem) && podeDarImagem(som)) {
    direcao = outra(direcao);
    radios.forEach((r) => (r.checked = r.value === direcao));
    if (atraso) definirAtraso(-atraso, false);
    return atualizar(true);
  }
  if (imagem.link && !imagem.imagem && temAlgo(som)) baixarVideoDoYoutube(direcao);

  let aviso = '';
  if (temAlgo(imagem) && temAlgo(som)) {
    if (!podeDarImagem(imagem)) aviso = `A fonte ${imagem.numero} não tem imagem.` + (podeDarImagem(som) ? ` Escolha “Imagem da fonte ${som.numero}”.` : ' Nenhuma das duas fontes tem imagem.');
    else if (!som.som) aviso = `A fonte ${som.numero} não tem som pra usar.`;
  }
  const baixando = fontes.a.baixandoVideo || fontes.b.baixandoVideo;
  if (!baixando) {
    if (!aviso && imagem.link && imagem.imagem) {
      estado(el.direcaoAviso, `Imagem do YouTube pronta (${imagem.info?.video?.altura || '?'}p, ${formatarTamanho(imagem.imagem.size)}).`, 'ok');
    } else estado(el.direcaoAviso, aviso, aviso ? 'erro' : '');
  }

  const pronto = !!(imagem.imagem && som.som);
  const temOndas = !!(imagem.onda || som.onda);
  el.ajuste.hidden = !(pronto || temOndas);
  el.exportacao.hidden = !pronto;
  el.nomeImagem.textContent = `Imagem: ${nomeDe(imagem)}`;
  el.nomeSom.textContent = `Som: ${nomeDe(som)}`;
  el.sugerir.disabled = !(fontes.a.onda && fontes.b.onda);
  if (!fontes.a.onda || !fontes.b.onda) {
    estado(el.sugestao, temAlgo(fontes.a) && temAlgo(fontes.b) ? 'Um dos lados não tem som, então o ajuste é manual.' : '');
  }

  // prévia
  const chave = [imagem.imagem?.name, imagem.imagem?.size, imagem.imagem?.lastModified, som.som?.name, som.som?.size, som.som?.lastModified].join('|');
  if (chave !== chavePrevia) {
    chavePrevia = chave;
    pausar();
    if (!exportando) estado(el.exportarEstado, ''); // o "Pronto" anterior era de outros arquivos
    semVideo = false;
    estado(el.previaAviso, '');
    for (const m of [el.video, el.audio]) { if (m.src) URL.revokeObjectURL(m.src); m.removeAttribute('src'); m.load(); }
    if (imagem.imagem) el.video.src = URL.createObjectURL(imagem.imagem);
    if (som.som) el.audio.src = URL.createObjectURL(som.som);
  }
  el.tocar.disabled = !pronto;
  el.voltar.disabled = !pronto;

  if (novaFonte) {
    redimensionar();
    verTudo();
    if (fontes.a.onda && fontes.b.onda && diferenca == null) sugerir();
  }
  desenhar();
}

// ---------- atraso ----------
function definirAtraso(valor, manual = true) {
  atraso = Math.round(valor * 1000) / 1000;
  el.atraso.value = formatarAtraso(atraso);
  if (manual && el.sugestao.dataset.auto) { delete el.sugestao.dataset.auto; }
  sincronizarPrevia(true);
  desenhar();
}
document.querySelectorAll('[data-passo]').forEach((b) => b.addEventListener('click', () => definirAtraso(atraso + Number(b.dataset.passo))));
el.atraso.addEventListener('change', () => {
  const v = lerAtraso(el.atraso.value);
  if (v == null) el.atraso.value = formatarAtraso(atraso); else definirAtraso(v);
});
el.atraso.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.atraso.blur(); });

let calculando = 0;
function sugerir() {
  if (!fontes.a.onda || !fontes.b.onda) return;
  const minha = ++calculando;
  el.sugerir.disabled = true;
  estado(el.sugestao, 'Comparando as ondas…');
  const w = new Worker('/calculo.js', { type: 'module' });
  w.onmessage = (e) => {
    w.terminate();
    if (minha !== calculando) return;
    el.sugerir.disabled = false;
    if (!e.data.ok) return estado(el.sugestao, 'Não consegui comparar: ' + e.data.erro, 'erro');
    diferenca = e.data.segundos;
    const nivel = nivelConfianca(e.data.confianca);
    definirAtraso(direcao === 'a' ? diferenca : -diferenca, false);
    estado(el.sugestao, nivel === 'baixa'
      ? `Sugestão: ${formatarAtraso(atraso)}, mas com confiança baixa. Confira na prévia e ajuste à mão.`
      : `Sugestão: ${formatarAtraso(atraso)} (confiança ${nivel}). Confira na prévia.`, nivel === 'baixa' ? 'erro' : 'ok');
    centralizarNoSom();
  };
  w.onerror = () => { w.terminate(); el.sugerir.disabled = false; estado(el.sugestao, 'Não consegui comparar as ondas.', 'erro'); };
  w.postMessage({ a: fontes.a.onda.env, b: fontes.b.onda.env });
}
el.sugerir.addEventListener('click', sugerir);

// ---------- ondas ----------
const ctx = el.ondas.getContext('2d');
let largura = 0, altura = 0;
function redimensionar() {
  const r = el.ondas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  largura = r.width; altura = r.height;
  el.ondas.width = Math.round(largura * dpr);
  el.ondas.height = Math.round(altura * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  desenhar();
}
new ResizeObserver(redimensionar).observe(el.ondas);

function limites() {
  const { imagem, som } = lados();
  const ini = Math.min(0, som.duracao ? atraso : 0);
  const fim = Math.max(imagem.duracao || 0, som.duracao ? som.duracao + atraso : 0, 1);
  return { ini, fim };
}
function verTudo() {
  if (!largura) return;
  const { ini, fim } = limites();
  vista.pps = largura / (fim - ini);
  vista.inicio = ini;
  desenhar();
}
function zoom(fator, x = largura / 2) {
  const t = vista.inicio + x / vista.pps;
  const { ini, fim } = limites();
  vista.pps = Math.min(4000, Math.max(largura / (fim - ini) / 1.2, vista.pps * fator));
  vista.inicio = t - x / vista.pps;
  desenhar();
}
function centralizarNoSom() {
  // depois da sugestão, mostra uns 20 s no meio do trecho em que os dois se sobrepõem
  const { imagem, som } = lados();
  const a = Math.max(0, atraso), b = Math.min(imagem.duracao || Infinity, (som.duracao || 0) + atraso);
  if (!(b > a) || !largura) return;
  const meio = tempoAtual() > a && tempoAtual() < b ? tempoAtual() : (a + b) / 2;
  vista.pps = largura / 20;
  vista.inicio = meio - 10;
  desenhar();
}
$('zoom-mais').addEventListener('click', () => zoom(2));
$('zoom-menos').addEventListener('click', () => zoom(0.5));
$('zoom-tudo').addEventListener('click', verTudo);

let pedido = 0;
function desenhar() { if (!pedido) pedido = requestAnimationFrame(pintar); }
function pintar() {
  pedido = 0;
  if (!largura) return;
  const estilo = getComputedStyle(document.documentElement);
  const cores = { imagem: estilo.getPropertyValue('--imagem'), som: estilo.getPropertyValue('--som'), fraco: estilo.getPropertyValue('--fraco') };
  ctx.clearRect(0, 0, largura, altura);
  const regua = 18, faixa = (altura - regua) / 2;
  const { imagem, som } = lados();

  // régua do tempo
  const alvo = 90 / vista.pps;
  const passos = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600];
  const passo = passos.find((p) => p >= alvo) || 3600;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = cores.fraco;
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let t = Math.ceil(vista.inicio / passo) * passo; t < vista.inicio + largura / vista.pps; t += passo) {
    const x = Math.round((t - vista.inicio) * vista.pps) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, regua); ctx.lineTo(x, altura); ctx.stroke();
    ctx.fillText(formatarTempo(t, passo < 1 ? (passo < 0.01 ? 3 : passo < 0.1 ? 2 : 1) : 0), x + 3, 12);
  }
  ctx.beginPath(); ctx.moveTo(0, regua + faixa + 0.5); ctx.lineTo(largura, regua + faixa + 0.5); ctx.stroke();

  const faixaDa = (fonte, desloc, topo, cor) => {
    const meio = topo + faixa / 2;
    // área que o arquivo ocupa
    if (fonte.duracao) {
      const x0 = Math.max(0, (desloc - vista.inicio) * vista.pps);
      const x1 = Math.min(largura, (desloc + fonte.duracao - vista.inicio) * vista.pps);
      if (x1 > x0) { ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(x0, topo + 2, x1 - x0, faixa - 4); }
    }
    if (!fonte.onda) return;
    ctx.fillStyle = cor;
    const porPx = TAXA_ENV / vista.pps;
    const base = (vista.inicio - desloc) * TAXA_ENV;
    const max = faixa / 2 - 4;
    for (let x = 0; x < largura; x++) {
      const i0 = Math.floor(base + x * porPx);
      const v = picoDa(fonte.onda, i0, Math.floor(base + (x + 1) * porPx));
      if (v <= 0) continue;
      const h = Math.max(0.5, Math.min(1, Math.sqrt(v / fonte.onda.escala)) * max);
      ctx.fillRect(x, meio - h, 1, 2 * h);
    }
  };
  faixaDa(imagem, 0, regua, cores.imagem);
  faixaDa(som, atraso, regua + faixa, cores.som);

  // agulha da prévia
  const xp = (tempoAtual() - vista.inicio) * vista.pps;
  if (xp >= 0 && xp <= largura) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(xp), regua, 1, altura - regua); }
}

let arrasto = null;
el.ondas.addEventListener('pointerdown', (e) => {
  const r = el.ondas.getBoundingClientRect();
  const y = e.clientY - r.top;
  arrasto = { x: e.clientX, x0: e.clientX, som: y > 18 + (altura - 18) / 2, moveu: false };
  el.ondas.setPointerCapture(e.pointerId);
  el.ondas.style.cursor = 'grabbing';
});
el.ondas.addEventListener('pointermove', (e) => {
  if (!arrasto) return;
  const dx = e.clientX - arrasto.x;
  if (Math.abs(e.clientX - arrasto.x0) > 3) arrasto.moveu = true;
  if (!arrasto.moveu) return;
  arrasto.x = e.clientX;
  if (arrasto.som) { atraso += dx / vista.pps; el.atraso.value = formatarAtraso(atraso); desenhar(); }
  else { vista.inicio -= dx / vista.pps; desenhar(); }
});
const soltar = (e) => {
  if (!arrasto) return;
  const a = arrasto; arrasto = null;
  el.ondas.style.cursor = '';
  if (a.moveu) { if (a.som) definirAtraso(atraso); return; }
  const r = el.ondas.getBoundingClientRect();
  irPara(vista.inicio + (e.clientX - r.left) / vista.pps);
};
el.ondas.addEventListener('pointerup', soltar);
el.ondas.addEventListener('pointercancel', () => { if (arrasto?.som) definirAtraso(atraso); arrasto = null; el.ondas.style.cursor = ''; });
el.ondas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { vista.inicio += (e.deltaX || e.deltaY) / vista.pps; desenhar(); }
  else zoom(Math.exp(-e.deltaY * 0.002), e.clientX - el.ondas.getBoundingClientRect().left);
}, { passive: false });

// ---------- prévia ----------
function tempoAtual() {
  return semVideo ? (el.audio.currentTime || 0) + atraso : el.video.currentTime || 0;
}
function sincronizarPrevia(forcar = false) {
  if (semVideo) return;
  const alvo = el.video.currentTime - atraso;
  const dentro = alvo >= 0 && alvo < (el.audio.duration || Infinity);
  if (!dentro || !tocando) { if (!el.audio.paused) el.audio.pause(); if (dentro && forcar) el.audio.currentTime = alvo; return; }
  if (el.audio.paused) { el.audio.currentTime = alvo; el.audio.play().catch(() => {}); }
  else if (forcar || Math.abs(el.audio.currentTime - alvo) > 0.045) el.audio.currentTime = alvo;
}
function irPara(t) {
  t = Math.max(0, t);
  if (semVideo) el.audio.currentTime = Math.max(0, t - atraso);
  else { el.video.currentTime = Math.min(t, el.video.duration || t); sincronizarPrevia(true); }
  desenhar();
}
async function tocar() {
  if (tocando) return pausar();
  tocando = true;
  el.tocar.textContent = '⏸ Pausar';
  try {
    if (semVideo) await el.audio.play();
    else { await el.video.play(); sincronizarPrevia(true); }
  } catch { pausar(); return; }
  requestAnimationFrame(ciclo);
}
function pausar() {
  tocando = false;
  el.tocar.textContent = '▶ Tocar prévia';
  el.video.pause(); el.audio.pause();
}
function ciclo() {
  if (!tocando) return;
  if ((semVideo ? el.audio : el.video).ended) { pausar(); return; }
  sincronizarPrevia();
  const t = tempoAtual();
  el.relogio.textContent = formatarTempo(t, 1);
  const fimTela = vista.inicio + largura / vista.pps;
  if (!arrasto && (t > fimTela || t < vista.inicio)) vista.inicio = t - (largura / vista.pps) * 0.1;
  desenhar();
  requestAnimationFrame(ciclo);
}
el.tocar.addEventListener('click', tocar);
el.voltar.addEventListener('click', () => irPara(tempoAtual() - 5));
el.ouvirOriginal.addEventListener('change', () => { el.video.muted = !el.ouvirOriginal.checked; });
el.video.addEventListener('seeked', () => { el.relogio.textContent = formatarTempo(tempoAtual(), 1); desenhar(); });
el.video.addEventListener('error', () => {
  if (!el.video.src) return;
  semVideo = true;
  pausar();
  estado(el.previaAviso, 'Este navegador não consegue tocar essa imagem, então a prévia fica só com o som. A exportação funciona normalmente.');
});
el.audio.addEventListener('error', () => {
  if (el.audio.src) estado(el.previaAviso, 'Este navegador não consegue tocar esse som na prévia. A exportação funciona normalmente.');
});

document.addEventListener('keydown', (e) => {
  if (el.app.hidden || el.ajuste.hidden || e.target.matches('input, button, select, textarea') && e.target !== el.ondas) return;
  if (e.key === ' ') { e.preventDefault(); if (!el.tocar.disabled) tocar(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const passo = e.ctrlKey || e.metaKey ? 1 : e.shiftKey ? 0.1 : e.altKey ? 0.001 : 0.01;
  definirAtraso(atraso + (e.key === 'ArrowLeft' ? -passo : passo));
});

// ---------- exportar ----------
el.exportar.addEventListener('click', async () => {
  const { imagem, som } = lados();
  if (!imagem.imagem || !som.som || exportando) return;
  const nome = (imagem.nome || 'pregacao').replace(/\.(mp4|m4v|mov|mkv|webm|avi|mts|m2ts)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ').trim() + '-sincronizado.mp4';
  let gravavel = null;
  if (window.showSaveFilePicker) {
    try {
      const alca = await window.showSaveFilePicker({ suggestedName: nome, types: [{ description: 'Vídeo MP4', accept: { 'video/mp4': ['.mp4'] } }] });
      gravavel = await alca.createWritable();
    } catch (erro) {
      if (erro.name === 'AbortError') return;
      return estado(el.exportarEstado, 'Não consegui criar o arquivo: ' + erro.message, 'erro');
    }
  } else if (imagem.imagem.size > 1.5e9) {
    return estado(el.exportarEstado, 'Esse vídeo é grande demais pra este navegador. Use o Chrome ou o Edge no computador.', 'erro');
  }
  pausar();
  exportando = new AbortController();
  el.exportar.disabled = true;
  el.cancelar.hidden = false;
  progresso(el.exportarProgresso, 0);
  const inicio = performance.now();
  estado(el.exportarEstado, `Montando o vídeo com o som em ${formatarAtraso(atraso)}…`);
  try {
    const blob = await exportar({
      imagem: imagem.imagem, som: som.som, atraso, gravavel, sinal: exportando.signal,
      aoProgresso: (p) => {
        progresso(el.exportarProgresso, p);
        estado(el.exportarEstado, `Montando o vídeo com o som em ${formatarAtraso(atraso)}… ${Math.round(p * 100)}%`);
      },
    });
    if (blob) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nome });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    estado(el.exportarEstado, `Pronto: ${nome} (${Math.round((performance.now() - inicio) / 1000)} s). Som em ${formatarAtraso(atraso)}.`, 'ok');
  } catch (erro) {
    try { await gravavel?.abort(); } catch {}
    estado(el.exportarEstado, erro.name === 'AbortError' ? 'Exportação cancelada.' : 'Não consegui montar o vídeo: ' + erro.message, 'erro');
  } finally {
    exportando = null;
    el.exportar.disabled = false;
    el.cancelar.hidden = true;
    progresso(el.exportarProgresso, null);
  }
});
el.cancelar.addEventListener('click', () => exportando?.abort());
window.addEventListener('beforeunload', (e) => { if (exportando) e.preventDefault(); });

// ---------- início ----------
limparTemporarios();
fetch('/api/sessao').then((r) => (r.ok ? mostrarApp() : mostrarLogin()), mostrarLogin);
