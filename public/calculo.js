// Worker: faz a comparação das ondas fora da tela, pra página não travar.
import { sugerirDiferenca } from './nucleo.js';
self.onmessage = (e) => {
  try {
    self.postMessage({ ok: true, ...sugerirDiferenca(e.data.a, e.data.b) });
  } catch (erro) {
    self.postMessage({ ok: false, erro: String(erro?.message || erro) });
  }
};
