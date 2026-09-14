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

/**
 * Filtro combinado da visualização em tabela — todos os campos em E lógico; campo vazio/ausente
 * em `filtros` não restringe nada. Função pura — testável sem montar a tabela de verdade.
 */
export function filtrarTabela(tarefas, filtros = {}) {
  const { colunaId, tipo, prioridade, etiquetaId, busca } = filtros;
  const buscaNorm = (busca ?? "").trim().toLowerCase();
  return tarefas.filter((t) => {
    if (colunaId && t.colunaId !== colunaId) return false;
    if (tipo && t.tipo !== tipo) return false;
    if (prioridade && t.prioridade !== prioridade) return false;
    if (etiquetaId && !(t.etiquetaIds ?? []).includes(etiquetaId)) return false;
    if (buscaNorm) {
      const alvo = `${t.titulo ?? ""} ${t.descricao ?? ""}`.toLowerCase();
      if (!alvo.includes(buscaNorm)) return false;
    }
    return true;
  });
}

/** `AAAA-MM-DD` local (não `toISOString`, que vira UTC e pode cair no dia errado perto da meia-noite). */
function isoLocal(data) {
  const y = data.getFullYear();
  const m = String(data.getMonth() + 1).padStart(2, "0");
  const d = String(data.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Agrupa tarefas por dia do prazo, só do mês pedido (`mes` 0-indexado, igual `Date`). Tarefa sem
 * `prazo` não entra em nenhum grupo — não tem onde plotar no calendário. Função pura.
 */
export function tarefasPorDia(tarefas, ano, mes) {
  const porDia = new Map();
  for (const t of tarefas) {
    if (!t.prazo) continue;
    const [y, m] = t.prazo.split("-").map(Number);
    if (y !== ano || m - 1 !== mes) continue;
    if (!porDia.has(t.prazo)) porDia.set(t.prazo, []);
    porDia.get(t.prazo).push(t);
  }
  return porDia;
}

/**
 * Intervalo total da timeline (com folga proporcional nas pontas) a partir das datas de TODOS os
 * marcos com pelo menos uma data — marco sem `inicio` nem `prazo` não entra na conta (não tem
 * onde plotar). `null` se nenhum marco tem data nenhuma (timeline vazia). Função pura.
 */
export function escalaDaTimeline(marcos) {
  const datas = marcos.flatMap((m) => [m.inicio, m.prazo].filter(Boolean));
  if (!datas.length) return null;
  const ms = datas.map((d) => new Date(`${d}T00:00:00`).getTime());
  const minMs = Math.min(...ms);
  const maxMs = Math.max(...ms);
  const folga = Math.max((maxMs - minMs) * 0.05, 24 * 3600 * 1000); // ao menos 1 dia de folga, mesmo com um só marco
  return { inicio: new Date(minMs - folga), fim: new Date(maxMs + folga) };
}

/**
 * Posição (0–100) de UM marco dentro da `escala` já calculada — barra proporcional quando tem
 * início e prazo, ou marcador de largura zero (ponto) quando só tem uma das duas datas. `null`
 * se o marco não tem data nenhuma (não entra na timeline). Função pura.
 */
export function posicaoNaTimeline(marco, escala) {
  if (!escala || (!marco.inicio && !marco.prazo)) return null;
  const total = escala.fim.getTime() - escala.inicio.getTime();
  const paraPct = (iso) => ((new Date(`${iso}T00:00:00`).getTime() - escala.inicio.getTime()) / total) * 100;
  const dataUnica = marco.inicio ?? marco.prazo;
  if (!marco.inicio || !marco.prazo) {
    const p = paraPct(dataUnica);
    return { left: p, width: 0 };
  }
  const left = paraPct(marco.inicio);
  return { left, width: Math.max(paraPct(marco.prazo) - left, 0.5) };
}

const ROTULO_PRIORIDADE = { baixa: "⌄ baixa", media: "≡ média", alta: "⌃ alta", urgente: "⚠ urgente" };
const ROTULO_TIPO = { bug: "🐛 bug", feature: "✨ feature", chore: "🔧 chore", spike: "🔬 spike" };

/** Nome curto (última pasta) de um caminho de projeto — `null`/"" vira "Nenhum projeto". */
function nomeDoProjeto(path) {
  if (!path) return "Nenhum projeto";
  const partes = path.split(/[/\\]/).filter(Boolean);
  return partes.at(-1) || path;
}

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
  /** id da coluna sendo arrastada pra reordenar — `null` quando não tem drag de coluna em curso. */
  let colArrastando = null;
  /** "kanban" | "lista" | "calendario" | "timeline" — só em memória, volta pro Kanban ao reabrir. */
  let modo = "kanban";
  /** Mês exibido no calendário — só ano/mês importam, dia fica sempre 1. */
  let mesCalendario = new Date();

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
    if (t.tipo) partes.push({ cls: "kanban-card-tipo", txt: ROTULO_TIPO[t.tipo] ?? t.tipo });
    if (t.parentId) {
      const mae = tarefas.find((x) => x.id === t.parentId);
      partes.push({ cls: "kanban-card-sub", txt: `↳ ${mae ? mae.titulo : "tarefa-mãe"}` });
    }
    if (t.dependeDe?.length) partes.push({ cls: "kanban-card-bloqueada", txt: `🔒 bloqueada por ${t.dependeDe.length}` });
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
    col.draggable = true;
    col.addEventListener("dragstart", (e) => {
      if (e.target.closest("input, button, .kanban-card")) {
        e.preventDefault();
        return;
      }
      colArrastando = coluna.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", coluna.id);
    });
    col.addEventListener("dragend", () => {
      colArrastando = null;
    });

    const head = document.createElement("div");
    head.className = "kanban-col-head";
    const handle = document.createElement("span");
    handle.className = "kanban-col-handle";
    handle.textContent = "⠿";
    handle.title = "Arrastar pra reordenar";
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
    head.append(handle, nome, count, del);

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

  /** Posição de inserção olhando o meio horizontal de cada coluna já renderizada no quadro. */
  function indiceDeDropColuna(container, clientX) {
    const cols = [...container.querySelectorAll(".kanban-col")].filter((c) => c.dataset.colunaId !== colArrastando);
    for (let i = 0; i < cols.length; i++) {
      const r = cols[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return cols.length;
  }

  async function moverColuna(colunaId, indice) {
    const ids = ordenarPorOrdem(quadro.colunas).map((c) => c.id);
    const novaOrdem = moverNaLista(ids, colunaId, indice);
    const porId = new Map(quadro.colunas.map((c) => [c.id, c]));
    await Promise.all(
      novaOrdem.map((id, idx) => {
        const c = porId.get(id);
        if (c.ordem === idx) return null;
        return req(`/v1/tarefas/colunas/${id}?${qs()}`, { method: "PUT", body: JSON.stringify({ ordem: idx }) }).catch(() => {});
      }),
    );
    await carregar();
  }

  async function moverTarefa(tarefaId, colunaDestinoId, indice) {
    const movida = tarefas.find((t) => t.id === tarefaId);
    if (!movida) return;
    const irmas = ordenarPorOrdem(tarefas.filter((t) => t.colunaId === colunaDestinoId && t.id !== tarefaId));
    const ids = irmas.map((t) => t.id);
    const novaOrdem = moverNaLista(ids, tarefaId, indice);
    const porId = new Map([...irmas, movida].map((t) => [t.id, t]));
    // A troca de coluna em si pode ser recusada pelo servidor (ex.: dependência ainda não
    // concluída) — nesse caso o card volta pro lugar (`carregar` busca o estado real), mas quem
    // arrastou precisa saber por quê em vez de ver o card simplesmente "voltar sozinho".
    let erroMove = null;
    await Promise.all(
      novaOrdem.map((id, idx) => {
        const t = porId.get(id);
        const mudouColuna = id === tarefaId && t.colunaId !== colunaDestinoId;
        if (t.ordem === idx && !mudouColuna) return null;
        const body = mudouColuna ? { colunaId: colunaDestinoId, ordem: idx } : { ordem: idx };
        return req(`/v1/tarefas/${id}?${qs()}`, { method: "PUT", body: JSON.stringify(body) }).catch((e) => {
          if (mudouColuna) erroMove = e;
        });
      }),
    );
    await carregar();
    if (erroMove) await avisar(erroMove.message || "Não deu pra mover.");
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
      const datas = [m.inicio ? `início ${m.inicio}` : "", m.prazo ? `prazo ${m.prazo}` : ""].filter(Boolean).join(" — ");
      nome.textContent = datas ? `${m.nome} — ${datas}` : m.nome;
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

  const MODOS = ["kanban", "lista", "calendario", "timeline"];

  /** Troca de aba: só alterna qual contêiner aparece e (re)desenha o modo ativo — sem recarregar dados. */
  function mudarModo(novo) {
    modo = novo;
    for (const m of MODOS) {
      el(`tab-tk-${m}`).dataset.on = m === modo ? "1" : "0";
      const container = m === "kanban" ? el("tk-board") : el(`tk-${m}`);
      container.classList.toggle("hidden", m !== modo);
    }
    renderModoAtivo();
  }

  function renderModoAtivo() {
    if (modo === "lista") renderLista();
    else if (modo === "calendario") renderCalendario();
    else if (modo === "timeline") renderTimeline();
    // "kanban" já é redesenhado dentro de render() — não precisa de passo extra aqui.
  }

  /** Selects de filtro da lista (coluna/etiqueta) — preservando o valor atual quando ainda existir. */
  function preencherFiltrosDaLista() {
    const selColuna = el("tk-lf-coluna");
    const atualColuna = selColuna.value;
    selColuna.replaceChildren(opcao("Todas as colunas", ""));
    for (const c of quadro.colunas) selColuna.append(opcao(c.nome, c.id));
    if ([...selColuna.options].some((o) => o.value === atualColuna)) selColuna.value = atualColuna;

    const selEtq = el("tk-lf-etiqueta");
    const atualEtq = selEtq.value;
    selEtq.replaceChildren(opcao("Todas as etiquetas", ""));
    for (const et of quadro.etiquetas) selEtq.append(opcao(et.nome, et.id));
    if ([...selEtq.options].some((o) => o.value === atualEtq)) selEtq.value = atualEtq;
  }

  function renderLista() {
    const filtros = {
      colunaId: el("tk-lf-coluna").value,
      tipo: el("tk-lf-tipo").value,
      prioridade: el("tk-lf-prioridade").value,
      etiquetaId: el("tk-lf-etiqueta").value,
      busca: el("tk-lf-busca").value,
    };
    const filtradas = ordenarPorOrdem(filtrarTabela(tarefas, filtros));
    const corpo = el("tk-lista-corpo");
    corpo.replaceChildren();
    for (const t of filtradas) {
      const tr = document.createElement("tr");
      tr.dataset.id = t.id;
      tr.addEventListener("click", () => abrirModal(t.id));
      const coluna = quadro.colunas.find((c) => c.id === t.colunaId)?.nome ?? "";
      const marco = t.marcoId ? (quadro.marcos.find((m) => m.id === t.marcoId)?.nome ?? "") : "";
      const etiquetas = (t.etiquetaIds ?? [])
        .map((id) => quadro.etiquetas.find((e) => e.id === id)?.nome)
        .filter(Boolean)
        .join(", ");
      const valores = [
        t.titulo,
        coluna,
        t.tipo ? (ROTULO_TIPO[t.tipo] ?? t.tipo) : "",
        t.prioridade ? (ROTULO_PRIORIDADE[t.prioridade] ?? t.prioridade) : "",
        marco,
        t.prazo ?? "",
        etiquetas,
      ];
      for (const v of valores) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      corpo.append(tr);
    }
    el("tk-lista-vazio").classList.toggle("hidden", filtradas.length > 0);
  }

  const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const MESES = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];

  function renderCalendario() {
    const ano = mesCalendario.getFullYear();
    const mes = mesCalendario.getMonth();
    el("tk-cal-titulo").textContent = `${MESES[mes]} ${ano}`;
    const porDia = tarefasPorDia(tarefas, ano, mes);
    const grade = el("tk-cal-grade");
    grade.replaceChildren();
    for (const nomeDia of DIAS_SEMANA) {
      const cab = document.createElement("div");
      cab.className = "tk-cal-dia-num";
      cab.textContent = nomeDia;
      grade.append(cab);
    }
    const primeiroDia = new Date(ano, mes, 1);
    const inicioGrade = new Date(primeiroDia);
    inicioGrade.setDate(primeiroDia.getDate() - primeiroDia.getDay());
    for (let i = 0; i < 42; i++) {
      const dia = new Date(inicioGrade);
      dia.setDate(inicioGrade.getDate() + i);
      const div = document.createElement("div");
      div.className = "tk-cal-dia";
      div.dataset.fora = dia.getMonth() === mes ? "0" : "1";
      const num = document.createElement("div");
      num.className = "tk-cal-dia-num";
      num.textContent = String(dia.getDate());
      div.append(num);
      for (const t of porDia.get(isoLocal(dia)) ?? []) {
        const chip = document.createElement("div");
        chip.className = "tk-cal-chip";
        chip.textContent = t.titulo;
        chip.title = t.titulo;
        chip.addEventListener("click", () => abrirModal(t.id));
        div.append(chip);
      }
      grade.append(div);
    }
  }

  function renderTimeline() {
    const corpo = el("tk-timeline-corpo");
    corpo.replaceChildren();
    const escala = escalaDaTimeline(quadro.marcos);
    el("tk-timeline-vazio").classList.toggle("hidden", Boolean(escala));
    if (!escala) return;
    for (const m of quadro.marcos) {
      const pos = posicaoNaTimeline(m, escala);
      if (!pos) continue;
      const wrap = document.createElement("div");
      wrap.className = "tk-tl-marco";
      const nome = document.createElement("p");
      nome.className = "kanban-card-title";
      nome.textContent = m.inicio || m.prazo ? `${m.nome} (${[m.inicio, m.prazo].filter(Boolean).join(" → ")})` : m.nome;
      const trilha = document.createElement("div");
      trilha.className = "tk-tl-trilha";
      const barra = document.createElement("div");
      barra.className = "tk-tl-barra";
      barra.style.left = `${pos.left}%`;
      barra.style.width = `${Math.max(pos.width, 1.5)}%`;
      const tarefasDoMarco = filtrarPorMarco(tarefas, m.id);
      const lista = document.createElement("ul");
      lista.className = "tk-tl-tarefas hidden";
      if (tarefasDoMarco.length) {
        for (const t of tarefasDoMarco) {
          const li = document.createElement("li");
          li.textContent = t.titulo;
          li.addEventListener("click", () => abrirModal(t.id));
          lista.append(li);
        }
      } else {
        const li = document.createElement("li");
        li.textContent = "Nenhuma tarefa neste marco.";
        lista.append(li);
      }
      barra.addEventListener("click", () => lista.classList.toggle("hidden"));
      trilha.append(barra);
      wrap.append(nome, trilha, lista);
      corpo.append(wrap);
    }
  }

  function render() {
    const projLabel = el("tk-projeto");
    if (projLabel) {
      const path = getProjectPath();
      projLabel.textContent = nomeDoProjeto(path);
      projLabel.title = path || "";
    }
    renderToolbar();
    renderMarcosLista();
    renderEtiquetasLista();
    preencherFiltrosDaLista();
    const board = el("tk-board");
    board.replaceChildren();
    for (const c of ordenarPorOrdem(quadro.colunas.map((c, i) => ({ ...c, ordem: c.ordem ?? i })))) {
      board.append(colEl(c));
    }
    renderModoAtivo();
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

  /**
   * `tk-f-parent`/`tk-f-depende-de`: lista de tarefas do MESMO quadro, excluindo a própria
   * (`id`, ausente = tarefa nova) e — só pra "subtarefa de" — quem já é filha direta dela (evita
   * montar um ciclo óbvio já na hora de escolher; ciclo mais profundo o servidor ainda recusa,
   * ver `limparParentId`). Mesmo idioma de `preencherEtiquetasDoModal`: recebe a seleção atual
   * em vez de tentar preservar estado de uma renderização anterior.
   *
   * "Depende de" some tarefas já na coluna final (feitas): bloqueador que já terminou não faz
   * sentido virar dependência nova — mesma noção de "coluna final" que o backend usa em
   * `limparDependeDe`/checagem de bloqueio (`tarefas.ts`, coluna de maior `ordem`).
   */
  function opcao(texto, valor) {
    const o = document.createElement("option");
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  function colunaFinalId() {
    if (!quadro.colunas.length) return undefined;
    return quadro.colunas.reduce((max, c) => (c.ordem > max.ordem ? c : max), quadro.colunas[0]).id;
  }

  function preencherParentEDependencias(id, parentIdAtual, dependeDeAtual) {
    const outras = tarefas.filter((x) => x.id !== id);

    const selParent = el("tk-f-parent");
    selParent.replaceChildren(opcao("Nenhuma — é uma tarefa de topo", ""));
    for (const t of outras) {
      if (t.parentId === id) continue; // já é filha desta — vira ciclo direto se virar mãe
      selParent.append(opcao(t.titulo, t.id));
    }
    selParent.value = parentIdAtual ?? "";

    const finalId = colunaFinalId();
    const selDep = el("tk-f-depende-de");
    selDep.replaceChildren();
    for (const t of outras) {
      if (t.colunaId === finalId) continue; // já feita — não vira bloqueadora nova
      selDep.append(opcao(t.titulo, t.id));
    }
    const marcadas = new Set(dependeDeAtual ?? []);
    for (const o of selDep.options) o.selected = marcadas.has(o.value);
  }

  async function preencherCommits(id) {
    const wrap = el("tk-commits-wrap");
    const ul = el("tk-f-commits");
    if (!id) {
      wrap.classList.add("hidden");
      return;
    }
    wrap.classList.remove("hidden");
    ul.replaceChildren();
    let commits;
    try {
      commits = await req(`/v1/tarefas/${id}/commits?${qs()}`);
    } catch {
      commits = [];
    }
    if (!commits.length) {
      const li = document.createElement("li");
      li.className = "tk-marco-vazio";
      li.textContent = "Nenhum commit menciona o id desta tarefa ainda.";
      ul.append(li);
      return;
    }
    for (const c of commits) {
      const li = document.createElement("li");
      li.className = "tk-comentario-item";
      const texto = document.createElement("div");
      texto.textContent = c.mensagem;
      const meta = document.createElement("div");
      meta.className = "tk-comentario-meta";
      meta.textContent = `${c.hash.slice(0, 7)} · ${new Date(c.data).toLocaleString("pt-BR")}`;
      li.append(texto, meta);
      ul.append(li);
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
    el("tk-f-tipo").value = t?.tipo ?? "";
    preencherEtiquetasDoModal(t?.etiquetaIds ?? []);
    preencherParentEDependencias(t?.id, t?.parentId, t?.dependeDe);
    el("btn-tk-apagar").classList.toggle("hidden", !t);
    el("btn-tk-abrir-conversa").classList.toggle("hidden", !t);
    el("tk-checklist-wrap").classList.toggle("hidden", !t);
    el("tk-comentarios-wrap").classList.toggle("hidden", !t);
    el("tk-checklist-hint").classList.toggle("hidden", Boolean(t));
    if (t) {
      preencherChecklist(t);
      preencherComentarios(t);
    }
    void preencherCommits(t?.id);
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
      tipo: el("tk-f-tipo").value || null,
      parentId: el("tk-f-parent").value || null,
      dependeDe: [...el("tk-f-depende-de").selectedOptions].map((o) => o.value),
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
    const inicioEl = el("tk-marco-inicio");
    const prazoEl = el("tk-marco-prazo");
    const nome = nomeEl.value.trim();
    if (!nome) return;
    try {
      await req(`/v1/tarefas/marcos?${qs()}`, {
        method: "POST",
        body: JSON.stringify({ nome, inicio: inicioEl.value || null, prazo: prazoEl.value || null }),
      });
    } catch (e) {
      await avisar(e.message || "Não deu pra criar o marco.");
      return;
    }
    nomeEl.value = "";
    inicioEl.value = "";
    prazoEl.value = "";
    await carregar();
  }

  function ligar() {
    const board = el("tk-board");
    board.addEventListener("dragover", (e) => {
      if (!colArrastando) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    board.addEventListener("drop", (e) => {
      if (!colArrastando) return;
      e.preventDefault();
      void moverColuna(colArrastando, indiceDeDropColuna(board, e.clientX));
    });
    el("tk-filtro-marco").addEventListener("change", () => {
      filtroMarco = el("tk-filtro-marco").value;
      render();
    });
    for (const m of MODOS) {
      el(`tab-tk-${m}`).addEventListener("click", () => mudarModo(m));
    }
    for (const id of ["tk-lf-coluna", "tk-lf-tipo", "tk-lf-prioridade", "tk-lf-etiqueta"]) {
      el(id).addEventListener("change", renderLista);
    }
    el("tk-lf-busca").addEventListener("input", renderLista);
    el("btn-tk-cal-anterior").addEventListener("click", () => {
      mesCalendario = new Date(mesCalendario.getFullYear(), mesCalendario.getMonth() - 1, 1);
      renderCalendario();
    });
    el("btn-tk-cal-seguinte").addEventListener("click", () => {
      mesCalendario = new Date(mesCalendario.getFullYear(), mesCalendario.getMonth() + 1, 1);
      renderCalendario();
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
