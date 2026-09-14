/**
 * Modal de automação da tela de Tarefas — cria/edita/apaga regras de Nexo Hook do evento
 * `tarefa.mudou-coluna`, sempre escopadas ao projeto aberto (`getProjectPath()`). Mesma API HTTP
 * de `hooks-studio.js` (`/v1/hooks/rules`), mas essa tela só existe aqui — o evento
 * `tarefa.mudou-coluna` nem aparece mais no select de evento do Hooks Studio.
 */
export function createAutomacaoModal({ req, el, getProjectPath, getAgents, getTeams, aoSalvar }) {
  const EVENTO = "tarefa.mudou-coluna";

  /** id em edição; "" = criando. `null` = modal fechado. */
  let editando = null;
  let regras = [];

  function erro(msg) {
    const p = el("am-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function ler() {
    const alvoTipo = el("am-alvo-tipo").value;
    return {
      nome: el("am-nome").value.trim(),
      descricao: el("am-descricao").value.trim(),
      colunaId: el("am-coluna").value,
      agentId: alvoTipo === "agente" ? el("am-agent").value : "",
      teamId: alvoTipo === "time" ? el("am-team").value : "",
    };
  }

  function aoMudarAlvo() {
    const alvoTipo = el("am-alvo-tipo").value;
    el("am-agent-wrap").classList.toggle("hidden", alvoTipo !== "agente");
    el("am-team-wrap").classList.toggle("hidden", alvoTipo !== "time");
  }

  function opcao(texto, valor) {
    const o = document.createElement("option");
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  function pintarLista(select, itens) {
    const atual = select.value;
    select.replaceChildren();
    for (const item of itens) select.append(opcao(item.name, item.id));
    if ([...select.options].some((o) => o.value === atual)) select.value = atual;
  }

  async function carregarColunas() {
    const sel = el("am-coluna");
    const atual = sel.value;
    sel.replaceChildren(opcao("qualquer coluna", ""));
    try {
      const quadro = await req(`/v1/tarefas/quadro?projectPath=${encodeURIComponent(getProjectPath())}`);
      for (const c of quadro.colunas) sel.append(opcao(c.nome, c.id));
      if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
    } catch {
      // quadro indisponível: mantém só "qualquer coluna"
    }
  }

  function rotulo(r) {
    return r.nome || `automação · ${r.colunaId || "qualquer coluna"}`;
  }

  function pintarListaAutomacoes() {
    const ul = el("am-lista");
    ul.replaceChildren();
    el("am-vazio").classList.toggle("hidden", regras.length > 0);
    for (const r of regras) {
      const li = document.createElement("li");
      li.className = "agent";

      const head = document.createElement("div");
      head.className = "agent-head";
      const nome = document.createElement("span");
      nome.className = "agent-title";
      nome.textContent = rotulo(r);
      const editar = document.createElement("button");
      editar.type = "button";
      editar.className = "ghost";
      editar.textContent = "✎";
      editar.title = "Editar";
      editar.addEventListener("click", () => preencherForm(r));
      head.append(nome, editar);

      const badges = document.createElement("div");
      badges.className = "agent-badges";
      const meta = document.createElement("span");
      const quem = r.teamId ? `time ${r.teamId}` : r.agentId;
      meta.textContent = [r.colunaId ? `coluna ${r.colunaId}` : "qualquer coluna", quem].join(" · ");
      badges.append(meta);

      li.append(head, badges);
      li.addEventListener("click", (e) => {
        if (e.target === editar) return;
        preencherForm(r);
      });
      ul.append(li);
    }
  }

  async function carregarRegras() {
    const todas = await req("/v1/hooks/rules");
    const projectPath = getProjectPath();
    regras = todas.filter(
      (r) => r.evento === EVENTO && r.escopo?.tipo === "projeto" && r.escopo.projectPath === projectPath,
    );
    pintarListaAutomacoes();
  }

  function preencherForm(def) {
    editando = def ? def.id : "";
    el("am-nome").value = def?.nome ?? "";
    el("am-descricao").value = def?.descricao ?? "";
    el("am-coluna").value = def?.colunaId ?? "";
    el("am-alvo-tipo").value = def?.teamId ? "time" : "agente";
    el("am-agent").value = def?.agentId ?? (def?.teamId ? "" : (getAgents()[0]?.id ?? ""));
    el("am-team").value = def?.teamId ?? "";
    el("btn-am-excluir").classList.toggle("hidden", !def);
    aoMudarAlvo();
    erro("");
  }

  /** Abre o modal (sempre escopado ao projeto atual — sem seletor de escopo/evento). */
  async function abrir() {
    pintarLista(el("am-agent"), getAgents());
    pintarLista(el("am-team"), getTeams());
    await carregarColunas();
    await carregarRegras();
    preencherForm(null);
    el("automacao-modal").classList.remove("hidden");
  }

  function fechar() {
    editando = null;
    el("automacao-modal").classList.add("hidden");
  }

  async function salvar() {
    const v = ler();
    if (!v.agentId && !v.teamId) {
      return erro("Escolha um agente ou um time — crie um antes se ainda não tiver nenhum."), false;
    }
    const body = {
      nome: v.nome,
      descricao: v.descricao,
      escopo: { tipo: "projeto", projectPath: getProjectPath() },
      evento: EVENTO,
      ...(v.agentId ? { agentId: v.agentId } : {}),
      ...(v.teamId ? { teamId: v.teamId } : {}),
      ...(v.colunaId ? { colunaId: v.colunaId } : {}),
    };
    try {
      const salva = editando
        ? await req(`/v1/hooks/rules/${editando}`, { method: "PUT", body: JSON.stringify(body) })
        : await req("/v1/hooks/rules", { method: "POST", body: JSON.stringify(body) });
      editando = salva.id;
    } catch (e) {
      return erro(e.message || "Falhou ao salvar."), false;
    }
    erro("");
    await carregarRegras();
    preencherForm(regras.find((r) => r.id === editando) ?? null);
    await aoSalvar();
    return true;
  }

  async function excluir() {
    if (!editando) return;
    try {
      await req(`/v1/hooks/rules/${editando}`, { method: "DELETE" });
    } catch (e) {
      return erro(e.message || "Falhou ao excluir.");
    }
    await carregarRegras();
    preencherForm(null);
    await aoSalvar();
  }

  function ligar() {
    el("am-alvo-tipo").addEventListener("change", aoMudarAlvo);
    el("btn-am-nova").addEventListener("click", () => preencherForm(null));
    el("btn-am-salvar").addEventListener("click", () => void salvar());
    el("btn-am-excluir").addEventListener("click", () => void excluir());
    el("btn-am-fechar").addEventListener("click", fechar);
    el("automacao-modal").addEventListener("click", (e) => {
      if (e.target.id === "automacao-modal") fechar();
    });
  }

  return { abrir, fechar, ligar, salvar, editandoId: () => editando };
}
