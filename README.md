# Sincronizador de pregações

Site pra juntar a **imagem** de uma fonte com o **som** de outra. São duas fontes, e
cada uma pode ser um **link do YouTube**, um **link público do Google Drive** ou um
**arquivo** do seu computador. Você escolhe qual das duas dá a imagem, e o som vem da outra.

Ele mostra as duas ondas de volume, sugere o atraso sozinho, deixa ajustar à mão
(arrastando, ou em passos de 1 s, 100 ms, 10 ms e 1 ms) e monta um MP4 novo.

## Como a qualidade é mantida

- A **imagem é copiada sem recodificar**: sai idêntica à original, bit a bit.
- O **som** é gravado em AAC 256 kbps já com o atraso aplicado (silêncio de verdade no
  começo, ou corte, conforme o caso). Assim o arquivo toca certo em qualquer player e
  pode subir pro YouTube sem perder a sincronia.
- Com link do Drive, o servidor busca o arquivo e repassa pro navegador, que guarda
  numa pasta temporária. Nada fica gravado no servidor.
- Os arquivos que você escolhe **nunca saem do seu computador**: tudo é feito no navegador. O
  servidor só baixa do YouTube.

## Como usar

1. Abra o site no **Chrome ou Edge do computador** e entre com a senha.
2. Em cada fonte, cole um link do YouTube ou do Drive e clique em **Buscar**, ou
   escolha um arquivo. O arquivo do Drive precisa estar compartilhado como
   "Qualquer pessoa com o link".
3. Escolha de qual fonte vem a imagem.
4. Confira a sugestão de atraso na prévia. Marque "Ouvir junto o som original" pra
   ouvir os dois sons ao mesmo tempo: se tiver eco, ainda não está no ponto.
5. Clique em **Baixar MP4 sincronizado** e escolha onde salvar.

## Publicar no Render

O código precisa estar num repositório do GitHub na conta que o Render enxerga.

**Jeito 1: repositório próprio (recomendado)**

1. Crie um repositório novo e coloque nele o conteúdo desta pasta (com o
   `render.yaml` na raiz).
2. No Render: **New → Blueprint**, escolha o repositório e confirme.
3. Quando ele pedir, preencha a variável **`SENHA`** com a senha que vocês vão usar.
4. Espere o deploy terminar e abra o endereço `https://….onrender.com`.

**Jeito 2: direto da pasta `sincronizador/` de outro repositório**

1. No Render: **New → Web Service**, escolha o repositório.
2. Em **Root Directory** coloque `sincronizador`. Em **Language** escolha **Docker**.
3. Em **Health Check Path** coloque `/healthz`.
4. Em **Environment Variables**, crie `SENHA` (a senha) e `SEGREDO_COOKIE` (qualquer
   texto longo e aleatório).

### Plano

- O `render.yaml` usa o plano **Free**, que não pede cartão. Ele dorme depois de
  15 minutos parado (a primeira abertura demora cerca de 1 minuto) e tem menos banda.
- Quando a imagem vem de um link (do YouTube ou do Drive), o vídeo inteiro passa pelo servidor (2 a 6 GB por
  pregação). Isso conta na banda de saída do plano. Se o Free não der conta, troque
  `plan: free` por `plan: starter` (pago) no `render.yaml`.

### Se o YouTube bloquear o servidor

O YouTube às vezes recusa servidores na nuvem ("confirme que você não é um robô"), e
vídeos privados sempre pedem login. Nos dois casos o site avisa. Há duas saídas:

- **Na hora**: baixe o áudio ou o vídeo do YouTube por fora e escolha o arquivo na
  fonte, no lugar do link.
- **De vez**: dê ao servidor os cookies de uma conta do YouTube.
  1. No Chrome, numa **janela anônima**, entre no YouTube com a conta.
  2. Exporte os cookies de `youtube.com` em formato `cookies.txt` (Netscape), com uma
     extensão como "Get cookies.txt LOCALLY". Feche a janela anônima sem sair da conta.
  3. No Render, abra o serviço → **Environment → Secret Files → Add Secret File**, com
     o nome `cookies.txt` e o conteúdo do arquivo. Salve e deixe o serviço reiniciar.

  Use uma conta secundária: esses cookies dão acesso a ela, e o YouTube pode
  restringir contas usadas assim.

### Se o link do Drive não funcionar

- **"Não está público"**: no Drive, abra Compartilhar e troque o acesso geral pra
  "Qualquer pessoa com o link".
- **"Excesso de acessos"**: o Google limita downloads automáticos de arquivos muito
  baixados. Tente mais tarde, ou baixe o arquivo e escolha ele na fonte.

### Se o download do YouTube parar de funcionar

O YouTube muda sempre e o `yt-dlp` precisa acompanhar. No Render, use **Manual
Deploy → Clear build cache & deploy**: isso reinstala a versão mais nova.

## Rodar no seu computador

Precisa de Node 22+, `yt-dlp` e `ffmpeg` instalados.

```
npm install
SENHA=minhasenha npm start     # abre em http://localhost:3000
npm test                       # testes do cálculo e do servidor
npm run test:e2e               # teste completo no navegador (precisa do Playwright e do ffmpeg)
```

## Limites

- Chrome ou Edge no computador. Em outros navegadores, só arquivos pequenos.
- Um atraso fixo pra pregação inteira. Se um dos lados "escorregar" ao longo do
  tempo, não é corrigido.
- A prévia tem precisão de uns 30 a 50 ms. O arquivo exportado é exato.
- Use só com vídeos que são seus ou que você tem permissão de baixar.
