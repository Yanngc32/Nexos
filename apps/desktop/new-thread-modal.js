/**
 * Modal de nova conversa: escolhe a branch que fica fixa pro resto da conversa.
 *
 * Mesmo padrão de dropdown do clone-modal.js (custom, não <select> nativo — no
 * Electron, rolar a bolinha do mouse com o popup nativo aberto fecha ele sozinho).
 *
 * A branch atual do projeto já vem selecionada: quem não mexe em nada tem o
 * comportamento de sempre (sem isolamento nenhum — `branch` só viaja no POST
 * quando a pessoa escolhe algo diferente da atual).
 */
export function createNewThreadModal({ el, req, aoCriar }) {
  /** Contexto da abertura atual: pra onde criar quando confirmar. */
  let ctx = null;
  /** Branch atual da pasta principal do projeto — referência do "sem mexer". */
  let branchAtual = "";

  function erro(msg) {
    const p = el("nt-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function rodando(sim) {
    el("btn-nt-criar").disabled = sim;
    el("btn-nt-criar").textContent = sim ? "Criando…" : "Criar conversa";
  }

  function fecharDropdown() {
    el("nt-branch-list")?.classList.add("hidden");
  }

  function toggleDropdown() {
    const lista = el("nt-branch-list");
    if (!lista) return;
    lista.classList.toggle("hidden");
  }

  function montarDropdown(branches) {
    const lista = el("nt-branch-list");
    if (!lista) return;
    lista.innerHTML = "";
    for (const branch of branches) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dropdown-item";
      btn.textContent = branch === branchAtual ? `${branch} (atual)` : branch;
      btn.addEventListener("click", () => {
        fecharDropdown();
        el("nt-branch-trigger").textContent = branch;
        el("nt-branch-trigger").dataset.branch = branch;
      });
      lista.appendChild(btn);
    }
  }

  async function carregarBranches(projectPath) {
    const campo = el("nt-branch-field");
    try {
      const { atual, locais } = await req(`/v1/git/branches?projectPath=${encodeURIComponent(projectPath)}`);
      branchAtual = atual || "";
      const gatilho = el("nt-branch-trigger");
      gatilho.textContent = branchAtual ? `${branchAtual} (atual)` : locais[0] || "";
      gatilho.dataset.branch = branchAtual || locais[0] || "";
      montarDropdown(locais.length ? locais : branchAtual ? [branchAtual] : []);
      campo?.classList.toggle("hidden", locais.length < 2);
    } catch {
      // não é repo git (ou git não deu pra rodar): cria direto na pasta, sem escolha nenhuma
      campo?.classList.add("hidden");
      branchAtual = "";
    }
  }

  async function criar() {
    if (!ctx) return;
    const escolhida = el("nt-branch-trigger")?.dataset.branch || "";
    erro("");
    rodando(true);
    try {
      const t = await req("/v1/threads", {
        method: "POST",
        body: JSON.stringify({
          projectPath: ctx.projectPath,
          ...(ctx.profileId ? { profileId: ctx.profileId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(escolhida && escolhida !== branchAtual ? { branch: escolhida } : {}),
        }),
      });
      fechar();
      await aoCriar(t.id);
    } catch (e) {
      erro(e.message || "Não deu pra criar a conversa.");
    } finally {
      rodando(false);
    }
  }

  /** `abrirCtx`: `{ projectPath, profileId?, agentId? }`. */
  async function abrir(abrirCtx) {
    ctx = abrirCtx;
    erro("");
    rodando(false);
    fecharDropdown();
    el("nt-branch-field")?.classList.add("hidden");
    el("new-thread-modal").classList.remove("hidden");
    await carregarBranches(abrirCtx.projectPath);
  }

  function fechar() {
    ctx = null;
    fecharDropdown();
    el("new-thread-modal").classList.add("hidden");
  }

  function ligar() {
    el("btn-nt-criar").addEventListener("click", () => void criar());
    el("btn-nt-fechar").addEventListener("click", fechar);
    el("nt-branch-trigger")?.addEventListener("click", toggleDropdown);
    document.addEventListener("click", (e) => {
      if (!el("nt-branch-dd")?.contains(e.target)) fecharDropdown();
    });
    el("new-thread-modal").addEventListener("click", (e) => {
      if (e.target.id === "new-thread-modal") fechar();
    });
  }

  return { abrir, fechar, ligar };
}
