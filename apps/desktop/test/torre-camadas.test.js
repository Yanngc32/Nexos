import { describe, expect, it } from "vitest";
import {
  aplicarEventoAgente,
  aplicarEventoRun,
  aplicarRetrato,
  autorDaMudanca,
  chaveDoProjeto,
  feedVazio,
  VOLTA_MS,
} from "../torre/feed.js";
import { ATIVA_MS, corDoProjeto, estadoDaConversa, resumoDaTorre, torreModelo, tituloCurto } from "../torre/modelo.js";
import { torreLugares } from "../torre/lugares.js";
import { retratoDaTorre, torreEventos } from "../torre/eventos.js";
import { acaoDaFerramenta, aplicarEventosNoCerebro, cerebroNovo, decidir } from "../torre/cerebro.js";
import { hashTexto, sorteioDe } from "../torre/acaso.js";
import { POSES } from "../torre/poses.js";

const P = "C:\\proj\\Nexos";
const T0 = 1_000_000;

function ag(threadId, extra = {}) {
  return {
    threadId,
    projectPath: P,
    busy: false,
    aguardando: false,
    emEspera: 0,
    pendingQuota: false,
    passos: [],
    preview: `Conversa ${threadId}`,
    updatedAt: new Date(T0).toISOString(),
    ...extra,
  };
}

function torre(modelo, chave = chaveDoProjeto(P)) {
  return modelo.torres.find((t) => t.chave === chave);
}

describe("feed", () => {
  it("chave do projeto igual à do motor", () => {
    expect(chaveDoProjeto("C:\\Proj\\Nexos\\")).toBe("c:/proj/nexos");
    expect(chaveDoProjeto("")).toBe("");
  });

  it("chamada Agent abre e fecha pelo id; erro volta ferido", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true })], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "Agent", id: "c1", input: { subagent_type: "Explore", description: "onde o plano é montado" } }, T0 + 1);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "Task", id: "c2", input: {} }, T0 + 2);
    expect(f.chamadas.get("c1")).toMatchObject({ tipo: "Explore", descricao: "onde o plano é montado", background: false });
    expect(f.chamadas.get("c2").tipo).toBe("general-purpose");
    aplicarEventoAgente(f, { type: "tool_result", threadId: "t1", id: "c1", result: "ok" }, T0 + 10);
    aplicarEventoAgente(f, { type: "tool_result", threadId: "t1", id: "c2", result: "x", isError: true }, T0 + 11);
    expect(f.chamadas.get("c1").fim).toEqual({ em: T0 + 10, erro: false });
    expect(f.chamadas.get("c2").fim).toEqual({ em: T0 + 11, erro: true });
  });

  it("subagente em 2º plano só volta quando a espera da conversa zera", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true })], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "Agent", id: "bg", input: { run_in_background: true } }, T0 + 1);
    aplicarEventoAgente(f, { type: "tool_result", threadId: "t1", id: "bg", result: "launched" }, T0 + 2);
    expect(f.chamadas.get("bg").fim).toBeUndefined();
    aplicarEventoAgente(f, { type: "em_espera", threadId: "t1", tarefas: 1 }, T0 + 3);
    expect(f.chamadas.get("bg").fim).toBeUndefined();
    aplicarEventoAgente(f, { type: "em_espera", threadId: "t1", tarefas: 0 }, T0 + 50);
    expect(f.chamadas.get("bg").fim).toEqual({ em: T0 + 50, erro: false });
  });

  it("turno que acabou sem evento (SSE caiu) não deixa explorador preso", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true })], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "Agent", id: "c1", input: {} }, T0 + 1);
    aplicarRetrato(f, [ag("t1", { busy: false, lastTerminal: "done" })], T0 + 2000);
    expect(f.chamadas.get("c1").fim.em).toBe(T0 + 2000);
    expect(f.terminouEm.get("t1")).toBe(T0 + 2000);
  });

  it("primeiro retrato não marca começo nem fim", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true })], T0);
    expect(f.pedidoEm.size).toBe(0);
    aplicarRetrato(f, [ag("t1", { busy: true }), ag("t2", { busy: true })], T0 + 1);
    expect(f.pedidoEm.get("t2")).toBe(T0 + 1);
  });

  it("autor da mudança no Quadro: ferramenta da mesma tarefa em até 3 s", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true }), ag("t2", { busy: true })], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "mcp__nexo__nexo_tarefa_salvar", input: { id: "tk-1", colunaId: "c2" } }, T0 + 100);
    aplicarEventoAgente(f, { type: "tool", threadId: "t2", name: "mcp__nexo__nexo_tarefa_comentar", input: { tarefaId: "tk-2" } }, T0 + 200);
    expect(autorDaMudanca(f, { tarefaId: "tk-1", via: "agente" }, T0 + 500)).toEqual({ tipo: "conversa", threadId: "t1" });
    expect(autorDaMudanca(f, { tarefaId: "tk-2", via: "agente" }, T0 + 500)).toEqual({ tipo: "conversa", threadId: "t2" });
    expect(autorDaMudanca(f, { tarefaId: "tk-1", via: "agente" }, T0 + 5000)).toEqual({ tipo: "sozinho" });
    expect(autorDaMudanca(f, { tarefaId: "tk-1" }, T0 + 500)).toEqual({ tipo: "voce" });
    aplicarEventoAgente(f, { type: "tool", threadId: "t2", name: "mcp__nexo__nexo_plano_implementacao", input: { etapa: "a" } }, T0 + 600);
    expect(autorDaMudanca(f, { tarefaId: "tk-9", via: "plano" }, T0 + 700)).toEqual({ tipo: "conversa", threadId: "t2" });
  });

  it("runs de hook acendem e apagam", () => {
    const f = feedVazio();
    expect(aplicarEventoRun(f, { type: "run_start", runId: "r1", projectPath: P, hook: true, time: "Hook: Memória" }, T0)).toBe(true);
    expect(f.runs.get("r1").ativo).toBe(true);
    aplicarEventoRun(f, { type: "run_end", runId: "r1", status: "done" }, T0 + 5);
    expect(f.runs.get("r1")).toMatchObject({ ativo: false, fimEm: T0 + 5 });
  });
});

describe("modelo", () => {
  it("estado de cada conversa", () => {
    expect(estadoDaConversa(ag("a", { aguardando: true, busy: true }))).toBe("esperando");
    expect(estadoDaConversa(ag("a", { pendingQuota: true }))).toBe("sem-mana");
    expect(estadoDaConversa(ag("a", { busy: true }), { fase: "pensando" })).toBe("pensando");
    expect(estadoDaConversa(ag("a", { busy: true }), { fase: "ferramenta" })).toBe("trabalhando");
    expect(estadoDaConversa(ag("a", { emEspera: 2 }))).toBe("segundo-plano");
    expect(estadoDaConversa(ag("a", { lastTerminal: "auth" }))).toBe("erro");
    expect(estadoDaConversa(ag("a", { lastTerminal: "done" }))).toBe("terminou");
    expect(estadoDaConversa(ag("a"))).toBe("ocioso");
  });

  it("ativa = pendência ou parou há menos de 10 min; hook e Manager não sentam no Salão", () => {
    const f = feedVazio();
    const velho = new Date(T0 - ATIVA_MS - 1).toISOString();
    aplicarRetrato(
      f,
      [
        ag("trab", { busy: true }),
        ag("fim", { lastTerminal: "done", updatedAt: new Date(T0 - 60_000).toISOString() }),
        ag("velho", { lastTerminal: "done", updatedAt: velho }),
        ag("hook", { busy: true, runId: "r1", oculta: true, runTitle: "Hook: Resumos do repo map" }),
        ag("ds", { busy: true, oculta: true }),
        ag("mgr", { busy: true, planejamento: { slug: "plano-x" } }),
      ],
      T0,
    );
    const t = torre(torreModelo(f, T0));
    expect(t.magos.map((m) => m.threadId).sort()).toEqual(["fim", "trab"]);
    expect(t.bibliotecarios).toMatchObject([{ runId: "r1" }]);
    expect(t.astronomos).toMatchObject([{ threadId: "mgr", slug: "plano-x", estado: "trabalhando" }]);
    expect(t.janelas).toMatchObject({ observatorio: true, salao: 1, biblioteca: true });
    expect(resumoDaTorre(t)).toBe("1 trabalhando");
  });

  it("implementação herda a aparência do Manager e o Manager sai do Observatório", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("mgr", { planejamento: { slug: "p" }, lastTerminal: "done" }), ag("impl", { busy: true, handoff: { slug: "p" } })], T0);
    const t = torre(torreModelo(f, T0));
    expect(t.astronomos).toEqual([]);
    const impl = t.magos.find((m) => m.threadId === "impl");
    expect(impl.semente).toBe(hashTexto("mgr"));
    expect(impl.herdouDe).toBe("mgr");
    // o Manager que volta ao Salão não fica com a mesma roupa da implementação
    expect(t.magos.find((m) => m.threadId === "mgr").semente).not.toBe(impl.semente);
  });

  it("exploradores por torre, mais recentes primeiro, teto 6 + escondidos", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("t1", { busy: true })], T0);
    for (let i = 0; i < 8; i++) {
      aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "Agent", id: `c${i}`, input: { subagent_type: "Explore", description: `busca ${i}` } }, T0 + i);
    }
    const t = torre(torreModelo(f, T0 + 10));
    expect(t.exploradores).toHaveLength(6);
    expect(t.exploradores[0]).toMatchObject({ chave: "exp:c7", pai: "conv:t1", rotulo: "Explore: busca 7" });
    expect(t.exploradoresEscondidos).toBe(2);
    expect(t.contagem.exploradores).toBe(8);
    // voltou há mais que VOLTA_MS: some
    aplicarEventoAgente(f, { type: "tool_result", threadId: "t1", id: "c7", result: "" }, T0 + 20);
    const depois = torre(torreModelo(f, T0 + 20 + VOLTA_MS + 1));
    expect(depois.exploradores.some((e) => e.id === "c7")).toBe(false);
  });

  it("conversa sem projeto mora na torre Geral (estandarte neutro); cor do projeto é estável", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("g", { busy: true, projectPath: "" })], T0);
    const g = torreModelo(f, T0).torres.find((t) => t.chave === "");
    expect(g).toMatchObject({ nome: "Geral", cor: -1 });
    expect(corDoProjeto("C:/a/Nexos")).toBe(corDoProjeto("D:\\outro\\nexos"));
    expect(tituloCurto("Refatorar session.ts agora mesmo")).toBe("Refatorar session…");
  });

  it("projetos conhecidos ganham torre mesmo sem atividade", () => {
    const m = torreModelo(feedVazio(), T0, { projetosConhecidos: ["C:/x/cli"] });
    expect(m.torres.map((t) => t.nome)).toEqual(["cli"]);
  });
});

describe("lugares", () => {
  const mago = (chave, estado, fimEm) => ({ chave, estado, fimEm });

  it("quem tem mesa fica; quem chega pega a menor livre", () => {
    const a = torreLugares([mago("a", "trabalhando", T0), mago("b", "trabalhando", T0)], null);
    expect([...a.mesas]).toEqual([["a", 0], ["b", 1]]);
    // "a" saiu: "b" NÃO escorrega pra mesa 0; o novo "c" pega a 0
    const b = torreLugares([mago("b", "trabalhando", T0), mago("c", "trabalhando", T0)], a);
    expect(b.mesas.get("b")).toBe(1);
    expect(b.mesas.get("c")).toBe(0);
  });

  it("cheio: cede o parado mais antigo; esperando nunca cede", () => {
    const sentados = [
      mago("e", "esperando", T0 - 10_000),
      mago("p1", "terminou", T0 - 9_000),
      mago("p2", "terminou", T0 - 5_000),
    ];
    const antes = torreLugares(sentados, null, 3);
    const depois = torreLugares([...sentados, mago("novo", "trabalhando", T0)], antes, 3);
    expect(depois.mesas.get("novo")).toBe(antes.mesas.get("p1"));
    expect(depois.escondidos).toEqual(["p1"]);
    expect(depois.mesas.has("e")).toBe(true);
    // o que cedeu não toma de volta a mesa de quem é mais novo que ele
    const de_novo = torreLugares([...sentados, mago("novo", "trabalhando", T0)], depois, 3);
    expect(de_novo.escondidos).toEqual(["p1"]);
    expect([...de_novo.mesas]).toEqual([...depois.mesas]);
  });

  it("ninguém troca de mesa sozinho ao longo de vários retratos", () => {
    let l = null;
    for (let r = 0; r < 20; r++) {
      const lista = [];
      for (let i = 0; i < 6; i++) if ((r + i) % 4 !== 0) lista.push(mago(`m${i}`, i % 2 ? "trabalhando" : "terminou", T0 + i));
      const novo = torreLugares(lista, l);
      // presente nos dois retratos seguidos → mesma mesa
      for (const [k, v] of novo.mesas) if (l?.mesas.has(k)) expect(v).toBe(l.mesas.get(k));
      l = novo;
    }
    const a = torreLugares([mago("x", "trabalhando", T0), mago("y", "ocioso", T0)], null);
    for (let r = 0; r < 5; r++) {
      const b = torreLugares([mago("y", r % 2 ? "trabalhando" : "ocioso", T0 + r), mago("x", "esperando", T0)], a);
      expect(b.mesas.get("x")).toBe(a.mesas.get("x"));
      expect(b.mesas.get("y")).toBe(a.mesas.get("y"));
    }
  });
});

describe("eventos", () => {
  function modeloCom(agentes, agora, mexer) {
    const f = feedVazio();
    aplicarRetrato(f, agentes, agora);
    mexer?.(f);
    return torreModelo(f, agora);
  }

  it("primeiro retrato não gera evento", () => {
    const depois = retratoDaTorre(modeloCom([ag("a", { busy: true }), ag("b", { aguardando: true })], T0), T0);
    expect(torreEventos(null, depois)).toEqual([]);
  });

  it("transições viram eventos", () => {
    const r1 = retratoDaTorre(modeloCom([ag("a", { busy: true }), ag("b", { busy: true }), ag("c")], T0), T0);
    const r2 = retratoDaTorre(
      modeloCom([ag("a", { lastTerminal: "done" }), ag("b", { aguardando: true }), ag("c", { busy: true }), ag("d", { lastTerminal: "error" })], T0 + 1),
      T0 + 1,
    );
    const evs = torreEventos(r1, r2).map((e) => `${e.tipo}:${e.chave}`);
    expect(evs).toEqual(expect.arrayContaining(["terminou:conv:a", "pergunta:conv:b", "pedido:conv:c", "entrou:conv:d"]));
  });

  it("explorador desce e volta (ok e ferido) no pai", () => {
    const f = feedVazio();
    aplicarRetrato(f, [ag("a", { busy: true })], T0);
    const r1 = retratoDaTorre(torreModelo(f, T0), T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "a", name: "Agent", id: "x", input: {} }, T0 + 1);
    aplicarEventoAgente(f, { type: "tool", threadId: "a", name: "Agent", id: "y", input: {} }, T0 + 1);
    const r2 = retratoDaTorre(torreModelo(f, T0 + 1), T0 + 1);
    expect(torreEventos(r1, r2).filter((e) => e.tipo === "delegou")).toHaveLength(2);
    aplicarEventoAgente(f, { type: "tool_result", threadId: "a", id: "x", result: "" }, T0 + 2);
    aplicarEventoAgente(f, { type: "tool_result", threadId: "a", id: "y", result: "", isError: true }, T0 + 2);
    const r3 = retratoDaTorre(torreModelo(f, T0 + 2), T0 + 2);
    expect(torreEventos(r2, r3).filter((e) => e.tipo === "voltou")).toEqual([
      { tipo: "voltou", chave: "conv:a", explorador: "exp:x", ok: true, torre: chaveDoProjeto(P) },
      { tipo: "voltou", chave: "conv:a", explorador: "exp:y", ok: false, torre: chaveDoProjeto(P) },
    ]);
  });
});

describe("cérebro", () => {
  const base = { chave: "conv:a", semente: 7, faseEm: T0, comemorando: false };

  it("ação pela ferramenta; terminal vira tamborilar depois de 1,5 s", () => {
    expect(acaoDaFerramenta("Edit", 0)).toBe("escrevendo");
    expect(acaoDaFerramenta("Grep", 0)).toBe("folheando");
    expect(acaoDaFerramenta("Bash", 100)).toBe("caldeirao");
    expect(acaoDaFerramenta("PowerShell", 2000)).toBe("tamborilando");
    expect(acaoDaFerramenta("WebSearch", 0)).toBe("bola-de-cristal");
    expect(acaoDaFerramenta("Agent", 0)).toBe("despachando");
  });

  it("prioridades: esperando de pé com ?, tarefa nunca dorme, sem mana no banco", () => {
    const c = cerebroNovo();
    expect(decidir(c, { ...base, estado: "esperando" }, T0 + 1000)).toMatchObject({ lugar: "lado-da-mesa", icone: "pergunta" });
    expect(decidir(c, { ...base, estado: "trabalhando", ferramenta: "Edit" }, T0)).toMatchObject({ modo: "tarefa", pose: "escrevendo", lugar: "mesa" });
    expect(decidir(c, { ...base, estado: "segundo-plano" }, T0)).toMatchObject({ pose: "ampulheta", icone: "ampulheta" });
    expect(decidir(c, { ...base, estado: "sem-mana" }, T0)).toMatchObject({ lugar: "cristais", icone: "sem-mana" });
    expect(decidir(c, { ...base, estado: "terminou", comemorando: true }, T0)).toMatchObject({ pose: "comemorando", icone: "estrela" });
    const parado = decidir(c, { ...base, estado: "terminou" }, T0, sorteioDe(1));
    expect(POSES[parado.pose]).toBeTruthy();
  });

  it("reação curta por evento e depois some", () => {
    const c = cerebroNovo();
    aplicarEventosNoCerebro(c, [{ tipo: "voltou", chave: "conv:a", ok: false }], T0);
    expect(decidir(c, { ...base, estado: "trabalhando", ferramenta: "Agent" }, T0 + 100).reacao).toBe("ombros");
    expect(decidir(c, { ...base, estado: "trabalhando", ferramenta: "Agent" }, T0 + 5000).reacao).toBe("");
  });
});
