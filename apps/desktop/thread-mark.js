/** Marca a linha da conversa aberta sem reconstruir a árvore inteira. */

export function marcarLinhaAtiva(raiz, threadId) {
  if (!raiz) return 0;
  const id = String(threadId || "");
  let n = 0;
  for (const li of raiz.querySelectorAll("[data-thread-id]")) {
    li.dataset.on = li.dataset.threadId === id ? "1" : "0";
    n += 1;
  }
  return n;
}
