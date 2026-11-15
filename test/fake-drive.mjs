// Google Drive de mentira pros testes.
// id "grande...": mostra o aviso de vírus antes; "privado...": pede login; "cota...": limite de acessos.
import http from 'node:http';
import fs from 'node:fs';

export function subirDriveFalso(porta, arquivo, nome = 'culto câmera.mp4') {
  const servidor = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id') || '';
    const html = (corpo, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(corpo); };
    if (u.pathname !== '/download') return html('nada', 404);
    if (id.startsWith('privado')) return html('<a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
    if (id.startsWith('cota')) return html('Sorry, you can\'t view or download this file at this time. Too many users have viewed or downloaded this file recently.');
    if (id.startsWith('sumiu')) return html('Not found', 404);
    if (id.startsWith('grande') && u.searchParams.get('uuid') !== 'abc-123') {
      return html(`<form id="download-form" action="/download" method="get">
        <input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form>`);
    }
    const dados = arquivo ? fs.readFileSync(arquivo) : Buffer.from('ARQUIVO-DO-DRIVE');
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Content-Length': dados.length,
      'Content-Disposition': `attachment; filename="x.mp4"; filename*=UTF-8''${encodeURIComponent(nome)}`,
    });
    res.end(dados);
  });
  return new Promise((ok) => servidor.listen(porta, '127.0.0.1', () => ok(servidor)));
}
