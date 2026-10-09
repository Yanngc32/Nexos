import { describe, expect, it } from "vitest";
import { MAGO_H } from "../torre/arte.js";
import { aplicarEventoAgente, aplicarRetrato, feedVazio } from "../torre/feed.js";
import { torreModelo } from "../torre/modelo.js";
import { DESCIDA_EXP_MS, avancarPalco, carregarQuadroNoPalco, mudancaNoQuadro, palcoNovo, recomecarPalco } from "../torre/palco.js";
import { SUBIDA_MS as MURAL_SUBIDA, GESTO_MS, DESCIDA_MS as MURAL_DESCIDA } from "../torre/mural.js";
import { ENTREGA_TOTAL_MS } from "../torre/entregas.js";
import { posicoesDoMural } from "../torre/render.js";

const T0 = 5_000_000;
const PROJ = "C:/proj/nexos";
const sorteio = () => 0.99; // ninguém sorteia lazer/conversa por conta própria

const agente = (id, extra = {}) => ({
  threadId: id,
  projectPath: PROJ,
  busy: false,
  aguardando: false,
  emEspera: 0,
  pendingQuota: false,
  passos: [],
  preview: `Conversa ${id}`,
  updatedAt: new Date(T0).toISOString(),
  ...extra,
});

function cenario(agentes, contas = [{ id: "a", limits: { fiveHour: { utilization: 0.3, resetsAt: (T0 + 3_600_000) / 1000 } } }]) {
  const feed = feedVazio();
  feed.contas = contas;
  aplicarRetrato(feed, agentes, T0);
  const palco = palcoNovo(PROJ.toLowerCase());
  const quadro = (agora, extra = {}) => avancarPalco(palco, { modelo: torreModelo(feed, agora, {}), feed, agora, sorteio, ...extra });
  return { feed, palco, quadro };
}

const mago = (q, id) => q.s.atores.find((a) => a.chave === `conv:${id}`);

describe("palco: o Salão bate com o retrato e ninguém troca de mesa sozinho", () => {
  it("cada conversa ativa vira um mago numa mesa, estável entre quadros; esperando fica de pé na frente", () => {
    const { feed, quadro } = cenario([agente("a", { busy: true }), agente("b", { aguardando: true, pergunta: { texto: "Qual?" } }), agente("c", { lastTerminal: "done" })]);
    const q1 = quadro(T0);
    expect(q1.hits.magos.map((m) => m.threadId).sort()).toEqual(["a", "b", "c"]);
    const x1 = new Map(q1.s.atores.map((a) => [a.chave, [a.x, a.y]]));
    expect(mago(q1, "b").icone).toBe("pergunta");
    // chega uma conversa nova e a primeira volta a ser pintada: quem já estava não muda de mesa
    aplicarRetrato(feed, [agente("a", { busy: true }), agente("b", { aguardando: true }), agente("c", { lastTerminal: "done" }), agente("d", { busy: true })], T0 + 100);
    const q2 = quadro(T0 + 200);
    for (const k of ["a", "b", "c"]) expect([mago(q2, k).x, mago(q2, k).y]).toEqual(x1.get(`conv:${k}`));
    expect(q2.hits.magos).toHaveLength(4);
    expect(q2.resumo).toMatch(/2 trabalhando/);
    expect(q2.resumo).toMatch(/1 esperando você/);
    expect(q2.plaquinhas.map((p) => p.texto)).toContain("Conversa a");
  });

  it("torre sem conversa: vazia (sem tela preta), cena com 1 faixa de dungeon", () => {
    const { quadro } = cenario([]);
    const q = quadro(T0);
    expect(q.vazia).toBe(true);
    expect(q.cena.dungeon.faixas).toHaveLength(1);
    expect(q.hits.magos).toEqual([]);
  });

  it("cristais refletem /v1/accounts/limits", () => {
    const { quadro } = cenario([agente("a")], [
      { id: "2d", limits: { fiveHour: { utilization: 0.38, resetsAt: (T0 + 9e6) / 1000 }, sevenDay: { utilization: 0.4, resetsAt: (T0 + 9e8) / 1000 } } },
      { id: "gm", limits: { fiveHour: { utilization: 0.92, resetsAt: (T0 + 9e6) / 1000 } } },
      { id: "sem", limits: null },
    ]);
    const q = quadro(T0);
    expect(q.s.contas.map((c) => [c.id, c.semDado])).toEqual([["2d", false], ["gm", false], ["sem", true]]);
    expect(q.contas.map((c) => c.texto)).toEqual(["62% livre", "8% livre", "sem leitura"]);
    expect(q.cena.cristais).toHaveLength(3);
  });
});

describe("palco: mural do Quadro", () => {
  const quadroReal = { colunas: [{ id: "c1", nome: "A fazer", ordem: 0 }, { id: "c2", nome: "Fazendo", ordem: 1 }, { id: "c3", nome: "Feito", ordem: 2 }] };
  const tarefas = [{ id: "t1", titulo: "Login", colunaId: "c1" }, { id: "t2", titulo: "CI", colunaId: "c2" }];

  it("mudança feita por uma conversa: o mago dela sobe, faz o gesto e só então o pergaminho muda", () => {
    const { feed, palco, quadro } = cenario([agente("a", { busy: true })]);
    carregarQuadroNoPalco(palco, quadroReal, tarefas);
    quadro(T0); // primeiro retrato
    const base = { ...mago(quadro(T0 + 10), "a") };
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", name: "mcp__nexo__nexo_tarefa_salvar", input: { id: "t1" } }, T0 + 20);
    mudancaNoQuadro(palco, feed, { tipo: "moveu", tarefaId: "t1", de: "c1", para: "c2", via: "agente" }, T0 + 30);
    let q = quadro(T0 + 40);
    expect(palco.mural.viagens.has("conv:a")).toBe(true);
    // subindo: já saiu da mesa e o pergaminho ainda está na coluna antiga
    q = quadro(T0 + 40 + MURAL_SUBIDA / 2);
    expect(mago(q, "a").y).not.toBe(base.y);
    expect(q.mural.tarefas.find((t) => t.id === "t1").colunaId).toBe("c1");
    // no mural: pose de gesto, e o pergaminho muda quando chega
    q = quadro(T0 + 40 + MURAL_SUBIDA + 50);
    const pos = posicoesDoMural(q.cena, { colunas: q.mural.colunas, tarefas: q.mural.tarefas });
    expect(pos.get("t1").coluna).toBe(1);
    expect(q.mural.tarefas.find((t) => t.id === "t1").colunaId).toBe("c2");
    // desceu e voltou pra mesa
    q = quadro(T0 + 40 + MURAL_SUBIDA + GESTO_MS + MURAL_DESCIDA + 100);
    expect([mago(q, "a").x, mago(q, "a").y]).toEqual([base.x, base.y]);
    expect(palco.mural.viagens.size).toBe(0);
  });

  it("mudança feita na tela desliza sozinha com o selo Você; ninguém anda", () => {
    const { feed, palco, quadro } = cenario([agente("a", { busy: true })]);
    carregarQuadroNoPalco(palco, quadroReal, tarefas);
    quadro(T0);
    const base = { ...mago(quadro(T0 + 10), "a") };
    mudancaNoQuadro(palco, feed, { tipo: "moveu", tarefaId: "t1", de: "c1", para: "c3" }, T0 + 20);
    const q = quadro(T0 + 30);
    expect(q.s.deslizando).toHaveLength(1);
    expect(q.s.deslizando[0].selo).toBe("voce");
    expect([mago(q, "a").x, mago(q, "a").y]).toEqual([base.x, base.y]);
    // a coluna final carimba
    expect(q.mural.tarefas.find((t) => t.id === "t1")).toMatchObject({ colunaId: "c3", carimbo: true });
  });

  it("nunca mais de 15 s de atraso: mago sem como chegar não segura o pergaminho", () => {
    const { feed, palco, quadro } = cenario([agente("a", { aguardando: true })]);
    carregarQuadroNoPalco(palco, quadroReal, tarefas);
    quadro(T0);
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", name: "mcp__nexo__nexo_tarefa_salvar", input: { id: "t1" } }, T0 + 20);
    mudancaNoQuadro(palco, feed, { tipo: "moveu", tarefaId: "t1", de: "c1", para: "c2", via: "agente" }, T0 + 30);
    quadro(T0 + 40);
    expect(palco.mural.tarefas.find((t) => t.id === "t1").colunaId).toBe("c2"); // mago esperando você não viaja
    expect(palco.mural.viagens.size).toBe(0);
  });

  it("aba oculta / ao voltar: aplica direto, sem animação", () => {
    const { feed, palco, quadro } = cenario([agente("a", { busy: true })]);
    carregarQuadroNoPalco(palco, quadroReal, tarefas);
    quadro(T0);
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", name: "mcp__nexo__nexo_tarefa_salvar", input: { id: "t1" } }, T0 + 20);
    mudancaNoQuadro(palco, feed, { tipo: "moveu", tarefaId: "t1", de: "c1", para: "c2", via: "agente" }, T0 + 30);
    recomecarPalco(palco);
    const q = quadro(T0 + 40, { visivel: false });
    expect(q.mural.tarefas.find((t) => t.id === "t1").colunaId).toBe("c2");
    expect(q.s.deslizando).toEqual([]);
    expect(palco.mural.viagens.size).toBe(0);
  });
});

describe("palco: apagão, exploradores e plano enviado", () => {
  it("todas as contas no limite: luzes caem e a festa começa; uma conta de volta, tudo volta", () => {
    const zeradas = [{ id: "a", limits: { status: "blocked", fiveHour: { utilization: 1, resetsAt: (T0 + 9e6) / 1000 } } }];
    const { feed, quadro } = cenario([agente("a"), agente("b")], zeradas);
    quadro(T0);
    expect(quadro(T0).luzes).toBe(1);
    const q = quadro(T0 + 2_000);
    expect(q.apagao).toBe(true);
    expect(q.s.luzes).toBe(0);
    expect(mago(q, "a").quadro).toBeTruthy();
    feed.contas = [{ id: "a", limits: { fiveHour: { utilization: 0.2, resetsAt: (T0 + 9e6) / 1000 } } }];
    expect(quadro(T0 + 2_100).apagao).toBe(false);
  });

  it("explorador desce da mesa do mago, anda na dungeon e, ao voltar, entrega o pergaminho (ferido se der erro)", () => {
    const { feed, palco, quadro } = cenario([agente("a", { busy: true })]);
    quadro(T0);
    const base = { ...mago(quadro(T0 + 10), "a") };
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", id: "toolu_1", name: "Agent", input: { subagent_type: "Explore", description: "onde o plano é montado" } }, T0 + 100);
    let q = quadro(T0 + 200);
    const exp = () => q.s.atores.find((a) => a.chave === "exp:toolu_1");
    expect(exp()).toBeTruthy();
    expect(q.hits.exploradores[0].rotulo).toMatch(/Explore: onde o plano é montado/);
    // descendo: ainda está na altura do Salão, longe da dungeon
    q = quadro(T0 + 200 + DESCIDA_EXP_MS / 2);
    expect(exp().y).toBeLessThan(q.cena.dungeon.y);
    // dentro da dungeon
    q = quadro(T0 + 200 + DESCIDA_EXP_MS + 4_000);
    expect(exp().y).toBeGreaterThanOrEqual(q.cena.dungeon.y);
    expect(q.s.dungeons).toHaveLength(1);
    // voltou com erro: sobe com o pergaminho, ferido, até a frente da mesa do mago
    aplicarEventoAgente(feed, { type: "tool_result", threadId: "a", id: "toolu_1", isError: true }, T0 + 10_000);
    q = quadro(T0 + 10_100);
    q = quadro(T0 + 10_100 + 600);
    expect(exp().icone).toBe("alerta");
    expect(exp().quadro.props.some(([n]) => n.startsWith("pergaminho"))).toBe(true);
    q = quadro(T0 + 10_100 + 2_700 + 400); // entregando
    expect(mago(q, "a").quadro).toBeTruthy();
    q = quadro(T0 + 10_100 + ENTREGA_TOTAL_MS + 100);
    expect(q.s.atores.find((a) => a.chave === "exp:toolu_1")?.y ?? 0).toBeGreaterThanOrEqual(0);
    expect([mago(q, "a").x]).toEqual([base.x]);
    expect(palco.faixas.get("exp:toolu_1")).toBe(0);
  });

  it("vários exploradores ao mesmo tempo: cada um na sua faixa, e as faixas crescem a cena", () => {
    const { feed, quadro } = cenario([agente("a", { busy: true })]);
    quadro(T0);
    for (const n of [1, 2, 3]) aplicarEventoAgente(feed, { type: "tool", threadId: "a", id: `toolu_${n}`, name: "Agent", input: { description: `x${n}` } }, T0 + 100 * n);
    const q = quadro(T0 + 500);
    expect(q.cena.dungeon.faixas).toHaveLength(3);
    expect(new Set(q.s.dungeons.map((d) => d.faixa)).size).toBe(3);
  });

  it("plano enviado: o astrônomo desce até a mesa da implementação, que herda a cor dele", () => {
    const manager = agente("m", { planejamento: { slug: "plano-x" }, agentColor: "#5fae74", busy: true });
    const { feed, quadro } = cenario([manager]);
    expect(quadro(T0).s.atores.some((a) => a.tipo === "astronomo")).toBe(true);
    aplicarRetrato(feed, [{ ...manager, busy: false, planejamento: { slug: "plano-x" } }, agente("i", { handoff: { slug: "plano-x" }, busy: true })], T0 + 1_000);
    let q = quadro(T0 + 1_100);
    // a mesa da implementação ainda não aparece: o astrônomo está a caminho
    const descendo = q.s.atores.find((a) => a.chave === "astro:desce:conv:i");
    expect(descendo).toBeTruthy();
    expect(descendo.cor).toBe("#5fae74");
    expect(q.hits.magos.some((h) => h.threadId === "i")).toBe(false);
    q = quadro(T0 + 1_100 + 3_000);
    expect(q.s.atores.some((a) => a.chave === "astro:desce:conv:i")).toBe(false);
    expect(mago(q, "i")?.cor).toBe("#5fae74");
  });
});

describe("palco: movimento reduzido e aba oculta", () => {
  it("reduzido: ninguém sai da mesa e a pose é o quadro parado", () => {
    const { feed, palco, quadro } = cenario([agente("a", { busy: true })]);
    carregarQuadroNoPalco(palco, { colunas: [{ id: "c1", ordem: 0 }, { id: "c2", ordem: 1 }] }, [{ id: "t1", colunaId: "c1" }]);
    quadro(T0, { reduzido: true });
    const base = { ...mago(quadro(T0 + 10, { reduzido: true }), "a") };
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", name: "mcp__nexo__nexo_tarefa_salvar", input: { id: "t1" } }, T0 + 20);
    mudancaNoQuadro(palco, feed, { tipo: "moveu", tarefaId: "t1", de: "c1", para: "c2", via: "agente" }, T0 + 30);
    for (const dt of [100, 1_000, 3_000]) {
      const q = quadro(T0 + 100 + dt, { reduzido: true });
      expect([mago(q, "a").x, mago(q, "a").y]).toEqual([base.x, base.y]);
    }
    expect(MAGO_H).toBeGreaterThan(0);
  });
});
