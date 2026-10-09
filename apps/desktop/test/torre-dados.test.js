import { describe, expect, it, vi } from "vitest";
import { criarTorreDados } from "../torre-dados.js";

const PROJ = "C:/proj/nexos";
const agente = (id, extra = {}) => ({ threadId: id, projectPath: PROJ, busy: false, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], ...extra });

function montar({ agentes = [agente("a", { busy: true })], falhaRetrato = false, quadroTarefas = true } = {}) {
  const chamadas = [];
  const req = vi.fn(async (rota) => {
    chamadas.push(rota);
    if (rota === "/v1/config") return { modulos: { quadroTarefas } };
    if (rota === "/v1/teams") return [{ id: "revisao", name: "Time de revisão" }];
    if (rota === "/v1/agents") {
      if (falhaRetrato) throw new Error("motor fora");
      return agentes;
    }
    if (rota === "/v1/accounts/limits") return [{ id: "2d", limits: { fiveHour: { utilization: 0.2, resetsAt: 9e9 } } }];
    if (rota === "/v1/agents/defs") return [{ id: "explore", name: "Explorador", color: "#5fae74" }];
    if (rota.startsWith("/v1/planejamento")) return [{ slug: "p1", titulo: "Plano", estrelas: ["feita", "pendente"] }];
    if (rota.startsWith("/v1/tarefas/quadro")) return { colunas: [{ id: "c1", nome: "A fazer", ordem: 0 }] };
    if (rota.startsWith("/v1/tarefas?")) return [{ id: "t1", colunaId: "c1", titulo: "x" }];
    throw new Error(`rota inesperada ${rota}`);
  });
  const abertos = new Map(); // url → { ev(), signal }
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
  const agendar = (f, ms) => {
    const t = { f, ms, ativo: true };
    timers.push(t);
    return t;
  };
  const cancelar = (t) => {
    if (t) t.ativo = false;
  };
  const d = criarTorreDados({ req, api: (r) => r, fetchStream, lerEventos, agendar, cancelar, relogio: () => 1_000_000, aprendizadosDe: () => 3 });
  return { d, req, chamadas, abertos, fetchStream, timers };
}

const noite = () => new Promise((r) => setTimeout(r, 0));

describe("torre-dados", () => {
  it("liga: lê retrato, limites e agentes do Nexos, abre o stream de runs e agenda o próximo retrato", async () => {
    const { d, chamadas, abertos, timers } = montar();
    expect(await d.ligar()).toBe(true);
    expect(chamadas).toEqual(expect.arrayContaining(["/v1/agents", "/v1/accounts/limits", "/v1/agents/defs"]));
    expect(d.feed.agentes.get("a").busy).toBe(true);
    expect(d.feed.contas).toHaveLength(1);
    expect(d.feed.defs.get("explore")).toEqual({ name: "Explorador", color: "#5fae74" });
    expect([...abertos.keys()]).toEqual(["/v1/runs/events"]);
    expect(timers.filter((t) => t.ativo)).toHaveLength(1);
  });

  it("times entram no mapa de nomes: o explorador de nexo_delegar leva o nome do time", async () => {
    const { d } = montar();
    await d.ligar();
    expect(d.feed.defs.get("revisao")).toEqual({ name: "Time de revisão", color: "" });
  });

  it("módulo Quadro de tarefas desligado: não consulta o Quadro nem abre o stream dele", async () => {
    const { d, chamadas, abertos } = montar({ quadroTarefas: false });
    await d.ligar();
    expect(d.feed.quadroLigado).toBe(false);
    d.observar([PROJ], PROJ);
    await noite();
    expect(chamadas.some((r) => r.startsWith("/v1/tarefas"))).toBe(false);
    expect([...abertos.keys()].some((u) => u.startsWith("/v1/tarefas/events"))).toBe(false);
  });

  it("motor fora: ligar devolve false e o feed fica vazio (a aba mostra o estado)", async () => {
    const { d } = montar({ falhaRetrato: true });
    expect(await d.ligar()).toBe(false);
    expect(d.feed.agentes.size).toBe(0);
  });

  it("observar: abre Quadro e vídeo de cada projeto, consulta planos e Quadro do aberto, e solta quem saiu", async () => {
    const { d, chamadas, abertos } = montar();
    await d.ligar();
    const quadros = vi.fn();
    d.ouvir("quadroCarregado", quadros);
    d.observar([PROJ, "C:/proj/outro"], PROJ);
    await noite();
    await noite();
    expect([...abertos.keys()].sort()).toEqual(
      ["/v1/runs/events", "/v1/tarefas/events?projectPath=C%3A%2Fproj%2Fnexos", "/v1/tarefas/events?projectPath=C%3A%2Fproj%2Foutro", "/v1/videos/events?projectPath=C%3A%2Fproj%2Fnexos", "/v1/videos/events?projectPath=C%3A%2Fproj%2Foutro"].sort(),
    );
    expect(chamadas.some((c) => c.startsWith("/v1/planejamento?projectPath=C%3A%2Fproj%2Fnexos"))).toBe(true);
    expect(quadros).toHaveBeenCalledWith(PROJ, expect.objectContaining({ colunas: expect.any(Array) }), expect.any(Array));
    expect(d.feed.planos.get("c:/proj/nexos")[0].estrelas).toEqual(["feita", "pendente"]);
    expect(d.feed.aprendizados.get("c:/proj/nexos")).toBe(3);
    // um projeto saiu da lista: os streams dele fecham
    const outro = abertos.get("/v1/tarefas/events?projectPath=C%3A%2Fproj%2Foutro");
    d.observar([PROJ], PROJ);
    expect(outro.signal.aborted).toBe(true);
  });

  it("mudança no Quadro chega ao ouvinte e acende o Observatório do projeto", async () => {
    const { d, abertos } = montar();
    await d.ligar();
    const quadro = vi.fn();
    d.ouvir("quadro", quadro);
    d.observar([PROJ], PROJ);
    await noite();
    await noite();
    const url = "/v1/tarefas/events?projectPath=C%3A%2Fproj%2Fnexos";
    abertos.get(url).enviar({ tipo: "moveu", tarefaId: "t1", de: "c1", para: "c2", via: "agente" });
    expect(quadro).toHaveBeenCalledWith(expect.objectContaining({ tarefaId: "t1" }), PROJ, 1_000_000);
    expect(d.feed.muralEm.get("c:/proj/nexos")).toBe(1_000_000);
  });

  it("evento de agente entra no feed; pausar fecha tudo e ignora eventos (aba oculta = zero timers)", async () => {
    const { d, abertos, timers } = montar();
    await d.ligar();
    d.observar([PROJ], PROJ);
    await noite();
    expect(d.aoEventoAgente({ type: "tool", threadId: "a", name: "Read", input: {} })).toBe(true);
    expect(d.feed.fase.get("a").ferramenta).toBe("Read");
    d.pausar();
    expect([...abertos.values()].every((a) => a.signal.aborted)).toBe(true);
    expect(timers.every((t) => !t.ativo)).toBe(true);
    expect(d.aoEventoAgente({ type: "tool", threadId: "a", name: "Edit" })).toBe(false);
    expect(d.ligado).toBe(false);
  });

  it("retomar recomeça do retrato de agora e reabre os streams", async () => {
    const { d, abertos } = montar();
    await d.ligar();
    d.observar([PROJ], PROJ);
    d.pausar();
    expect(await d.retomar([PROJ], PROJ)).toBe(true);
    await noite();
    expect(d.ligado).toBe(true);
    expect([...abertos.entries()].filter(([, a]) => !a.signal.aborted).length).toBeGreaterThanOrEqual(3);
    expect(d.projetoAberto).toBe(PROJ);
  });
});
