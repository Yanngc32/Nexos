import { describe, expect, it } from "vitest";
import { saveAgent } from "../src/agents.ts";
import { createApp } from "../src/http.ts";
import { addProfile } from "../src/profiles.ts";
import { runsBus, saveRun } from "../src/runs.ts";
import { comoAutor, salvarTarefa, getQuadro } from "../src/tarefas.ts";
import { upsertTimeDeHook } from "../src/teams.ts";
import { tempHome } from "./helpers.ts";

/*
 * As duas rotas SSE que a torre de magia usa: o Quadro (mural do Observatório) e os runs
 * (bibliotecário escrevendo enquanto o hook roda).
 */

const token = "test-token";

/** Abre o SSE e devolve um leitor que junta os `data:` que chegarem. */
async function abrir(app: ReturnType<typeof createApp>, path: string) {
  const ctrl = new AbortController();
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  const leitor = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    /** Lê até ter `n` eventos (ou estourar o tempo). */
    async eventos(n: number, ms = 1500): Promise<any[]> {
      const fim = Date.now() + ms;
      const achados = () => [...buf.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!));
      while (achados().length < n && Date.now() < fim) {
        const r = await Promise.race([
          leitor.read(),
          new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), fim - Date.now())),
        ]);
        if (r.done) break;
        buf += dec.decode(r.value);
      }
      return achados();
    },
    fechar() {
      ctrl.abort();
      void leitor.cancel().catch(() => {});
    },
  };
}

const esperaAbrir = () => new Promise((ok) => setTimeout(ok, 20));

describe("SSE do Quadro (/v1/tarefas/events)", () => {
  it("exige projectPath", async () => {
    const app = createApp(tempHome(), token);
    const res = await app.request("/v1/tarefas/events", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it("criou, moveu (com a coluna de antes) e quem mexeu", async () => {
    const home = tempHome();
    const app = createApp(home, token);
    const projectPath = "C:/proj/torre";
    const sse = await abrir(app, `/v1/tarefas/events?projectPath=${encodeURIComponent(projectPath)}`);
    await esperaAbrir();
    const [a, b] = getQuadro(projectPath, home).colunas;
    const t = salvarTarefa({ projectPath, titulo: "Mural", colunaId: a!.id }, home);
    comoAutor("agente", () => salvarTarefa({ projectPath, id: t.id, colunaId: b!.id }, home));
    // outro projeto não vaza pra cá
    salvarTarefa({ projectPath: "C:/proj/outro", titulo: "X", colunaId: getQuadro("C:/proj/outro", home).colunas[0]!.id }, home);
    const evs = await sse.eventos(2);
    sse.fechar();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ tarefaId: t.id, tipo: "criou", para: a!.id, titulo: "Mural" });
    expect(evs[0].via).toBeUndefined();
    expect(evs[1]).toMatchObject({ tarefaId: t.id, tipo: "moveu", de: a!.id, para: b!.id, via: "agente" });
    expect(typeof evs[1].em).toBe("string");
  });

  it("checklist e comentário pela ferramenta saem como agente", async () => {
    const home = tempHome();
    const app = createApp(home, token);
    const projectPath = "C:/proj/torre2";
    const col = getQuadro(projectPath, home).colunas[0]!;
    const t = salvarTarefa({ projectPath, titulo: "T", colunaId: col.id }, home);
    const sse = await abrir(app, `/v1/tarefas/events?projectPath=${encodeURIComponent(projectPath)}`);
    await esperaAbrir();
    const res = await app.request(`/v1/tarefas/${t.id}/comentarios?projectPath=${encodeURIComponent(projectPath)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ texto: "oi" }),
    });
    expect(res.status).toBe(201);
    const evs = await sse.eventos(1);
    sse.fechar();
    expect(evs[0]).toMatchObject({ tarefaId: t.id, tipo: "comentou", de: col.id, para: col.id });
    expect(evs[0].via).toBeUndefined();
  });
});

describe("SSE de runs (/v1/runs/events)", () => {
  it("leva projeto e marca de hook; filtra por projeto", async () => {
    const home = tempHome();
    const app = createApp(home, token);
    addProfile({ id: "p1", engine: "stub" }, home);
    saveAgent({ id: "memo", name: "Memória", profileId: "p1" }, home);
    const time = upsertTimeDeHook("memo", home);
    const base = { goal: "g", status: "running" as const, steps: [], createdAt: new Date().toISOString() };
    saveRun({ ...base, id: "run-a", teamId: time.id, projectPath: "C:/proj/a" }, home);
    saveRun({ ...base, id: "run-b", teamId: "time-x", projectPath: "C:/proj/b" }, home);

    const tudo = await abrir(app, "/v1/runs/events");
    const soA = await abrir(app, `/v1/runs/events?projectPath=${encodeURIComponent("C:/proj/a")}`);
    await esperaAbrir();
    runsBus.emit("*", { type: "run_start", runId: "run-b", teamId: "time-x" });
    runsBus.emit("*", { type: "run_start", runId: "run-a", teamId: time.id });
    runsBus.emit("*", { type: "run_start", runId: "nao-existe", teamId: "?" });
    const evs = await tudo.eventos(2);
    const evsA = await soA.eventos(1);
    tudo.fechar();
    soA.fechar();
    expect(evs).toEqual([
      { type: "run_start", runId: "run-b", teamId: "time-x", projectPath: "C:/proj/b", hook: false, time: "time-x" },
      { type: "run_start", runId: "run-a", teamId: time.id, projectPath: "C:/proj/a", hook: true, time: "Hook: Memória" },
    ]);
    expect(evsA.map((e) => e.runId)).toEqual(["run-a"]);
  });
});
