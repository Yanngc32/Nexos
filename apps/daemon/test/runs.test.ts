import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("fan-in", () => {
  function timeFanIn(membros: Array<{ agentId: string; papel?: string }>, home: string) {
    return saveTeam({ id: "t", name: "T", topology: "fanin", members: membros }, home);
  }

  it("todos menos o último rodam; o último junta", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await rodar(home);
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("o agregador recebe a saída de TODOS os paralelos, identificadas", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn(
      [
        { agentId: "a1", papel: "olha o backend" },
        { agentId: "a2", papel: "olha o frontend" },
        { agentId: "juntar", papel: "escreve o relatório" },
      ],
      home,
    );
    const run = await rodar(home, "auditar o sistema");
    const relatorio = readFileSync(run.steps[2]!.artifact!, "utf8");
    expect(relatorio).toContain("2 membros trabalharam em paralelo");
    // cada entrada vem com o nome de quem produziu: sem isso ele não sabe quem disse o quê
    expect(relatorio).toContain("## a1 — olha o backend");
    expect(relatorio).toContain("## a2 — olha o frontend");
  });

  it("os paralelos não recebem entrada: não há passo anterior", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await rodar(home);
    for (const i of [0, 1]) {
      expect(readFileSync(run.steps[i]!.artifact!, "utf8")).not.toContain("Entrada");
    }
  });

  it("os paralelos rodam ao mesmo tempo, não em fila", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await rodar(home);
    const [a, b] = run.steps;
    // se fossem em fila, o segundo começaria depois do primeiro terminar
    expect(Date.parse(b!.startedAt!)).toBeLessThanOrEqual(Date.parse(a!.endedAt!));
  });

  it("falha de um paralelo pula o agregador e para o run", async () => {
    const home = base();
    addProfile({ id: "morto", engine: "claude" }, home, { skipBinCheck: true });
    saveAgent({ id: "quebra", name: "Quebra", profileId: "morto" }, home);
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "quebra" }, { agentId: "juntar" }], home);
    const run = await rodar(home);
    expect(run.status).toBe("error");
    // o que deu certo terminou: a quota dele já tinha sido gasta, cancelar não devolve
    expect(run.steps[0]?.status).toBe("done");
    expect(run.steps[1]?.status).toBe("error");
    expect(run.steps[2]?.status).toBe("skipped");
  });

  it("time de um membro só cai no pipeline: não há o que juntar", async () => {
    const home = base();
    timeFanIn([{ agentId: "a1" }], home);
    const run = await rodar(home, "sozinho");
    expect(run.status).toBe("done");
    expect(readFileSync(run.steps[0]!.artifact!, "utf8")).toContain("sozinho");
  });

  it("teto de passos corta antes de disparar o lote", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await rodar(home, "x", { maxSteps: 1 });
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/teto de 1 passos/);
    expect(run.steps.every((s) => s.status !== "done")).toBe(true);
  });

  it("emite um par de eventos por passo, agregador incluso", async () => {
    const home = base();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x" }, home);
    const vistos: string[] = [];
    const onEv = (ev: { type: string }) => vistos.push(ev.type);
    runsBus.on(run.id, onEv);
    await executarRun(run, home);
    runsBus.off(run.id, onEv);
    expect(vistos.filter((t) => t === "step_start")).toHaveLength(3);
    expect(vistos.filter((t) => t === "step_done")).toHaveLength(3);
    expect(vistos.at(-1)).toBe("run_end");
  });
});

describe("isolamento no fan-in", () => {
  /** Repositório de verdade: o isolamento é git worktree, não dá pra fingir. */
  function repoGit(): string {
    const dir = mkdtempSync(join(tmpdir(), "nexo-runrepo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "teste@nexo");
    git("config", "user.name", "Teste");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "alvo.txt"), "original\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "primeiro");
    return dir;
  }

  function timeFanIn(membros: Array<{ agentId: string }>, home: string) {
    return saveTeam({ id: "t", name: "T", topology: "fanin", members: membros }, home);
  }

  it("cada paralelo trabalha numa árvore própria, com branch próprio", async () => {
    const home = base();
    const projeto = repoGit();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await executarRun(criarRun({ teamId: "t", projectPath: projeto, goal: "x" }, home), home);

    expect(run.isolated).toBe(true);
    expect(run.steps[0]?.branch).toMatch(/^nexo\/r-.+\/1-a1$/);
    expect(run.steps[1]?.branch).toMatch(/^nexo\/r-.+\/2-a2$/);
    // árvores diferentes
    expect(run.steps[0]?.worktree).not.toBe(run.steps[1]?.worktree);
    // o agregador NÃO é isolado: ele junta, e junta na pasta do projeto
    expect(run.steps[2]?.worktree).toBeUndefined();
  });

  it("as árvores saem do disco no fim, e os branches ficam", async () => {
    const home = base();
    const projeto = repoGit();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "juntar" }], home);
    const run = await executarRun(criarRun({ teamId: "t", projectPath: projeto, goal: "x" }, home), home);

    expect(existsSync(run.steps[0]!.worktree!)).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", "nexo/*"], { cwd: projeto, encoding: "utf8" });
    expect(branches).toContain(run.steps[0]!.branch);
  });

  it("projeto sem git roda igual, registrando por que não isolou", async () => {
    const home = base();
    const semGit = mkdtempSync(join(tmpdir(), "nexo-semgit-"));
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await executarRun(criarRun({ teamId: "t", projectPath: semGit, goal: "x" }, home), home);

    // sem isolamento, mas o run roda: não isolar não é motivo pra recusar trabalho
    expect(run.status).toBe("done");
    expect(run.isolated).toBe(false);
    expect(run.isolationOff).toMatch(/repositório git/);
    expect(run.steps.every((s) => !s.worktree)).toBe(true);
  });

  it("pipeline NÃO isola: compartilhar a árvore é o ponto dele", async () => {
    const home = base();
    const projeto = repoGit();
    time([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await executarRun(criarRun({ teamId: "t", projectPath: projeto, goal: "x" }, home), home);
    expect(run.isolated).toBeUndefined();
    expect(run.steps.every((s) => !s.worktree)).toBe(true);
  });

  it("o motor de cada paralelo nasce dentro da árvore dele, não na pasta do projeto", async () => {
    const home = base();
    const projeto = repoGit();
    saveAgent({ id: "juntar", name: "Juntar", profileId: "p1" }, home);
    timeFanIn([{ agentId: "a1" }, { agentId: "a2" }, { agentId: "juntar" }], home);
    const run = await executarRun(criarRun({ teamId: "t", projectPath: projeto, goal: "x" }, home), home);

    // a conversa do passo guarda a pasta onde o motor rodou
    const meta = readThread(run.steps[0]!.threadId!, home)[0];
    expect(meta).toMatchObject({ type: "thread_meta", projectPath: run.steps[0]!.worktree });
    // e a do agregador aponta pro projeto
    const metaJunta = readThread(run.steps[2]!.threadId!, home)[0];
    expect(metaJunta).toMatchObject({ type: "thread_meta", projectPath: projeto });
  });
});

/*
 * O supervisor precisa responder DIFERENTE em turnos seguidos da mesma conversa
 * — chamar fulano, depois encerrar — e o eco do stub não dá isso. As linhas
 * `STUB:` no objetivo viram a fila de falas daquele motor (ver stub.ts): cada
 * conversa nova captura a fila do pedido que recebe, então o supervisor consome
 * o roteiro na ordem e cada membro consome uma cópia, sem atrapalhar.
 */
describe("supervisor", () => {
  function timeSup(membros: Array<{ agentId: string; papel?: string }>, home: string) {
    return saveTeam({ id: "t", name: "T", topology: "supervisor", members: membros }, home);
  }

  const chamar = (membro: string, pedido = "faz isso") =>
    `STUB:{"acao":"chamar","membro":"${membro}","pedido":"${pedido}"}`;
  const encerrar = (resumo = "acabou") => `STUB:{"acao":"encerrar","resumo":"${resumo}"}`;

  function roteiro(...falas: string[]): string {
    return ["objetivo do time", ...falas].join("\n");
  }

  it("chama quem ele escolheu e encerra quando quer", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(chamar("a2"), encerrar("relatório final")));
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => [s.agentId, s.status])).toEqual([
      ["a1", "done"],
      ["a2", "done"],
    ]);
    expect(run.steps[0]?.supervisor).toBe(true);
    expect(readFileSync(run.steps[0]!.artifact!, "utf8")).toBe("relatório final");
  });

  it("o run nasce só com o passo do supervisor: os outros ele decide durante", () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = criarRun({ teamId: "t", projectPath: "/p", goal: "x" }, home);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.agentId).toBe("a1");
  });

  it("o pedido do supervisor chega no membro, junto do objetivo", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(chamar("a2", "lê o config"), encerrar()));
    const recebido = readThread(run.steps[1]!.threadId!, home).find((e) => e.type === "user") as {
      text: string;
    };
    expect(recebido.text).toContain("# Objetivo do time");
    expect(recebido.text).toContain("# Pedido do supervisor");
    expect(recebido.text).toContain("lê o config");
    // pedido do supervisor não tem artefato: não pode apontar pra arquivo nenhum
    expect(recebido.text).not.toContain("Arquivo com a entrada completa");
  });

  it("o supervisor vê a lista de quem pode chamar, com papel", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2", papel: "olha o banco" }], home);
    const run = await rodar(home, roteiro(encerrar()));
    const pedido = readThread(run.steps[0]!.threadId!, home).find((e) => e.type === "user");
    expect(pedido).toMatchObject({ text: expect.stringContaining("- a2 — A2: olha o banco") });
    // ele mesmo não está na lista: supervisor que se chama vira laço
    expect((pedido as { text: string }).text).not.toContain("- a1 —");
  });

  it("o resultado do membro volta pro supervisor na MESMA conversa", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(chamar("a2"), encerrar()));
    const falas = readThread(run.steps[0]!.threadId!, home).filter((e) => e.type === "user");
    expect(falas).toHaveLength(2);
    expect((falas[1] as { text: string }).text).toContain("# Resultado de a2");
    // o segundo pedido não repete o objetivo: a conversa é a mesma, isso seria pago duas vezes
    expect((falas[1] as { text: string }).text).not.toContain("# Objetivo do time");
  });

  it("o custo do supervisor é o acumulado das decisões, não o da última", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(chamar("a2"), chamar("a2"), encerrar()));
    expect(run.steps[0]?.decisoes).toBe(3);
    expect(run.steps).toHaveLength(3);
  });

  it("resposta fora do formato ganha UMA correção, e a segunda derruba o run", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro("STUB:não vou responder em JSON", "STUB:continuo sem JSON"));
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/não respondeu no formato/);
    expect(run.steps[0]?.decisoes).toBe(2);
  });

  it("uma correção basta: JSON no meio de texto é aceito", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(`STUB:claro! {"acao":"encerrar","resumo":"ok"} espero ter ajudado`));
    expect(run.status).toBe("done");
    expect(run.steps[0]?.decisoes).toBe(1);
  });

  it("membro fora do time é recusado em vez de adivinhado", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = await rodar(home, roteiro(chamar("fantasma"), encerrar("depois da correção")));
    // a correção entrou e ele encerrou: nenhum passo de trabalho foi criado
    expect(run.status).toBe("done");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.decisoes).toBe(2);
  });

  it("membro que falha volta pro supervisor decidir, e não derruba o run", async () => {
    const home = base();
    addProfile({ id: "morto", engine: "claude" }, home, { skipBinCheck: true });
    saveAgent({ id: "quebra", name: "Quebra", profileId: "morto" }, home);
    timeSup([{ agentId: "a1" }, { agentId: "quebra" }], home);
    const run = await rodar(home, roteiro(chamar("quebra"), encerrar("segui sem ele")));
    expect(run.status).toBe("done");
    expect(run.steps[1]?.status).toBe("error");
    const falas = readThread(run.steps[0]!.threadId!, home).filter((e) => e.type === "user");
    expect((falas[1] as { text: string }).text).toContain("quebra falhou");
  });

  it("o teto de passos para o laço mesmo com o supervisor querendo seguir", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    // três chamadas roteirizadas, teto de 3 passos (supervisor + 2 membros)
    const run = await rodar(home, roteiro(chamar("a2"), chamar("a2"), chamar("a2"), encerrar()), {
      maxSteps: 3,
    });
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/teto de 3 passos/);
    expect(run.steps).toHaveLength(3);
    expect(run.steps[0]?.status).toBe("error");
  });

  it("time sem ninguém além do supervisor é recusado na criação do time", () => {
    const home = base();
    expect(() => timeSup([{ agentId: "a1" }], home)).toThrow(/pelo menos um membro além dele/);
  });

  it("passo que nasce no meio do run é anunciado antes de começar", async () => {
    const home = base();
    timeSup([{ agentId: "a1" }, { agentId: "a2" }], home);
    const run = criarRun(
      { teamId: "t", projectPath: "/p", goal: roteiro(chamar("a2"), encerrar()) },
      home,
    );
    const vistos: string[] = [];
    const onEv = (ev: { type: string }) => vistos.push(ev.type);
    runsBus.on(run.id, onEv);
    await executarRun(run, home);
    runsBus.off(run.id, onEv);
    expect(vistos).toEqual([
      "run_start",
      "step_start",
      "step_add",
      "step_start",
      "step_done",
      "step_done",
      "run_end",
    ]);
  });
});
