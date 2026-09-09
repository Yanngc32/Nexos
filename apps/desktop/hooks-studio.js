/**
 * Tela cheia de UMA regra de Nexo Hook — sem bancada de execução (a regra não roda aqui, só
 * dispara sozinha quando o evento acontece). Mesmo padrão de `team-studio.js`: campos lidos por
 * `id`, `sujo()` compara contra um snapshot pra saber se há mudança pendente, erro da API cai
 * num parágrafo dedicado.
 */
export function createHooksStudio({ req, el, getProjects, getAgents, getTeams, aoSalvar, aoFechar }) {
  /** id em edição; "" = criando. `null` = tela fechada. */
  let editando = null;
  let original = null;

  const GLOBAL = "__global__";
  const EVENTOS_COM_BRANCH = new Set(["git.post-push", "git.pre-push"]);

  function erro(msg) {
    const p = el("hk-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function ler() {
    const escopoVal = el("hk-escopo").value;
    const alvoTipo = el("hk-alvo-tipo").value;
    return {
      nome: el("hk-nome").value.trim(),
      descricao: el("hk-descricao").value.trim(),
      escopo: escopoVal === GLOBAL ? { tipo: "global" } : { tipo: "projeto", projectPath: escopoVal },
      evento: el("hk-evento").value,
      branch: el("hk-branch").value.trim(),
      agentId: alvoTipo === "agente" ? el("hk-agent").value : "",
      teamId: alvoTipo === "time" ? el("hk-team").value : "",
      bloqueante: el("hk-bloqueante").checked,
    };
  }

  function sujo() {
    if (!original) return true;
    return JSON.stringify(ler()) !== JSON.stringify(original);
  }

  function aoMudar() {
    const evento = el("hk-evento").value;
    const alvoTipo = el("hk-alvo-tipo").value;
    el("hk-branch-wrap").classList.toggle("hidden", !EVENTOS_COM_BRANCH.has(evento));
    el("hk-bloqueante-wrap").classList.toggle("hidden", evento !== "git.pre-push");
    el("hk-agent-wrap").classList.toggle("hidden", alvoTipo !== "agente");
    el("hk-team-wrap").classList.toggle("hidden", alvoTipo !== "time");
    el("hk-dirty").classList.toggle("hidden", !sujo());
    el("hk-head-name").textContent = el("hk-nome").value.trim() || editando || "nova regra";
  }

  /** Preenche um `<select>` com `{id, name}` preservando o valor atual, se ainda existir na lista. */
  function pintarLista(select, itens) {
    const atual = select.value;
    select.replaceChildren();
    for (const item of itens) {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      select.append(o);
    }
    if ([...select.options].some((o) => o.value === atual)) select.value = atual;
  }

  function pintarOpcoes() {
    const escopo = el("hk-escopo");
    const valorAtual = escopo.value;
    escopo.replaceChildren();
    const global = document.createElement("option");
    global.value = GLOBAL;
    global.textContent = "Global — todo projeto";
    escopo.append(global);
    for (const p of getProjects()) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      escopo.append(o);
    }
    if ([...escopo.options].some((o) => o.value === valorAtual)) escopo.value = valorAtual;

    pintarLista(el("hk-agent"), getAgents());
    pintarLista(el("hk-team"), getTeams());
  }

  /** Abre a tela. `def` vazio = regra nova. */
  function abrir(def) {
    editando = def ? def.id : "";
    pintarOpcoes();
    el("hk-nome").value = def?.nome ?? "";
    el("hk-descricao").value = def?.descricao ?? "";
    el("hk-escopo").value = def?.escopo?.tipo === "projeto" ? def.escopo.projectPath : GLOBAL;
    el("hk-evento").value = def?.evento ?? "git.post-commit";
    el("hk-branch").value = def?.branch ?? "";
    el("hk-alvo-tipo").value = def?.teamId ? "time" : "agente";
    el("hk-agent").value = def?.agentId ?? (def?.teamId ? "" : (getAgents()[0]?.id ?? ""));
    el("hk-team").value = def?.teamId ?? "";
    el("hk-bloqueante").checked = Boolean(def?.bloqueante);
    el("btn-hk-del").classList.toggle("hidden", !def);
    original = def ? ler() : null;
    erro("");
    aoMudar();
  }

  async function salvar() {
    const v = ler();
    if (v.escopo.tipo === "projeto" && !v.escopo.projectPath) return erro("Escolha um projeto."), false;
    if (!v.agentId && !v.teamId) {
      return erro("Escolha um agente ou um time — crie um antes se ainda não tiver nenhum."), false;
    }
    const body = {
      nome: v.nome,
      descricao: v.descricao,
      escopo: v.escopo,
      evento: v.evento,
      ...(v.agentId ? { agentId: v.agentId } : {}),
      ...(v.teamId ? { teamId: v.teamId } : {}),
      ...(v.branch && EVENTOS_COM_BRANCH.has(v.evento) ? { branch: v.branch } : {}),
      ...(v.evento === "git.pre-push" ? { bloqueante: v.bloqueante } : {}),
    };
    try {
      const salva = editando
        ? await req(`/v1/hooks/rules/${editando}`, { method: "PUT", body: JSON.stringify(body) })
        : await req("/v1/hooks/rules", { method: "POST", body: JSON.stringify(body) });
      editando = salva.id;
    } catch (e) {
      return erro(e.message || "Falhou ao salvar."), false;
    }
    el("btn-hk-del").classList.remove("hidden");
    original = ler();
    erro("");
    aoMudar();
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
    await aoSalvar();
    fechar();
  }

  function fechar() {
    editando = null;
    aoFechar();
  }

  /** Liga os controles. Chamado uma vez, no boot. */
  function ligar() {
    for (const id of ["hk-escopo", "hk-evento", "hk-alvo-tipo", "hk-agent", "hk-team", "hk-bloqueante"]) {
      el(id).addEventListener("change", aoMudar);
    }
    for (const id of ["hk-branch", "hk-nome", "hk-descricao"]) {
      el(id).addEventListener("input", aoMudar);
    }
    el("btn-hk-save").addEventListener("click", () => void salvar());
    el("btn-hk-del").addEventListener("click", () => void excluir());
  }

  return { abrir, fechar, ligar, salvar, editandoId: () => editando };
}
