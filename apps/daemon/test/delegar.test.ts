import { describe, it, expect } from "vitest";
import { createThread } from "../src/threads.ts";
import { addProfile, updateProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import { saveTeam } from "../src/teams.ts";
import {
  ferramentaDeDelegar,
  modoDeDelegacaoDaThread,
  resetDelegarForTest,
} from "../src/delegar.ts";
import { responderPergunta } from "../src/perguntas.ts";
import { resetPerguntasForTest } from "../src/perguntas.ts";
import { sessionBus } from "../src/bus.ts";
import { tempHome } from "./helpers.ts";

function setup() {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "escritor", name: "Escritor", profileId: "p1" }, home);
  const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
  return { home, threadId: t.id };
}

describe("nexo_delegar", () => {
  it("modo negado (padrão): a conta não libera a ferramenta", () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    expect(modoDeDelegacaoDaThread(threadId, home)).toBe("negado");
  });

  it("modo liberado: roda o agente de verdade e devolve a saída como texto", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    updateProfile("p1", home, { delegacaoModo: "liberado" });
    expect(modoDeDelegacaoDaThread(threadId, home)).toBe("liberado");

    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];
    const saida = await ferramenta.executar({ agentId: "escritor", pedido: "escreva algo" });
    expect(saida.ok).toBe(true);
    expect(saida.texto).toContain("echo:");
  });

  it("agentId/teamId inexistente é recusado sem gastar run", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];
    const saida = await ferramenta.executar({ agentId: "fantasma", pedido: "x" });
    expect(saida.ok).toBe(false);
  });

  it("sem agentId nem teamId é recusado", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];
    const saida = await ferramenta.executar({ pedido: "x" });
    expect(saida.ok).toBe(false);
  });

  it("modo questionar: pausa via nexo_perguntar antes de rodar, resposta != sim cancela sem gastar run", async () => {
    resetDelegarForTest();
    resetPerguntasForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "questionar", home)()[0];

    const chamada = ferramenta.executar({ agentId: "escritor", pedido: "escreva algo" });
    await new Promise((r) => setTimeout(r, 10));
    responderPergunta(threadId, "não");
    const saida = await chamada;
    expect(saida.ok).toBe(false);
  });

  it("modo questionar: resposta 'sim' roda de verdade", async () => {
    resetDelegarForTest();
    resetPerguntasForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "questionar", home)()[0];

    const chamada = ferramenta.executar({ agentId: "escritor", pedido: "escreva algo" });
    await new Promise((r) => setTimeout(r, 10));
    responderPergunta(threadId, "sim");
    const saida = await chamada;
    expect(saida.ok).toBe(true);
  });

  it("teto de 3 delegações por turno: a 4ª é recusada", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];
    for (let i = 0; i < 3; i++) {
      const saida = await ferramenta.executar({ agentId: "escritor", pedido: `pedido ${i}` });
      expect(saida.ok).toBe(true);
    }
    const quarta = await ferramenta.executar({ agentId: "escritor", pedido: "pedido 4" });
    expect(quarta.ok).toBe(false);
  });

  it("emite delegacao_run com o runId ANTES do run terminar — é o que abre o subchat ao vivo", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];

    const vistos: Array<{ type: string; runId?: string }> = [];
    const onEv = (ev: { type: string; runId?: string }) => vistos.push(ev);
    sessionBus.on(threadId, onEv);
    try {
      const saida = await ferramenta.executar({ agentId: "escritor", pedido: "escreva algo" });
      expect(saida.ok).toBe(true);
      const ev = vistos.find((e) => e.type === "delegacao_run");
      expect(ev?.runId).toBeTruthy();
    } finally {
      sessionBus.off(threadId, onEv);
    }
  });

  it("teamId aponta pra time já existente e roda direto (sem criar time oculto)", async () => {
    resetDelegarForTest();
    const { home, threadId } = setup();
    saveTeam({ id: "revisao", name: "Revisão", topology: "pipeline", members: [{ agentId: "escritor" }] }, home);
    const ferramenta = ferramentaDeDelegar(threadId, "/proj", "liberado", home)()[0];
    const saida = await ferramenta.executar({ teamId: "revisao", pedido: "revise x" });
    expect(saida.ok).toBe(true);
  });
});
