# Nexo — inspector de elemento no painel Browser (design)

Data: 2026-09-08
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

O painel Browser do Nexo (`apps/desktop`) é hoje um `<iframe id="browser-frame">` que só carrega uma URL (`state.browserUrl`, via `setBrowserUrl()`/`safeUrl()` em `url.js`). Pra pedir uma mudança de UI, a pessoa precisa descrever o elemento em texto puro ("o botão azul no topo direito") — impreciso, e o agente (que não vê a tela) tem pouco pra se guiar.

O usuário quer um modo de seleção de elemento estilo "inspect"/"select" (como o Cursor): passar o mouse destaca o elemento sob o cursor, clicar seleciona ele com precisão de DOM, e uma caixa secundária acumula os elementos escolhidos até a pessoa escrever o pedido e mandar — virando uma mensagem de chat normal, que o agente lê e localiza no código.

## Objetivo

1. Alternar um "modo seleção" dentro do preview do PRÓPRIO projeto (localhost) que a pessoa já tem aberto no painel Browser.
2. Hover destaca o elemento sob o mouse; clique seleciona (previne o comportamento default do elemento — link, submit).
3. Seleção acumula: vários elementos, numerados, antes de escrever o pedido.
4. Escrever o pedido e mandar gera UMA mensagem de chat (lista dos elementos + texto) pelo caminho normal de envio (`sendChatMessage`), com os mesmos direitos que qualquer mensagem digitada à mão — incluindo `@menção`.
5. Fechar o painel ou `Esc` cancela sem mandar nada.

## Fora do escopo

- Site de terceiro no preview (só o preview do projeto do próprio usuário, servido em localhost).
- Identificar o arquivo/componente fonte (React DevTools fiber, source maps por framework) — cada framework exigiria integração própria e quebra fácil entre versões. O agente localiza pelo `outerHTML`/seletor/texto que a mensagem carrega, do jeito que uma pessoa faria com grep.
- Anotação persistente sem enviar — toda seleção vira mensagem de chat ou é descartada; não fica salva em lugar nenhum entre sessões.
- Edição do elemento pelo próprio inspector (mover, redimensionar, trocar estilo direto no preview) — só seleciona e descreve; quem edita é o agente, no código.

## Por que `<iframe>` não serve mais

O `<iframe>` carrega `http://127.0.0.1:<porta>`, origem diferente da do próprio Nexo (`file://`, carregado via `win.loadFile` em `main.cjs`). Same-Origin Policy do Chromium bloqueia o Nexo de ler/escrever o DOM de dentro desse iframe a partir do renderer — mesmo sendo tudo na mesma máquina, a política não faz exceção por "confiança", só por origem.

A saída correta no Electron é a tag `<webview>`: um elemento especial cujo conteúdo roda em `WebContents` própria, mas que o app host pode controlar via API do Electron (`executeJavaScript`, `send`/`ipc-message`) **independente da origem carregada dentro** — não é um furo de SOP, é o mecanismo pensado pra isso. A alternativa de desligar `webSecurity` da janela foi descartada: afetaria a janela inteira, não só o preview, e permaneceria assim pra qualquer coisa carregada nela no futuro.

## Arquitetura

### 1. `<webview>` no lugar do `<iframe>`

- `apps/desktop/main.cjs`: `webviewTag: true` nas `webPreferences` da `BrowserWindow` principal (`createWindow`). Não entra no painel flutuante (`createWidget`) — ele não tem Browser.
- `apps/desktop/index.html`: `<iframe id="browser-frame" ...>` vira `<webview id="browser-frame" src="about:blank" preload="browser-inspector-preload.cjs">`. Mesmo id, então `setBrowserUrl()`/`reiniciarBrowser()` (que fazem `frame.src = href`) continuam funcionando sem mudança — `<webview>` também tem `.src`.

### 2. Preload dedicado do webview

Novo `apps/desktop/browser-inspector-preload.cjs` — roda dentro do `<webview>`, com acesso a `electron` (preload sempre tem), mas a PÁGINA carregada dentro (o projeto do usuário) continua sem `nodeIntegration` nenhuma: só o preload enxerga Node/Electron, exatamente como o `preload.cjs` principal já faz pra `index.html`.

Responsabilidades do preload:

- Escuta `ipcRenderer.on("nexo-inspector:toggle", (_e, on) => ...)` — liga/desliga os listeners de `mousemove`/`click` no `document` da página.
- **Hover**: `mousemove` acha o elemento sob o cursor (`document.elementFromPoint`) e posiciona um `<div>` overlay próprio (criado pelo preload, `position: fixed`, `pointer-events: none`, z-index alto) sobre o `getBoundingClientRect()` dele — não toca no `style`/layout do elemento real.
- **Clique**: fase de captura, `preventDefault()` + `stopPropagation()` (não deixa o link navegar nem o form submeter). Monta um objeto:
  - `seletor`: gerado subindo do elemento até ~4 ancestrais — usa `#id` se tiver, senão até 2 classes estáveis (ignora classes que parecem geradas, tipo hash do CSS-in-JS), senão `nth-child`. Não precisa ser globalmente único: é contexto pro agente, não uma query de verdade.
  - `outerHTML` truncado: só a tag de abertura + até ~300 caracteres do conteúdo (não serializa a subárvore inteira — um `<div>` container gigante não pode virar um payload enorme).
  - `texto`: `element.textContent` truncado a ~150 caracteres.
  - Desenha um segundo overlay fixo, numerado (badge), que fica GRUDADO no elemento selecionado (reposiciona em `scroll`/`resize` enquanto o modo estiver ligado).
  - Manda pro host: `ipcRenderer.sendToHost("nexo-inspector:selecionado", dados)`.

### 3. Host (`renderer.js`)

- Botão novo na toolbar do Browser (`#browser-form`, ao lado de reload/limpar cache): liga/desliga o modo. Ligar chama `frame.send("nexo-inspector:toggle", true)`.
- `frame.addEventListener("ipc-message", (e) => { if (e.channel === "nexo-inspector:selecionado") ... })`: empilha em `state.inspector.selecionados` (lista) e re-renderiza a caixa secundária.
- Caixa secundária: painel lateral dentro do `.browser-stage` (não modal) — lista numerada dos elementos (tag+seletor+texto resumido) e uma textarea livre + botões "Mandar"/"Descartar". Só aparece quando há pelo menos 1 elemento selecionado.
- "Mandar": monta o texto —
  ```
  Nestes elementos do preview:
  1. button.btn-cta — "Comprar agora"
     <button class="btn-cta" ...>Comprar agora</button>
  2. h1.hero-title — "Bem-vindo"
     <h1 class="hero-title" ...>Bem-vindo</h1>

  Pedido: <o que a pessoa escreveu>
  ```
  e chama `sendChatMessage(texto)` — o mesmo caminho de qualquer mensagem do composer (fila, `@menção`, tudo herdado sem código novo). Depois, desliga o modo seleção, limpa `state.inspector`, remove os overlays (`frame.send("nexo-inspector:toggle", false)`).
- "Descartar", fechar o painel Browser (`btn-close-browser`), ou `Esc`: mesma limpeza, sem chamar `sendChatMessage`.

### 4. Ajuste no tratamento de falha de carregamento

Hoje, `main.cjs` escuta `did-fail-load` no `webContents` da janela principal (pega falha de qualquer subframe, incluindo o `<iframe>` antigo) e repassa pro renderer via `frame:fail` (ver `apps/desktop/renderer.js` perto de `window.nexo.onFrameFail`). Um `<webview>` é uma `WebContents` própria, separada — esse listener não dispara mais pra ele.

Fix: em `main.cjs`, escutar `win.webContents.on("did-attach-webview", (_e, webContents) => { webContents.on("did-fail-load", ...) })` e mandar o mesmo evento `frame:fail` de antes. Sem isso, a troca de tag regrediria silenciosamente a mensagem amigável de "preview não carregou" que já existe.

## Segurança

- O preload do webview só roda dentro do preview de um projeto que a própria pessoa abriu no Nexo — mesmo escopo de confiança que já existe pra rodar `npm run dev` desse projeto.
- A página carregada dentro do `<webview>` continua SEM `nodeIntegration`: o preload expõe só os dois canais IPC acima (`nexo-inspector:toggle` entrando, `nexo-inspector:selecionado` saindo) — nenhuma superfície nova de execução de código.
- `outerHTML`/seletor capturados vão para o MESMO caminho que qualquer texto de mensagem já passa (`POST /v1/threads/.../messages`) — nenhum novo canal de rede, nenhum novo trust boundary além do preload em si.

## Testes

- `browser-inspector-preload.cjs`: função pura de geração de seletor (dado um elemento mock/JSDOM, sobe até id/classes/nth-child esperado) e de truncamento de `outerHTML`/texto — testável fora do Electron.
- `renderer.js`: acumulação de `state.inspector.selecionados` a partir de eventos `ipc-message` simulados; texto final montado por "Mandar"; limpeza ao descartar/fechar/Esc.
- Manual (não automatizável neste ambiente — Electron com GUI nativa): abrir um preview local de verdade, ligar o modo, conferir hover/clique/badge numerado, mandar e ver a mensagem chegar formatada na conversa.
