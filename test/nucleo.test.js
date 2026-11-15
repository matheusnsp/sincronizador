import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Envelope, sugerirDiferenca, planejarBloco, formatarAtraso, lerAtraso, formatarTempo, nivelConfianca,
} from '../public/nucleo.js';

// "fala" falsa: ruído com volume que muda de forma irregular
function sinal(segundos, taxa, semente = 1) {
  let s = semente;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(segundos * taxa);
  let vol = 0.5, ate = 0;
  for (let i = 0; i < out.length; i++) {
    if (i >= ate) { vol = rnd() < 0.3 ? 0.02 : rnd(); ate = i + Math.floor((0.05 + rnd() * 0.4) * taxa); }
    out[i] = (rnd() * 2 - 1) * vol;
  }
  return out;
}

function envelopeDe(amostras, taxa, inicio = 0, bloco = 4096) {
  const e = new Envelope();
  for (let i = 0; i < amostras.length; i += bloco) {
    e.adicionar(amostras.subarray(i, i + bloco), taxa, inicio + i / taxa);
  }
  return e.concluir();
}

test('envelope tem 1 valor por milissegundo', () => {
  const env = envelopeDe(new Float32Array(48000).fill(0.5), 48000);
  assert.ok(Math.abs(env.length - 1000) <= 1);
  assert.ok(Math.abs(env[500] - 0.5) < 0.01);
});

test('acha a diferença entre dois áudios (taxas diferentes, com ruído)', () => {
  const base = sinal(120, 8000);
  // A: o mesmo som começando 2,345 s depois, em outra taxa, com ruído por cima
  const atraso = 2.345;
  const ruido = sinal(120, 8000, 99);
  const a = new Float32Array(base.length);
  for (let i = 0; i < a.length; i++) a[i] = base[i] * 0.4 + ruido[i] * 0.05;
  const envA = envelopeDe(a, 8000, atraso);
  const envB = envelopeDe(base.subarray(0, 100 * 8000), 8000);
  const r = sugerirDiferenca(envA, envB);
  assert.ok(Math.abs(r.segundos - atraso) < 0.003, `achou ${r.segundos}`);
  assert.equal(nivelConfianca(r.confianca), 'alta');
});

test('acha diferença negativa e grande', () => {
  const base = sinal(300, 4000, 7);
  const envA = envelopeDe(base.subarray(95 * 4000 + 2000), 4000); // A começa 95,5 s depois dentro de B
  const envB = envelopeDe(base, 4000);
  const r = sugerirDiferenca(envA, envB);
  assert.ok(Math.abs(r.segundos + 95.5) < 0.003, `achou ${r.segundos}`);
});

test('áudios sem relação dão confiança baixa', () => {
  const r = sugerirDiferenca(envelopeDe(sinal(60, 4000, 1), 4000), envelopeDe(sinal(60, 4000, 2), 4000));
  assert.equal(nivelConfianca(r.confianca), 'baixa');
});

test('planejarBloco: atraso positivo começa com silêncio', () => {
  assert.deepEqual(planejarBloco(0, 4800, 1024, 1e6), { silencio: 4800, pular: 0, usar: 1024 });
});

test('planejarBloco: atraso negativo corta o começo', () => {
  assert.deepEqual(planejarBloco(0, -2000, 1024, 1e6), { silencio: 0, pular: 1024, usar: 0 });
  assert.deepEqual(planejarBloco(0, -24, 1024, 1e6), { silencio: 0, pular: 24, usar: 1000 });
});

test('planejarBloco: blocos seguidos e fim do vídeo', () => {
  assert.deepEqual(planejarBloco(1024, 1025, 1024, 1e6, 96), { silencio: 0, pular: 0, usar: 1024 });
  assert.deepEqual(planejarBloco(1024, 1023, 1024, 1e6, 96), { silencio: 0, pular: 0, usar: 1024 });
  assert.deepEqual(planejarBloco(1024, 5000, 1024, 1e6, 96), { silencio: 3976, pular: 0, usar: 1024 });
  assert.deepEqual(planejarBloco(900, 900, 1024, 1000), { silencio: 0, pular: 0, usar: 100 });
  assert.deepEqual(planejarBloco(900, 2000, 1024, 1000), { silencio: 100, pular: 0, usar: 0 });
  assert.deepEqual(planejarBloco(1000, 1000, 1024, 1000), { silencio: 0, pular: 1024, usar: 0 });
});

test('formata e lê o atraso', () => {
  assert.equal(formatarAtraso(2.345), '+2,345 s');
  assert.equal(formatarAtraso(-0.05), '−0,050 s');
  assert.equal(lerAtraso('+2,345 s'), 2.345);
  assert.equal(lerAtraso('−0,050'), -0.05);
  assert.equal(lerAtraso('-1:02.5'), -62.5);
  assert.equal(lerAtraso('abc'), null);
  assert.equal(formatarTempo(3723), '1:02:03');
  assert.equal(formatarTempo(62.34, 1), '1:02,3');
});
