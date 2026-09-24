/**
 * Modal de nova conversa: escolhe a branch que fica fixa pro resto da conversa.
 *
 * Lista inline (um botão por branch, `role=option`) em vez de dropdown flutuante: o popup
 * absoluto ficava cortado pelo `overflow:auto` do card e virava uma caixinha com barra de
 * rolagem dentro do modal. Com muitas branches aparece um filtro em cima.
 *
 * Sem escolha a fazer (chat geral, pasta sem git, uma branch só) o modal nem abre: cria direto.
 * Antes ele abria só com o botão "Criar conversa" — um clique a mais pra nada.
 *
 * A branch atual do projeto já vem selecionada: quem não mexe em nada tem o comportamento de
 * sempre (sem isolamento nenhum — `branch` só viaja no POST quando a pessoa escolhe outra).
 */

/** A partir daqui a lista ganha o campo de filtro. */
const FILTRO_A_PARTIR_DE = 7;

export function createNewThreadModal({ el, req, aoCriar }) {
  /** Contexto da abertura atual: pra onde criar quando confirmar. */
  let ctx = null;
  /** Branch atual da pasta principal do projeto — referência do "sem mexer". */
  let branchAtual = "";
  let branches = [];
  let escolhida = "";

  function erro(msg) {
    const p = el("nt-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function rodando(sim) {
    el("btn-nt-criar").disabled = sim;
    el("btn-nt-criar").textContent = sim ? "Criando…" : "Criar conversa";
  }

  function dica() {
    const p = el("nt-branch-dica");
    if (!p) return;
    p.textContent =
      escolhida && escolhida !== branchAtual
        ? `Roda numa cópia isolada (worktree) em ${escolhida}. A pasta do projeto não muda de branch.`
        : "Roda na pasta do projeto, na branch atual.";
  }

  function visiveis() {
    const termo = (el("nt-branch-filtro")?.value || "").trim().toLowerCase();
    return termo ? branches.filter((b) => b.toLowerCase().includes(termo)) : branches;
  }

  function escolher(branch) {
    escolhida = branch;
    for (const item of el("nt-branch-list")?.querySelectorAll(".nt-branch") ?? []) {
      item.setAttribute("aria-selected", String(item.dataset.branch === branch));
    }
    dica();
  }

  function montarLista() {
    const lista = el("nt-branch-list");
    if (!lista) return;
    lista.replaceChildren();
    const itens = visiveis();
    for (const branch of itens) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nt-branch";
      btn.setAttribute("role", "option");
      btn.dataset.branch = branch;
      btn.setAttribute("aria-selected", String(branch === escolhida));
      const nome = document.createElement("span");
      nome.className = "nt-branch-nome";
      nome.textContent = branch;
      btn.append(nome);
      if (branch === branchAtual) {
        const tag = document.createElement("span");
        tag.className = "nt-branch-tag";
        tag.textContent = "atual";
        btn.append(tag);
      }
      btn.addEventListener("click", () => escolher(branch));
      btn.addEventListener("dblclick", () => {
        escolher(branch);
        void criar();
      });
      lista.append(btn);
    }
    if (itens.length === 0) {
      const vazio = document.createElement("p");
      vazio.className = "nt-branch-vazio";
      vazio.textContent = "Nenhuma branch com esse nome.";
      lista.append(vazio);
    }
  }

  /** Setas no filtro andam pela lista; Enter cria. */
  function moverSelecao(delta) {
    const itens = visiveis();
    if (itens.length === 0) return;
    const i = itens.indexOf(escolhida);
    const prox = itens[Math.max(0, Math.min(itens.length - 1, (i < 0 ? -1 : i) + delta))];
    escolher(prox);
    el("nt-branch-list")?.querySelector(`[aria-selected="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }

  /** Devolve se há escolha a fazer (2+ branches). */
  async function carregarBranches(projectPath) {
    try {
      const { atual, locais } = await req(`/v1/git/branches?projectPath=${encodeURIComponent(projectPath)}`);
      branchAtual = atual || "";
      // atual primeiro: é o caminho de quem não quer mexer em nada
      branches = [...(branchAtual ? [branchAtual] : []), ...locais.filter((b) => b !== branchAtual)];
      escolhida = branchAtual || branches[0] || "";
      return branches.length >= 2;
    } catch {
      // não é repo git (ou git não deu pra rodar): cria direto na pasta, sem escolha nenhuma
      branchAtual = "";
      branches = [];
      escolhida = "";
      return false;
    }
  }

  async function criar() {
    if (!ctx) return;
    erro("");
    rodando(true);
    try {
      const t = await req("/v1/threads", {
        method: "POST",
        body: JSON.stringify({
          ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
          ...(ctx.profileId ? { profileId: ctx.profileId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(ctx.projectPath && escolhida && escolhida !== branchAtual ? { branch: escolhida } : {}),
        }),
      });
      fechar();
      await aoCriar(t.id);
    } catch (e) {
      // sem modal aberto (criação direta) o erro precisa aparecer em algum lugar
      el("new-thread-modal").classList.remove("hidden");
      erro(e.message || "Não deu pra criar a conversa.");
    } finally {
      rodando(false);
    }
  }

  /** `abrirCtx`: `{ projectPath?, profileId?, agentId? }` — sem `projectPath`, cria no chat geral. */
  async function abrir(abrirCtx) {
    ctx = abrirCtx;
    erro("");
    rodando(false);
    const filtro = el("nt-branch-filtro");
    if (filtro) filtro.value = "";
    const temEscolha = abrirCtx.projectPath ? await carregarBranches(abrirCtx.projectPath) : false;
    if (!abrirCtx.projectPath) {
      branchAtual = "";
      branches = [];
      escolhida = "";
    }
    if (!temEscolha) {
      el("nt-branch-field")?.classList.add("hidden");
      await criar();
      return;
    }
    el("nt-branch-field")?.classList.remove("hidden");
    filtro?.classList.toggle("hidden", branches.length < FILTRO_A_PARTIR_DE);
    montarLista();
    dica();
    el("new-thread-modal").classList.remove("hidden");
    (branches.length >= FILTRO_A_PARTIR_DE ? filtro : el("btn-nt-criar"))?.focus?.();
  }

  function fechar() {
    ctx = null;
    el("new-thread-modal").classList.add("hidden");
  }

  function ligar() {
    el("btn-nt-criar").addEventListener("click", () => void criar());
    el("btn-nt-fechar").addEventListener("click", fechar);
    el("btn-nt-cancelar")?.addEventListener("click", fechar);
    el("nt-branch-filtro")?.addEventListener("input", () => {
      const itens = visiveis();
      if (itens.length && !itens.includes(escolhida)) escolhida = itens[0];
      montarLista();
      dica();
    });
    el("new-thread-modal").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        fechar();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moverSelecao(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && !el("btn-nt-criar").disabled) {
        e.preventDefault();
        void criar();
      }
    });
    el("new-thread-modal").addEventListener("click", (e) => {
      if (e.target.id === "new-thread-modal") fechar();
    });
  }

  return { abrir, fechar, ligar };
}
