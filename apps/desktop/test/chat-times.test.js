// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createBarraTimes, fraseDoRun, runsVisiveis, MOSTRAR_FECHADO_MS } from "../chat-times.js";

const run = (over = {}) => ({
  id: "r1",
  teamId: "t",
  status: "running",
  createdAt: "2026-09-22T10:00:00.000Z",
  steps: [
    { index: 0, agentId: "a1", status: "done" },
    { index: 1, agentId: "a2", status: "running", threadId: "th-2" },
    { index: 2, agentId: "a3", status: "pending" },
  ],
  ...over,
});

describe("fraseDoRun", () => {
  it("passo atual e quem está trabalhando", () => {
    expect(fraseDoRun(run(), (id) => id.toUpperCase())).toBe("passo 2/3 · A2 trabalhando");
  });
  it("na fila quando nenhum passo começou; estados finais", () => {
    expect(fraseDoRun(run({ steps: [{ index: 0, agentId: "a1", status: "pending" }] }))).toBe("na fila");
    expect(fraseDoRun(run({ status: "done" }))).toBe("terminou");
    expect(fraseDoRun(run({ status: "error" }))).toBe("falhou");
  });
});

describe("runsVisiveis", () => {
  it("em curso sempre; fechado só por alguns segundos", () => {
    const agora = Date.parse("2026-09-22T10:10:00.000Z");
    const recente = run({ id: "r2", status: "done", endedAt: new Date(agora - 1000).toISOString() });
    const velho = run({ id: "r3", status: "done", endedAt: new Date(agora - MOSTRAR_FECHADO_MS - 1).toISOString() });
    expect(runsVisiveis([run(), recente, velho], agora).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});

describe("createBarraTimes", () => {
  function montar(respostas) {
    document.body.innerHTML = `<div id="times-bar" class="hidden"></div>`;
    const abertos = [];
    const barra = createBarraTimes({
      el: (id) => document.getElementById(id),
      req: async (url) => respostas[url],
      nomeDoTime: () => "Revisores",
      aoAbrirPasso: (id) => abertos.push(id),
    });
    return { barra, abertos, el: document.getElementById("times-bar") };
  }

  it("carrega os runs do chat, mostra e deixa abrir a conversa de um passo", async () => {
    const { barra, abertos, el } = montar({ "/v1/threads/c1/runs": [run()] });
    await barra.carregar("c1");
    expect(el.classList.contains("hidden")).toBe(false);
    expect(el.querySelector(".tb-nome").textContent).toBe("Revisores");
    el.querySelector(".tb-cab").click();
    const ver = el.querySelector(".tb-ver");
    expect(ver).toBeTruthy();
    ver.click();
    expect(abertos).toEqual(["th-2"]);
  });

  it("aplica evento ao vivo e ignora evento de outro chat", async () => {
    const { barra, el } = montar({ "/v1/threads/c1/runs": [run()] });
    await barra.carregar("c1");
    await barra.aplicar({ type: "run_evento", threadId: "outro", runId: "r1", ev: { type: "run_end", runId: "r1", status: "done" } });
    expect(barra._runs().get("r1").status).toBe("running");
    await barra.aplicar({ type: "run_evento", threadId: "c1", runId: "r1", ev: { type: "run_end", runId: "r1", status: "done" } });
    expect(barra._runs().get("r1").status).toBe("done");
    expect(el.querySelector(".tb-frase").textContent).toBe("terminou");
  });

  it("run novo (menção recém-disparada) é buscado inteiro no primeiro evento", async () => {
    const { barra, el } = montar({ "/v1/threads/c1/runs": [], "/v1/runs/r9": run({ id: "r9" }) });
    await barra.carregar("c1");
    expect(el.classList.contains("hidden")).toBe(true);
    await barra.aplicar({ type: "run_evento", threadId: "c1", runId: "r9", ev: { type: "run_start", runId: "r9", teamId: "t" } });
    expect(el.classList.contains("hidden")).toBe(false);
  });
});
