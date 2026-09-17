/**
 * Relayout do guest do painel Browser. Gráfico SVG/canvas mede o container uma
 * vez; se o `<webview>` nasceu escondido o arco colapsa. Empurrão barato: UA
 * Chrome + tamanho em px + `resize` DEPOIS do paint — sem jiggle de 1px no
 * caminho da troca de conversa (isso travava a UI).
 *
 * ESM: o renderer (import) e `main.cjs` (import() dinâmico) consomem o mesmo
 * arquivo. Não pode ser `.cjs` — o `<script type="module">` do renderer carrega
 * via file://, e o Chromium serve `.cjs` como "text/plain" (MIME sniffing por
 * extensão), o que derruba o `import` com "Failed to load module script".
 */

/** Dispara no guest: quem escuta `resize`/`visualViewport` (ResponsiveContainer) redesenha. */
export const JS_RELAYOUT_GUEST =
  "window.dispatchEvent(new Event('resize'));" +
  "window.visualViewport&&window.visualViewport.dispatchEvent(new Event('resize'));";

/**
 * Chrome sem a palavra Electron. Página que cheira UA e manda CSS/bundle "pra Electron"
 * (ou recusa canvas) passa a ver o preview como Chrome normal.
 */
export function uaChromeAPartirDe(uaCheio) {
  const ver = /Chrome\/([\d.]+)/.exec(String(uaCheio || ""))?.[1] || "130.0.0.0";
  const s = String(uaCheio || "");
  let os = "Windows NT 10.0; Win64; x64";
  if (/Mac OS X/.test(s)) os = "Macintosh; Intel Mac OS X 10_15_7";
  else if (/Linux/.test(s) && !/Android/.test(s)) os = "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

export function pedirRelayoutGuest(el) {
  if (!el || typeof el.executeJavaScript !== "function") return;
  Promise.resolve(el.executeJavaScript(JS_RELAYOUT_GUEST)).catch(() => {});
}

/**
 * Guest do `<webview>` às vezes não acompanha o tamanho CSS do host (o elemento
 * preenche o painel, o backing store fica 300×150). Travar width/height em px no
 * retângulo do pai força o Chromium a casar os dois.
 */
export function sincronizarPixels(el) {
  const pai = el?.parentElement;
  if (!pai || typeof pai.getBoundingClientRect !== "function") return false;
  const r = pai.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  el.style.width = `${Math.round(r.width)}px`;
  el.style.height = `${Math.round(r.height)}px`;
  return true;
}

/**
 * Um rAF: mostrar() já tirou `.stowed` neste turno; o próximo frame o guest
 * tem tamanho. Sem jiggle — troca de conversa não mexe layout no clique.
 */
export function avisarGuestDepoisDoPaint(el) {
  if (!el) return;
  const go = () => {
    if (el.isConnected === false) return;
    sincronizarPixels(el);
    pedirRelayoutGuest(el);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  else go();
}
