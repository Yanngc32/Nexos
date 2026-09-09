import { describe, it, expect } from "vitest";
import { createThread, readThread } from "../src/threads.ts";
import { addProfile } from "../src/profiles.ts";
import { ferramentaDePerguntar, responderPergunta, temPerguntaPendente, resetPerguntasForTest } from "../src/perguntas.ts";
import { tempHome } from "./helpers.ts";

describe("nexo_perguntar", () => {
  it("emite pergunta, pausa, e retoma com a resposta ao responder", async () => {
    resetPerguntasForTest();
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const ferramenta = ferramentaDePerguntar(t.id, home)()[0];

    const chamada = ferramenta.executar({ pergunta: "qual conta usar?", opcoes: ["a", "b"] });

    // dá um tick pro `executar` chegar até o `await` da resposta
    await new Promise((r) => setTimeout(r, 10));
    expect(temPerguntaPendente(t.id)).toBe(true);
    const pergunta = readThread(t.id, home).find((e) => e.type === "pergunta");
    expect(pergunta && pergunta.type === "pergunta" ? pergunta.texto : "").toBe("qual conta usar?");
    expect(pergunta && pergunta.type === "pergunta" ? pergunta.opcoes : []).toEqual(["a", "b"]);

    const resolvida = responderPergunta(t.id, "a");
    expect(resolvida).toBe(true);
    expect(temPerguntaPendente(t.id)).toBe(false);

    const saida = await chamada;
    expect(saida).toEqual({ ok: true, texto: "a" });

    const resposta = readThread(t.id, home).find((e) => e.type === "pergunta_resposta");
    expect(resposta && resposta.type === "pergunta_resposta" ? resposta.resposta : "").toBe("a");
  });

  it("multiSelect: true chega no evento pergunta, e a resposta pode juntar mais de uma opção", async () => {
    resetPerguntasForTest();
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const ferramenta = ferramentaDePerguntar(t.id, home)()[0];

    const chamada = ferramenta.executar({
      pergunta: "quais pontos se aplicam?",
      opcoes: ["a", "b", "c"],
      multiSelect: true,
    });
    await new Promise((r) => setTimeout(r, 10));

    const pergunta = readThread(t.id, home).find((e) => e.type === "pergunta");
    expect(pergunta && pergunta.type === "pergunta" ? pergunta.multiSelect : undefined).toBe(true);

    responderPergunta(t.id, "a; c");
    const saida = await chamada;
    expect(saida).toEqual({ ok: true, texto: "a; c" });
  });

  it("sem opcoes, multiSelect é ignorado (não faz sentido marcar várias sem opção nenhuma)", async () => {
    resetPerguntasForTest();
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const ferramenta = ferramentaDePerguntar(t.id, home)()[0];

    void ferramenta.executar({ pergunta: "aberta?", multiSelect: true });
    await new Promise((r) => setTimeout(r, 10));
    const pergunta = readThread(t.id, home).find((e) => e.type === "pergunta");
    expect(pergunta && pergunta.type === "pergunta" ? pergunta.multiSelect : undefined).toBeUndefined();
    responderPergunta(t.id, "ok");
  });

  it("responder thread sem pergunta pendente devolve false", () => {
    resetPerguntasForTest();
    expect(responderPergunta("thread-sem-nada", "x")).toBe(false);
  });

  it("recusa segunda pergunta enquanto a primeira ainda está pendente", async () => {
    resetPerguntasForTest();
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const ferramenta = ferramentaDePerguntar(t.id, home)()[0];

    void ferramenta.executar({ pergunta: "primeira?" });
    await new Promise((r) => setTimeout(r, 10));

    const segunda = await ferramenta.executar({ pergunta: "segunda?" });
    expect(segunda.ok).toBe(false);

    responderPergunta(t.id, "ok");
  });

  it("sem 'pergunta' recusa antes de pausar nada", async () => {
    resetPerguntasForTest();
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const ferramenta = ferramentaDePerguntar(t.id, home)()[0];
    const saida = await ferramenta.executar({});
    expect(saida.ok).toBe(false);
  });
});
