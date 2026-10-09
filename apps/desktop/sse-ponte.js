/**
 * Streams longos do motor (SSE) pelo processo PRINCIPAL, não pelo `fetch` do renderer.
 *
 * O Chromium abre no máximo 6 conexões HTTP/1.1 por host:porta. O app mantém vários streams
 * abertos o tempo todo no mesmo `127.0.0.1:<porta>` (agentes, um por chat, DS, vídeo, plano,
 * serviços, runs): com 6 de pé, todo `fetch` novo — inclusive a resposta do print do DS e do
 * navegador pro motor — ficava na fila sem prazo ("o app não respondeu a tempo"). O Node do
 * processo principal não tem esse teto; ele lê o stream e repassa os pedaços por IPC.
 *
 * Devolve um Response-like (`ok`, `status`, `body` ReadableStream de bytes): quem consome
 * (`lerEventos`) não muda. Fora do Electron (testes) cai no `fetch` comum.
 */
export function criarFetchSse({ ponte = globalThis.window?.nexo, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (!ponte?.sseAbrir) return (url, opts) => fetchImpl(url, opts);
  return function fetchSse(url, { headers = {}, signal } = {}) {
    return new Promise((resolve, reject) => {
      const enc = new TextEncoder();
      let controller;
      let id = "";
      let respondeu = false;
      const body = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          if (id) ponte.sseFechar(id);
        },
      });
      const abortar = () => {
        if (id) ponte.sseFechar(id);
        const erro = new DOMException("aborted", "AbortError");
        if (!respondeu) reject(erro);
        else
          try {
            controller.error(erro);
          } catch {
            /* stream já fechado */
          }
      };
      if (signal?.aborted) return abortar();
      signal?.addEventListener("abort", abortar, { once: true });
      id = ponte.sseAbrir(url, headers, (m) => {
        if (m.inicio) {
          respondeu = true;
          resolve({ ok: m.status >= 200 && m.status < 300, status: m.status, body });
          return;
        }
        if (m.dado !== undefined) {
          controller.enqueue(enc.encode(m.dado));
          return;
        }
        if (m.fim) {
          signal?.removeEventListener("abort", abortar);
          if (!respondeu) return reject(new Error(m.erro || "stream fechou antes de responder"));
          try {
            if (m.erro) controller.error(new Error(m.erro));
            else controller.close();
          } catch {
            /* já fechado */
          }
        }
      });
    });
  };
}
