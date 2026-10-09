import { describe, expect, it } from "vitest";
import { aplicarEventoAgente, aplicarEventoVideo, aplicarRetrato, feedVazio } from "../torre/feed.js";
import { torreModelo } from "../torre/modelo.js";
import { DESCIDA_ASTRO_MS, acenarNoPalco, avancarPalco, palcoNovo } from "../torre/palco.js";

const T0 = 7_000_000;
const PROJ = "C:/proj/nexos";
const sorteio = () => 0.99;
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

function cenario(agentes) {
  const feed = feedVazio();
  aplicarRetrato(feed, agentes, T0);
  const palco = palcoNovo(PROJ.toLowerCase());
  const quadro = (agora, extra = {}) => avancarPalco(palco, { modelo: torreModelo(feed, agora, {}), feed, agora, sorteio, ...extra });
  return { feed, palco, quadro };
}

describe("palco: conversa que vira Manager sobe pro Observatório", () => {
  it("o mago sai da mesa, sobe a escada até o telescópio e o astrônomo ocupa o lugar dele", () => {
    const { feed, quadro } = cenario([agente("m", { busy: true })]);
    const antes = quadro(T0);
    const mesa = antes.s.atores.find((a) => a.chave === "conv:m");
    expect(mesa).toBeTruthy();
    // o plano nasce da conversa: ela passa a ser o Manager
    aplicarRetrato(feed, [agente("m", { busy: true, planejamento: { slug: "plano-x" } })], T0 + 500);
    let q = quadro(T0 + 600);
    expect(q.s.atores.some((a) => a.chave === "conv:m")).toBe(false);
    const meio = quadro(T0 + 600 + DESCIDA_ASTRO_MS / 2).s.atores.find((a) => a.tipo === "astronomo");
    expect(meio).toBeTruthy();
    expect([meio.x, meio.y]).not.toEqual([mesa.x, mesa.y]);
    expect(meio.y).toBeGreaterThan(q.cena.telescopio.astronomo.y - 1); // ainda não chegou lá em cima
    q = quadro(T0 + 600 + DESCIDA_ASTRO_MS + 100);
    const topo = q.s.atores.find((a) => a.tipo === "astronomo");
    expect([topo.x, topo.y]).toEqual([q.cena.telescopio.astronomo.x, q.cena.telescopio.astronomo.y]);
  });

  it("abrir a aba com o plano já criado não reencena a subida", () => {
    const { quadro } = cenario([agente("m", { busy: true, planejamento: { slug: "plano-x" } })]);
    const q = quadro(T0);
    const a = q.s.atores.find((x) => x.tipo === "astronomo");
    expect([a.x, a.y]).toEqual([q.cena.telescopio.astronomo.x, q.cena.telescopio.astronomo.y]);
  });
});

describe("palco: textos soltos sobre a arte", () => {
  it("sem plano: 'Nenhum plano'; com plano, some", () => {
    const { feed, quadro } = cenario([agente("a")]);
    expect(quadro(T0).notas.map((n) => n.texto)).toContain("Nenhum plano");
    feed.planos.set(PROJ.toLowerCase(), [{ slug: "p1", titulo: "P", estrelas: ["feita", "pendente"] }]);
    expect(quadro(T0 + 100).notas.map((n) => n.texto)).not.toContain("Nenhum plano");
  });

  it("contador da pilha de aprendizados e % do render de vídeo", () => {
    const { feed, quadro } = cenario([agente("a")]);
    feed.aprendizados.set(PROJ.toLowerCase(), 3);
    aplicarEventoVideo(feed, PROJ, { type: "render", estado: "rodando", progresso: { pct: 42 } }, T0);
    const notas = quadro(T0 + 100).notas;
    expect(notas.find((n) => n.k === "pilha")).toMatchObject({ texto: "3", titulo: "3 aprendizados pra revisar" });
    expect(notas.find((n) => n.k === "render").texto).toBe("42%");
  });
});

describe("palco: exploradores demais e aceno ao clique", () => {
  it("acima de 6 simultâneos mostra os 6 mais recentes e conta o resto", () => {
    const { feed, quadro } = cenario([agente("a", { busy: true })]);
    quadro(T0);
    for (let n = 1; n <= 8; n++) aplicarEventoAgente(feed, { type: "tool", threadId: "a", id: `toolu_${n}`, name: "Agent", input: { description: `x${n}` } }, T0 + 100 * n);
    const q = quadro(T0 + 1_000);
    expect(q.hits.exploradores).toHaveLength(6);
    expect(q.exploradoresEscondidos).toBe(2);
    expect(q.cena.dungeon.faixas).toHaveLength(6);
  });

  it("clique no mago: ele acena por 1,5 s e depois volta ao que fazia", () => {
    const { palco, quadro } = cenario([agente("a")]);
    quadro(T0);
    const parado = quadro(T0 + 10).s.atores.find((a) => a.chave === "conv:a").quadro;
    expect(acenarNoPalco(palco, "conv:a", T0 + 20)).toBe(true);
    const acenando = quadro(T0 + 30).s.atores.find((a) => a.chave === "conv:a").quadro;
    expect(acenando.props.length + acenando.o).not.toBe(parado.props.length + parado.o);
    // 1,5 s depois acabou
    quadro(T0 + 20 + 1_600);
    expect(palco.convivio.ativas.has("conv:a")).toBe(false);
  });
});
