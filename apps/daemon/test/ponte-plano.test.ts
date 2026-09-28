import { afterEach, describe, expect, it } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { perguntar, resetPerguntasForTest, temPerguntaPendente } from "../src/perguntas.ts";
import { alternarPonte, iniciarPontePlano, ligarPlano, mandarPelaPonte, ponteLigada, resetPontePlanoForTest } from "../src/ponte-plano.ts";
import { appendEvent, createThread, listThreads, readThread, threadHead } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

function cenario() {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  const origem = createThread({ projectPath: "/proj", profileId: "p1" }, home).id;
  const manager = createThread({ projectPath: "/proj", profileId: "p1", planejamento: { slug: "plano-x" }, origemThreadId: origem }, home).id;
  ligarPlano(origem, "plano-x", manager, "Plano X", home);
  return { home, origem, manager };
}

const pontes = (home: string, id: string) => readThread(id, home).filter((e) => e.type === "ponte");

describe("ponte chat de origem ↔ Agent Manager", () => {
  afterEach(() => {
    resetPontePlanoForTest();
    resetPerguntasForTest();
  });

  it("chat de origem fica ligado ao plano e o Manager aparece na barra lateral", () => {
    const { home, origem, manager } = cenario();
    expect(threadHead(origem, home)?.planoLigado).toEqual({ slug: "plano-x", managerThreadId: manager, titulo: "Plano X", ligada: true });
    expect(ponteLigada(origem, home)).toEqual({ slug: "plano-x", managerThreadId: manager });
    const ids = listThreads("/proj", home).map((t) => t.id);
    expect(ids).toContain(manager);
    expect(ids).toContain(origem);
  });

  it("mensagem no chat de origem responde a pergunta pendente do Manager", async () => {
    const { home, origem, manager } = cenario();
    const chamada = perguntar(manager, home, "qual escopo?", ["a", "b"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(temPerguntaPendente(manager)).toBe(true);

    mandarPelaPonte(origem, "b", [], home);

    expect(await chamada).toEqual({ ok: true, texto: "b" });
    expect(pontes(home, origem)).toMatchObject([{ direcao: "ida", texto: "b", managerThreadId: manager }]);
  });

  it("fala do Manager volta pro chat de origem; desligada, não volta nem desvia mensagem", () => {
    const { home, origem, manager } = cenario();
    iniciarPontePlano();
    appendEvent({ ts: new Date().toISOString(), type: "assistant", threadId: manager, text: "separei 3 etapas" }, home);
    expect(pontes(home, origem)).toMatchObject([{ direcao: "volta", texto: "separei 3 etapas" }]);

    expect(alternarPonte(origem, false, home)).toBe(true);
    expect(ponteLigada(origem, home)).toBeNull();
    appendEvent({ ts: new Date().toISOString(), type: "assistant", threadId: manager, text: "outra fala" }, home);
    expect(pontes(home, origem)).toHaveLength(1);
    expect(() => mandarPelaPonte(origem, "oi", [], home)).toThrow();
  });

  it("conversa que nunca abriu plano não tem ponte pra alternar", () => {
    const { home } = cenario();
    const solta = createThread({ projectPath: "/proj", profileId: "p1" }, home).id;
    expect(alternarPonte(solta, true, home)).toBe(false);
  });
});

describe("título do plano vindo da conversa", () => {
  it("corta no fim de uma palavra, com reticências", async () => {
    const { tituloCurto } = await import("../src/planejamento-integracao.ts");
    expect(tituloCurto("Quero planejar um botao de exportar CSV na tela de Tarefas do Nexos. Responda em 1 linha")).toBe(
      "Quero planejar um botao de exportar CSV na tela de Tarefas…",
    );
    expect(tituloCurto("curto")).toBe("curto");
  });
});

describe("POST /v1/threads/:id/messages com pergunta pendente", () => {
  it("o texto vira a resposta da pergunta, sem abrir turno novo", async () => {
    const { createApp } = await import("../src/http.ts");
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home).id;
    const app = createApp(home, "tk");
    const chamada = perguntar(t, home, "qual?", ["a", "b"]);
    await new Promise((r) => setTimeout(r, 10));
    const res = await app.request(`/v1/threads/${t}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer tk", "content-type": "application/json" },
      body: JSON.stringify({ text: "b" }),
    });
    expect(await res.json()).toEqual({ ok: true, respondeu: true });
    expect(await chamada).toEqual({ ok: true, texto: "b" });
    expect(readThread(t, home).filter((e) => e.type === "user")).toHaveLength(0);
  });
});
