// Leitura e escrita dos arquivos de mídia (com a biblioteca Mediabunny).
import {
  Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, StreamTarget, BufferTarget,
  EncodedPacketSink, EncodedVideoPacketSource, AudioSampleSink, AudioSampleSource, AudioSample,
  canEncodeAudio,
} from 'mediabunny';
import { Envelope, planejarBloco } from './nucleo.js';

const KBPS_AUDIO = 256;
let aacRegistrado = false;

function abrir(arquivo) {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(arquivo) });
}

function conferir(sinal) {
  if (sinal?.aborted) throw new DOMException('Cancelado', 'AbortError');
}

/**
 * Lê um arquivo e monta o envelope de volume do áudio dele.
 * Devolve { temVideo, temAudio, duracao, env, descricao, aviso }.
 */
export async function analisar(arquivo, { aoProgresso, sinal } = {}) {
  const input = abrir(arquivo);
  try {
    if (!(await input.canRead())) throw new Error('Não consegui ler esse arquivo. Ele é mesmo um vídeo ou áudio?');
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new Error('Esse arquivo não tem imagem nem som.');
    const duracao = await input.computeDuration();
    const partes = [];
    if (video) partes.push(`imagem ${video.codedWidth}×${video.codedHeight} (${video.codec || 'codec desconhecido'})`);
    if (audio) partes.push(`som ${audio.codec || 'desconhecido'}, ${Math.round(audio.sampleRate / 100) / 10} kHz`);
    const r = { temVideo: !!video, temAudio: !!audio, duracao, env: null, descricao: partes.join(' · '), aviso: null };
    if (!audio) return r;
    if (!(await audio.canDecode())) {
      r.aviso = `Este navegador não consegue abrir o som desse arquivo (${audio.codec || 'codec desconhecido'}), então ele fica sem onda.`;
      r.temAudio = false;
      return r;
    }
    const env = new Envelope();
    const fim = (await audio.computeDuration()) || duracao || 1;
    let buf = new Float32Array(8192);
    let ultimo = 0;
    for await (const s of new AudioSampleSink(audio).samples()) {
      conferir(sinal);
      const n = s.numberOfFrames;
      if (buf.length < n) buf = new Float32Array(n);
      s.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      env.adicionar(buf.subarray(0, n), s.sampleRate, s.timestamp);
      const agora = performance.now();
      if (aoProgresso && agora - ultimo > 100) { ultimo = agora; aoProgresso(Math.min(1, s.timestamp / fim)); }
      s.close();
    }
    r.env = env.concluir();
    return r;
  } finally {
    input.dispose();
  }
}

/**
 * Junta a imagem de um arquivo com o som de outro.
 * A imagem é copiada sem recodificar. O som é deslocado em `atraso` segundos
 * (positivo: o som entra depois) e gravado em AAC.
 * `gravavel`: FileSystemWritableFileStream, ou null pra montar na memória (devolve um Blob).
 */
export async function exportar({ imagem, som, atraso, gravavel, aoProgresso, sinal }) {
  const entradaImagem = abrir(imagem);
  const entradaSom = imagem === som ? entradaImagem : abrir(som);
  let saida = null;
  try {
    const trilhaVideo = await entradaImagem.getPrimaryVideoTrack();
    if (!trilhaVideo) throw new Error('O arquivo da imagem não tem vídeo.');
    const trilhaAudio = await entradaSom.getPrimaryAudioTrack();
    if (!trilhaAudio) throw new Error('O arquivo do som não tem áudio.');
    if (!(await trilhaAudio.canDecode())) throw new Error('Este navegador não consegue abrir o som desse arquivo.');

    const formato = new Mp4OutputFormat({ fastStart: false });
    if (!formato.getSupportedVideoCodecs().includes(trilhaVideo.codec)) {
      throw new Error(`O vídeo está em ${trilhaVideo.codec || 'um formato'} que não cabe num MP4 sem recodificar.`);
    }
    const taxa = trilhaAudio.sampleRate;
    const canais = trilhaAudio.numberOfChannels;
    const bitrate = KBPS_AUDIO * 1000;
    if (!aacRegistrado && !(await canEncodeAudio('aac', { numberOfChannels: canais, sampleRate: taxa, bitrate }))) {
      const { registerAacEncoder } = await import('/vendor/mediabunny-aac-encoder.mjs');
      registerAacEncoder();
      aacRegistrado = true;
    }

    const alvo = gravavel ? new StreamTarget(gravavel, { chunked: true, chunkSize: 8 * 1024 * 1024 }) : new BufferTarget();
    saida = new Output({ format: formato, target: alvo });
    const fonteVideo = new EncodedVideoPacketSource(trilhaVideo.codec);
    const fonteAudio = new AudioSampleSource({ codec: 'aac', bitrate });
    saida.addVideoTrack(fonteVideo, { rotation: trilhaVideo.rotation });
    saida.addAudioTrack(fonteAudio);
    await saida.start();

    const fimVideo = await trilhaVideo.computeDuration();
    const configuracao = await trilhaVideo.getDecoderConfig();

    const copiarImagem = async () => {
      let primeiro = true, ultimo = 0;
      for await (const pacote of new EncodedPacketSink(trilhaVideo).packets()) {
        conferir(sinal);
        await fonteVideo.add(pacote, primeiro ? { decoderConfig: configuracao } : undefined);
        primeiro = false;
        const agora = performance.now();
        if (aoProgresso && agora - ultimo > 150) { ultimo = agora; aoProgresso(Math.min(1, pacote.timestamp / (fimVideo || 1))); }
      }
      fonteVideo.close();
    };

    const gravarSom = async () => {
      const limite = Math.round(fimVideo * taxa);
      const tolerancia = Math.round(taxa * 0.002);
      let escritos = 0;
      const silencio = async (quadros) => {
        while (quadros > 0) {
          conferir(sinal);
          const n = Math.min(quadros, taxa);
          const s = new AudioSample({
            data: new Float32Array(n * canais), format: 'f32', numberOfChannels: canais, sampleRate: taxa, timestamp: escritos / taxa,
          });
          await fonteAudio.add(s);
          s.close();
          escritos += n;
          quadros -= n;
        }
      };
      // com atraso negativo, pula direto pra perto do ponto de corte
      const desde = Math.max(0, -atraso - 1);
      for await (const s of new AudioSampleSink(trilhaAudio).samples(desde)) {
        conferir(sinal);
        const inicio = Math.round((s.timestamp + atraso) * taxa);
        const plano = planejarBloco(escritos, inicio, s.numberOfFrames, limite, tolerancia);
        if (plano.silencio) await silencio(plano.silencio);
        if (plano.usar > 0) {
          const inteiro = plano.pular === 0 && plano.usar === s.numberOfFrames;
          const bloco = inteiro ? s : s.trim(plano.pular, plano.pular + plano.usar);
          bloco.setTimestamp(escritos / taxa);
          await fonteAudio.add(bloco);
          escritos += plano.usar;
          if (!inteiro) bloco.close();
        }
        s.close();
        if (escritos >= limite) break;
      }
      fonteAudio.close();
    };

    await Promise.all([copiarImagem(), gravarSom()]);
    conferir(sinal);
    await saida.finalize();
    aoProgresso?.(1);
    return gravavel ? null : new Blob([alvo.buffer], { type: 'video/mp4' });
  } catch (erro) {
    try { await saida?.cancel(); } catch {}
    throw erro;
  } finally {
    entradaImagem.dispose();
    if (entradaSom !== entradaImagem) entradaSom.dispose();
  }
}
