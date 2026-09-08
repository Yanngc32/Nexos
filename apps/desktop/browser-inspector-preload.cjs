const { ipcRenderer } = require("electron");
const { capturarElemento, gerarSeletor } = require("./inspector-selector.cjs");
const { criarOverlay } = require("./inspector-overlay.cjs");

/**
 * Preload do `<webview>` do painel Browser (main.cjs trava este caminho em
 * `will-attach-webview`, ignorando o que a página pedir).
 *
 * Roda DENTRO do preview do projeto do usuário, mas com acesso a Node/Electron só aqui —
 * a página em si segue sem `nodeIntegration`, do mesmo jeito que qualquer preload comum.
 * Implementa o "modo seleção": hover destaca o elemento sob o mouse com um overlay próprio
 * (não mexe no estilo do elemento real); clique marca um badge numerado nele e manda os
 * dados capturados pro host via `sendToHost` — quem decide o que fazer com isso (acumular,
 * montar a mensagem) é `renderer.js`, não este arquivo.
 *
 * Nomes de canal aqui são literais, não `import` de `inspector-protocolo.js`: este arquivo
 * é CommonJS e roda num processo/contexto separado do resto do desktop (ESM). Mudou um nome
 * lá, espelha aqui.
 */

let ligado = false;
const overlay = criarOverlay();

/** Elemento sob o mouse é sempre resolvido por coordenada — clique usa a mesma fonte que o
 * hover (senão os dois divergem sob overlay/shadow DOM e o badge marca algo diferente do
 * que a pessoa viu destacado). */
function elementoSobMouse(e) {
  return document.elementFromPoint(e.clientX, e.clientY);
}

function onMouseMove(e) {
  const el = elementoSobMouse(e);
  // pointer-events:none já tira o overlay do hit-test, mas um elemento já selecionado (com
  // badge por cima) também não precisa do destaque de hover — o badge já marca ele
  if (!el || overlay.estaMarcado(el)) {
    overlay.esconderHover();
    return;
  }
  overlay.mostrarHover(el, { etiqueta: gerarSeletor(el) });
}

/** Mouse saiu da janela do preview: sem isso o realce do último elemento hovered trava na tela. */
function onMouseOut(e) {
  if (e.relatedTarget) return;
  overlay.esconderHover();
}

function onClick(e) {
  const el = elementoSobMouse(e);
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const indice = overlay.marcar(el);
  // clicar de novo no que já está selecionado não pode duplicar badge nem mandar de novo
  if (indice === null) return;
  // x/y são coordenadas do viewport do preview (não da página host) — o host traduz pra sua
  // própria tela somando o retângulo do `<webview>`, e usa só a do 1º clique da sessão pra
  // abrir a caixa flutuante perto de onde a pessoa clicou.
  ipcRenderer.sendToHost("nexo-inspector:selecionado", { ...capturarElemento(el), x: e.clientX, y: e.clientY });
}

/**
 * `click` sozinho não basta: carousel/menu/drag do preview reage a pointerdown/mousedown/
 * mouseup antes do click disparar, e a página navega ou arrasta em vez de só selecionar.
 * Bloqueia tudo em captura; só `onClick` faz alguma coisa com o evento.
 */
function bloqueiaEvento(e) {
  e.preventDefault();
  e.stopPropagation();
}

function onScrollOuResize() {
  overlay.reposicionarBadges();
}

function onKeyDown(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  // desliga local imediatamente — não espera o host confirmar. Se o IPC de aviso se
  // perder, o modo já saiu sozinho e não fica comendo clique pra sempre.
  desliga();
  ipcRenderer.sendToHost("nexo-inspector:esc");
}

let estiloCursor = null;

function ligaCursor() {
  estiloCursor = document.createElement("style");
  estiloCursor.textContent = "*{cursor:crosshair!important;}";
  document.documentElement.appendChild(estiloCursor);
}

function desligaCursor() {
  estiloCursor?.remove();
  estiloCursor = null;
}

function liga() {
  if (ligado) return;
  ligado = true;
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", bloqueiaEvento, true);
  document.addEventListener("mousedown", bloqueiaEvento, true);
  document.addEventListener("mouseup", bloqueiaEvento, true);
  document.addEventListener("contextmenu", bloqueiaEvento, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", onScrollOuResize, true);
  window.addEventListener("resize", onScrollOuResize);
  ligaCursor();
  // confirma o handshake só depois dos listeners estarem de pé — é isto que autoriza o
  // host a acender o botão como "pressionado"
  ipcRenderer.sendToHost("nexo-inspector:pronto");
}

function desliga() {
  if (!ligado) return;
  ligado = false;
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("mouseout", onMouseOut, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("pointerdown", bloqueiaEvento, true);
  document.removeEventListener("mousedown", bloqueiaEvento, true);
  document.removeEventListener("mouseup", bloqueiaEvento, true);
  document.removeEventListener("contextmenu", bloqueiaEvento, true);
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("scroll", onScrollOuResize, true);
  window.removeEventListener("resize", onScrollOuResize);
  desligaCursor();
  overlay.esconderHover();
  overlay.limpar();
}

ipcRenderer.on("nexo-inspector:toggle", (_e, on) => {
  if (on) liga();
  else desliga();
});

ipcRenderer.on("nexo-inspector:desmarcar", (_e, indice1based) => {
  overlay.desmarcar(indice1based);
});

ipcRenderer.on("nexo-inspector:realcar", (_e, indice1based) => {
  overlay.realcar(indice1based);
});
