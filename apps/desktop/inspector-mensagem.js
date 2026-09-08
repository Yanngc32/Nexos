/**
 * Monta a mensagem que o botão "Mandar" do inspector de elemento envia pro chat — função
 * pura, sem DOM: testa no node.
 *
 * Módulo à parte de `inspector-selector.cjs` (que faz a captura, dentro do preload do
 * `<webview>`) porque este aqui roda no lado do host (`renderer.js`), carregado como ESM
 * de navegador puro — não entende `module.exports`/`require` de um `.cjs`.
 */

/** A mensagem que "Mandar" manda pro chat — lista numerada dos elementos + o pedido livre. */
export function montarMensagem(selecionados, pedido) {
  const linhas = selecionados.map((s, i) => {
    const rotulo = s.texto ? `${s.seletor} — "${s.texto}"` : s.seletor;
    return `${i + 1}. ${rotulo}\n   ${s.outerHtml}`;
  });
  return `Nestes elementos do preview:\n${linhas.join("\n")}\n\nPedido: ${String(pedido ?? "").trim()}`;
}
