# Sincronizador de áudio e vídeo de pregações — Design

Data: 2026-11-15

## Intenção e porquê

O Matheus e mais uma pessoa da equipe de mídia publicam pregações. A imagem boa vem
de um lado e o som bom do outro:

- **Drive → YouTube**: a imagem vem do arquivo exportado do Google Drive (gravação da
  câmera), e o som vem da transmissão do YouTube (som limpo da mesa).
- **YouTube → Drive**: a imagem vem do YouTube, e o som vem do arquivo do Drive.

Hoje não existe ferramenta pra isso. Eles querem um **site publicado** (não um programa
local) onde colam o link do YouTube, escolhem o arquivo do Drive, veem as formas de onda
dos dois, ajustam o atraso (segundos e milissegundos) e baixam um arquivo final **com a
mesma qualidade** da imagem original.

## Objetivos

1. Colar um link do YouTube e o servidor buscar o áudio (Drive → YouTube) ou o vídeo
   (YouTube → Drive).
2. Escolher um arquivo local (exportado do Drive), que pode ser vídeo ou áudio.
3. Escolher a direção: de onde vem a imagem. O som vem sempre do outro lado.
4. Mostrar as duas formas de onda, uma em cima da outra, alinhadas pelo atraso atual.
5. Sugerir o atraso automaticamente (correlação cruzada das ondas), quando os dois
   lados tiverem som.
6. Ajuste manual do atraso: arrastar a onda, botões ±1 s / ±100 ms / ±10 ms / ±1 ms,
   e um campo numérico (`+2,345 s`). O atraso pode ser positivo ou negativo.
7. Prévia: tocar a imagem com o som deslocado a partir de qualquer ponto, pra conferir
   no olho e no ouvido (por exemplo, a boca do pregador).
8. Baixar um MP4 com a **imagem copiada sem recodificar** e o som deslocado.
9. Senha compartilhada (duas pessoas).
10. Deploy no Render de outra conta: o repositório sai com `render.yaml`, `Dockerfile`
    e um README com o passo a passo, pra eles publicarem sozinhos.

## Fora do escopo

- Login no Google Drive ou na API do Drive: o arquivo é baixado e escolhido à mão.
- Cortar trechos, editar, colocar legenda, mixar os dois áudios ou ajustar volume.
- Contas de usuário, histórico ou guardar arquivos no servidor.
- Celular: o uso é em Chrome ou Edge de computador.
- Corrigir "drift" (um lado mais rápido que o outro ao longo do tempo). Só tem um atraso
  fixo. *(minha decisão: se aparecer drift na prática, vira uma etapa futura)*

## O que seria um fracasso

- Recodificar a imagem (perde qualidade e demora). A imagem é **sempre** copiada pacote
  a pacote.
- Mandar o arquivo grande do Drive (que pode ter vários GB) pro servidor. Ele nunca sai
  do computador.
- Travar ou estourar a memória do navegador com pregações de 1 a 2 horas.
- Ficar aberto pra qualquer pessoa usar o servidor de download do YouTube.

## Restrições

- Pregações têm 1 a 2 horas. O vídeo pode passar de 2 a 6 GB.
- O YouTube bloqueia IPs de nuvem às vezes ("confirme que você não é um robô").
- Hospedagem: Render, num serviço web Docker, numa conta do Matheus que não é a desta
  sessão. Nada de deploy automático daqui.
- O código vive num repositório próprio, separado do `mesversario` (o Wrapped).

## Abordagens consideradas

| | Abordagem | Trade-off |
|---|---|---|
| **A** ✅ escolhida | Servidor pequeno só pro YouTube; ondas, prévia e montagem do MP4 no navegador | Arquivo grande fica local, servidor barato. A montagem depende da File System Access API (Chrome/Edge). |
| B | Tudo no servidor (upload do arquivo do Drive + ffmpeg) | Código mais simples, mas sobe e desce GB a cada pregação, e precisa de servidor com disco e memória maiores. |
| C | Site + ajudante local pro YouTube | Download mais confiável (IP de casa), mas depende de um programa rodando no PC. Foi pedido que não fosse só local. |
| — | Vercel | Descartado: limite de tempo e tamanho das funções, e os IPs da AWS são mais bloqueados pelo YouTube. Eles escolheram fazer **tudo no Render**. |

## Como funciona (decidido)

### Servidor (Render, Docker)
*(stack: minha decisão)* Node 20 + Express, com a imagem Docker já trazendo `ffmpeg` e
`yt-dlp` (versão mais recente instalada no build, já que o yt-dlp quebra quando o
YouTube muda).

- **Serve o site estático** (`public/`).
- **Senha**: variável de ambiente `SENHA`. `POST /api/login` grava um cookie assinado
  (HttpOnly, 30 dias). Todas as rotas `/api/*` (exceto o login) exigem esse cookie.
  Se `SENHA` não estiver definida, o servidor recusa subir.
- **`GET /api/youtube/info?url=`**: título, duração e formatos disponíveis (yt-dlp `-J`).
- **`GET /api/youtube/baixar?url=&tipo=audio|video`**: roda o yt-dlp com saída no
  stdout (`-o -`) e faz *stream* direto pra resposta, sem gravar em disco.
  - `audio`: `bestaudio[ext=m4a]/bestaudio` (AAC preferido, Opus aceito).
  - `video`: o melhor formato **só de vídeo** que caiba em MP4
    (`bestvideo[ext=mp4]/bestvideo`), sem juntar áudio.
  - Manda `Content-Length` quando o yt-dlp informa o tamanho, pra mostrar o progresso.
  - Se o cliente cancelar, mata o processo do yt-dlp.
- **Cookies do YouTube** (contra bloqueio): variável opcional `YT_COOKIES`, com o
  conteúdo do `cookies.txt` (formato Netscape). Ela é gravada num arquivo temporário e
  passada com `--cookies`. O README explica como exportar.
- Erros do yt-dlp viram mensagens claras em português ("O YouTube bloqueou o servidor.
  Atualize os cookies ou envie o arquivo à mão.").
- `GET /healthz` pro Render.

### Navegador
*(stack: minha decisão)* HTML + CSS + JS puro (sem build), no mesmo espírito do
`mesversario`, mais a biblioteca **Mediabunny** (via CDN, versão fixa) pra ler e
escrever MP4/MOV/WebM/MKV/MP3/WAV/M4A sem recodificar.

1. **Entrada**
   - Link do YouTube → baixa com progresso. O resultado fica em memória como `Blob`
     (áudio de 1 h ≈ 60 MB). Se for vídeo, é gravado num arquivo temporário via OPFS,
     pra não estourar a memória.
   - Plano B: botão "Enviar arquivo do YouTube à mão", caso o servidor seja bloqueado.
   - Arquivo do Drive: `<input type=file>`. O arquivo é lido direto do disco (`File`),
     nunca carregado inteiro.
   - Direção: "Imagem de: Drive / YouTube". O som vem do outro.
2. **Ondas**
   - Decodifica o áudio dos dois lados em fluxo (Mediabunny `AudioSampleSink`), soma em
     mono e guarda só um envelope de energia (RMS) em ~100 Hz, mais os picos pro
     desenho. Uma pregação de 2 h vira cerca de 720 mil números por lado.
   - Desenho em `<canvas>`: as duas ondas empilhadas, com zoom (da pregação inteira até
     ~1 s na tela) e rolagem. A onda de baixo se move com o atraso.
   - Se o lado da imagem não tiver faixa de áudio, só mostra a onda do som e avisa
     que o alinhamento vai ser manual.
3. **Atraso automático**
   - Correlação cruzada por FFT dos envelopes, procurando dentro de ±5 min *(minha
     decisão)* em vários trechos (ex.: 3 janelas de 2 min espalhadas pela pregação). O
     resultado é a mediana.
   - Depois um refinamento em ±50 ms com áudio de 8 kHz no trecho de melhor
     correlação, pra chegar ao milissegundo.
   - Mostra a confiança (alta, média ou baixa). Se for baixa, pede ajuste manual.
4. **Ajuste manual**: arrastar a onda, botões ±1 s / ±100 ms / ±10 ms / ±1 ms, campo
   numérico e atalhos de teclado (← → com Shift/Alt pra mudar o passo).
5. **Prévia**: um `<video>` mudo da fonte de imagem e um `<audio>` da fonte de som,
   tocados juntos com o atraso aplicado e ressincronizados a cada ~0,5 s se derivarem
   mais de 30 ms. Botões "tocar daqui" (posição clicada na onda) e "voltar 5 s".
   - Se o navegador não conseguir tocar o formato direto (ex.: MKV), a prévia usa
     só o som com a onda andando e avisa disso.
6. **Exportar**
   - `showSaveFilePicker` → Mediabunny `Output` com `Mp4OutputFormat`
     (`fastStart: false`, escrevendo em fluxo direto no arquivo escolhido).
   - **Vídeo**: pacotes copiados sem recodificar (`EncodedPacketSink` → `EncodedVideoPacketSource`).
   - **Áudio**: copiado se o codec couber no MP4 (AAC, Opus, MP3). Se não couber
     (ex.: PCM de WAV), é recodificado em AAC 256 kbps.
   - **Atraso positivo** (o som começa depois): os pacotes de áudio recebem
     `timestamp + atraso`, e o início fica em silêncio (sem pacotes).
     **Atraso negativo**: os pacotes antes do corte são descartados e os seguintes
     recebem `timestamp − |atraso|`. Se o corte cair no meio de um pacote, ele é
     descartado inteiro (erro < 1 frame de áudio, ~21 ms no AAC). *(minha decisão: se
     for preciso precisão de ms no corte negativo, recodificar só o áudio)*
   - A duração final é a do **vídeo**. O áudio que passar do fim é cortado.
   - Barra de progresso e cancelar. No fim, aparece "Pronto: <nome>.mp4".
   - Nome sugerido: `<nome do arquivo de imagem>-sincronizado.mp4`.
7. Tudo vale para os dois sentidos: a lógica é "fonte de imagem" + "fonte de som", e a
   direção só troca quem é quem.

### Deploy ("deixa tudo no esquema")
- `Dockerfile` (node:20-slim + ffmpeg + yt-dlp via pip ou binário oficial).
- `render.yaml` (Blueprint): 1 web service Docker, `healthCheckPath: /healthz`,
  variáveis `SENHA` (sync: false, preenchida no painel), `SEGREDO_COOKIE`
  (generateValue) e `YT_COOKIES` (opcional). Plano sugerido: **Starter** (o Free dorme
  e tem 512 MB, o que pode falhar com vídeo longo). O README diz que o Free serve pra
  testar.
- README em português: criar o repositório, conectar no Render (New → Blueprint),
  definir a senha, como exportar os cookies do YouTube e como atualizar o yt-dlp
  (Manual Deploy → Clear build cache & deploy).

### Testes *(minha decisão)*
- Servidor: testes da senha e da rota de download com o yt-dlp falso (mock).
- Navegador: funções puras testadas com Node (correlação, deslocamento de timestamps,
  conversão de ms). Teste ponta a ponta com Playwright e arquivos curtos gerados pelo
  ffmpeg: um vídeo com bip e o mesmo bip atrasado 2,345 s → a sugestão automática
  acerta ±5 ms, e o MP4 exportado tem o vídeo bit a bit igual (hash dos pacotes) e o
  áudio deslocado.

## Deixado pro builder
- Estrutura de pastas, nomes de arquivo e detalhes visuais (paleta escura simples e
  legível).
- Ajuste fino dos parâmetros da correlação (janelas, faixa, taxa do envelope).
- Mensagens e textos da interface, em português.

## Em aberto (com o Matheus)
- **Onde fica o código**: esta sessão só consegue escrever no repositório `mesversario`.
  Opções: (a) ele cria um repositório novo e adiciona aqui, ou (b) eu construo numa
  pasta `sincronizador/` num branch e ele copia pro repositório dele.

## Correções depois da revisão (valem sobre o texto acima; minhas decisões)
- **Node 22 LTS** em vez de Node 20.
- **yt-dlp precisa de um runtime JavaScript**: instalar `yt-dlp[default]` (traz o
  `yt-dlp-ejs`) e o Deno na imagem. Conferir na hora do build o que a versão atual
  exige.
- **`Content-Length`** só é enviado quando o tamanho exato vem do `-J` (`filesize`). Se
  não vier, o progresso mostra só os MB baixados. O tamanho aproximado vai num
  cabeçalho separado (`X-Tamanho-Aproximado`).
- **Planos do Render**: Free e Starter têm os dois 512 MB. O motivo pra usar o Starter
  é que o Free dorme e tem limite de banda. No sentido YouTube → Drive, cada pregação
  gasta de 2 a 6 GB de banda de saída. O README avisa disso.
- **Tempo máximo de resposta do Render**: conferir o limite do proxy pra respostas
  longas. Se um download de vídeo de vários GB não couber numa resposta só, o cliente
  baixa em pedaços (`Range`), com o servidor guardando o arquivo em disco temporário.
- **Codificador AAC**: nem todo Chrome tem AAC no WebCodecs. Usar o
  `@mediabunny/aac-encoder` como reserva.
- **Plano B do YouTube** (enviar o arquivo à mão) tem o mesmo destaque que o link na
  tela, sem ficar escondido.

## Como ficou na construção
- **Som sempre em AAC 256 kbps**, com silêncio de verdade no começo (atraso positivo)
  ou corte exato na amostra (atraso negativo). Não depende de "edit list" do MP4, então
  toca igual em qualquer player. Só a imagem é copiada sem recodificar.
- **Servidor sem dependências** (só `node:http`), em vez de Express.
- **Mediabunny servido pelo próprio servidor** (`/vendor/`), e não por CDN.
- A busca automática do atraso compara a **pregação inteira** (sem o limite de ±5 min),
  porque a transmissão pode começar muito antes da câmera.
- O servidor **nunca manda `Content-Length`** no download. O tamanho pro progresso vem
  da rota de informações.
- Os cookies do YouTube entram por **Secret File** do Render (`cookies.txt`) ou pela
  variável `YT_COOKIES`.
- Código no repositório próprio `sincronizador` (começou numa pasta do `mesversario`).
