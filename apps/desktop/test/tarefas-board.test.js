// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  createTarefasBoard,
  moverNaLista,
  ordenarPorOrdem,
  filtrarPorMarco,
  filtrarTabela,
  tarefasPorDia,
  escalaDaTimeline,
  posicaoNaTimeline,
} from "../tarefas-board.js";

const HTML = `
  <select id="tk-filtro-marco"></select>
  <button id="tab-tk-kanban" data-on="1"></button>
  <button id="tab-tk-lista" data-on="0"></button>
  <button id="tab-tk-calendario" data-on="0"></button>
  <button id="tab-tk-timeline" data-on="0"></button>
  <button id="btn-tk-marcos"></button>
  <div id="tk-marcos-painel" class="hidden">
    <ul id="tk-marcos-lista"></ul>
    <input id="tk-marco-nome" />
    <input id="tk-marco-inicio" />
    <input id="tk-marco-prazo" />
    <button id="btn-tk-marco-add"></button>
  </div>
  <button id="btn-tk-etiquetas"></button>
  <div id="tk-etiquetas-painel" class="hidden">
    <ul id="tk-etiquetas-lista"></ul>
    <input id="tk-etiqueta-nome" />
    <input id="tk-etiqueta-cor" type="color" value="#7c5cbf" />
    <button id="btn-tk-etiqueta-add"></button>
  </div>
  <input id="tk-nova-coluna-nome" />
  <button id="btn-tk-nova-coluna-add"></button>
  <div id="tk-board"></div>
  <div id="tk-lista" class="hidden">
    <select id="tk-lf-coluna"><option value="">Todas as colunas</option></select>
    <select id="tk-lf-tipo">
      <option value="">Todos os tipos</option>
      <option value="bug">Bug</option>
      <option value="feature">Feature</option>
      <option value="chore">Chore</option>
      <option value="spike">Spike</option>
    </select>
    <select id="tk-lf-prioridade">
      <option value="">Todas as prioridades</option>
      <option value="baixa">Baixa</option>
      <option value="media">Média</option>
      <option value="alta">Alta</option>
      <option value="urgente">Urgente</option>
    </select>
    <select id="tk-lf-etiqueta"><option value="">Todas as etiquetas</option></select>
    <input type="search" id="tk-lf-busca" />
    <tbody id="tk-lista-corpo"></tbody>
    <p id="tk-lista-vazio" class="hidden"></p>
  </div>
  <div id="tk-calendario" class="hidden">
    <button id="btn-tk-cal-anterior"></button>
    <span id="tk-cal-titulo"></span>
    <button id="btn-tk-cal-seguinte"></button>
    <div id="tk-cal-grade"></div>
  </div>
  <div id="tk-timeline" class="hidden">
    <div id="tk-timeline-corpo"></div>
    <p id="tk-timeline-vazio" class="hidden"></p>
  </div>
  <div id="tarefa-modal" class="hidden">
    <h2 id="tk-modal-title"></h2>
    <input id="tk-f-titulo" />
    <textarea id="tk-f-descricao"></textarea>
    <select id="tk-f-coluna"></select>
    <select id="tk-f-marco"></select>
    <select id="tk-f-prioridade">
      <option value="">Nenhuma</option>
      <option value="baixa">Baixa</option>
      <option value="media">Média</option>
      <option value="alta">Alta</option>
      <option value="urgente">Urgente</option>
    </select>
    <input id="tk-f-responsavel" />
    <input id="tk-f-agente" />
    <input id="tk-f-prazo" type="date" />
    <select id="tk-f-tipo">
      <option value="">Nenhum</option>
      <option value="bug">Bug</option>
      <option value="feature">Feature</option>
      <option value="chore">Chore</option>
      <option value="spike">Spike</option>
    </select>
    <select id="tk-f-parent"><option value="">Nenhuma</option></select>
    <select id="tk-f-depende-de" multiple></select>
    <div id="tk-commits-wrap" class="hidden">
      <ul id="tk-f-commits"></ul>
    </div>
    <div id="tk-f-etiquetas"></div>
    <div id="tk-checklist-wrap">
      <ul id="tk-f-checklist"></ul>
      <input id="tk-checklist-novo-texto" />
      <button id="btn-tk-checklist-add"></button>
    </div>
    <div id="tk-comentarios-wrap">
      <ul id="tk-f-comentarios"></ul>
      <textarea id="tk-comentario-novo-texto"></textarea>
      <button id="btn-tk-comentario-add"></button>
    </div>
    <p id="tk-checklist-hint" class="hidden"></p>
    <p id="tk-f-err" class="hidden"></p>
    <button id="btn-tk-modal-close"></button>
    <button id="btn-tk-salvar"></button>
    <button id="btn-tk-apagar" class="hidden"></button>
    <button id="btn-tk-abrir-conversa" class="hidden"></button>
  </div>
`;

const COL_A = "cl-a";
const COL_B = "cl-b";

function quadroFixture(over = {}) {
  return {
    projectPath: "/proj",
    colunas: [
      { id: COL_A, nome: "A fazer", ordem: 0 },
      { id: COL_B, nome: "Fazendo", ordem: 1 },
    ],
    marcos: [],
    etiquetas: [],
    ...over,
  };
}

function tarefaFixture(over = {}) {
  return {
    id: "tk-1",
    projectPath: "/proj",
    titulo: "x",
    colunaId: COL_A,
    ordem: 0,
    etiquetaIds: [],
    checklist: [],
    comentarios: [],
    ...over,
  };
}

function montar({ quadro = quadroFixture(), tarefas = [], reqImpl, aoAbrirConversa, confirmar, avisar } = {}) {
  document.body.innerHTML = HTML;
  const chamadas = [];
  const req =
    reqImpl ??
    vi.fn(async (path) => {
      chamadas.push(path);
      if (path.startsWith("/v1/tarefas/quadro")) return quadro;
      if (/^\/v1\/tarefas\/[^/?]+\/commits/.test(path)) return [];
      if (path.startsWith("/v1/tarefas")) return tarefas;
      return {};
    });
  const board = createTarefasBoard({
    req,
    el: (id) => document.getElementById(id),
    getProjectPath: () => "/proj",
    aoAbrirConversa: aoAbrirConversa ?? vi.fn(),
    confirmar: confirmar ?? vi.fn(async () => true),
    avisar: avisar ?? vi.fn(async () => {}),
  });
  board.ligar();
  return { board, req, chamadas, $: (id) => document.getElementById(id) };
}

/**
 * Backend falso o bastante pra exercitar checklist/comentário de verdade: guarda o quadro e as
 * tarefas em memória e responde os mesmos formatos de rota do daemon (ver http.ts).
 */
function fakeBackend({ quadro, tarefas, commits = {} }) {
  const t = () => tarefas;
  return vi.fn(async (path, opts = {}) => {
    const method = opts.method ?? "GET";
    if (path.startsWith("/v1/tarefas/quadro")) return quadro;
    const mCommits = /^\/v1\/tarefas\/([^/?]+)\/commits/.exec(path);
    if (mCommits) return commits[mCommits[1]] ?? [];
    const mChecklist = /^\/v1\/tarefas\/([^/?]+)\/checklist(?:\/([^/?]+))?/.exec(path);
    if (mChecklist) {
      const [, tarefaId, itemId] = mChecklist;
      const tarefa = t().find((x) => x.id === tarefaId);
      if (method === "POST") {
        const { texto } = JSON.parse(opts.body);
        const item = { id: `ck-${tarefa.checklist.length + 1}`, texto, feito: false };
        tarefa.checklist.push(item);
        return item;
      }
      if (method === "PUT") {
        const { feito } = JSON.parse(opts.body);
        const item = tarefa.checklist.find((i) => i.id === itemId);
        item.feito = feito;
        return { ok: true };
      }
      if (method === "DELETE") {
        tarefa.checklist = tarefa.checklist.filter((i) => i.id !== itemId);
        return { ok: true };
      }
    }
    const mComentarios = /^\/v1\/tarefas\/([^/?]+)\/comentarios/.exec(path);
    if (mComentarios && method === "POST") {
      const tarefa = t().find((x) => x.id === mComentarios[1]);
      const { texto, autor } = JSON.parse(opts.body);
      const comentario = { id: `cm-${tarefa.comentarios.length + 1}`, texto, ...(autor ? { autor } : {}), criadoEm: "2026-01-01T00:00:00.000Z" };
      tarefa.comentarios.push(comentario);
      return comentario;
    }
    const mUm = /^\/v1\/tarefas\/([^/?]+)\?/.exec(path);
    if (mUm && method === "GET") return t().find((x) => x.id === mUm[1]);
    if (path.startsWith("/v1/tarefas")) return t();
    return {};
  });
}

describe("moverNaLista (pura)", () => {
  it("insere na posição pedida, sem depender de nenhum evento de drag", () => {
    expect(moverNaLista(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("move do meio pro início", () => {
    expect(moverNaLista(["a", "b", "c"], "b", 0)).toEqual(["b", "a", "c"]);
  });

  it("id que ainda não está na lista (vindo de outra coluna) entra normalmente", () => {
    expect(moverNaLista(["a", "b"], "novo", 1)).toEqual(["a", "novo", "b"]);
  });

  it("índice fora do intervalo é sujeito ao tamanho da lista", () => {
    expect(moverNaLista(["a", "b"], "a", 99)).toEqual(["b", "a"]);
  });
});

describe("ordenarPorOrdem / filtrarPorMarco (puras)", () => {
  it("ordena por ordem crescente", () => {
    const r = ordenarPorOrdem([{ ordem: 2 }, { ordem: 0 }, { ordem: 1 }]);
    expect(r.map((t) => t.ordem)).toEqual([0, 1, 2]);
  });

  it("sem marcoId devolve tudo", () => {
    const tarefas = [{ marcoId: "m1" }, { marcoId: undefined }];
    expect(filtrarPorMarco(tarefas, "")).toHaveLength(2);
  });

  it("filtra só as tarefas do marco pedido", () => {
    const tarefas = [{ id: "1", marcoId: "m1" }, { id: "2", marcoId: "m2" }];
    expect(filtrarPorMarco(tarefas, "m1")).toEqual([{ id: "1", marcoId: "m1" }]);
  });
});

describe("filtrarTabela (pura)", () => {
  const t1 = { id: "1", titulo: "revisar PR", descricao: "olhar os testes", colunaId: "c1", tipo: "bug", prioridade: "alta", etiquetaIds: ["e1"] };
  const t2 = { id: "2", titulo: "escrever docs", descricao: "", colunaId: "c2", tipo: "chore", prioridade: "baixa", etiquetaIds: [] };

  it("sem filtro nenhum devolve tudo", () => {
    expect(filtrarTabela([t1, t2], {})).toEqual([t1, t2]);
    expect(filtrarTabela([t1, t2])).toEqual([t1, t2]);
  });

  it("cada filtro isolado", () => {
    expect(filtrarTabela([t1, t2], { colunaId: "c1" })).toEqual([t1]);
    expect(filtrarTabela([t1, t2], { tipo: "chore" })).toEqual([t2]);
    expect(filtrarTabela([t1, t2], { prioridade: "alta" })).toEqual([t1]);
    expect(filtrarTabela([t1, t2], { etiquetaId: "e1" })).toEqual([t1]);
  });

  it("busca de texto casa título OU descrição, sem diferenciar maiúscula/minúscula", () => {
    expect(filtrarTabela([t1, t2], { busca: "REVISAR" })).toEqual([t1]);
    expect(filtrarTabela([t1, t2], { busca: "testes" })).toEqual([t1]);
    expect(filtrarTabela([t1, t2], { busca: "docs" })).toEqual([t2]);
  });

  it("filtros combinam em E lógico", () => {
    expect(filtrarTabela([t1, t2], { tipo: "bug", prioridade: "baixa" })).toEqual([]);
    expect(filtrarTabela([t1, t2], { tipo: "bug", prioridade: "alta" })).toEqual([t1]);
  });
});

describe("tarefasPorDia (pura)", () => {
  it("agrupa por dia do prazo", () => {
    const tarefas = [
      { id: "1", prazo: "2026-03-05" },
      { id: "2", prazo: "2026-03-05" },
      { id: "3", prazo: "2026-03-06" },
    ];
    const mapa = tarefasPorDia(tarefas, 2026, 2); // março = mês 2 (0-indexado)
    expect(mapa.get("2026-03-05")).toHaveLength(2);
    expect(mapa.get("2026-03-06")).toHaveLength(1);
  });

  it("tarefa sem prazo não entra em nenhum dia", () => {
    const mapa = tarefasPorDia([{ id: "1" }], 2026, 2);
    expect(mapa.size).toBe(0);
  });

  it("mês diferente do pedido não entra", () => {
    const mapa = tarefasPorDia([{ id: "1", prazo: "2026-04-05" }], 2026, 2);
    expect(mapa.size).toBe(0);
  });
});

describe("escalaDaTimeline / posicaoNaTimeline (puras)", () => {
  it("sem marco nenhum com data, escala é null", () => {
    expect(escalaDaTimeline([{ id: "1", nome: "x" }])).toBeNull();
  });

  it("marco só com prazo vira ponto (width 0)", () => {
    const marcos = [{ id: "1", prazo: "2026-06-01" }];
    const escala = escalaDaTimeline(marcos);
    expect(escala).not.toBeNull();
    const pos = posicaoNaTimeline(marcos[0], escala);
    expect(pos.width).toBe(0);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.left).toBeLessThanOrEqual(100);
  });

  it("marco com início e prazo vira barra proporcional (width > 0)", () => {
    const marcos = [
      { id: "1", inicio: "2026-01-01", prazo: "2026-12-01" },
      { id: "2", prazo: "2026-06-01" },
    ];
    const escala = escalaDaTimeline(marcos);
    const pos = posicaoNaTimeline(marcos[0], escala);
    expect(pos.width).toBeGreaterThan(0);
  });

  it("marco sem nenhuma data não entra no cálculo da escala nem tem posição", () => {
    const marcos = [{ id: "1", nome: "sem data" }, { id: "2", prazo: "2026-06-01" }];
    const escala = escalaDaTimeline(marcos);
    expect(posicaoNaTimeline(marcos[0], escala)).toBeNull();
    expect(posicaoNaTimeline(marcos[1], escala)).not.toBeNull();
  });
});

describe("render do quadro", () => {
  it("desenha uma coluna por coluna do quadro e um cartão por tarefa", async () => {
    const { board, $ } = montar({ tarefas: [tarefaFixture({ id: "t1" }), tarefaFixture({ id: "t2", colunaId: COL_B })] });
    await board.abrir();
    const cols = $("tk-board").querySelectorAll(".kanban-col");
    expect(cols).toHaveLength(2);
    expect($("tk-board").querySelectorAll(".kanban-card")).toHaveLength(2);
  });

  it("filtro por marco esconde cartões de outros marcos", async () => {
    const quadro = quadroFixture({ marcos: [{ id: "m1", nome: "v1" }, { id: "m2", nome: "v2" }] });
    const tarefas = [tarefaFixture({ id: "t1", marcoId: "m1" }), tarefaFixture({ id: "t2", marcoId: "m2" })];
    const { board, $ } = montar({ quadro, tarefas });
    await board.abrir();
    $("tk-filtro-marco").value = "m1";
    $("tk-filtro-marco").dispatchEvent(new Event("change"));
    expect($("tk-board").querySelectorAll(".kanban-card")).toHaveLength(1);
  });

  it("lista de marcos mostra mensagem de vazio quando não há nenhum", async () => {
    const { board, $ } = montar({});
    await board.abrir();
    expect($("tk-marcos-lista").textContent).toContain("Nenhum marco");
  });

  it("cartão mostra chip de etiqueta, badge de prioridade e progresso do checklist", async () => {
    const quadro = quadroFixture({ etiquetas: [{ id: "e1", nome: "Urgente", cor: "#ff0000" }] });
    const tarefas = [
      tarefaFixture({
        id: "t1",
        etiquetaIds: ["e1"],
        prioridade: "urgente",
        checklist: [{ id: "c1", texto: "a", feito: true }, { id: "c2", texto: "b", feito: false }],
        comentarios: [{ id: "co1", texto: "oi", criadoEm: "2026-01-01T00:00:00.000Z" }],
      }),
    ];
    const { board, $ } = montar({ quadro, tarefas });
    await board.abrir();
    const card = $("tk-board").querySelector(".kanban-card");
    expect(card.querySelector(".kanban-card-etiqueta")).toBeTruthy();
    expect(card.querySelector(".kanban-card-prioridade").textContent).toContain("urgente");
    expect(card.querySelector(".kanban-card-checklist").textContent).toContain("1/2");
    expect(card.querySelector(".kanban-card-comentarios").textContent).toContain("1");
  });

  it("cartão mostra badge de tipo, 'sub de <mãe>' e 'bloqueada por N'", async () => {
    const mae = tarefaFixture({ id: "mae", titulo: "épico" });
    const filha = tarefaFixture({ id: "t1", tipo: "bug", parentId: "mae", dependeDe: ["mae"] });
    const { board, $ } = montar({ tarefas: [mae, filha] });
    await board.abrir();
    const card = $("tk-board").querySelector('.kanban-card[data-id="t1"]');
    expect(card.querySelector(".kanban-card-tipo").textContent).toContain("bug");
    expect(card.querySelector(".kanban-card-sub").textContent).toContain("épico");
    expect(card.querySelector(".kanban-card-bloqueada").textContent).toContain("1");
  });
});

describe("modal de tarefa", () => {
  it("abrir cartão preenche o modal com os dados da tarefa e mostra 'Apagar'/'Abrir conversa'", async () => {
    const { board, $ } = montar({ tarefas: [tarefaFixture({ id: "t1", titulo: "revisar PR" })] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-titulo").value).toBe("revisar PR");
    expect($("btn-tk-apagar").classList.contains("hidden")).toBe(false);
    expect($("btn-tk-abrir-conversa").classList.contains("hidden")).toBe(false);
    expect($("tk-checklist-wrap").classList.contains("hidden")).toBe(false);
  });

  it("abrir cartão preenche tipo/subtarefa/dependências e exclui a própria tarefa das listas", async () => {
    const outra = tarefaFixture({ id: "outra", titulo: "outra tarefa" });
    const mae = tarefaFixture({ id: "mae", titulo: "épico" });
    const t1 = tarefaFixture({ id: "t1", titulo: "x", tipo: "feature", parentId: "mae", dependeDe: ["outra"] });
    const { board, $ } = montar({ tarefas: [outra, mae, t1] });
    await board.abrir();
    $("tk-board").querySelector('.kanban-card[data-id="t1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-tipo").value).toBe("feature");
    expect($("tk-f-parent").value).toBe("mae");
    expect([...$("tk-f-depende-de").selectedOptions].map((o) => o.value)).toEqual(["outra"]);
    // a própria tarefa (t1) não pode aparecer como opção de mãe/dependência de si mesma
    expect([...$("tk-f-parent").options].some((o) => o.value === "t1")).toBe(false);
    expect([...$("tk-f-depende-de").options].some((o) => o.value === "t1")).toBe(false);
  });

  it("salvar manda tipo/parentId/dependeDe no corpo da requisição", async () => {
    const outra = tarefaFixture({ id: "outra", titulo: "outra" });
    const { board, req, $ } = montar({ tarefas: [outra, tarefaFixture({ id: "t1" })] });
    await board.abrir();
    $("tk-board").querySelector('.kanban-card[data-id="t1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    $("tk-f-tipo").value = "chore";
    $("tk-f-parent").value = "outra";
    [...$("tk-f-depende-de").options].find((o) => o.value === "outra").selected = true;
    $("btn-tk-salvar").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const chamada = req.mock.calls.find(([path, opts]) => path.startsWith("/v1/tarefas/t1?") && opts?.method === "PUT");
    const body = JSON.parse(chamada[1].body);
    expect(body.tipo).toBe("chore");
    expect(body.parentId).toBe("outra");
    expect(body.dependeDe).toEqual(["outra"]);
  });

  it("carrega commits relacionados ao abrir uma tarefa existente; tarefa nova não mostra a seção", async () => {
    const commits = { t1: [{ hash: "abc1234def", mensagem: "corrige tk-1", data: "2026-01-01T00:00:00.000Z" }] };
    const req = fakeBackend({ quadro: quadroFixture(), tarefas: [tarefaFixture({ id: "t1" })], commits });
    document.body.innerHTML = HTML;
    const board = createTarefasBoard({
      req,
      el: (id) => document.getElementById(id),
      getProjectPath: () => "/proj",
      aoAbrirConversa: vi.fn(),
    });
    board.ligar();
    await board.abrir();
    const $ = (id) => document.getElementById(id);
    $("tk-board").querySelector('.kanban-card[data-id="t1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect($("tk-commits-wrap").classList.contains("hidden")).toBe(false);
    expect($("tk-f-commits").textContent).toContain("corrige tk-1");

    $("tk-board").querySelector(".kanban-col-add").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-commits-wrap").classList.contains("hidden")).toBe(true);
  });

  it("botão '+ tarefa' da coluna abre modal vazio sem 'Apagar', com aviso de salvar antes de comentar", async () => {
    const { board, $ } = montar({ tarefas: [] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-col-add").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-titulo").value).toBe("");
    expect($("btn-tk-apagar").classList.contains("hidden")).toBe(true);
    expect($("tk-checklist-wrap").classList.contains("hidden")).toBe(true);
    expect($("tk-checklist-hint").classList.contains("hidden")).toBe(false);
  });

  it("apagar usa o diálogo injetado (não window.confirm) e não apaga se a pessoa cancelar", async () => {
    const confirmar = vi.fn(async () => false);
    const { board, req, $ } = montar({ tarefas: [tarefaFixture({ id: "t1" })], confirmar });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const chamadasAntes = req.mock.calls.length; // já abriu o modal (busca de commits inclusa)
    $("btn-tk-apagar").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(confirmar).toHaveBeenCalledWith("Apagar esta tarefa? Não volta.");
    expect(req.mock.calls.length).toBe(chamadasAntes); // não chamou DELETE nenhum
    expect($("tarefa-modal").classList.contains("hidden")).toBe(false);
  });

  it("marcar/desmarcar etiqueta no modal reflete no chip visual (data-on)", async () => {
    const quadro = quadroFixture({ etiquetas: [{ id: "e1", nome: "Urgente", cor: "#ff0000" }] });
    const { board, $ } = montar({ quadro, tarefas: [tarefaFixture({ id: "t1", etiquetaIds: ["e1"] })] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const opcao = $("tk-f-etiquetas").querySelector("label");
    expect(opcao.dataset.on).toBe("1");
    opcao.querySelector("input").click();
    expect(opcao.dataset.on).toBe("0");
  });
});

describe("visualizações novas (lista/calendário/timeline)", () => {
  it("trocar de aba mostra o contêiner certo e esconde os outros três", async () => {
    const { board, $ } = montar({ tarefas: [] });
    await board.abrir();
    $("tab-tk-lista").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-lista").classList.contains("hidden")).toBe(false);
    expect($("tk-board").classList.contains("hidden")).toBe(true);
    expect($("tk-calendario").classList.contains("hidden")).toBe(true);
    expect($("tk-timeline").classList.contains("hidden")).toBe(true);
    expect($("tab-tk-lista").dataset.on).toBe("1");
    expect($("tab-tk-kanban").dataset.on).toBe("0");

    $("tab-tk-calendario").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-calendario").classList.contains("hidden")).toBe(false);
    expect($("tk-lista").classList.contains("hidden")).toBe(true);

    $("tab-tk-timeline").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-timeline").classList.contains("hidden")).toBe(false);
    expect($("tk-calendario").classList.contains("hidden")).toBe(true);

    $("tab-tk-kanban").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-board").classList.contains("hidden")).toBe(false);
    expect($("tk-timeline").classList.contains("hidden")).toBe(true);
  });

  it("lista: clique numa linha abre o modal com os dados da tarefa", async () => {
    const { board, $ } = montar({ tarefas: [tarefaFixture({ id: "t1", titulo: "revisar PR" })] });
    await board.abrir();
    $("tab-tk-lista").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const linha = $("tk-lista-corpo").querySelector("tr");
    expect(linha.textContent).toContain("revisar PR");
    linha.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-titulo").value).toBe("revisar PR");
  });

  it("lista: filtro por tipo esconde quem não bate", async () => {
    const tarefas = [
      tarefaFixture({ id: "t1", titulo: "bug aqui", tipo: "bug" }),
      tarefaFixture({ id: "t2", titulo: "feature aqui", tipo: "feature" }),
    ];
    const { board, $ } = montar({ tarefas });
    await board.abrir();
    $("tab-tk-lista").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-lista-corpo").children.length).toBe(2);
    $("tk-lf-tipo").value = "bug";
    $("tk-lf-tipo").dispatchEvent(new Event("change"));
    expect($("tk-lista-corpo").children.length).toBe(1);
    expect($("tk-lista-corpo").textContent).toContain("bug aqui");
  });

  it("calendário: chip do dia com prazo abre o modal", async () => {
    const hoje = new Date();
    const prazo = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
    const { board, $ } = montar({ tarefas: [tarefaFixture({ id: "t1", titulo: "com prazo hoje", prazo })] });
    await board.abrir();
    $("tab-tk-calendario").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const chip = $("tk-cal-grade").querySelector(".tk-cal-chip");
    expect(chip.textContent).toBe("com prazo hoje");
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-titulo").value).toBe("com prazo hoje");
  });

  it("timeline: sem marco com data nenhuma, mostra aviso de vazio", async () => {
    const quadro = quadroFixture({ marcos: [{ id: "m1", nome: "sem data" }] });
    const { board, $ } = montar({ quadro, tarefas: [] });
    await board.abrir();
    $("tab-tk-timeline").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-timeline-vazio").classList.contains("hidden")).toBe(false);
    expect($("tk-timeline-corpo").children.length).toBe(0);
  });

  it("timeline: clique na barra expande a lista de tarefas do marco, clique numa tarefa abre o modal", async () => {
    const quadro = quadroFixture({ marcos: [{ id: "m1", nome: "v1.0", prazo: "2026-06-01" }] });
    const tarefas = [tarefaFixture({ id: "t1", titulo: "da v1", marcoId: "m1" })];
    const { board, $ } = montar({ quadro, tarefas });
    await board.abrir();
    $("tab-tk-timeline").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const barra = $("tk-timeline-corpo").querySelector(".tk-tl-barra");
    const lista = $("tk-timeline-corpo").querySelector(".tk-tl-tarefas");
    expect(lista.classList.contains("hidden")).toBe(true);
    barra.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lista.classList.contains("hidden")).toBe(false);
    lista.querySelector("li").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-f-titulo").value).toBe("da v1");
  });
});

describe("checklist e comentários (fluxo completo via backend falso)", () => {
  it("adiciona item de checklist e ele aparece na lista e no cartão", async () => {
    const quadro = quadroFixture();
    const tarefas = [tarefaFixture({ id: "t1" })];
    const req = fakeBackend({ quadro, tarefas });
    const board = createTarefasBoard({
      req,
      el: (id) => document.getElementById(id),
      getProjectPath: () => "/proj",
      aoAbrirConversa: vi.fn(),
      confirmar: vi.fn(async () => true),
      avisar: vi.fn(async () => {}),
    });
    document.body.innerHTML = HTML;
    board.ligar();
    await board.abrir();
    const $ = (id) => document.getElementById(id);
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    $("tk-checklist-novo-texto").value = "escrever teste";
    $("btn-tk-checklist-add").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect($("tk-f-checklist").textContent).toContain("escrever teste");
    expect($("tk-board").querySelector(".kanban-card-checklist")?.textContent).toContain("0/1");
  });

  it("adiciona comentário e ele aparece na lista", async () => {
    const quadro = quadroFixture();
    const tarefas = [tarefaFixture({ id: "t1" })];
    const req = fakeBackend({ quadro, tarefas });
    const board = createTarefasBoard({
      req,
      el: (id) => document.getElementById(id),
      getProjectPath: () => "/proj",
      aoAbrirConversa: vi.fn(),
      confirmar: vi.fn(async () => true),
      avisar: vi.fn(async () => {}),
    });
    document.body.innerHTML = HTML;
    board.ligar();
    await board.abrir();
    const $ = (id) => document.getElementById(id);
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    $("tk-comentario-novo-texto").value = "olha isso";
    $("btn-tk-comentario-add").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect($("tk-f-comentarios").textContent).toContain("olha isso");
  });
});
