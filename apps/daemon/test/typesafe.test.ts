import { afterEach, describe, expect, it, vi } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import { saveConfig } from "../src/config.ts";
import {
  avisoNovoDePausa,
  clearTypesafeApiKey,
  decidirRoteamento,
  hasTypesafeApiKey,
  pausaDoTypesafe,
  resetTypesafeCircuitoForTest,
  saveTypesafeApiKey,
  TIMEOUT_TYPESAFE_MS,
  typesafeUsage,
} from "../src/typesafe.ts";
import { tempHome } from "./helpers.ts";

function homeComAgente(): string {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "revisor", name: "Revisor", profileId: "p1", description: "Revisa PRs" }, home);
  return home;
}

function respostaFake(choice: string, confidence: number) {
  return new Response(
    JSON.stringify({
      model: "jev-1.0",
      answers: {
        which_agent: {
          type: "choice",
          choice,
          confidence,
          probabilities: { [choice]: confidence, automatico: 1 - confidence },
        },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("typesafe: armazenamento da key", () => {
  it("save/has/clear", () => {
    const home = tempHome();
    expect(hasTypesafeApiKey(home)).toBe(false);
    saveTypesafeApiKey("abc123", home);
    expect(hasTypesafeApiKey(home)).toBe(true);
    clearTypesafeApiKey(home);
    expect(hasTypesafeApiKey(home)).toBe(false);
  });

  it("recusa key vazia", () => {
    const home = tempHome();
    expect(() => saveTypesafeApiKey("   ", home)).toThrow();
  });

  it("uso começa zerado", () => {
    expect(typesafeUsage(tempHome())).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 });
  });
});

describe("typesafe: decidirRoteamento nunca lança e é best-effort", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("modo desligado nunca chama a API", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "desligado" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem key configurada, não chama a API", async () => {
    const home = homeComAgente();
    saveConfig(home, { typesafe: { modo: "automatico" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem nenhum agente cadastrado, não chama a API", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolve pra agente e contabiliza o uso de tokens", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.9)));

    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toMatchObject({ tipo: "agente", agentId: "revisor", confianca: 0.9 });
    expect(typesafeUsage(home)).toEqual({ inputTokens: 100, outputTokens: 20, calls: 1 });
  });

  it("resolve pra automatico quando a escolha é 'automatico'", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("automatico", 0.7)));

    expect(await decidirRoteamento({ mensagem: "qualquer coisa" }, home)).toMatchObject({ tipo: "automatico", confianca: 0.7 });
  });

  it("resolve pra time quando a escolha vem prefixada 'time:'", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("time:time-feature", 0.85)));

    expect(await decidirRoteamento({ mensagem: "implementa e revisa" }, home)).toMatchObject({ tipo: "time", teamId: "time-feature", confianca: 0.85 });
  });

  it("erro de rede não lança — devolve undefined", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
  });

  it("resposta 401 (key inválida) não lança — devolve undefined", async () => {
    const home = homeComAgente();
    saveTypesafeApiKey("k-invalida", home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })),
    );
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
  });
});

describe("typesafe: falha não pode virar espera em toda mensagem", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTypesafeCircuitoForTest();
  });

  function homeLigado(key = "k"): string {
    const home = homeComAgente();
    saveTypesafeApiKey(key, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    return home;
  }

  it("espera no máximo 3s por chamada", () => {
    expect(TIMEOUT_TYPESAFE_MS).toBe(3000);
  });

  it("key recusada (401) pausa: a próxima mensagem nem chama a API, e o aviso sai uma vez só", async () => {
    const home = homeLigado("k-invalida");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pausaDoTypesafe(home)).toMatchObject({ motivo: "key-recusada" });

    expect(await decidirRoteamento({ mensagem: "e agora?" }, home)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(avisoNovoDePausa(home)).toMatchObject({ motivo: "key-recusada" });
    expect(avisoNovoDePausa(home)).toBeUndefined();
  });

  it("salvar outra key tira a pausa na hora", async () => {
    const home = homeLigado("k-invalida");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await decidirRoteamento({ mensagem: "oi" }, home);
    expect(pausaDoTypesafe(home)).toBeDefined();

    saveTypesafeApiKey("k-nova", home);
    expect(pausaDoTypesafe(home)).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.9)));
    expect(await decidirRoteamento({ mensagem: "revisa esse PR" }, home)).toMatchObject({ tipo: "agente" });
  });

  it("uma falha de rede não pausa; duas seguidas pausam", async () => {
    const home = homeLigado();
    const fetchMock = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchMock);

    await decidirRoteamento({ mensagem: "1" }, home);
    expect(pausaDoTypesafe(home)).toBeUndefined();
    await decidirRoteamento({ mensagem: "2" }, home);
    expect(pausaDoTypesafe(home)).toMatchObject({ motivo: "sem-resposta" });
    await decidirRoteamento({ mensagem: "3" }, home);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sucesso no meio zera a contagem de falhas de rede", async () => {
    const home = homeLigado();
    const boom = async () => {
      throw new Error("boom");
    };
    vi.stubGlobal("fetch", vi.fn(boom));
    await decidirRoteamento({ mensagem: "1" }, home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.9)));
    await decidirRoteamento({ mensagem: "2" }, home);
    vi.stubGlobal("fetch", vi.fn(boom));
    await decidirRoteamento({ mensagem: "3" }, home);
    expect(pausaDoTypesafe(home)).toBeUndefined();
  });
});
