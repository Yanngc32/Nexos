/**
 * Modal de clonar repositório: cola o link, escolhe a pasta, acompanha o progresso.
 *
 * O progresso chega por SSE (`POST /v1/git/clone`) e não por resposta simples
 * porque clone de repositório grande leva minutos — e tela parada por minutos é
 * indistinguível de travada. O `ok`/`erro` vem como ÚLTIMO EVENTO, não como
 * status HTTP: quando o stream abriu, o 200 já foi embora.
 *
 * Dependências por parâmetro (mesmo motivo de `dialogo.js` e `automacao-modal.js`):
 * é o que torna isto testável fora do Electron, que é onde `window.nexo` existe.
 */
export function createCloneModal({ el, api, headers, lerEventos, pickFolder, aoClonar, fetchImpl = fetch }) {
  /** Cancela o stream em andamento; `null` quando não há clone rodando. */
  let cancelar = null;

  function erro(msg) {
    const p = el("cl-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function progresso(msg) {
    const p = el("cl-progresso");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  /** Enquanto clona, o botão vira estado: sem isso dá pra disparar dois clones na mesma pasta. */
  function rodando(sim) {
    el("btn-cl-clonar").disabled = sim;
    el("btn-cl-clonar").textContent = sim ? "Clonando…" : "Clonar";
    el("cl-url").disabled = sim;
    el("btn-cl-pasta").disabled = sim;
  }

  async function escolherPasta() {
    const pasta = await pickFolder();
    if (!pasta) return;
    el("cl-pasta").value = pasta;
    erro("");
  }

  async function clonar() {
    const url = el("cl-url").value.trim();
    const destinoPai = el("cl-pasta").value.trim();
    if (!url) return erro("Cole o link do repositório.");
    if (!destinoPai) return erro("Escolha a pasta onde o repositório vai ficar.");

    erro("");
    progresso("Começando…");
    rodando(true);
    const ac = new AbortController();
    cancelar = () => ac.abort();
    let destino = "";
    try {
      const res = await fetchImpl(api("/v1/git/clone"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url, destinoPai }),
        signal: ac.signal,
      });
      await lerEventos(res, (ev) => {
        if (ev.type === "progresso") progresso(ev.linha);
        if (ev.type === "erro") erro(ev.message);
        if (ev.type === "ok") destino = ev.dir;
      });
    } catch (e) {
      // abortar é a pessoa fechando o modal, não falha que ela precise ler
      if (!ac.signal.aborted) erro(e.message || "O clone falhou.");
    } finally {
      cancelar = null;
      rodando(false);
      progresso("");
    }

    if (!destino) return false;
    await aoClonar(destino);
    fechar();
    return true;
  }

  function abrir() {
    el("cl-url").value = "";
    el("cl-pasta").value = "";
    erro("");
    progresso("");
    rodando(false);
    el("clone-modal").classList.remove("hidden");
  }

  function fechar() {
    // o clone segue no daemon se já começou; o que se corta aqui é só o stream
    cancelar?.();
    el("clone-modal").classList.add("hidden");
  }

  function ligar() {
    el("btn-cl-pasta").addEventListener("click", () => void escolherPasta());
    el("btn-cl-clonar").addEventListener("click", () => void clonar());
    el("btn-cl-fechar").addEventListener("click", fechar);
    el("clone-modal").addEventListener("click", (e) => {
      if (e.target.id === "clone-modal") fechar();
    });
  }

  return { abrir, fechar, ligar, clonar };
}
