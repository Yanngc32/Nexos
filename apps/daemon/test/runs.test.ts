import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { removeAgent, saveAgent } from "../src/agents.ts";
import { saveTeam } from "../src/teams.ts";
import { criarRun, executarRun, getRun, listRuns, resetRunsForTest, runsBus } from "../src/runs.ts";
import { readThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

/*
 * O motor stub ecoa "echo:<pedido>", então a saída de cada passo carrega o
 * pedido inteiro que ele recebeu — é o que deixa verificar, sem mockar nada,
 * que o objetivo, o papel e a entrada do passo anterior chegaram de verdade.
 */

function time(membros: Array<{ agentId: string; papel?: string }>, home: string) {
  return saveTeam({ id: "t", name: "T", members: membros }, home);
}

function base(): string {
  resetRunsForTest();
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "a1", name: "A1", profileId: "p1" }, home);
  saveAgent({ id: "a2", name: "A2", profileId: "p1" }, home);
  return home;
}

async function rodar(home: string, goal = "fazer a coisa", budget?: unknown) {
  const run = criarRun({ teamId: "t", projectPath: "/proj", goal, budget }, home);
  return executarRun(run, home);
}

describe("pipeline", () => {
  it("roda os membros na ordem, um por passo", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home);
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => [s.agentId, s.status])).toEqual([
      ["a1", "done"],
      ["a2", "done"],
    ]);
  });

  it("cada passo tem a própria conversa, e ela fica pra auditoria", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home);
    const ids = run.steps.map((s) => s.threadId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(readThread(id!, home).length).toBeGreaterThan(0);
  });

  it("o objetivo do run chega no primeiro membro", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home, "consertar o login");
    const saida = readFileSync(run.steps[0]!.artifact!, "utf8");
    expect(saida).toContain("consertar o login");
  });

  it("o papel do membro entra no pedido dele", async () => {
    const home = base();
    time([{ agentId: "a1", papel: "só critica, não conserta" }], home);
    const run = await rodar(home);
    expect(readFileSync(run.steps[0]!.artifact!, "utf8")).toContain("só critica, não conserta");
  });

  it("a saída de um passo vira entrada do próximo", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, "marcador-unico-42");
    const segundo = readFileSync(run.steps[1]!.artifact!, "utf8");
    // o segundo recebeu o que o primeiro produziu, que continha o objetivo
    expect(segundo).toContain("Entrada (saída do passo anterior)");
    expect(segundo).toContain("marcador-unico-42");
  });

  it("o primeiro passo não recebe bloco de entrada — não há anterior", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home);
    expect(readFileSync(run.steps[0]!.artifact!, "utf8")).not.toContain("passo anterior");
  });

  it("cada passo grava artefato com a saída inteira", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home);
    for (const s of run.steps) {
      expect(s.artifact).toMatch(/passo-\d+-a\d\.md$/);
      expect(readFileSync(s.artifact!, "utf8").length).toBe(s.outputChars);
    }
  });

  it("passo guarda início, fim e uso", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home);
    const s = run.steps[0]!;
    expect(s.startedAt).toBeTruthy();
    expect(s.endedAt).toBeTruthy();
    expect(typeof s.tokens).toBe("number");
    expect(typeof s.costUsd).toBe("number");
  });
});

describe("persistência", () => {
  it("o run é lido de volta do disco com os passos", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home);
    const salvo = getRun(run.id, home);
    expect(salvo?.status).toBe("done");
    expect(salvo?.steps[0]?.status).toBe("done");
  });

  it("listRuns filtra por projeto e traz o mais novo primeiro", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const a = criarRun({ teamId: "t", projectPath: "/proj", goal: "um" }, home);
    await new Promise((r) => setTimeout(r, 5));
    const b = criarRun({ teamId: "t", projectPath: "/outro", goal: "dois" }, home);
    expect(listRuns(home).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(listRuns(home, "/proj").map((r) => r.id)).toEqual([a.id]);
  });
});

describe("criação", () => {
  it("recusa time, projeto ou objetivo faltando", () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    expect(() => criarRun({ teamId: "fantasma", projectPath: "/p", goal: "x" }, home)).toThrow(
      /time não existe/,
    );
    expect(() => criarRun({ teamId: "t", projectPath: "", goal: "x" }, home)).toThrow(/projectPath/);
    expect(() => criarRun({ teamId: "t", projectPath: "/p", goal: "   " }, home)).toThrow(/goal/);
  });

  it("nasce com todos os passos pendentes e nada executado", () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x" }, home);
    expect(run.status).toBe("running");
    expect(run.steps.every((s) => s.status === "pending")).toBe(true);
    expect(run.steps.every((s) => !s.threadId)).toBe(true);
  });

  it("agente apagado depois do time criado é pego antes de gastar quota", () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    removeAgent("a2", home);
    // pega na criação, não no meio: falhar no passo 2 já teria gasto o passo 1
    expect(() => criarRun({ teamId: "t", projectPath: "/p", goal: "x" }, home)).toThrow(
      /agente não existe: a2/,
    );
  });
});

describe("falha", () => {
  it("passo com conta sem login para o run e não segue pro próximo", async () => {
    const home = base();
    addProfile({ id: "morto", engine: "claude" }, home, { skipBinCheck: true });
    saveAgent({ id: "quebra", name: "Quebra", profileId: "morto" }, home);
    time([{ agentId: "quebra" }, { agentId: "a2" }], home);
    const run = await rodar(home);
    expect(run.status).toBe("error");
    expect(run.steps[0]?.status).toBe("error");
    // o segundo nem começou: entrada vazia produziria trabalho sem base
    expect(run.steps[1]?.status).toBe("pending");
    expect(run.steps[1]?.threadId).toBeUndefined();
  });

  it("o motivo da falha fica no passo e no run", async () => {
    const home = base();
    addProfile({ id: "morto", engine: "claude" }, home, { skipBinCheck: true });
    saveAgent({ id: "quebra", name: "Quebra", profileId: "morto" }, home);
    time([{ agentId: "quebra" }], home);
    const run = await rodar(home);
    expect(run.steps[0]?.error).toBeTruthy();
    expect(run.error).toBe(run.steps[0]?.error);
  });
});

describe("orçamento", () => {
  it("teto de passos corta antes de rodar o excedente", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, "x", { maxSteps: 1 });
    expect(run.steps[0]?.status).toBe("done");
    expect(run.steps[1]?.status).toBe("skipped");
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/teto de 1 passos/);
  });

  it("orçamento zerado não conta como teto: 0 é ausente, não 'proibido'", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home, "x", { maxUsd: 0, maxSteps: 0 });
    expect(run.budget).toBeUndefined();
    expect(run.status).toBe("done");
  });

  it("orçamento inválido é ignorado em vez de derrubar", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = await rodar(home, "x", { maxUsd: "muito", maxSteps: null });
    expect(run.budget).toBeUndefined();
  });
});

describe("eventos", () => {
  it("emite início, um par por passo e fim", async () => {
    const home = base();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x" }, home);
    const vistos: string[] = [];
    const onEv = (ev: { type: string }) => vistos.push(ev.type);
    runsBus.on(run.id, onEv);
    await executarRun(run, home);
    runsBus.off(run.id, onEv);
    expect(vistos).toEqual([
      "run_start",
      "step_start",
      "step_done",
      "step_start",
      "step_done",
      "run_end",
    ]);
  });

  it("o canal '*' recebe o que qualquer run emite", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const vistos: string[] = [];
    const onEv = (ev: { type: string }) => vistos.push(ev.type);
    runsBus.on("*", onEv);
    await rodar(home);
    runsBus.off("*", onEv);
    expect(vistos).toContain("run_start");
    expect(vistos).toContain("run_end");
  });

  it("run_end carrega o status final", async () => {
    const home = base();
    time([{ agentId: "a1" }], home);
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x" }, home);
    let fim: { status?: string } = {};
    runsBus.on(run.id, (ev: { type: string; status?: string }) => {
      if (ev.type === "run_end") fim = ev;
    });
    await executarRun(run, home);
    expect(fim.status).toBe("done");
  });
});
