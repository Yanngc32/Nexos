// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createTarefasBoard, moverNaLista, ordenarPorOrdem, filtrarPorMarco } from "../tarefas-board.js";

const HTML = `
  <select id="tk-filtro-marco"></select>
  <button id="btn-tk-marcos"></button>
  <div id="tk-marcos-painel" class="hidden">
    <ul id="tk-marcos-lista"></ul>
    <input id="tk-marco-nome" />
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
function fakeBackend({ quadro, tarefas }) {
  const t = () => tarefas;
  return vi.fn(async (path, opts = {}) => {
    const method = opts.method ?? "GET";
    if (path.startsWith("/v1/tarefas/quadro")) return quadro;
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
    const chamadasAntes = req.mock.calls.length;
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
