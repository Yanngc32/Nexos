// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  camposMudados,
  chaveDoAnexo,
  createPlanejamentoBoard,
  opcoesDeAnexo,
  previaDoCorpo,
  rotuloDaFonte,
  sugestoesDeRef,
  MODELO_SPEC_TELA,
  estadoDoDesign,
  telaSemMock,
} from "../planejamento-board.js";

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

  it("avisa quem abriu a tela a cada plano carregado (tela cheia liga Manager e Implementação)", async () => {
    const aoCarregarPlano = vi.fn();
    const { board } = montar({ deps: { aoCarregarPlano } });
    await board.abrir();
    expect(aoCarregarPlano).toHaveBeenCalledTimes(1);
    expect(aoCarregarPlano.mock.calls[0][0].roteiro.titulo).toBe("Meu plano");
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
    // plano com etapas: "uma tarefa por etapa no Quadro" vem ligado
    expect(chamadas.find((c) => c.path.includes("/handoff/enviar")).body).toEqual({ texto: "# Editado", profileId: "p1", quadro: true });
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

describe("anexos e Quadro (F7)", () => {
  const alvos = {
    ds: [
      { sistema: "oficial", nome: "Oficial", ativo: true, cards: [{ id: "login", titulo: "Tela de login", secao: "Telas" }, { id: "botao", titulo: "Botão", secao: "Base" }] },
      { sistema: "mocks", nome: "Mocks", ativo: false, cards: [{ id: "m1", titulo: "Mock de login", secao: "Outros" }] },
    ],
    tarefas: [{ id: "tk-1", titulo: "Fazer login", coluna: "A fazer", feita: false }],
  };

  it("opções: busca sem acento em título/seção/DS e tira o que o card já tem", () => {
    expect(opcoesDeAnexo(alvos, "ds", "LOGIN").map((o) => o.anexo.card)).toEqual(["login", "m1"]);
    expect(opcoesDeAnexo(alvos, "ds", "mocks").map((o) => o.titulo)).toEqual(["Mock de login"]);
    expect(opcoesDeAnexo(alvos, "ds", "", [{ tipo: "ds", sistema: "oficial", card: "login" }]).map((o) => o.anexo.card)).toEqual(["botao", "m1"]);
    expect(opcoesDeAnexo(alvos, "tarefa", "fazer")).toEqual([{ anexo: { tipo: "tarefa", id: "tk-1" }, titulo: "Fazer login", detalhe: "A fazer", feita: false }]);
    expect(chaveDoAnexo({ tipo: "ds", sistema: "a", card: "b" })).toBe("ds:a/b");
  });

  function planoComAnexos() {
    const p = planoBase();
    p.cards[0].anexos = [
      { tipo: "ds", sistema: "oficial", card: "login" },
      { tipo: "tarefa", id: "tk-sumiu" },
    ];
    p.roteiro.etapas[0].tarefaId = "tk-a";
    p.integracao = {
      anexos: {
        "ds:oficial/login": { existe: true, titulo: "Tela de login", detalhe: "Oficial · Telas" },
        "tarefa:tk-sumiu": { existe: false, titulo: "Tarefa apagada" },
      },
      etapas: { a: { tarefaId: "tk-a", existe: true, titulo: "Etapa A", coluna: "Fazendo", feita: false } },
    };
    return p;
  }

  it("card mostra os anexos resolvidos (apagado riscado); clique abre a prévia da tela e dela o Canvas; etapa mostra o selo do Quadro", async () => {
    const aoAbrirDs = vi.fn();
    const aoAbrirTarefa = vi.fn();
    const tela = {
      sistema: { id: "oficial", nome: "Oficial" },
      card: { id: "login", titulo: "Tela de login", html: '<div class="x">Entrar</div>' },
      css: ":root{--color-bg:#111}",
      vars: [],
      kitCss: "",
      projetoAbs: "/proj",
    };
    const { board, setPlano, chamadas } = montar({ deps: { aoAbrirDs, aoAbrirTarefa }, respostas: { "GET /v1/ds/tela": () => tela } });
    setPlano(planoComAnexos());
    await board.abrir();
    const chips = [...document.querySelectorAll('.pl-card[data-id="r1"] .pl-anexo')];
    expect(chips.map((c) => [c.textContent.replace(/[▣☐☑]/g, ""), c.dataset.existe])).toEqual([
      ["Tela de login", "1"],
      ["Tarefa apagada", "0"],
    ]);
    chips[0].querySelector("button").click();
    await vi.waitFor(() => expect(document.getElementById("pl-previa-frame").classList.contains("hidden")).toBe(false));
    expect(chamadas.some((c) => c.path.startsWith("/v1/ds/tela?") && c.path.includes("sistema=oficial") && c.path.includes("card=login"))).toBe(true);
    expect(document.getElementById("pl-previa").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("pl-previa-titulo").textContent).toBe("Tela de login");
    const srcdoc = document.getElementById("pl-previa-frame").getAttribute("srcdoc");
    expect(srcdoc).toContain('<div class="x">Entrar</div>');
    expect(srcdoc).toContain("--color-bg:#111");
    expect(aoAbrirDs).not.toHaveBeenCalled();
    document.getElementById("btn-pl-previa-canvas").click();
    expect(aoAbrirDs).toHaveBeenCalledWith("oficial", "login");
    expect(document.getElementById("pl-previa").classList.contains("hidden")).toBe(true);
    expect(chips[1].querySelector("button").disabled).toBe(true);

    const selo = document.querySelector(".pl-etapa .pl-etapa-quadro");
    expect(selo.textContent).toBe("Fazendo");
    selo.click();
    expect(aoAbrirTarefa).toHaveBeenCalledWith("tk-a");
    expect(document.querySelector('.pl-coluna[data-id="a"] .pl-coluna-quadro').textContent).toBe("Quadro: Fazendo");
  });

  it("editor: + Tela abre o seletor, escolher grava o anexo; ✕ tira", async () => {
    const { board, chamadas } = montar({
      respostas: {
        "GET /v1/planejamento/alvos": () => alvos,
        "PUT /v1/planejamento/plano-1/cards/r1": ({ plano, body }) => ({ ...plano.cards[0], ...body, rev: 2 }),
      },
    });
    await board.abrir();
    document.querySelector('.pl-card[data-id="r1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.getElementById("pl-ed-anexos").textContent).toMatch(/Nenhuma/);
    document.getElementById("btn-pl-ed-anexar-ds").click();
    await vi.waitFor(() => expect(document.querySelectorAll(".pl-ed-picker-item").length).toBe(3));
    const filtro = document.getElementById("pl-ed-picker-filtro");
    filtro.value = "botão";
    filtro.dispatchEvent(new Event("input"));
    const itens = [...document.querySelectorAll(".pl-ed-picker-item")];
    expect(itens.map((i) => i.querySelector(".pl-ed-picker-nome").textContent)).toEqual(["Botão"]);
    itens[0].click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.metodo === "PUT" && c.path.includes("/cards/r1"))).toBe(true));
    const put = chamadas.find((c) => c.metodo === "PUT" && c.path.includes("/cards/r1"));
    expect(put.body).toEqual({ anexos: [{ tipo: "ds", sistema: "oficial", card: "botao" }], expectedRev: 1 });
    expect(document.getElementById("pl-ed-picker").classList.contains("hidden")).toBe(true);
  });

  it("Etapas → Quadro confirma, cria e avisa; sem etapa nova só avisa", async () => {
    const { board, chamadas, avisar, setPlano } = montar({
      respostas: { "POST /v1/planejamento/plano-1/quadro": () => ({ marcoId: "m1", tarefas: [{ etapa: "a", tarefaId: "t1", criada: true }, { etapa: "b", tarefaId: "t2", criada: true }] }) },
    });
    await board.abrir();
    document.getElementById("btn-pl-quadro").click();
    await vi.waitFor(() => expect(avisar).toHaveBeenCalledWith(expect.stringMatching(/2 tarefa\(s\) criada/)));
    expect(chamadas.some((c) => c.metodo === "POST" && c.path.includes("/quadro"))).toBe(true);

    const p = planoComAnexos();
    p.integracao.etapas.b = { tarefaId: "tk-b", existe: true, coluna: "A fazer", feita: false };
    setPlano(p);
    await board.recarregar();
    avisar.mockClear();
    document.getElementById("btn-pl-quadro").click();
    await vi.waitFor(() => expect(avisar).toHaveBeenCalledWith(expect.stringMatching(/já têm tarefa/)));
  });
});

describe("implementação marcada no plano", () => {
  it("etapa com marca mostra o estado e o clique avança; card feito mostra ✓ e o editor desmarca", async () => {
    const { board, chamadas, setPlano } = montar({
      respostas: {
        "PUT /v1/planejamento/plano-1/etapas/a/implementacao": ({ plano, body }) => ({
          roteiro: { ...plano.roteiro, rev: 4, etapas: plano.roteiro.etapas.map((e) => (e.id === "a" ? { ...e, implementacao: body.estado } : e)) },
        }),
        "PUT /v1/planejamento/plano-1/cards/r1": ({ plano, body }) => ({ ...plano.cards[0], ...body, rev: 2 }),
      },
    });
    const p = planoBase();
    p.roteiro.etapas[0].implementacao = "em_andamento";
    p.cards[0].feito = true;
    setPlano(p);
    await board.abrir();
    const impl = document.querySelector(".pl-etapa .pl-etapa-impl");
    expect(impl.dataset.estado).toBe("em_andamento");
    // etapa sem marca e sem tarefa no Quadro não mostra o botão
    expect(document.querySelectorAll(".pl-etapa-impl")).toHaveLength(1);
    expect(document.querySelector('.pl-coluna[data-id="a"] .pl-coluna-impl').textContent).toBe("Implementando");
    impl.click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.path.includes("/implementacao"))).toBe(true));
    expect(chamadas.find((c) => c.path.includes("/implementacao")).body).toEqual({ estado: "feita", expectedRev: 3 });

    expect(document.querySelector('.pl-card[data-id="r1"]').dataset.feito).toBe("1");
    document.querySelector('.pl-card[data-id="r1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const caixa = document.getElementById("pl-ed-feito");
    expect(caixa.checked).toBe(true);
    caixa.checked = false;
    caixa.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(chamadas.some((c) => c.metodo === "PUT" && c.path.includes("/cards/r1"))).toBe(true));
    expect(chamadas.find((c) => c.metodo === "PUT" && c.path.includes("/cards/r1")).body).toEqual({ feito: false, expectedRev: 1 });
  });
});

describe("card de Tela", () => {
  it("mostra mock pendente até ter tela do DS anexada; escolher o tipo no editor põe o esqueleto da spec", async () => {
    const { board, setPlano } = montar();
    const p = planoBase();
    p.cards.push(
      { id: "t1", tipo: "tela", titulo: "Login", etapa: "a", links: [], anexos: [], rev: 1, corpo: "spec" },
      { id: "t2", tipo: "tela", titulo: "Painel", etapa: "a", links: [], anexos: [{ tipo: "ds", sistema: "mocks", card: "painel" }], rev: 1, corpo: "spec" },
    );
    setPlano(p);
    await board.abrir();
    expect(telaSemMock(p.cards.at(-2))).toBe(true);
    expect(document.querySelector('.pl-card[data-id="t1"] .pl-card-mock').dataset.estado).toBe("sem_mock");
    // t2 tem anexo mas o GET não resolveu (sem integracao): continua valendo como mock
    expect(document.querySelector('.pl-card[data-id="t2"] .pl-card-mock').dataset.estado).toBe("sem_mock");

    document.querySelector('.pl-card[data-id="r1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    document.getElementById("pl-ed-corpo").value = "";
    document.querySelector('#pl-ed-tipos button[data-tipo="tela"]').click();
    expect(document.getElementById("pl-ed-corpo").value).toBe(MODELO_SPEC_TELA);
  });
});

describe("aprovação do design", () => {
  function planoComMock(design) {
    const p = planoBase();
    p.cards.push({
      id: "t1",
      tipo: "tela",
      titulo: "Login",
      etapa: "a",
      links: [],
      anexos: [{ tipo: "ds", sistema: "mocks", card: "login" }],
      rev: 1,
      corpo: "spec",
      ...(design ? { design } : {}),
    });
    p.integracao = { anexos: { "ds:mocks/login": { existe: true, titulo: "Login mock", hash: "h1" } }, etapas: {} };
    return p;
  }

  it("estado: aguardando sem veredito ou com mock/hash diferente; aprovado/reprovado só pro mock avaliado", () => {
    const integ = { anexos: { "ds:mocks/login": { existe: true, hash: "h1" } } };
    const card = (design) => ({ tipo: "tela", anexos: [{ tipo: "ds", sistema: "mocks", card: "login" }], design });
    expect(estadoDoDesign({ tipo: "nota" }, integ)).toBe(null);
    expect(estadoDoDesign({ tipo: "tela", anexos: [] }, integ)).toBe("sem_mock");
    expect(estadoDoDesign(card(undefined), integ)).toBe("aguardando");
    expect(estadoDoDesign(card({ veredito: "aprovado", mock: "ds:mocks/login", hash: "h1" }), integ)).toBe("aprovado");
    expect(estadoDoDesign(card({ veredito: "aprovado", mock: "ds:mocks/login", hash: "h0" }), integ)).toBe("aguardando");
    expect(estadoDoDesign(card({ veredito: "reprovado", mock: "ds:mocks/outro" }), integ)).toBe("aguardando");
    // tela só de referência de layout não é mock: não pede aprovação
    expect(estadoDoDesign({ tipo: "tela", anexos: [{ tipo: "ds", sistema: "mocks", card: "login", referencia: true }] }, integ)).toBe("sem_mock");
  });

  it("mock novo mostra Aprovar/Reprovar no card; aprovar grava; reprovar exige motivo pelo editor", async () => {
    const { board, chamadas, avisar, setPlano } = montar({
      respostas: {
        "POST /v1/planejamento/plano-1/cards/t1/design": ({ plano, body }) => ({
          card: { ...plano.cards.find((c) => c.id === "t1"), rev: 2, design: { veredito: body.veredito, mock: "ds:mocks/login", hash: "h1", ...(body.motivo ? { motivo: body.motivo } : {}) } },
          avisou: true,
        }),
      },
    });
    setPlano(planoComMock());
    await board.abrir();
    const no = () => document.querySelector('.pl-card[data-id="t1"]');
    expect(no().querySelector(".pl-card-mock").dataset.estado).toBe("aguardando");
    no().querySelector(".pl-design-aprovar").click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.path.includes("/design"))).toBe(true));
    expect(chamadas.find((c) => c.path.includes("/design")).body).toEqual({ veredito: "aprovado", expectedRev: 1 });
    expect(no().querySelector(".pl-card-mock").dataset.estado).toBe("aprovado");
    expect(no().querySelector(".pl-card-design")).toBe(null);

    // reprovar: pelo editor, sem motivo não vai
    setPlano(planoComMock());
    await board.recarregar();
    chamadas.length = 0;
    no().querySelector(".pl-design-reprovar").click();
    expect(document.getElementById("pl-ed-design").classList.contains("hidden")).toBe(false);
    document.getElementById("btn-pl-ed-reprovar").click();
    expect(avisar).toHaveBeenCalledWith(expect.stringMatching(/o que mudar/));
    expect(chamadas.some((c) => c.path.includes("/design"))).toBe(false);
    document.getElementById("pl-ed-design-motivo").value = "botão maior";
    document.getElementById("btn-pl-ed-reprovar").click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.path.includes("/design"))).toBe(true));
    expect(chamadas.find((c) => c.path.includes("/design")).body).toEqual({ veredito: "reprovado", motivo: "botão maior", expectedRev: 1 });
    expect(document.getElementById("pl-ed-design-estado").textContent).toBe("Reprovado: botão maior");
  });
});
