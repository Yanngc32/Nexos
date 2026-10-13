import { describe, expect, it, vi } from "vitest";
import { aplicarEvento, criarCerebroDados } from "../cerebro-dados.js";

const PROJ = "C:/proj/nexos";

function montar() {
  const chamadas = [];
  const req = vi.fn(async (rota, init) => {
    chamadas.push([rota, init?.method ?? "GET", init?.body]);
    if (rota.startsWith("/v1/cerebro/catalogo?")) return { itens: [{ id: "skill:caveman", tipo: "skill", nome: "caveman", usos30d: 1 }], kpis: { total: 1 } };
    if (rota === "/v1/cerebro/catalogo") return { itens: [], kpis: { total: 0 } };
    if (rota.startsWith("/v1/cerebro/disparos")) return { disparos: [{ chave: "skill:caveman" }] };
    if (rota.startsWith("/v1/cerebro/catalogo/") && init?.method === "PUT") return { id: "skill:caveman", descricao: "nova", origem: "pessoa" };
    throw new Error(`rota inesperada ${rota}`);
  });
  const abertos = new Map();
  const fetchStream = vi.fn(async (url, { signal }) => {
    abertos.set(url, { signal, enviar: null });
    return { ok: true, status: 200, body: {}, url };
  });
  const lerEventos = vi.fn(async (res, on) => {
    const alvo = abertos.get(res.url);
    alvo.enviar = on;
    await new Promise((resolve) => alvo.signal.addEventListener("abort", resolve));
  });
  const timers = [];
  const d = criarCerebroDados({ req, api: (r) => r, fetchStream, lerEventos, agendar: (f, ms) => (timers.push({ f, ms }), timers.length), cancelar: () => {} });
  return { d, req, chamadas, abertos, fetchStream, timers };
}

const noite = () => new Promise((r) => setTimeout(r, 0));

describe("cerebro-dados", () => {
  it("catálogo, disparos e salvar vão pras rotas certas, com o projeto na query", async () => {
    const { d, chamadas } = montar();
    const c = await d.catalogo(PROJ);
    expect(c.itens).toHaveLength(1);
    expect(c.kpis).toEqual({ total: 1 });
    expect((await d.catalogo("")).itens).toEqual([]);
    expect(await d.disparos(PROJ, 10)).toEqual([{ chave: "skill:caveman" }]);
    const salvo = await d.salvar("skill:caveman", { descricao: "nova" }, PROJ);
    expect(salvo.origem).toBe("pessoa");
    expect(chamadas.map((c) => c[0])).toEqual([
      `/v1/cerebro/catalogo?projectPath=${encodeURIComponent(PROJ)}`,
      "/v1/cerebro/catalogo",
      `/v1/cerebro/disparos?projectPath=${encodeURIComponent(PROJ)}&max=10`,
      `/v1/cerebro/catalogo/skill%3Acaveman?projectPath=${encodeURIComponent(PROJ)}`,
    ]);
    expect(chamadas[3][1]).toBe("PUT");
    expect(JSON.parse(chamadas[3][2])).toEqual({ descricao: "nova" });
  });

  it("acompanhar abre o stream do projeto pela ponte; trocar de projeto troca o stream; pausar fecha tudo", async () => {
    const { d, abertos } = montar();
    const eventos = [];
    d.ouvir("evento", (ev) => eventos.push(ev));
    d.acompanhar(PROJ);
    await noite();
    const url1 = `/v1/cerebro/events?projectPath=${encodeURIComponent(PROJ)}`;
    expect([...abertos.keys()]).toEqual([url1]);
    expect(d.projetoDoStream).toBe(PROJ);
    abertos.get(url1).enviar({ tipo: "uso", chave: "skill:caveman", threadId: "t", ts: "x" });
    abertos.get(url1).enviar({ event: "ping" });
    expect(eventos).toEqual([{ tipo: "uso", chave: "skill:caveman", threadId: "t", ts: "x" }]);
    // mesmo projeto de novo: não reabre
    d.acompanhar(PROJ);
    await noite();
    expect(abertos.size).toBe(1);
    d.acompanhar("C:/outro");
    await noite();
    expect(abertos.get(url1).signal.aborted).toBe(true);
    expect(abertos.size).toBe(2);
    d.pausar();
    for (const a of abertos.values()) expect(a.signal.aborted).toBe(true);
    expect(d.ligado).toBe(false);
    expect(d.projetoDoStream).toBe(null);
  });

  it("stream caiu: religa com atraso crescente", async () => {
    const { d, timers, fetchStream } = montar();
    fetchStream.mockImplementation(async () => ({ ok: false, status: 500, body: null, url: "x" }));
    d.acompanhar(PROJ);
    await noite();
    await noite();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1500);
    timers[0].f();
    await noite();
    await noite();
    expect(timers[1].ms).toBe(3000);
  });
});

describe("aplicarEvento", () => {
  it("uso soma 7d/30d e marca o último; disparo soma disparos; delegação cai no agente/time", () => {
    const itens = [
      { id: "skill:caveman", usos7d: 1, usos30d: 2 },
      { id: "agente:revisor", usos7d: 0, usos30d: 0 },
      { id: "time:qa" },
    ];
    expect(aplicarEvento(itens, { tipo: "uso", chave: "skill:caveman", ts: "T" })).toMatchObject({ usos7d: 2, usos30d: 3, ultimoUso: "T" });
    expect(aplicarEvento(itens, { tipo: "uso", chave: "skill:caveman", ts: "T2", usou: true })).toMatchObject({ usos30d: 4, usosAposDisparo30d: 1 });
    expect(aplicarEvento(itens, { tipo: "disparo", chave: "agente:revisor", ts: "T" })).toMatchObject({ disparos30d: 1, usos30d: 0 });
    expect(aplicarEvento(itens, { tipo: "uso", chave: "delegar:agente/revisor", ts: "T" })).toMatchObject({ id: "agente:revisor", usos30d: 1 });
    expect(aplicarEvento(itens, { tipo: "uso", chave: "delegar:time/qa", ts: "T" })).toMatchObject({ id: "time:qa", usos30d: 1 });
    expect(aplicarEvento(itens, { tipo: "uso", chave: "ferramenta:ToolSearch", ts: "T" })).toBeNull();
    expect(aplicarEvento(itens, null)).toBeNull();
  });
});
