const { ipcRenderer } = require("electron");
const { capturarElemento } = require("./inspector-selector.cjs");

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
 */

let ligado = false;
let overlayHover = null;
let badges = [];
let contador = 0;

function aplicaEstilo(el, extra) {
  Object.assign(el.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxSizing: "border-box",
    margin: "0",
    padding: "0",
    display: "none",
    ...extra,
  });
}

function garanteOverlayHover() {
  if (overlayHover && overlayHover.isConnected) return overlayHover;
  overlayHover = document.createElement("div");
  aplicaEstilo(overlayHover, { border: "2px solid #4f9dff", background: "rgba(79,157,255,.12)" });
  document.documentElement.appendChild(overlayHover);
  return overlayHover;
}

function posicionaSobre(el, caixa) {
  const r = el.getBoundingClientRect();
  Object.assign(caixa.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "block" });
}

function onMouseMove(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // pointer-events:none já tira o overlay do hit-test, mas um elemento já selecionado (com
  // badge por cima) também não precisa do destaque de hover — o badge já marca ele
  if (!el || badges.some((b) => b.el === el)) return;
  posicionaSobre(el, garanteOverlayHover());
}

function novoBadge(el) {
  contador += 1;
  const badge = document.createElement("div");
  aplicaEstilo(badge, { border: "2px solid #ff7a4f", background: "rgba(255,122,79,.10)" });
  const numero = document.createElement("span");
  Object.assign(numero.style, {
    position: "absolute",
    top: "-10px",
    left: "-10px",
    background: "#ff7a4f",
    color: "#fff",
    borderRadius: "999px",
    minWidth: "18px",
    height: "18px",
    fontSize: "11px",
    lineHeight: "18px",
    textAlign: "center",
    fontFamily: "system-ui, sans-serif",
  });
  numero.textContent = String(contador);
  badge.appendChild(numero);
  document.documentElement.appendChild(badge);
  posicionaSobre(el, badge);
  return { el, badge };
}

function reposicionaBadges() {
  for (const b of badges) posicionaSobre(b.el, b.badge);
}

function onClick(e) {
  const el = e.target;
  if (!el || el === overlayHover) return;
  e.preventDefault();
  e.stopPropagation();
  // clicar de novo no que já está selecionado não pode duplicar badge nem mandar de novo
  if (badges.some((b) => b.el === el)) return;
  badges.push(novoBadge(el));
  ipcRenderer.sendToHost("nexo-inspector:selecionado", capturarElemento(el));
}

function limpaBadges() {
  for (const b of badges) b.badge.remove();
  badges = [];
  contador = 0;
}

function liga() {
  if (ligado) return;
  ligado = true;
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("scroll", reposicionaBadges, true);
  window.addEventListener("resize", reposicionaBadges);
}

function desliga() {
  if (!ligado) return;
  ligado = false;
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("scroll", reposicionaBadges, true);
  window.removeEventListener("resize", reposicionaBadges);
  if (overlayHover) overlayHover.style.display = "none";
  limpaBadges();
}

ipcRenderer.on("nexo-inspector:toggle", (_e, on) => {
  if (on) liga();
  else desliga();
});
