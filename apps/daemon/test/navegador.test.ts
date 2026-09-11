import { describe, it, expect, vi } from "vitest";
import { createThread } from "../src/threads.ts";
import { addProfile, updateProfile } from "../src/profiles.ts";
import {
  comandoNavegador,
  ferramentasDeNavegador,
  modoDeNavegadorDaThread,
  responderNavegador,
  resetNavegadorForTest,
} from "../src/navegador.ts";
import { responderPergunta, resetPerguntasForTest } from "../src/perguntas.ts";
import { sessionBus } from "../src/bus.ts";
import { tempHome } from "./helpers.ts";

function setup() {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
  return { home, threadId: t.id };
}

describe("comandoNavegador / responderNavegador", () => {
  it("emite browser_comando no bus, pausa, e retoma com o resultado ao responder", async () => {
    resetNavegadorForTest();
    const { threadId } = setup();
    const eventos: unknown[] = [];
    sessionBus.on(threadId, (ev) => eventos.push(ev));

    const chamada = comandoNavegador(threadId, { acao: "abrir", url: "https://exemplo.com" });
    await new Promise((r) => setTimeout(r, 10));

    expect(eventos).toEqual([
      expect.objectContaining({ type: "browser_comando", threadId, acao: "abrir", url: "https://exemplo.com" }),
    ]);

    const resolvido = responderNavegador(threadId, { ok: true, texto: "aberto" });
    expect(resolvido).toBe(true);

    const saida = await chamada;
    expect(saida).toEqual({ ok: true, texto: "aberto" });
  });

  it("responder thread sem comando pendente devolve false", () => {
    resetNavegadorForTest();
    expect(responderNavegador("thread-sem-nada", { ok: true, texto: "x" })).toBe(false);
  });

  it("recusa um segundo comando enquanto o primeiro ainda está pendente na mesma thread", async () => {
    resetNavegadorForTest();
    const { threadId } = setup();
    void comandoNavegador(threadId, { acao: "ler" });
    await new Promise((r) => setTimeout(r, 10));

    const segundo = await comandoNavegador(threadId, { acao: "screenshot" });
    expect(segundo.ok).toBe(false);

    responderNavegador(threadId, { ok: true, texto: "x" });
  });

  it("sem resposta do renderer, expira sozinho depois do timeout e libera a thread", async () => {
    resetNavegadorForTest();
    vi.useFakeTimers();
    try {
      const { threadId } = setup();
      const chamada = comandoNavegador(threadId, { acao: "ler" });
      await vi.advanceTimersByTimeAsync(20_000);
      const saida = await chamada;
      expect(saida.ok).toBe(false);
      expect(saida.texto).toMatch(/não respondeu a tempo/);
      // liberou a thread — um comando novo não é mais recusado por "já existe pendente"
      const proximo = comandoNavegador(threadId, { acao: "ler" });
      responderNavegador(threadId, { ok: true, texto: "ok" });
      expect((await proximo).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("modoDeNavegadorDaThread", () => {
  it("padrão 'negado' quando o perfil não configurou nada", () => {
    resetNavegadorForTest();
    const { home, threadId } = setup();
    expect(modoDeNavegadorDaThread(threadId, home)).toBe("negado");
  });

  it("lê o modo configurado no perfil ativo da thread", () => {
    resetNavegadorForTest();
    const { home, threadId } = setup();
    updateProfile("p1", home, { navegadorModo: "liberado" });
    expect(modoDeNavegadorDaThread(threadId, home)).toBe("liberado");
  });

  it("thread inexistente devolve 'negado', não lança", () => {
    resetNavegadorForTest();
    expect(modoDeNavegadorDaThread("thread-fantasma", tempHome())).toBe("negado");
  });
});

describe("ferramentasDeNavegador", () => {
  it("modo liberado: todas rodam direto, sem perguntar nada", async () => {
    resetNavegadorForTest();
    const { threadId } = setup();
    const [abrir] = ferramentasDeNavegador(threadId, "h", "liberado")();
    const chamada = abrir!.executar({ url: "https://exemplo.com" });
    await new Promise((r) => setTimeout(r, 10));
    responderNavegador(threadId, { ok: true, texto: "aberto" });
    expect(await chamada).toEqual({ ok: true, texto: "aberto" });
  });

  it("modo questionar: abrir/clicar/digitar perguntam antes (nexo_perguntar) e respeitam a resposta", async () => {
    resetNavegadorForTest();
    resetPerguntasForTest();
    const { home, threadId } = setup();
    const [abrir] = ferramentasDeNavegador(threadId, home, "questionar")();

    const chamada = abrir!.executar({ url: "https://exemplo.com" });
    await new Promise((r) => setTimeout(r, 10));
    responderPergunta(threadId, "sim");
    await new Promise((r) => setTimeout(r, 10));
    // depois do "sim", o comando de navegador de verdade fica pendente — responde ele também
    responderNavegador(threadId, { ok: true, texto: "aberto" });
    expect(await chamada).toEqual({ ok: true, texto: "aberto" });
  });

  it("modo questionar: resposta diferente de 'sim' cancela sem chamar o comando de navegador", async () => {
    resetNavegadorForTest();
    resetPerguntasForTest();
    const { home, threadId } = setup();
    const [abrir] = ferramentasDeNavegador(threadId, home, "questionar")();

    const chamada = abrir!.executar({ url: "https://exemplo.com" });
    await new Promise((r) => setTimeout(r, 10));
    responderPergunta(threadId, "não");
    const saida = await chamada;
    expect(saida.ok).toBe(false);
    expect(saida.texto).toMatch(/cancelado/);
  });

  it("modo questionar: ler e screenshot NÃO perguntam antes", async () => {
    resetNavegadorForTest();
    resetPerguntasForTest();
    const { home, threadId } = setup();
    const [, ler] = ferramentasDeNavegador(threadId, home, "questionar")();

    const chamada = ler!.executar({});
    await new Promise((r) => setTimeout(r, 10));
    // se tivesse perguntado, isto resolveria a pergunta em vez do comando — como não perguntou,
    // resolve o comando de navegador direto
    const resolvido = responderNavegador(threadId, { ok: true, texto: "árvore" });
    expect(resolvido).toBe(true);
    expect(await chamada).toEqual({ ok: true, texto: "árvore" });
  });

  it("modo negado: ferramentasDeNavegador ainda pode ser chamado, mas quem monta o Conjunto decide não incluir (ver http.ts)", () => {
    // Não há checagem interna de "negado" aqui — a exclusão é responsabilidade de quem monta o
    // Conjunto (mesmo critério de ferramentaDeDelegar). Este teste documenta essa fronteira.
    resetNavegadorForTest();
    const { threadId } = setup();
    const ferramentas = ferramentasDeNavegador(threadId, "h", "negado")();
    expect(ferramentas).toHaveLength(5);
  });
});
