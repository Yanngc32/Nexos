// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { camposMudados, createPlanejamentoBoard, previaDoCorpo, rotuloDaFonte, sugestoesDeRef } from "../planejamento-board.js";

// o markup de verdade da tela, direto do index.html: teste e app não divergem
const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const INICIO = INDEX.indexOf('<section class="pane" id="pane-planejamento">');
// o pane tem <section> dentro (diálogo de envio): fecha no </section> da indentação dele
const PANE = INDEX.slice(INICIO, INDEX.indexOf("\n      </section>", INICIO) + 17);

function planoBase() {
  return {
    slug: "plano-1",
    dir: "/x",
    roteiro: {
      titulo: "Meu plano",
      rev: 3,
      etapas: [
        { id: "a", titulo: "Etapa A", status: "concluida" },
        { id: "b", titulo: "Etapa B", status: "pendente" },
      ],
    },
    cards: [
      { id: "r1", tipo: "requisito", titulo: "Req 1", etapa: "a", links: ["s1"], rev: 1, corpo: "ver [[Amb]]" },
      { id: "s1", tipo: "sugestao", titulo: "Sug", etapa: "b", links: [], rev: 2, corpo: "", fonte: "https://www.hono.dev/x" },
      { id: "amb", tipo: "ambiguidade", titulo: "Amb", etapa: "b", status: "aberta", links: [], rev: 1, corpo: "" },
    ],
    layout: { posicoes: {} },
    invalidos: [],
  };
}

function montar({ slug = "plano-1", respostas = {}, deps = {} } = {}) {
  document.body.innerHTML = PANE;
  let plano = planoBase();
  const chamadas = [];
  const req = vi.fn(async (path, opts = {}) => {
    const metodo = opts.method || "GET";
    chamadas.push({ metodo, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    const chave = `${metodo} ${path.split("?")[0]}`;
    if (respostas[chave]) return respostas[chave]({ plano, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (metodo === "GET" && path.startsWith("/v1/planejamento?")) return [{ slug: "plano-1", titulo: "Meu plano", etapas: 2, concluidas: 1 }];
    if (metodo === "GET") return structuredClone(plano);
    return {};
  });
  const confirmar = vi.fn(async () => true);
  const avisar = vi.fn();
  const board = createPlanejamentoBoard({
    req,
    api: (p) => p,
    headers: () => ({}),
    el: (id) => document.getElementById(id),
    getProjectPath: () => "/proj",
    getSlug: () => slug,
    lerEventos: null,
    confirmar,
    avisar,
    ...deps,
  });
  board.ligar();
  return { board, req, chamadas, confirmar, avisar, setPlano: (p) => (plano = p), plano: () => plano };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* sem storage */
  }
});

describe("puros", () => {
  it("prévia tira marcação e resolve [[ref]]; fonte mostra o host", () => {
    expect(previaDoCorpo("# Título\n**forte** e [[Outro card]]")).toBe("Título forte e Outro card");
    expect(rotuloDaFonte("https://www.hono.dev/docs")).toBe("hono.dev");
    expect(rotuloDaFonte("src/a.ts:12")).toBe("src/a.ts:12");
  });

  it("camposMudados só devolve o que a pessoa mexeu", () => {
    expect(camposMudados({ titulo: "a", corpo: "x", tipo: "nota" }, { titulo: "a", corpo: "y", tipo: "nota", etapa: "" })).toEqual({ corpo: "y" });
  });

  it("sugestões de [[ casam sem acento e excluem o próprio card", () => {
    const cards = [{ id: "a", titulo: "Decisão" }, { id: "b", titulo: "Outra decisao" }];
    expect(sugestoesDeRef(cards, "decis", "a").map((c) => c.id)).toEqual(["b"]);
  });
});

describe("tela", () => {
  it("conversa que não é plano mostra o convite", async () => {
    const { board } = montar({ slug: "" });
    await board.abrir();
    expect(document.getElementById("pl-vazio-conversa").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("pl-corpo").classList.contains("hidden")).toBe(true);
  });

  it("pinta título, roteiro, colunas, cards e setas", async () => {
    const { board } = montar();
    await board.abrir();
    expect(document.getElementById("pl-titulo").value).toBe("Meu plano");
    expect(document.getElementById("pl-selo").textContent).toBe("1 de 2 etapas");
    expect([...document.querySelectorAll(".pl-etapa")].map((li) => li.dataset.status)).toEqual(["concluida", "pendente"]);
    expect([...document.querySelectorAll(".pl-coluna")].map((c) => c.dataset.id)).toEqual(["a", "b"]);
    expect([...document.querySelectorAll(".pl-card")].map((c) => c.dataset.tipo)).toEqual(["requisito", "sugestao", "ambiguidade"]);
    expect(document.querySelector('.pl-card[data-id="s1"] .pl-card-fonte').textContent).toBe("hono.dev ↗");
    expect(document.querySelector('.pl-card[data-id="amb"] .pl-card-selo').textContent).toBe("aberta");
    const tipos = [...document.querySelectorAll(".pl-aresta")].map((p) => p.getAttribute("class"));
    expect(tipos).toEqual(["pl-aresta pl-aresta-sequencia", "pl-aresta pl-aresta-ligacao", "pl-aresta pl-aresta-referencia"]);
  });

  it("clique no status da etapa manda o próximo status com o rev; conflito reaplica uma vez", async () => {
    let tentativas = 0;
    const { board, chamadas } = montar({
      respostas: {
        "PUT /v1/planejamento/plano-1/etapas/b": ({ plano, body }) => {
          tentativas++;
          if (tentativas === 1) {
            const e = new Error("mudou");
            e.status = 409;
            e.data = { atual: { ...plano.roteiro, rev: 7 } };
            throw e;
          }
          return { ...plano.roteiro, rev: 8, etapas: plano.roteiro.etapas.map((x) => (x.id === "b" ? { ...x, status: body.status } : x)) };
        },
      },
    });
    await board.abrir();
    document.querySelectorAll(".pl-etapa-marca")[1].click();
    await vi.waitFor(() => expect(tentativas).toBe(2));
    const puts = chamadas.filter((c) => c.metodo === "PUT");
    expect(puts.map((c) => c.body)).toEqual([
      { status: "em_andamento", expectedRev: 3 },
      { status: "em_andamento", expectedRev: 7 },
    ]);
    await vi.waitFor(() => expect(document.querySelectorAll(".pl-etapa")[1].dataset.status).toBe("em_andamento"));
  });

  it("duplo clique abre o editor; fechar grava só o que mudou, com o rev", async () => {
    const { board, chamadas } = montar({
      respostas: { "PUT /v1/planejamento/plano-1/cards/r1": ({ plano, body }) => ({ ...plano.cards[0], ...body, rev: 2 }) },
    });
    await board.abrir();
    document.querySelector('.pl-card[data-id="r1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.getElementById("pl-editor").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("pl-ed-titulo").value).toBe("Req 1");
    expect(document.getElementById("pl-ed-etapa").value).toBe("a");
    document.getElementById("pl-ed-titulo").value = "Req renomeado";
    document.getElementById("btn-pl-ed-fechar").click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.metodo === "PUT")).toBe(true));
    expect(chamadas.find((c) => c.metodo === "PUT").body).toEqual({ titulo: "Req renomeado", expectedRev: 1 });
    await vi.waitFor(() => expect(document.getElementById("pl-editor").classList.contains("hidden")).toBe(true));
  });

  it("tipo sugestão mostra o campo fonte; ambiguidade mostra a situação", async () => {
    const { board } = montar();
    await board.abrir();
    document.querySelector('.pl-card[data-id="amb"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.getElementById("pl-ed-situacao-campo").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("pl-ed-fonte-campo").classList.contains("hidden")).toBe(true);
    document.querySelector('.pl-ed-tipo[data-tipo="sugestao"]').click();
    expect(document.getElementById("pl-ed-fonte-campo").classList.contains("hidden")).toBe(false);
  });

  it("Delete no card selecionado confirma e apaga com o rev", async () => {
    const { board, chamadas, confirmar } = montar();
    await board.abrir();
    const n = document.querySelector('.pl-card[data-id="s1"]');
    n.click();
    n.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await vi.waitFor(() => expect(chamadas.some((c) => c.metodo === "DELETE")).toBe(true));
    expect(confirmar).toHaveBeenCalled();
    expect(chamadas.find((c) => c.metodo === "DELETE").path).toContain("/cards/s1?projectPath=%2Fproj&rev=2");
  });

  it("+ Card cria na coluna e abre o editor", async () => {
    const { board, chamadas } = montar({
      respostas: {
        "POST /v1/planejamento/plano-1/cards": ({ body }) => ({ id: "novo-card", links: [], rev: 1, corpo: "", ...body }),
      },
    });
    await board.abrir();
    document.getElementById("btn-pl-card").click();
    await vi.waitFor(() => expect(document.getElementById("pl-ed-id").textContent).toBe("novo-card"));
    expect(chamadas.find((c) => c.metodo === "POST").body).toEqual({ tipo: "nota", titulo: "Novo card" });
  });
});

describe("enviar para implementação", () => {
  const rascunho = {
    texto: "# Implementação: Meu plano\n",
    pedido: "Gere agora o handoff",
    prontidao: { bloqueios: [{ tipo: "ambiguidade-aberta", ref: "amb", texto: 'Ambiguidade aberta: "Amb"' }], avisos: [{ tipo: "etapa-nao-concluida", texto: "A etapa B ainda está pendente." }] },
  };

  it("ambiguidade aberta trava os botões até marcar 'enviar mesmo assim'; rascunho vai pra revisão; enviar abre a conversa", async () => {
    const aoAbrirConversa = vi.fn();
    const { board, chamadas } = montar({
      deps: { getProfileId: () => "p1", aoAbrirConversa },
      respostas: {
        "GET /v1/planejamento/plano-1/handoff/rascunho": () => rascunho,
        "POST /v1/planejamento/plano-1/handoff/enviar": () => ({ threadId: "th-impl", handoff: "2026-09-24-01.md" }),
      },
    });
    await board.abrir();
    document.getElementById("btn-pl-enviar").click();
    await vi.waitFor(() => expect(document.getElementById("pl-envio").classList.contains("hidden")).toBe(false));
    expect(document.getElementById("pl-envio-bloqueios-lista").textContent).toContain("Amb");
    expect(document.getElementById("btn-pl-envio-rascunho").disabled).toBe(true);
    const mesmoAssim = document.getElementById("pl-envio-mesmo-assim");
    mesmoAssim.checked = true;
    mesmoAssim.dispatchEvent(new Event("change"));
    expect(document.getElementById("btn-pl-envio-rascunho").disabled).toBe(false);
    document.getElementById("btn-pl-envio-rascunho").click();
    expect(document.getElementById("pl-envio-prompt").value).toBe("# Implementação: Meu plano");
    document.getElementById("pl-envio-prompt").value = "# Editado";
    document.getElementById("btn-pl-envio-enviar").click();
    await vi.waitFor(() => expect(aoAbrirConversa).toHaveBeenCalledWith("th-impl"));
    expect(chamadas.find((c) => c.path.includes("/handoff/enviar")).body).toEqual({ texto: "# Editado", profileId: "p1" });
    expect(document.getElementById("pl-envio").classList.contains("hidden")).toBe(true);
  });

  it("pedir ao Manager manda o pedido no chat e pega o arquivo novo que ele gravar", async () => {
    const aoPedirAoManager = vi.fn();
    let handoffs = [{ nome: "2026-09-24-01.md", texto: "velho" }];
    const { board } = montar({
      deps: { aoPedirAoManager },
      respostas: {
        "GET /v1/planejamento/plano-1/handoff/rascunho": () => ({ ...rascunho, prontidao: { bloqueios: [], avisos: [] } }),
        "GET /v1/planejamento/plano-1/handoff": () => handoffs,
      },
    });
    await board.abrir();
    document.getElementById("btn-pl-enviar").click();
    await vi.waitFor(() => expect(document.getElementById("pl-envio-tudo-certo").classList.contains("hidden")).toBe(false));
    document.getElementById("btn-pl-envio-manager").click();
    await vi.waitFor(() => expect(aoPedirAoManager).toHaveBeenCalledWith("Gere agora o handoff"));
    expect(document.getElementById("pl-envio-gerando").classList.contains("hidden")).toBe(false);
    handoffs = [...handoffs, { nome: "2026-09-24-02.md", texto: "# Do Manager\n" }];
    board._aoEvento({ type: "mudou", slug: "plano-1", alvo: "handoff", origem: "agente" });
    await vi.waitFor(() => expect(document.getElementById("pl-envio-prompt").value).toBe("# Do Manager"));
    expect(document.getElementById("pl-envio-revisar").classList.contains("hidden")).toBe(false);
  });
});
