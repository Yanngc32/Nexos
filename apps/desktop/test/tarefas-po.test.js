// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTarefasBoard,
  tituloEfetivo,
  resumoDoCard,
  colunaDoMeio,
  acaoDoPo,
  aguardaVoce,
  dicaDoSeloPo,
  dicaDoAguardando,
  tipoDeResposta,
  mensagemDeResposta,
  textoDoMotivo,
  rotuloDoAutor,
  tempoAtras,
  linhaDoPo,
  assinarSse,
  MENSAGEM_AUTORIZAR,
} from "../tarefas-board.js";

// Mesmo esqueleto do tarefas-board.test.js + a linha do PO e o bloco do PO no detalhe.
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
  <p id="tk-po-status" class="hidden"></p>
  <p id="tk-erro" class="hidden"></p>
  <div id="tk-board"></div>
  <div id="tk-lista" class="hidden">
    <select id="tk-lf-coluna"><option value="">Todas as colunas</option></select>
    <select id="tk-lf-tipo"><option value="">Todos os tipos</option></select>
    <select id="tk-lf-prioridade"><option value="">Todas as prioridades</option></select>
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
    <section id="tk-po-wrap" class="hidden"></section>
    <input id="tk-f-titulo" />
    <textarea id="tk-f-descricao"></textarea>
    <select id="tk-f-coluna"></select>
    <select id="tk-f-marco"></select>
    <select id="tk-f-prioridade"><option value="">Nenhuma</option></select>
    <input id="tk-f-responsavel" />
    <input id="tk-f-agente" />
    <input id="tk-f-prazo" type="date" />
    <select id="tk-f-tipo"><option value="">Nenhum</option></select>
    <select id="tk-f-parent"><option value="">Nenhuma</option></select>
    <select id="tk-f-depende-de" multiple></select>
    <div id="tk-commits-wrap" class="hidden"><ul id="tk-f-commits"></ul></div>
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

const COLS2 = [
  { id: "cl-a", nome: "A fazer", ordem: 0 },
  { id: "cl-b", nome: "Feito", ordem: 1 },
];
const COLS3 = [
  { id: "cl-a", nome: "A fazer", ordem: 0 },
  { id: "cl-m", nome: "Fazendo", ordem: 1 },
  { id: "cl-z", nome: "Feito", ordem: 2 },
];

function tarefa(over = {}) {
  return {
    id: "tk-1",
    projectPath: "/proj",
    titulo: "x",
    colunaId: "cl-a",
    ordem: 0,
    etiquetaIds: [],
    checklist: [],
    comentarios: [],
    ...over,
  };
}

const AGORA = Date.parse("2026-11-19T12:00:00.000Z");
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/**
 * Monta o quadro com um backend falso: `poStatus` = resposta de /v1/po/status (função que lança
 * simula o 404). `sse` = capturar o `aoEvento` que o quadro assina.
 */
function montar({ colunas = COLS2, tarefas = [], poStatus, enviar, comSse = false } = {}) {
  document.body.innerHTML = HTML;
  let lista = tarefas;
  const req = vi.fn(async (path, opts = {}) => {
    if (path.startsWith("/v1/po/status")) {
      if (typeof poStatus === "function") return poStatus();
      if (poStatus === undefined) {
        const e = new Error("Not Found");
        e.status = 404;
        throw e;
      }
      return poStatus;
    }
    if (path.startsWith("/v1/tarefas/quadro")) return { projectPath: "/proj", colunas, marcos: [], etiquetas: [] };
    if (/^\/v1\/tarefas\/[^/?]+\/commits/.test(path)) return [];
    const mUm = /^\/v1\/tarefas\/([^/?]+)\?/.exec(path);
    if (mUm && (opts.method ?? "GET") === "PUT") {
      const body = JSON.parse(opts.body);
      lista = lista.map((t) => (t.id === mUm[1] ? { ...t, ...body } : t));
      return lista.find((t) => t.id === mUm[1]);
    }
    if (mUm) return lista.find((t) => t.id === mUm[1]);
    if (path.startsWith("/v1/tarefas")) return lista;
    return {};
  });
  const sse = { aoEvento: null, rota: null };
  const fetchStream = comSse
    ? vi.fn(async (rota) => {
        sse.rota = rota;
        return { ok: true, body: {} };
      })
    : null;
  const lerEventos = comSse
    ? vi.fn((_res, onEvent) => {
        sse.aoEvento = onEvent;
        return new Promise(() => {}); // stream aberto pra sempre
      })
    : null;
  const enviarParaConversa = enviar ?? vi.fn(async () => "sent");
  const board = createTarefasBoard({
    req,
    el: (id) => document.getElementById(id),
    getProjectPath: () => "/proj",
    aoAbrirConversa: vi.fn(),
    confirmar: vi.fn(async () => true),
    avisar: vi.fn(async () => {}),
    enviarParaConversa,
    fetchStream,
    lerEventos,
    agora: () => AGORA,
  });
  board.ligar();
  const atualizar = (novas) => (lista = novas);
  return { board, req, sse, enviarParaConversa, atualizar, $: (id) => document.getElementById(id) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("helpers da camada do PO (puros)", () => {
  it("título efetivo: o do PO quando há, senão o original", () => {
    expect(tituloEfetivo(tarefa({ titulo: "a", po: { titulo: "B", em: "x" } }))).toBe("B");
    expect(tituloEfetivo(tarefa({ titulo: "a", po: { titulo: "  ", em: "x" } }))).toBe("a");
    expect(tituloEfetivo(tarefa({ titulo: "a" }))).toBe("a");
  });

  it("resumo: o do PO; sem resumo e com título reescrito, o título do agente", () => {
    expect(resumoDoCard(tarefa({ po: { resumo: "faz X", em: "x" } }))).toBe("faz X");
    expect(resumoDoCard(tarefa({ titulo: "orig", po: { titulo: "Novo", em: "x" } }))).toBe("orig");
    expect(resumoDoCard(tarefa())).toBe("");
  });

  it("coluna do meio só com 3+ colunas", () => {
    expect(colunaDoMeio(COLS3)).toBe("cl-m");
    expect(colunaDoMeio(COLS2)).toBeUndefined();
    expect(colunaDoMeio([])).toBeUndefined();
  });

  it("ação do PO: adicionou / corrigiu / reescreveu / revisou / nada", () => {
    expect(acaoDoPo(tarefa({ criadoPor: "po" }), COLS3)).toBe("adicionou");
    expect(acaoDoPo(tarefa({ fonte: { status: "in_progress" }, po: { status: "completed", em: "x" } }), COLS3)).toBe("corrigiu");
    expect(acaoDoPo(tarefa({ titulo: "a", po: { titulo: "B", em: "x" } }), COLS3)).toBe("reescreveu");
    expect(acaoDoPo(tarefa({ fonte: { status: "pending" }, po: { status: "pending", em: "x" } }), COLS3)).toBe("revisou");
    expect(acaoDoPo(tarefa(), COLS3)).toBeNull();
  });

  it("aguardando você: ação pedida e cartão não feito", () => {
    expect(aguardaVoce(tarefa({ po: { acaoVoce: "Autorizar deploy", status: "pending", em: "x" } }))).toBe(true);
    expect(aguardaVoce(tarefa({ po: { acaoVoce: "Autorizar deploy", status: "completed", em: "x" } }))).toBe(false);
    expect(aguardaVoce(tarefa({ po: { acaoVoce: " ", em: "x" } }))).toBe(false);
  });

  it("tooltips do selo e do chip trazem o motivo", () => {
    expect(dicaDoSeloPo("corrigiu", "testes passam")).toBe("PO corrigiu\nMotivo: testes passam");
    expect(dicaDoSeloPo("revisou")).toBe("PO revisou");
    expect(dicaDoAguardando(tarefa({ po: { acaoVoce: "Escolher a cor", motivo: "duas opções", em: "x" } }))).toBe(
      "O que você precisa fazer: Escolher a cor\nMotivo: duas opções",
    );
  });

  it("tipo de resposta: campo explícito; sem ele, autorizar/aprovar vira botão", () => {
    expect(tipoDeResposta(tarefa({ po: { tipoResposta: "responder", acaoVoce: "Autorizar", em: "x" } }))).toBe("responder");
    expect(tipoDeResposta(tarefa({ po: { tipoResposta: "botao", acaoVoce: "Diga a cor", em: "x" } }))).toBe("botao");
    expect(tipoDeResposta(tarefa({ po: { acaoVoce: "Aprovar o PR", em: "x" } }))).toBe("botao");
    expect(tipoDeResposta(tarefa({ po: { acaoVoce: "Diga a cor", em: "x" } }))).toBe("responder");
  });

  it("mensagem de resposta cita o cartão e o pedido", () => {
    const t = tarefa({ titulo: "a", po: { titulo: "Deploy", acaoVoce: "Autorizar deploy", em: "x" } });
    expect(mensagemDeResposta(t, "Pode fazer.")).toBe('Pode fazer.\n\nCartão do quadro: "Deploy" (pedido: Autorizar deploy)');
    expect(mensagemDeResposta(tarefa({ titulo: "a" }), "oi")).toBe('oi\n\nCartão do quadro: "a"');
  });

  it("motivo atual: com status corrigido diz pra onde o PO mandou", () => {
    const t = tarefa({ fonte: { status: "in_progress" }, po: { status: "completed", motivo: "commit abc entrou", em: "x" } });
    expect(textoDoMotivo(t, COLS3)).toBe("marcou como feito: commit abc entrou");
    expect(textoDoMotivo(tarefa({ fonte: { status: "pending" }, po: { status: "pending", motivo: "ok", em: "x" } }), COLS3)).toBe("ok");
  });

  it("rótulo do autor: PO / Você / Agente / Sistema", () => {
    expect(rotuloDoAutor("po")).toBe("PO");
    expect(rotuloDoAutor(undefined)).toBe("Você");
    expect(rotuloDoAutor("voce")).toBe("Você");
    expect(rotuloDoAutor("agente")).toBe("Agente");
    expect(rotuloDoAutor("sistema")).toBe("Sistema");
  });

  it("tempo atrás", () => {
    expect(tempoAtras(new Date(AGORA - 20_000).toISOString(), AGORA)).toBe("agora");
    expect(tempoAtras(new Date(AGORA - 5 * 60_000).toISOString(), AGORA)).toBe("há 5 min");
    expect(tempoAtras(new Date(AGORA - 3 * 3600_000).toISOString(), AGORA)).toBe("há 3 h");
    expect(tempoAtras(new Date(AGORA - 2 * 86400_000).toISOString(), AGORA)).toBe("há 2 d");
    expect(tempoAtras("lixo", AGORA)).toBeNull();
  });

  it("linha do PO: texto + estado; null sem rodada", () => {
    const em = new Date(AGORA - 4 * 60_000).toISOString();
    expect(linhaDoPo({ ligado: true, ultima: { em, fase: "abertura", resultado: "ok", cards: 3 } }, AGORA)).toEqual({
      texto: "O PO atualizou o quadro há 4 min",
      estado: "rodada de abertura · ok · 3 cartões",
      erro: false,
    });
    expect(linhaDoPo({ ligado: false, ultima: { em, resultado: "erro" } }, AGORA)).toEqual({
      texto: "O PO atualizou o quadro há 4 min",
      estado: "falhou · PO desligado",
      erro: true,
    });
    expect(linhaDoPo({ ligado: true }, AGORA)).toBeNull();
    expect(linhaDoPo(null, AGORA)).toBeNull();
  });
});

describe("assinarSse", () => {
  it("assina a rota com headers e entrega os eventos", async () => {
    const eventos = [];
    const fetchStream = vi.fn(async () => ({ ok: true, body: {} }));
    const lerEventos = vi.fn(async (_res, on) => {
      on({ tipo: "moveu" });
      return new Promise(() => {});
    });
    const cancelar = assinarSse({
      fetchStream,
      lerEventos,
      api: (r) => `http://d${r}`,
      headers: () => ({ Authorization: "Bearer t" }),
      rota: "/v1/tarefas/events?projectPath=x",
      aoEvento: (ev) => eventos.push(ev),
    });
    await flush();
    expect(fetchStream).toHaveBeenCalledWith("http://d/v1/tarefas/events?projectPath=x", expect.objectContaining({ headers: { Authorization: "Bearer t" } }));
    expect(eventos).toEqual([{ tipo: "moveu" }]);
    cancelar();
    expect(fetchStream.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("religa com atraso crescente quando a conexão cai", async () => {
    const agendar = vi.fn();
    const fetchStream = vi.fn(async () => ({ ok: false, status: 500 }));
    assinarSse({ fetchStream, lerEventos: vi.fn(), rota: "/r", aoEvento: () => {}, agendar });
    await flush();
    expect(agendar).toHaveBeenCalledTimes(1);
    expect(agendar.mock.calls[0][1]).toBe(1500);
    agendar.mock.calls[0][0]();
    await flush();
    expect(agendar.mock.calls[1][1]).toBe(3000);
  });

  it("sem fetchStream/lerEventos não assina", () => {
    expect(typeof assinarSse({ rota: "/r", aoEvento: () => {} })).toBe("function");
  });
});

describe("cartão com a camada do PO", () => {
  it("título do PO, resumo embaixo, selo com motivo no tooltip e chip Aguardando você", async () => {
    const { board, $ } = montar({
      colunas: COLS3,
      tarefas: [
        tarefa({
          id: "t1",
          titulo: "fix bug 12",
          fonte: { status: "pending" },
          po: { titulo: "Corrigir login", resumo: "Login quebra no Safari", status: "pending", motivo: "precisa de chave", acaoVoce: "Autorizar o deploy", em: "e1" },
        }),
        tarefa({ id: "t2", titulo: "outra", fonte: { status: "in_progress" }, colunaId: "cl-m", po: { status: "completed", motivo: "commit abc", em: "e1" } }),
      ],
    });
    await board.abrir();
    const c1 = $("tk-board").querySelector('.kanban-card[data-id="t1"]');
    expect(c1.querySelector(".kanban-card-title").textContent).toBe("Corrigir login");
    expect(c1.querySelector(".kanban-card-resumo").textContent).toBe("Login quebra no Safari");
    const selo1 = c1.querySelector(".tk-po-selo");
    expect(selo1.dataset.acao).toBe("reescreveu");
    expect(selo1.title).toBe("PO reescreveu\nMotivo: precisa de chave");
    expect(selo1.getAttribute("aria-label")).toBe(selo1.title);
    expect(selo1.querySelector("svg")).not.toBeNull();
    const chip = c1.querySelector(".tk-po-aguardando");
    expect(chip.textContent).toBe("Aguardando você");
    expect(chip.title).toContain("Autorizar o deploy");
    expect(chip.getAttribute("aria-label")).toBe(chip.title);
    expect(c1.tabIndex).toBe(0);

    const c2 = $("tk-board").querySelector('.kanban-card[data-id="t2"]');
    expect(c2.querySelector(".tk-po-selo").title).toBe("PO corrigiu\nMotivo: commit abc");
    expect(c2.querySelector(".tk-po-aguardando")).toBeNull();
  });

  it("cartão sem camada não ganha selo", async () => {
    const { board, $ } = montar({ tarefas: [tarefa({ id: "t1", titulo: "puro" })] });
    await board.abrir();
    expect($("tk-board").querySelector(".kanban-card-po")).toBeNull();
    expect($("tk-board").querySelector(".kanban-card-resumo")).toBeNull();
  });

  it("Enter no cartão abre o detalhe (teclado)", async () => {
    const { board, $ } = montar({ tarefas: [tarefa({ id: "t1", titulo: "revisar" })] });
    await board.abrir();
    const card = $("tk-board").querySelector(".kanban-card");
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect($("tk-f-titulo").value).toBe("revisar");
  });
});

describe("resposta pelo cartão", () => {
  const pedindo = (over = {}) =>
    tarefa({ id: "t1", titulo: "deploy", threadId: "th-1", po: { acaoVoce: "Autorizar o deploy", tipoResposta: "botao", status: "pending", em: "e1" }, ...over });

  it("tipo botão: 'Pode fazer' manda a mensagem pra conversa do cartão", async () => {
    const { board, $, enviarParaConversa } = montar({ tarefas: [pedindo()] });
    await board.abrir();
    const btn = $("tk-board").querySelector(".tk-po-autorizar");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toBe("Pode fazer");
    btn.click();
    await flush();
    expect(enviarParaConversa).toHaveBeenCalledWith("th-1", `${MENSAGEM_AUTORIZAR}\n\nCartão do quadro: "deploy" (pedido: Autorizar o deploy)`);
    expect($("tk-board").querySelector(".tk-po-enviado").textContent).toBe("Enviado");
    // clicar no botão não abre o detalhe
    expect($("tarefa-modal").classList.contains("hidden")).toBe(true);
  });

  it("tipo responder: caixa + Enviar manda o texto", async () => {
    const { board, $, enviarParaConversa } = montar({
      tarefas: [pedindo({ po: { acaoVoce: "Qual cor usar?", tipoResposta: "responder", status: "pending", em: "e1" } })],
    });
    await board.abrir();
    const caixa = $("tk-board").querySelector("textarea.tk-po-texto");
    caixa.value = "azul";
    $("tk-board").querySelector("button.tk-po-enviar").click();
    await flush();
    expect(enviarParaConversa).toHaveBeenCalledWith("th-1", 'azul\n\nCartão do quadro: "deploy" (pedido: Qual cor usar?)');
  });

  it("Enter na caixa manda; caixa vazia não manda", async () => {
    const { board, $, enviarParaConversa } = montar({
      tarefas: [pedindo({ po: { acaoVoce: "Qual cor?", tipoResposta: "responder", status: "pending", em: "e1" } })],
    });
    await board.abrir();
    const caixa = $("tk-board").querySelector("textarea.tk-po-texto");
    caixa.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(enviarParaConversa).not.toHaveBeenCalled();
    caixa.value = "verde";
    caixa.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(enviarParaConversa).toHaveBeenCalledTimes(1);
  });

  it("conversa sumida e falha viram aviso, e o botão volta", async () => {
    const enviar = vi.fn().mockResolvedValueOnce("missing").mockResolvedValueOnce("failed");
    const { board, $ } = montar({ tarefas: [pedindo()], enviar });
    await board.abrir();
    const btn = $("tk-board").querySelector(".tk-po-autorizar");
    btn.click();
    await flush();
    const aviso = $("tk-board").querySelector(".tk-po-resposta-erro");
    expect(aviso.textContent).toBe("A conversa deste cartão não está mais aqui.");
    expect(aviso.classList.contains("hidden")).toBe(false);
    expect(aviso.getAttribute("role")).toBe("alert");
    expect(btn.disabled).toBe(false);
    btn.click();
    await flush();
    expect(aviso.textContent).toBe("Não deu para enviar. Tente de novo.");
  });

  it("cartão sem conversa não mostra resposta no cartão", async () => {
    const { board, $ } = montar({ tarefas: [pedindo({ threadId: undefined })] });
    await board.abrir();
    expect($("tk-board").querySelector(".tk-po-resposta")).toBeNull();
    expect($("tk-board").querySelector(".tk-po-aguardando")).not.toBeNull();
  });
});

describe("arrastar pra coluna do meio", () => {
  function arrastar($, id, colunaId) {
    const dt = { setData() {}, effectAllowed: "", dropEffect: "" };
    const card = $("tk-board").querySelector(`.kanban-card[data-id="${id}"]`);
    const ini = new Event("dragstart", { bubbles: true });
    Object.defineProperty(ini, "dataTransfer", { value: dt });
    card.dispatchEvent(ini);
    const alvo = $("tk-board").querySelector(`.kanban-col-cards[data-coluna-id="${colunaId}"]`);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    alvo.dispatchEvent(drop);
  }

  it("cartão com conversa avisa o agente pra começar", async () => {
    const { board, $, enviarParaConversa } = montar({
      colunas: COLS3,
      tarefas: [tarefa({ id: "t1", titulo: "a", threadId: "th-9", po: { titulo: "Ajustar header", em: "e" } })],
    });
    await board.abrir();
    arrastar($, "t1", "cl-m");
    await vi.waitFor(() => expect(enviarParaConversa).toHaveBeenCalledWith("th-9", 'Comece a trabalhar nesta tarefa: "Ajustar header"'));
  });

  it("pra outra coluna, ou sem conversa, não manda nada", async () => {
    const { board, $, enviarParaConversa, req } = montar({
      colunas: COLS3,
      tarefas: [tarefa({ id: "t1", threadId: "th-9" }), tarefa({ id: "t2", ordem: 1 })],
    });
    await board.abrir();
    arrastar($, "t1", "cl-z");
    await vi.waitFor(() => expect(req.mock.calls.some(([p, o]) => p.startsWith("/v1/tarefas/t1?") && o?.method === "PUT")).toBe(true));
    await flush();
    await board.abrir();
    arrastar($, "t2", "cl-m");
    await vi.waitFor(() => expect(req.mock.calls.some(([p, o]) => p.startsWith("/v1/tarefas/t2?") && o?.method === "PUT")).toBe(true));
    await flush();
    expect(enviarParaConversa).not.toHaveBeenCalled();
  });
});

describe("linha de status do PO", () => {
  it("mostra quando o PO rodou e o estado da rodada", async () => {
    const em = new Date(AGORA - 10 * 60_000).toISOString();
    const { board, $ } = montar({ poStatus: { ligado: true, ultima: { em, fase: "fechamento", resultado: "ok", cards: 2 } } });
    await board.abrir();
    await flush();
    const p = $("tk-po-status");
    expect(p.classList.contains("hidden")).toBe(false);
    expect(p.querySelector(".tk-po-status-quando").textContent).toBe("O PO atualizou o quadro há 10 min");
    expect(p.querySelector(".tk-po-status-estado").textContent).toBe("rodada de fechamento · ok · 2 cartões");
  });

  it("404 em /v1/po/status: some calado, sem erro no quadro", async () => {
    const { board, $ } = montar({ poStatus: undefined });
    await board.abrir();
    await flush();
    expect($("tk-po-status").classList.contains("hidden")).toBe(true);
    expect($("tk-erro").classList.contains("hidden")).toBe(true);
  });

  it("sem rodada ainda: escondida", async () => {
    const { board, $ } = montar({ poStatus: { ligado: true } });
    await board.abrir();
    await flush();
    expect($("tk-po-status").classList.contains("hidden")).toBe(true);
  });
});

describe("SSE do quadro", () => {
  it("assina /v1/tarefas/events do projeto e recarrega em qualquer evento de tarefa", async () => {
    const { board, req, sse, atualizar, $ } = montar({ comSse: true, tarefas: [tarefa({ id: "t1", titulo: "antes" })] });
    await board.abrir();
    await flush();
    expect(sse.rota).toBe("/v1/tarefas/events?projectPath=%2Fproj");
    expect(typeof sse.aoEvento).toBe("function");
    atualizar([tarefa({ id: "t1", titulo: "depois", comentarios: [{ id: "c1", texto: "oi", criadoEm: "2026-01-01T00:00:00.000Z" }] })]);
    const antes = req.mock.calls.filter(([p]) => p.startsWith("/v1/tarefas?")).length;
    sse.aoEvento({ tipo: "comentou", projectPath: "/proj", tarefaId: "t1" });
    sse.aoEvento({ tipo: "checklist", projectPath: "/proj", tarefaId: "t1" });
    await vi.waitFor(() => expect($("tk-board").querySelector(".kanban-card-title").textContent).toBe("depois"));
    // rajada vira uma recarga só
    expect(req.mock.calls.filter(([p]) => p.startsWith("/v1/tarefas?")).length).toBe(antes + 1);
  });

  it("evento de outro projeto é ignorado", async () => {
    const { board, req, sse } = montar({ comSse: true });
    await board.abrir();
    await flush();
    const antes = req.mock.calls.length;
    sse.aoEvento({ tipo: "moveu", projectPath: "/outro" });
    await new Promise((r) => setTimeout(r, 200));
    expect(req.mock.calls.length).toBe(antes);
  });

  it("po.rodada atualiza a linha do PO na hora", async () => {
    const { board, sse, $ } = montar({ comSse: true, poStatus: undefined });
    await board.abrir();
    await flush();
    expect($("tk-po-status").classList.contains("hidden")).toBe(true);
    sse.aoEvento({ tipo: "po.rodada", projectPath: "/proj", ligado: true, ultima: { em: new Date(AGORA).toISOString(), fase: "abertura", resultado: "ok" } });
    const p = $("tk-po-status");
    expect(p.classList.contains("hidden")).toBe(false);
    expect(p.querySelector(".tk-po-status-quando").textContent).toBe("O PO atualizou o quadro agora");
    expect(p.querySelector(".tk-po-status-estado").textContent).toBe("rodada de abertura · ok");
  });
});

describe("detalhe do cartão com a camada do PO", () => {
  it("mostra O que você precisa fazer, Motivo atual e Pendência de (clicável)", async () => {
    const mae = tarefa({ id: "mae", titulo: "épico", po: { titulo: "Épico do login", em: "e" } });
    const filha = tarefa({
      id: "t1",
      titulo: "sub",
      parentId: "mae",
      ordem: 1,
      threadId: "th-1",
      fonte: { status: "pending" },
      po: { acaoVoce: "Escolher o provedor", tipoResposta: "responder", motivo: "duas opções", status: "pending", em: "e" },
    });
    const { board, $ } = montar({ colunas: COLS3, tarefas: [mae, filha] });
    await board.abrir();
    $("tk-board").querySelector('.kanban-card[data-id="t1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const wrap = $("tk-po-wrap");
    expect(wrap.classList.contains("hidden")).toBe(false);
    const rotulos = [...wrap.querySelectorAll(".tk-po-rotulo")].map((h) => h.textContent);
    expect(rotulos).toEqual(["O que você precisa fazer", "Motivo atual", "Pendência de"]);
    const secaoAcao = wrap.querySelector(".tk-po-secao.is-acao");
    expect(secaoAcao.querySelector(".tk-po-texto-secao").textContent).toBe("Escolher o provedor");
    expect(secaoAcao.querySelector("textarea.tk-po-texto")).not.toBeNull();
    expect([...wrap.querySelectorAll(".tk-po-texto-secao")][1].textContent).toBe("duas opções");
    const btnMae = wrap.querySelector("button.tk-po-mae");
    expect(btnMae.textContent).toBe("Épico do login");
    expect(btnMae.getAttribute("aria-label")).toBe('Abrir o cartão "Épico do login"');
    btnMae.click();
    expect($("tk-f-titulo").value).toBe("épico");
  });

  it("cartão sem camada: bloco do PO escondido", async () => {
    const { board, $ } = montar({ tarefas: [tarefa({ id: "t1" })] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-po-wrap").classList.contains("hidden")).toBe(true);
  });

  it("pedido sem conversa explica como responder", async () => {
    const { board, $ } = montar({ tarefas: [tarefa({ id: "t1", po: { acaoVoce: "Revisar o texto", status: "pending", em: "e" } })] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("tk-po-wrap").querySelector(".tk-po-dica").textContent).toBe("Este cartão não tem conversa — responda abrindo uma.");
  });

  it("timeline de comentários rotula PO / Você / Agente / Sistema", async () => {
    const comentarios = [
      { id: "c1", texto: "a", autor: "po", criadoEm: "2026-01-01T00:00:00.000Z" },
      { id: "c2", texto: "b", criadoEm: "2026-01-01T00:00:00.000Z" },
      { id: "c3", texto: "c", autor: "agente", criadoEm: "2026-01-01T00:00:00.000Z" },
      { id: "c4", texto: "d", autor: "sistema", criadoEm: "2026-01-01T00:00:00.000Z" },
    ];
    const { board, $ } = montar({ tarefas: [tarefa({ id: "t1", comentarios })] });
    await board.abrir();
    $("tk-board").querySelector(".kanban-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const itens = [...$("tk-f-comentarios").querySelectorAll("li")];
    expect(itens.map((li) => li.querySelector(".tk-comentario-autor").textContent)).toEqual(["PO", "Você", "Agente", "Sistema"]);
    expect(itens.map((li) => li.dataset.autor)).toEqual(["po", "voce", "agente", "sistema"]);
  });
});
