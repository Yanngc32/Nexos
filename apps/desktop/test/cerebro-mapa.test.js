import { describe, expect, it } from "vitest";
import { aplicarRoda, arrastar, citacoes, descricaoDoNo, kpisDoMapa, layoutDoMapa, NUNCA_POR_SETOR, RAIO_MAX, RAIO_MIN, raioDoNo, TIPOS, vistaInicial, ZOOM_MAX, ZOOM_MIN } from "../cerebro-mapa.js";

const cap = (id, extra = {}) => {
  const [tipo, nome] = id.split(":");
  return { id, tipo, nome, descricao: "", gatilhos: [], comoUsar: "", origem: "auto", ligada: true, usos7d: 0, usos30d: 0, disparos30d: 0, usosAposDisparo30d: 0, ...extra };
};

describe("layoutDoMapa", () => {
  const itens = [
    cap("ferramenta:nexo_perguntar", { usos30d: 148, usos7d: 20, gatilhos: ["decisão"], ultimoUso: "2026-10-13T10:00:00Z" }),
    cap("ferramenta:nexo_mapa_simbolos", { usos30d: 35, ultimoUso: "2026-10-13T10:00:00Z" }),
    cap("ferramenta:nexo_video_render"),
    cap("skill:caveman", { usos30d: 11, ultimoUso: "2026-10-10T10:00:00Z" }),
    cap("skill:make-interfaces-feel-better", { comoUsar: "Skill `make-interfaces-feel-better`; confira com nexo_mapa_simbolos", gatilhos: ["ui"] }),
    cap("agente:explorador", { gatilhos: ["onde fica"] }),
    cap("skill:nexo-times", { ligada: false }),
    cap("memoria:projeto", { usos30d: 9, ultimoUso: "2026-10-12T10:00:00Z" }),
  ];

  it("centro no meio, um hub por tipo no anel 1 e cada capacidade ao redor do hub do seu tipo", () => {
    const L = layoutDoMapa(itens, { largura: 1000, altura: 500 });
    expect(L.centro).toEqual({ x: 500, y: 250, r: 34 });
    expect(L.hubs.map((h) => h.tipo)).toEqual(TIPOS.map((t) => t.tipo));
    expect(L.hubs.find((h) => h.tipo === "ferramenta").n).toBe(3);
    expect(L.hubs.find((h) => h.tipo === "time").n).toBe(0);
    // hubs equidistantes do centro
    const d = L.hubs.map((h) => Math.hypot(h.x - 500, h.y - 250));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(0.001);
    expect(L.nos).toHaveLength(itens.length);
    for (const no of L.nos) {
      const hub = L.hubs.find((h) => h.tipo === no.tipo);
      expect(Math.hypot(no.x - hub.x, no.y - hub.y)).toBeLessThan(200);
      expect(Math.hypot(no.x - hub.x, no.y - hub.y)).toBeGreaterThan(40);
    }
  });

  it("raio pelo uso, tracejado = nunca usada, apagado = desligada, anel = com gatilho", () => {
    const L = layoutDoMapa(itens);
    const no = (id) => L.nos.find((n) => n.id === id);
    expect(no("ferramenta:nexo_perguntar").r).toBe(RAIO_MAX);
    expect(no("ferramenta:nexo_video_render").r).toBe(RAIO_MIN);
    expect(no("ferramenta:nexo_mapa_simbolos").r).toBeGreaterThan(RAIO_MIN);
    expect(no("ferramenta:nexo_mapa_simbolos").r).toBeLessThan(RAIO_MAX);
    expect(no("ferramenta:nexo_video_render").nunca).toBe(true);
    expect(no("skill:caveman").nunca).toBe(false);
    expect(no("skill:nexo-times").off).toBe(true);
    expect(no("agente:explorador").gatilho).toBe(true);
    expect(no("skill:caveman").gatilho).toBe(false);
    expect(raioDoNo(0, 100)).toBe(RAIO_MIN);
    expect(raioDoNo(100, 100)).toBe(RAIO_MAX);
    expect(raioDoNo(25, 100)).toBeCloseTo(RAIO_MIN + (RAIO_MAX - RAIO_MIN) * 0.5, 5);
  });

  it("arestas: hub→capacidade pra cada nó e capacidade→capacidade quando o comoUsar cita outra", () => {
    const L = layoutDoMapa(itens);
    expect(L.arestas.filter((a) => a.tipo === "hub")).toHaveLength(itens.length);
    const cita = L.arestas.filter((a) => a.tipo === "cita");
    expect(cita.map((a) => a.id)).toEqual(["skill:make-interfaces-feel-better→ferramenta:nexo_mapa_simbolos"]);
    expect(citacoes(itens)).toEqual([{ de: "skill:make-interfaces-feel-better", para: "ferramenta:nexo_mapa_simbolos" }]);
  });

  it("tipo oculto pela legenda some do mapa (hub fica, apagado)", () => {
    const L = layoutDoMapa(itens, { ocultos: new Set(["skill"]) });
    expect(L.nos.some((n) => n.tipo === "skill")).toBe(false);
    expect(L.hubs.find((h) => h.tipo === "skill").oculto).toBe(true);
    expect(L.nos).toHaveLength(itens.length - 3);
  });

  it("setor com muitas nunca usadas colapsa num '+N'; expandido volta a mostrar todas", () => {
    const muitas = [cap("ferramenta:viva", { usos30d: 5, ultimoUso: "x" })];
    for (let i = 0; i < NUNCA_POR_SETOR + 3; i++) muitas.push(cap(`ferramenta:morta_${i}`));
    const L = layoutDoMapa(muitas);
    expect(L.nos.map((n) => n.id)).toEqual(["ferramenta:viva"]);
    expect(L.colapsados).toHaveLength(1);
    expect(L.colapsados[0]).toMatchObject({ tipo: "ferramenta", n: NUNCA_POR_SETOR + 3 });
    expect(L.colapsados[0].ids).toHaveLength(NUNCA_POR_SETOR + 3);
    const L2 = layoutDoMapa(muitas, { expandidos: new Set(["ferramenta"]) });
    expect(L2.colapsados).toHaveLength(0);
    expect(L2.nos).toHaveLength(muitas.length);
    // nós não se sobrepõem ao hub mesmo com muitos
    const hub = L2.hubs.find((h) => h.tipo === "ferramenta");
    for (const no of L2.nos) expect(Math.hypot(no.x - hub.x, no.y - hub.y)).toBeGreaterThan(hub.r + no.r);
  });

  it("zoom com a roda fica entre 0,5× e 2× e mantém o ponto sob o cursor; arrastar só translada", () => {
    let v = vistaInicial();
    v = aplicarRoda(v, -100, 100, 50);
    expect(v.escala).toBeCloseTo(1.12, 5);
    // ponto (100,50) do palco continua apontando pro mesmo ponto do mapa
    const mapaX = (100 - v.dx) / v.escala;
    expect(mapaX).toBeCloseTo(100, 5);
    for (let i = 0; i < 30; i++) v = aplicarRoda(v, -100, 0, 0);
    expect(v.escala).toBe(ZOOM_MAX);
    for (let i = 0; i < 60; i++) v = aplicarRoda(v, 100, 0, 0);
    expect(v.escala).toBe(ZOOM_MIN);
    const a = arrastar({ escala: 1, dx: 0, dy: 0 }, 10, -5);
    expect(a).toEqual({ escala: 1, dx: 10, dy: -5 });
  });

  it("descrição do nó e KPIs", () => {
    const L = layoutDoMapa(itens);
    const no = L.nos.find((n) => n.id === "ferramenta:nexo_perguntar");
    expect(descricaoDoNo(no)).toBe("nexo_perguntar · ferramenta · 20 usos em 7 d · 148 em 30 d · gatilhos: decisão");
    expect(descricaoDoNo(L.nos.find((n) => n.id === "skill:nexo-times"))).toContain("desligada");
    expect(kpisDoMapa(itens)).toEqual({ total: 8, auto: 8, pessoa: 0, usadas7d: 1, nuncaUsadas: 4, disparos30d: 0, usosAposDisparo30d: 0 });
  });
});
