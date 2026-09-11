/**
 * Quadro Kanban de tarefas por projeto (módulo "Tarefas"). Fala com `/v1/tarefas*` no daemon
 * (`apps/daemon/src/tarefas.ts`) — mesmo idioma de `hooks-studio.js`/`file-tree.js`: dependências
 * (`req`, `el`, callbacks) entram por parâmetro pra dar pra testar sem subir o Electron.
 *
 * Arrastar um cartão só reordena/move no cliente e depois manda pro servidor — sem endpoint de
 * lote, então um drop dispara um PUT por tarefa cuja `ordem` mudou na coluna de destino.
 *
 * Tarefa mora num arquivo dentro da pasta DAQUELE projeto (ver tarefas.ts) — não tem índice
 * global por id, então toda chamada de UMA tarefa (GET/PUT/DELETE, checklist, comentário) precisa
 * do `projectPath` na query, mesmo pra atualizar.
 */

/**
 * Recoloca `id` na posição `indice` de `ids` (removendo a ocorrência antiga primeiro). Função pura
 * — o cálculo de onde uma tarefa cai depois de um drop não depende de nenhum evento de drag real.
 */
export function moverNaLista(ids, id, indice) {
  const semId = ids.filter((x) => x !== id);
  const pos = Math.max(0, Math.min(indice, semId.length));
  semId.splice(pos, 0, id);
  return semId;
}

export function ordenarPorOrdem(lista) {
  return [...lista].sort((a, b) => a.ordem - b.ordem);
}

export function filtrarPorMarco(tarefas, marcoId) {
  if (!marcoId) return tarefas;
  return tarefas.filter((t) => t.marcoId === marcoId);
}

const ROTULO_PRIORIDADE = { baixa: "⌄ baixa", media: "≡ média", alta: "⌃ alta", urgente: "⚠ urgente" };

export function createTarefasBoard({
  req,
  el,
  getProjectPath,
  aoAbrirConversa,
  confirmar = (msg) => Promise.resolve(window.confirm(msg)),
  avisar = (msg) => Promise.resolve(window.alert(msg)),
}) {
  let quadro = { colunas: [], marcos: [], etiquetas: [] };
  let tarefas = [];
  let filtroMarco = "";
  /** id em edição no modal; "" = tarefa nova; null = modal fechado. */
  let editando = null;
  let colunaDaNova = "";
  let arrastando = null;

  function qs() {
    return `projectPath=${encodeURIComponent(getProjectPath())}`;
  }

  function erro(msg) {
    const p = el("tk-f-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  async function carregar() {
    const projectPath = getProjectPath();
    if (!projectPath) {
      quadro = { colunas: [], marcos: [], etiquetas: [] };
      tarefas = [];
      render();
      return;
    }
    [quadro, tarefas] = await Promise.all([req(`/v1/tarefas/quadro?${qs()}`), req(`/v1/tarefas?${qs()}`)]);
    render();
  }

  function tarefasDaColuna(colunaId) {
    return ordenarPorOrdem(filtrarPorMarco(tarefas, filtroMarco).filter((t) => t.colunaId === colunaId));
  }

  function cardEl(t) {
    const div = document.createElement("div");
    div.className = "kanban-card";
    div.draggable = true;
    div.dataset.id = t.id;
    div.addEventListener("dragstart", (e) => {
      arrastando = t.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", t.id);
    });
    div.addEventListener("dragend", () => {
      arrastando = null;
    });
    div.addEventListener("click", () => abrirModal(t.id));

    const titulo = document.createElement("p");
    titulo.className = "kanban-card-title";
    titulo.textContent = t.titulo;
    div.append(titulo);

    if (t.etiquetaIds?.length) {
      const chips = document.createElement("div");
      chips.className = "kanban-card-etiquetas";
      for (const id of t.etiquetaIds) {
        const etq = quadro.etiquetas.find((e) => e.id === id);
        if (!etq) continue;
        const chip = document.createElement("span");
        chip.className = "kanban-card-etiqueta";
        chip.style.background = etq.cor;
        chip.title = etq.nome;
        chips.append(chip);
      }
      if (chips.children.length) div.append(chips);
    }

    const marco = t.marcoId ? quadro.marcos.find((m) => m.id === t.marcoId) : null;
    const partes = [];
    if (t.prioridade) partes.push({ cls: "kanban-card-prioridade", txt: ROTULO_PRIORIDADE[t.prioridade] ?? t.prioridade, dataP: t.prioridade });
    if (marco) partes.push({ cls: "kanban-card-marco", txt: `🏁 ${marco.nome}` });
    if (t.prazo) partes.push({ cls: "kanban-card-prazo", txt: `📅 ${t.prazo}` });
    if (t.responsavel) partes.push({ cls: "kanban-card-responsavel", txt: `👤 ${t.responsavel}` });
    if (t.agentId) partes.push({ cls: "kanban-card-responsavel", txt: `🤖 ${t.agentId}` });
    if (t.checklist?.length) {
      const feitos = t.checklist.filter((i) => i.feito).length;
      partes.push({ cls: "kanban-card-checklist", txt: `☑ ${feitos}/${t.checklist.length}` });
    }
    if (t.comentarios?.length) partes.push({ cls: "kanban-card-comentarios", txt: `✎ ${t.comentarios.length}` });
    if (t.threadId) partes.push({ cls: "kanban-card-thread", txt: "💬" });
    if (t.criadoPor === "agente") partes.push({ cls: "kanban-card-agente", txt: "criada por IA" });
    if (partes.length) {
      const meta = document.createElement("div");
      meta.className = "kanban-card-meta";
      for (const p of partes) {
        const span = document.createElement("span");
        span.className = p.cls;
        if (p.dataP) span.dataset.p = p.dataP;
        span.textContent = p.txt;
        meta.append(span);
      }
      div.append(meta);
    }
    return div;
  }

  function colEl(coluna) {
    const col = document.createElement("div");
    col.className = "kanban-col";
    col.dataset.colunaId = coluna.id;

    const head = document.createElement("div");
    head.className = "kanban-col-head";
    const nome = document.createElement("input");
    nome.type = "text";
    nome.className = "kanban-col-nome";
    nome.value = coluna.nome;
    nome.addEventListener("click", (e) => e.stopPropagation());
    nome.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nome.blur();
    });
    nome.addEventListener("blur", () => void renomearColuna(coluna, nome));
    const count = document.createElement("span");
    count.className = "kanban-col-count";
    count.textContent = String(tarefasDaColuna(coluna.id).length);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost kanban-col-del";
    del.title = "Apagar coluna";
    del.textContent = "✕";
    del.addEventListener("click", () => void apagarColunaUi(coluna));
    head.append(nome, count, del);

    const cards = document.createElement("div");
    cards.className = "kanban-col-cards";
    cards.dataset.colunaId = coluna.id;
    for (const t of tarefasDaColuna(coluna.id)) cards.append(cardEl(t));
    cards.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      cards.classList.add("tk-dragover");
    });
    cards.addEventListener("dragleave", () => cards.classList.remove("tk-dragover"));
    cards.addEventListener("drop", (e) => {
      e.preventDefault();
      cards.classList.remove("tk-dragover");
      if (!arrastando) return;
      const indice = indiceDeDrop(cards, e.clientY);
      void moverTarefa(arrastando, coluna.id, indice);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ghost kanban-col-add";
    addBtn.textContent = "+ tarefa";
    addBtn.addEventListener("click", () => abrirModal(null, coluna.id));

    col.append(head, cards, addBtn);
    return col;
  }

  /** Posição de inserção olhando o meio vertical de cada cartão já renderizado na coluna. */
  function indiceDeDrop(container, clientY) {
    const cartoes = [...container.querySelectorAll(".kanban-card")].filter((c) => c.dataset.id !== arrastando);
    for (let i = 0; i < cartoes.length; i++) {
      const r = cartoes[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return cartoes.length;
  }

  async function moverTarefa(tarefaId, colunaDestinoId, indice) {
    const movida = tarefas.find((t) => t.id === tarefaId);
    if (!movida) return;
    const irmas = ordenarPorOrdem(tarefas.filter((t) => t.colunaId === colunaDestinoId && t.id !== tarefaId));
    const ids = irmas.map((t) => t.id);
    const novaOrdem = moverNaLista(ids, tarefaId, indice);
    const porId = new Map([...irmas, movida].map((t) => [t.id, t]));
    await Promise.all(
      novaOrdem.map((id, idx) => {
        const t = porId.get(id);
        const mudouColuna = id === tarefaId && t.colunaId !== colunaDestinoId;
        if (t.ordem === idx && !mudouColuna) return null;
        const body = mudouColuna ? { colunaId: colunaDestinoId, ordem: idx } : { ordem: idx };
        return req(`/v1/tarefas/${id}?${qs()}`, { method: "PUT", body: JSON.stringify(body) }).catch(() => {});
      }),
    );
    await carregar();
  }

  async function renomearColuna(coluna, input) {
    const nome = input.value.trim();
    if (!nome || nome === coluna.nome) {
      input.value = coluna.nome;
      return;
    }
    try {
      await req(`/v1/tarefas/colunas/${coluna.id}?${qs()}`, { method: "PUT", body: JSON.stringify({ nome }) });
    } catch {
      input.value = coluna.nome;
      return;
    }
    await carregar();
  }

  async function apagarColunaUi(coluna) {
    if (!(await confirmar(`Apagar a coluna "${coluna.nome}"?`))) return;
    try {
      await req(`/v1/tarefas/colunas/${coluna.id}?${qs()}`, { method: "DELETE" });
    } catch (e) {
      await avisar(e.message || "Não deu pra apagar.");
      return;
    }
    await carregar();
  }

  function renderToolbar() {
    const sel = el("tk-filtro-marco");
    const atual = sel.value;
    sel.replaceChildren();
    const todos = document.createElement("option");
    todos.value = "";
    todos.textContent = "Todos os marcos";
    sel.append(todos);
    for (const m of quadro.marcos) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.prazo ? `${m.nome} (${m.prazo})` : m.nome;
      sel.append(o);
    }
    sel.value = [...sel.options].some((o) => o.value === atual) ? atual : "";
    filtroMarco = sel.value;
  }

  function renderMarcosLista() {
    const ul = el("tk-marcos-lista");
    ul.replaceChildren();
    if (!quadro.marcos.length) {
      const li = document.createElement("li");
      li.className = "tk-marco-vazio";
      li.textContent = "Nenhum marco ainda.";
      ul.append(li);
      return;
    }
    for (const m of quadro.marcos) {
      const li = document.createElement("li");
      li.className = "tk-marco-item";
      const nome = document.createElement("span");
      nome.textContent = m.prazo ? `${m.nome} — prazo ${m.prazo}` : m.nome;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = "✕";
      del.addEventListener("click", () => void apagarMarcoUi(m));
      li.append(nome, del);
      ul.append(li);
    }
  }

  async function apagarMarcoUi(m) {
    if (!(await confirmar(`Apagar o marco "${m.nome}"?`))) return;
    try {
      await req(`/v1/tarefas/marcos/${m.id}?${qs()}`, { method: "DELETE" });
    } catch (e) {
      await avisar(e.message || "Não deu pra apagar.");
      return;
    }
    await carregar();
  }

  function renderEtiquetasLista() {
    const ul = el("tk-etiquetas-lista");
    ul.replaceChildren();
    if (!quadro.etiquetas.length) {
      const li = document.createElement("li");
      li.className = "tk-marco-vazio";
      li.textContent = "Nenhuma etiqueta ainda.";
      ul.append(li);
      return;
    }
    for (const et of quadro.etiquetas) {
      const li = document.createElement("li");
      li.className = "tk-marco-item";
      const cor = document.createElement("span");
      cor.className = "kanban-card-etiqueta";
      cor.style.background = et.cor;
      cor.style.width = "14px";
      cor.style.height = "14px";
      cor.style.borderRadius = "3px";
      cor.style.flex = "0 0 auto";
      const nome = document.createElement("span");
      nome.textContent = et.nome;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = "✕";
      del.addEventListener("click", () => void apagarEtiquetaUi(et));
      li.append(cor, nome, del);
      ul.append(li);
    }
  }

  async function apagarEtiquetaUi(et) {
    if (!(await confirmar(`Apagar a etiqueta "${et.nome}"?`))) return;
    try {
      await req(`/v1/tarefas/etiquetas/${et.id}?${qs()}`, { method: "DELETE" });
    } catch (e) {
      await avisar(e.message || "Não deu pra apagar.");
      return;
    }
    await carregar();
  }

  async function novaEtiquetaUi() {
    const nomeEl = el("tk-etiqueta-nome");
    const corEl = el("tk-etiqueta-cor");
    const nome = nomeEl.value.trim();
    if (!nome) return;
    try {
      await req(`/v1/tarefas/etiquetas?${qs()}`, { method: "POST", body: JSON.stringify({ nome, cor: corEl.value }) });
    } catch (e) {
      await avisar(e.message || "Não deu pra criar a etiqueta.");
      return;
    }
    nomeEl.value = "";
    await carregar();
  }

  function render() {
    renderToolbar();
    renderMarcosLista();
    renderEtiquetasLista();
    const board = el("tk-board");
    board.replaceChildren();
    for (const c of ordenarPorOrdem(quadro.colunas.map((c, i) => ({ ...c, ordem: c.ordem ?? i })))) {
      board.append(colEl(c));
    }
  }

  // ---------- modal de uma tarefa ----------

  function preencherSelectsDoModal() {
    const selColuna = el("tk-f-coluna");
    selColuna.replaceChildren();
    for (const c of quadro.colunas) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.nome;
      selColuna.append(o);
    }
    const selMarco = el("tk-f-marco");
    selMarco.replaceChildren();
    const nenhum = document.createElement("option");
    nenhum.value = "";
    nenhum.textContent = "Nenhum";
    selMarco.append(nenhum);
    for (const m of quadro.marcos) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.nome;
      selMarco.append(o);
    }
  }

  function preencherEtiquetasDoModal(selecionadas) {
    const wrap = el("tk-f-etiquetas");
    wrap.replaceChildren();
    for (const etq of quadro.etiquetas) {
      const label = document.createElement("label");
      label.className = "tk-etiqueta-opcao";
      const on = selecionadas.includes(etq.id);
      label.dataset.on = on ? "1" : "0";
      label.style.background = on ? etq.cor : "transparent";
      label.style.borderColor = on ? etq.cor : "";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = on;
      input.dataset.etiquetaId = etq.id;
      input.addEventListener("change", () => {
        label.dataset.on = input.checked ? "1" : "0";
        label.style.background = input.checked ? etq.cor : "transparent";
        label.style.borderColor = input.checked ? etq.cor : "";
      });
      const span = document.createElement("span");
      span.textContent = etq.nome;
      label.append(input, span);
      wrap.append(label);
    }
  }

  function etiquetasSelecionadas() {
    return [...el("tk-f-etiquetas").querySelectorAll("input[type=checkbox]")].filter((i) => i.checked).map((i) => i.dataset.etiquetaId);
  }

  function preencherChecklist(t) {
    const ul = el("tk-f-checklist");
    ul.replaceChildren();
    for (const item of t.checklist) {
      const li = document.createElement("li");
      li.className = "tk-checklist-item";
      li.dataset.feito = item.feito ? "1" : "0";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.feito;
      check.addEventListener("change", () => void alternarChecklistUi(item.id, check.checked));
      const span = document.createElement("span");
      span.textContent = item.texto;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = "✕";
      del.addEventListener("click", () => void apagarChecklistUi(item.id));
      li.append(check, span, del);
      ul.append(li);
    }
  }

  function preencherComentarios(t) {
    const ul = el("tk-f-comentarios");
    ul.replaceChildren();
    if (!t.comentarios.length) {
      const li = document.createElement("li");
      li.className = "tk-marco-vazio";
      li.textContent = "Nenhum comentário ainda.";
      ul.append(li);
      return;
    }
    for (const c of t.comentarios) {
      const li = document.createElement("li");
      li.className = "tk-comentario-item";
      const texto = document.createElement("div");
      texto.textContent = c.texto;
      const meta = document.createElement("div");
      meta.className = "tk-comentario-meta";
      const quando = new Date(c.criadoEm).toLocaleString("pt-BR");
      meta.textContent = c.autor ? `${c.autor} · ${quando}` : quando;
      li.append(texto, meta);
      ul.append(li);
    }
  }

  /** Releva só a tarefa em edição (checklist/comentário mudou) — sem fechar o modal. */
  async function recarregarTarefaAtual() {
    if (!editando) return;
    const t = await req(`/v1/tarefas/${editando}?${qs()}`);
    tarefas = tarefas.map((x) => (x.id === t.id ? t : x));
    preencherChecklist(t);
    preencherComentarios(t);
    render();
  }

  async function adicionarChecklistUi() {
    const input = el("tk-checklist-novo-texto");
    const texto = input.value.trim();
    if (!texto || !editando) return;
    try {
      await req(`/v1/tarefas/${editando}/checklist?${qs()}`, { method: "POST", body: JSON.stringify({ texto }) });
    } catch (e) {
      await avisar(e.message || "Não deu pra adicionar.");
      return;
    }
    input.value = "";
    await recarregarTarefaAtual();
  }

  async function alternarChecklistUi(itemId, feito) {
    try {
      await req(`/v1/tarefas/${editando}/checklist/${itemId}?${qs()}`, { method: "PUT", body: JSON.stringify({ feito }) });
    } catch {
      // segue — recarregar traz o estado real de volta
    }
    await recarregarTarefaAtual();
  }

  async function apagarChecklistUi(itemId) {
    try {
      await req(`/v1/tarefas/${editando}/checklist/${itemId}?${qs()}`, { method: "DELETE" });
    } catch {
      // idem
    }
    await recarregarTarefaAtual();
  }

  async function adicionarComentarioUi() {
    const input = el("tk-comentario-novo-texto");
    const texto = input.value.trim();
    if (!texto || !editando) return;
    try {
      await req(`/v1/tarefas/${editando}/comentarios?${qs()}`, { method: "POST", body: JSON.stringify({ texto }) });
    } catch (e) {
      await avisar(e.message || "Não deu pra comentar.");
      return;
    }
    input.value = "";
    await recarregarTarefaAtual();
  }

  function abrirModal(id, colunaSugerida) {
    editando = id ? id : "";
    colunaDaNova = colunaSugerida || quadro.colunas[0]?.id || "";
    preencherSelectsDoModal();
    const t = id ? tarefas.find((x) => x.id === id) : null;
    el("tk-modal-title").textContent = t ? "Editar tarefa" : "Nova tarefa";
    el("tk-f-titulo").value = t?.titulo ?? "";
    el("tk-f-descricao").value = t?.descricao ?? "";
    el("tk-f-coluna").value = t?.colunaId ?? colunaDaNova;
    el("tk-f-marco").value = t?.marcoId ?? "";
    el("tk-f-prioridade").value = t?.prioridade ?? "";
    el("tk-f-prazo").value = t?.prazo ?? "";
    el("tk-f-responsavel").value = t?.responsavel ?? "";
    el("tk-f-agente").value = t?.agentId ?? "";
    preencherEtiquetasDoModal(t?.etiquetaIds ?? []);
    el("btn-tk-apagar").classList.toggle("hidden", !t);
    el("btn-tk-abrir-conversa").classList.toggle("hidden", !t);
    el("tk-checklist-wrap").classList.toggle("hidden", !t);
    el("tk-comentarios-wrap").classList.toggle("hidden", !t);
    el("tk-checklist-hint").classList.toggle("hidden", Boolean(t));
    if (t) {
      preencherChecklist(t);
      preencherComentarios(t);
    }
    erro("");
    el("tarefa-modal").classList.remove("hidden");
  }

  function fecharModal() {
    editando = null;
    el("tarefa-modal").classList.add("hidden");
  }

  async function salvarModal() {
    const titulo = el("tk-f-titulo").value.trim();
    if (!titulo) return erro("Título obrigatório."), false;
    const body = {
      projectPath: getProjectPath(),
      titulo,
      descricao: el("tk-f-descricao").value.trim(),
      colunaId: el("tk-f-coluna").value,
      marcoId: el("tk-f-marco").value || null,
      etiquetaIds: etiquetasSelecionadas(),
      prioridade: el("tk-f-prioridade").value || null,
      responsavel: el("tk-f-responsavel").value.trim() || null,
      agentId: el("tk-f-agente").value.trim() || null,
      prazo: el("tk-f-prazo").value || null,
    };
    try {
      if (editando) {
        await req(`/v1/tarefas/${editando}?${qs()}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        const criada = await req("/v1/tarefas", { method: "POST", body: JSON.stringify(body) });
        editando = criada.id;
      }
    } catch (e) {
      return erro(e.message || "Não deu pra salvar."), false;
    }
    await carregar();
    fecharModal();
    return true;
  }

  async function apagarModal() {
    if (!editando) return;
    if (!(await confirmar("Apagar esta tarefa? Não volta."))) return;
    try {
      await req(`/v1/tarefas/${editando}?${qs()}`, { method: "DELETE" });
    } catch (e) {
      return erro(e.message || "Não deu pra apagar.");
    }
    await carregar();
    fecharModal();
  }

  async function abrirConversaDaModal() {
    if (!editando) return;
    let t = tarefas.find((x) => x.id === editando);
    let threadId = t?.threadId;
    if (!threadId) {
      const criada = await req("/v1/threads", {
        method: "POST",
        body: JSON.stringify({ projectPath: getProjectPath() }),
      });
      threadId = criada.id;
      await req(`/v1/tarefas/${editando}?${qs()}`, { method: "PUT", body: JSON.stringify({ threadId }) });
      await carregar();
    }
    fecharModal();
    await aoAbrirConversa(threadId);
  }

  async function novaColunaUi() {
    const nome = el("tk-nova-coluna-nome");
    const v = nome.value.trim();
    if (!v) return;
    try {
      await req(`/v1/tarefas/colunas?${qs()}`, { method: "POST", body: JSON.stringify({ nome: v }) });
    } catch (e) {
      await avisar(e.message || "Não deu pra criar a coluna.");
      return;
    }
    nome.value = "";
    await carregar();
  }

  async function novoMarcoUi() {
    const nomeEl = el("tk-marco-nome");
    const prazoEl = el("tk-marco-prazo");
    const nome = nomeEl.value.trim();
    if (!nome) return;
    try {
      await req(`/v1/tarefas/marcos?${qs()}`, { method: "POST", body: JSON.stringify({ nome, prazo: prazoEl.value || null }) });
    } catch (e) {
      await avisar(e.message || "Não deu pra criar o marco.");
      return;
    }
    nomeEl.value = "";
    prazoEl.value = "";
    await carregar();
  }

  function ligar() {
    el("tk-filtro-marco").addEventListener("change", () => {
      filtroMarco = el("tk-filtro-marco").value;
      render();
    });
    el("btn-tk-marcos").addEventListener("click", () => el("tk-marcos-painel").classList.toggle("hidden"));
    el("btn-tk-etiquetas").addEventListener("click", () => el("tk-etiquetas-painel").classList.toggle("hidden"));
    el("btn-tk-nova-coluna-add").addEventListener("click", () => void novaColunaUi());
    el("tk-nova-coluna-nome").addEventListener("keydown", (e) => {
      if (e.key === "Enter") void novaColunaUi();
    });
    el("btn-tk-marco-add").addEventListener("click", () => void novoMarcoUi());
    el("btn-tk-etiqueta-add").addEventListener("click", () => void novaEtiquetaUi());
    el("btn-tk-checklist-add").addEventListener("click", () => void adicionarChecklistUi());
    el("tk-checklist-novo-texto").addEventListener("keydown", (e) => {
      if (e.key === "Enter") void adicionarChecklistUi();
    });
    el("btn-tk-comentario-add").addEventListener("click", () => void adicionarComentarioUi());
    el("btn-tk-modal-close").addEventListener("click", fecharModal);
    el("btn-tk-salvar").addEventListener("click", () => void salvarModal());
    el("btn-tk-apagar").addEventListener("click", () => void apagarModal());
    el("btn-tk-abrir-conversa").addEventListener("click", () => void abrirConversaDaModal());
  }

  function abrir() {
    return carregar();
  }

  return { ligar, abrir, editandoId: () => editando };
}
