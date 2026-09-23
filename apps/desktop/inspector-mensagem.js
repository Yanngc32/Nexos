/**
 * Monta o que o botão "Mandar" do inspector de elemento envia pro chat — função pura, sem DOM:
 * testa no node.
 *
 * Módulo à parte de `inspector-selector.cjs` (que faz a captura, dentro do preload do
 * `<webview>`) porque este aqui roda no lado do host (`renderer.js`), carregado como ESM
 * de navegador puro — não entende `module.exports`/`require` de um `.cjs`.
 */

/**
 * O pedido vai como texto da mensagem e os elementos à parte: o chat mostra só o pedido e um chip
 * por elemento ("div1", "svg2"); seletor/texto/HTML o daemon junta no que vai pro motor.
 */
/** "div1", "svg2" — com hífen quando a tag termina em número ("h1-3" em vez de "h13"). */
export function rotuloDoElemento(tag, i) {
  const t = tag || "elemento";
  return `${t}${/\d$/.test(t) ? "-" : ""}${i + 1}`;
}

export function montarMensagem(selecionados, pedido) {
  return {
    texto: String(pedido ?? "").trim(),
    elementos: selecionados.map((s, i) => ({
      rotulo: rotuloDoElemento(s.tag, i),
      seletor: s.seletor,
      ...(s.texto ? { texto: s.texto } : {}),
      html: s.outerHtml,
    })),
  };
}
