// Funções puras do sincronizador (rodam no navegador e nos testes com Node).

export const TAXA_ENV = 1000; // envelope em 1 kHz: 1 valor por milissegundo

/** Junta o áudio decodificado num envelope de volume (média do valor absoluto por ms). */
export class Envelope {
  constructor() {
    this.dados = new Float32Array(1 << 20);
    this.tamanho = 0;
  }
  /** amostras: Float32Array de um canal; taxa em Hz; inicio em segundos. */
  adicionar(amostras, taxa, inicio) {
    const passo = TAXA_ENV / taxa;
    const base = inicio * TAXA_ENV;
    const fim = Math.floor(base + amostras.length * passo) + 1;
    if (fim <= 0) return;
    if (fim > this.dados.length) {
      let novo = this.dados.length;
      while (novo < fim) novo *= 2;
      const d = new Float32Array(novo);
      d.set(this.dados);
      this.dados = d;
    }
    const d = this.dados;
    const peso = passo; // cada amostra vale 1/(amostras por ms)
    for (let i = 0; i < amostras.length; i++) {
      const idx = Math.floor(base + i * passo);
      if (idx < 0) continue;
      const v = amostras[i];
      d[idx] += (v < 0 ? -v : v) * peso;
    }
    if (fim > this.tamanho) this.tamanho = fim;
  }
  concluir() {
    return this.dados.subarray(0, this.tamanho);
  }
}

/** Reduz o envelope tirando a média de cada grupo de `fator` valores. */
export function reduzir(env, fator) {
  const n = Math.floor(env.length / fator);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const b = i * fator;
    for (let j = 0; j < fator; j++) s += env[b + j];
    out[i] = s / fator;
  }
  return out;
}

/** Prepara o envelope pra comparação: comprime (raiz) e tira a média móvel. */
export function preparar(env, janela) {
  const n = env.length;
  const x = new Float64Array(n);
  let media = 0;
  for (let i = 0; i < n; i++) media += env[i];
  media = media / Math.max(1, n) || 1;
  for (let i = 0; i < n; i++) x[i] = Math.sqrt(env[i] / media);
  const acum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) acum[i + 1] = acum[i] + x[i];
  const meia = Math.max(1, janela >> 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - meia);
    const b = Math.min(n, i + meia + 1);
    out[i] = x[i] - (acum[b] - acum[a]) / (b - a);
  }
  return out;
}

function fft(re, im, inversa) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inversa ? -2 : 2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const meio = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < meio; k++) {
        const a = i + k, b = a + meio;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/**
 * Correlação cruzada de dois sinais preparados.
 * Devolve o deslocamento k (em amostras) em que a[n + k] ≈ b[n], e a confiança
 * (pico dividido pelo maior valor fora da vizinhança do pico).
 */
export function correlacionar(a, b, vizinhanca = 200) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const m = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = m;
  }
  fft(ar, ai, true);
  let pico = -Infinity, onde = 0;
  for (let i = 0; i < n; i++) if (ar[i] > pico) { pico = ar[i]; onde = i; }
  let segundo = 0;
  for (let i = 0; i < n; i++) {
    let dist = Math.abs(i - onde);
    if (dist > n / 2) dist = n - dist;
    if (dist > vizinhanca && ar[i] > segundo) segundo = ar[i];
  }
  const k = onde > n / 2 ? onde - n : onde;
  return { k, confianca: segundo > 0 ? pico / segundo : Infinity };
}

/** Procura o melhor deslocamento perto de `centro` (em amostras), com fração de amostra. */
export function refinar(a, b, centro, alcance, maxAmostras = 600000) {
  // trecho de b que cai dentro de a em todos os deslocamentos testados
  const ini = Math.max(0, -(centro - alcance));
  const fim = Math.min(b.length, a.length - (centro + alcance));
  if (fim - ini < 100) return centro;
  let i0 = ini, i1 = fim;
  if (i1 - i0 > maxAmostras) {
    i0 = ini + ((fim - ini - maxAmostras) >> 1);
    i1 = i0 + maxAmostras;
  }
  const valores = new Float64Array(2 * alcance + 1);
  let melhor = 0;
  for (let d = -alcance; d <= alcance; d++) {
    const k = centro + d;
    let s = 0;
    for (let i = i0; i < i1; i++) s += a[i + k] * b[i];
    valores[d + alcance] = s;
    if (s > valores[melhor]) melhor = d + alcance;
  }
  let fracao = 0;
  if (melhor > 0 && melhor < valores.length - 1) {
    const y0 = valores[melhor - 1], y1 = valores[melhor], y2 = valores[melhor + 1];
    const den = y0 - 2 * y1 + y2;
    if (den < 0) fracao = (0.5 * (y0 - y2)) / den;
  }
  return centro + melhor - alcance + fracao;
}

/**
 * Descobre a diferença de tempo entre dois envelopes de 1 kHz.
 * Devolve { segundos, confianca }: um mesmo momento aparece em `envA` no tempo
 * tA = tB + segundos.
 */
export function sugerirDiferenca(envA, envB) {
  const FATOR = 10; // 100 Hz pra busca geral
  const a = preparar(reduzir(envA, FATOR), 200);
  const b = preparar(reduzir(envB, FATOR), 200);
  const { k, confianca } = correlacionar(a, b);
  const fa = preparar(envA, 100);
  const fb = preparar(envB, 100);
  const fino = refinar(fa, fb, k * FATOR, 2 * FATOR + 40);
  return { segundos: fino / TAXA_ENV, confianca };
}

export function nivelConfianca(c) {
  return c >= 2 ? 'alta' : c >= 1.3 ? 'média' : 'baixa';
}

/**
 * Decide o que fazer com um bloco de áudio na hora de exportar.
 * Tudo em quadros (amostras). `escritos`: quanto já foi gravado; `inicio`: onde
 * o bloco deveria começar na saída; `quadros`: tamanho do bloco; `limite`: fim
 * da saída. Devolve { silencio, pular, usar }.
 */
export function planejarBloco(escritos, inicio, quadros, limite, tolerancia = 0) {
  if (escritos >= limite) return { silencio: 0, pular: quadros, usar: 0 };
  let pular = Math.max(0, escritos - inicio);
  let silencio = Math.max(0, inicio - escritos);
  if (escritos > 0) {
    // pequenas imprecisões de tempo entre blocos seguidos não viram corte nem silêncio
    if (pular <= tolerancia) pular = 0;
    if (silencio <= tolerancia) silencio = 0;
  }
  if (pular >= quadros) return { silencio: 0, pular: quadros, usar: 0 };
  silencio = Math.min(silencio, limite - escritos);
  const usar = Math.max(0, Math.min(quadros - pular, limite - escritos - silencio));
  return { silencio, pular, usar };
}

/** "+2,345 s" */
export function formatarAtraso(s) {
  const ms = Math.round(s * 1000);
  const sinal = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  return `${sinal}${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, '0')} s`;
}

/** Aceita "2,345", "-2.345", "+1:02,5" e devolve segundos (ou null). */
export function lerAtraso(texto) {
  const t = String(texto).trim().replace('−', '-').replace(/s$/i, '').trim().replace(',', '.');
  const m = /^([+-]?)(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(t);
  if (!m) return null;
  const v = (m[2] ? Number(m[2]) * 60 : 0) + Number(m[3]);
  return Math.round((m[1] === '-' ? -v : v) * 1000) / 1000;
}

/** "1:02:03" ou "2:03,4" */
export function formatarTempo(s, decimais = 0) {
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s - h * 3600 - m * 60;
  const ss = decimais
    ? seg.toFixed(decimais).padStart(3 + decimais, '0').replace('.', ',')
    : String(Math.floor(seg)).padStart(2, '0');
  return (neg ? '−' : '') + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + ss;
}

export function formatarTamanho(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2).replace('.', ',') + ' GB';
  return (bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1).replace('.', ',') + ' MB';
}
