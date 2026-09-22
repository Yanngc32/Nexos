import { describe, expect, it } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import { saveTeam } from "../src/teams.ts";
import { sessionBus } from "../src/bus.ts";
import { abortarRun, criarRun, executarNoChat, resetRunsForTest, runsDoChat } from "../src/runs.ts";
import { createThread, listThreads, readThread } from "../src/threads.ts";
import { postMessage } from "../src/session.ts";
import { perguntar, resetPerguntasForTest, responderPergunta } from "../src/perguntas.ts";
import { tempHome } from "./helpers.ts";

/*
 * Time chamado de DENTRO de um chat (menção, roteador, nexo_delegar): os passos pertencem ao chat
 * de origem, rodam em fila com os outros times dele e o resultado volta pra ele. Motor stub ecoa
 * "echo:<pedido>".
 */

function base() {
  resetRunsForTest();
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "a1", name: "A1", profileId: "p1" }, home);
  saveTeam({ id: "t", name: "Revisores", members: [{ agentId: "a1" }] }, home);
  const origem = createThread({ projectPath: "/proj", profileId: "p1" }, home).id;
  return { home, origem };
}

describe("time dentro do chat", () => {
  it("passos saem da barra lateral, pedido vai marcado como automático, resultado volta pro chat", async () => {
    const { home, origem } = base();
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "revisar o login", origemThreadId: origem }, home);
    const feito = await executarNoChat(run, home, { entregar: true });
    expect(feito.status).toBe("done");

    const passo = feito.steps[0]!.threadId!;
    const meta = readThread(passo, home).find((e) => e.type === "thread_meta");
    expect(meta).toMatchObject({ origemThreadId: origem });
    const pedido = readThread(passo, home).find((e) => e.type === "user");
    expect(pedido).toMatchObject({ automatico: true });
    // só o chat de origem aparece na lista do projeto
    expect(listThreads("/proj", home).map((t) => t.id)).toEqual([origem]);

    const resultado = readThread(origem, home).find((e) => e.type === "run_resultado");
    expect(resultado).toMatchObject({ runId: feito.id, status: "done" });
    expect(resultado && resultado.type === "run_resultado" && resultado.texto).toContain("revisar o login");
    expect(runsDoChat(origem, home).map((r) => r.id)).toEqual([feito.id]);
  });

  it("a próxima mensagem do chat leva o resultado pro agente (uma vez só), sem sujar o que a pessoa digitou", async () => {
    const { home, origem } = base();
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "listar riscos", origemThreadId: origem }, home);
    await executarNoChat(run, home, { entregar: true });
    await postMessage(origem, "e aí, o que acharam?", home);
    const falas = readThread(origem, home);
    const eco = [...falas].reverse().find((e) => e.type === "assistant");
    expect(eco && eco.type === "assistant" && eco.text).toContain('O time "Revisores');
    const digitado = [...falas].reverse().find((e) => e.type === "user");
    expect(digitado).toMatchObject({ text: "e aí, o que acharam?" });
    // segunda mensagem: o resultado já foi entregue
    await postMessage(origem, "valeu", home);
    const eco2 = [...readThread(origem, home)].reverse().find((e) => e.type === "assistant");
    expect(eco2 && eco2.type === "assistant" && eco2.text).not.toContain("O time");
  });

  it("nexo_delegar (entregar: false) não grava resultado — ele volta pelo tool_result", async () => {
    const { home, origem } = base();
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x", origemThreadId: origem }, home);
    await executarNoChat(run, home, { entregar: false });
    expect(readThread(origem, home).some((e) => e.type === "run_resultado")).toBe(false);
  });

  it("dois times do mesmo chat rodam em fila, não juntos", async () => {
    const { home, origem } = base();
    const ordem: string[] = [];
    const ouvir = (ev: { type?: string; runId?: string; ev?: { type: string } }) => {
      if (ev.type === "run_evento" && ev.ev && (ev.ev.type === "run_start" || ev.ev.type === "run_end")) ordem.push(`${ev.ev.type}:${ev.runId}`);
    };
    sessionBus.on(origem, ouvir);
    try {
      const r1 = criarRun({ teamId: "t", projectPath: "/proj", goal: "um", origemThreadId: origem }, home);
      const r2 = criarRun({ teamId: "t", projectPath: "/proj", goal: "dois", origemThreadId: origem }, home);
      await Promise.all([executarNoChat(r1, home, { entregar: true }), executarNoChat(r2, home, { entregar: true })]);
      expect(ordem).toEqual([`run_start:${r1.id}`, `run_end:${r1.id}`, `run_start:${r2.id}`, `run_end:${r2.id}`]);
    } finally {
      sessionBus.off(origem, ouvir);
    }
  });

  it("time na fila pode ser cancelado antes de começar; o que está rodando segue", async () => {
    const { home, origem } = base();
    const r1 = criarRun({ teamId: "t", projectPath: "/proj", goal: "um", origemThreadId: origem }, home);
    const r2 = criarRun({ teamId: "t", projectPath: "/proj", goal: "dois", origemThreadId: origem }, home);
    const p1 = executarNoChat(r1, home, { entregar: true });
    const p2 = executarNoChat(r2, home, { entregar: true });
    expect(await abortarRun(r2.id)).toBe(true);
    const [f1, f2] = await Promise.all([p1, p2]);
    expect(f1.status).toBe("done");
    expect(f2).toMatchObject({ status: "aborted", error: "cancelado antes de começar" });
    expect(f2.steps.every((s) => s.status === "pending")).toBe(true);
    // só o que rodou devolve resultado
    expect(readThread(origem, home).filter((e) => e.type === "run_resultado").map((e) => e.type === "run_resultado" && e.runId)).toEqual([r1.id]);
  });

  it("pergunta do subagente aparece no chat de origem, e a resposta dada lá destrava o subagente", async () => {
    const { home, origem } = base();
    const passo = createThread({ projectPath: "/proj", profileId: "p1", agentId: "a1", origemThreadId: origem }, home).id;
    const vistos: { type?: string; deThreadId?: string; de?: string }[] = [];
    const ouvir = (ev: { type?: string; deThreadId?: string; de?: string }) => vistos.push(ev);
    sessionBus.on(origem, ouvir);
    try {
      const espera = perguntar(passo, home, "Qual ícone trocar?");
      const repassada = readThread(origem, home).find((e) => e.type === "pergunta");
      expect(repassada).toMatchObject({ texto: "Qual ícone trocar?", deThreadId: passo, de: "A1" });
      // a tela responde pela conversa DO PASSO (deThreadId)
      expect(responderPergunta(passo, "o do app desktop")).toBe(true);
      expect(await espera).toEqual({ ok: true, texto: "o do app desktop" });
      expect(readThread(origem, home).some((e) => e.type === "pergunta_resposta")).toBe(true);
      expect(vistos.map((e) => e.type)).toEqual(["pergunta", "pergunta_resposta"]);
    } finally {
      sessionBus.off(origem, ouvir);
      resetPerguntasForTest();
    }
  });

  it("origem que não existe é ignorada (não esconde passo de lista nenhuma)", () => {
    const { home } = base();
    const run = criarRun({ teamId: "t", projectPath: "/proj", goal: "x", origemThreadId: "t-nao-existe" }, home);
    expect(run.origemThreadId).toBeUndefined();
  });
});
