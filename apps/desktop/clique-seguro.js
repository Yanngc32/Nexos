/**
 * O navegador só dispara `click` se o `pointerdown` e o `pointerup` caem no MESMO elemento.
 * Redesenho que troca o DOM nesse meio (lista de agentes a cada 1 s, árvore de conversas quando
 * alguém começa ou para) engolia o clique — "preciso clicar 2 ou 3 vezes". Com o botão apertado,
 * o redesenho espera o clique terminar e roda logo depois, uma vez só.
 */
export function criarCliqueSeguro(doc = globalThis.document, agendar = (f) => setTimeout(f, 0)) {
  let apertado = false;
  const adiados = new Set();

  const soltar = () => {
    if (!apertado) return;
    apertado = false;
    // depois do `click`, que sai na mesma tarefa do `pointerup`
    agendar(() => {
      const fns = [...adiados];
      adiados.clear();
      for (const f of fns) f();
    });
  };

  doc?.addEventListener?.("pointerdown", () => (apertado = true), true);
  doc?.addEventListener?.("pointerup", soltar, true);
  doc?.addEventListener?.("pointercancel", soltar, true);
  doc?.defaultView?.addEventListener?.("blur", soltar);

  /** `true` = adiou (quem chamou sai sem desenhar); `false` = pode desenhar agora. */
  return function adiarSeApertado(redesenho) {
    if (!apertado) return false;
    adiados.add(redesenho);
    return true;
  };
}
