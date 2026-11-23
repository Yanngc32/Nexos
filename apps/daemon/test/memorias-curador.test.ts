import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { lerMemoria, proporMemoria } from "../src/memorias/nucleo.ts";
import {
  ATRASO_INICIAL_CURADOR_MS,
  INTERVALO_CURADOR_MS,
  MAX_TRECHOS,
  TETO_CURADOR_MS,
  fatiarTranscritos,
  iniciarCurador,
  lerTranscritosDoHome,
  rodarCuradoria,
} from "../src/memorias/curador.ts";
import { PROMPT_CURADOR, montarPromptCurador } from "../src/memorias/memorista-prompt.ts";
import type { EventoMemoriaSalva, RodarModelo } from "../src/memorias/motor.ts";

function modeloFalso(respostas: (string | Error)[]) {
  const prompts: { prompt: string; ctx: Parameters<RodarModelo>[1] }[] = [];
  const rodar: RodarModelo = async (prompt, ctx) => {
    prompts.push({ prompt, ctx });
    const r = respostas.shift() ?? "OK";
    if (r instanceof Error) throw r;
    return r;
  };
  return { rodar, prompts };
}

const AGORA = Date.parse("2026-11-23T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function gravarThread(home: string, id: string, eventos: object[]) {
  const dir = join(home, "threads");
  mkdirSync(dir, { recursive: true });
  const arq = join(dir, `${id}.jsonl`);
  writeFileSync(arq, eventos.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return arq;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prompt do curador", () => {
  it("só correção/ensinamento explícito, só acrescenta, mesmo formato e 'na dúvida, OK'", () => {
    expect(PROMPT_CURADOR).toContain("EXPLICITAMENTE");
    expect(PROMPT_CURADOR).toContain("Não deduza nada do que o agente fez");
    expect(PROMPT_CURADOR).toContain("Você só ACRESCENTA: nunca apaga, nunca aposenta");
    expect(PROMPT_CURADOR).toContain("daqui a um mês");
    expect(PROMPT_CURADOR).toContain("COMPLEMENTA | <caminho.md> | <o fato novo>");
    expect(PROMPT_CURADOR).toContain("Na dúvida, responda OK.");
    const p = montarPromptCurador({ memorias: [{ relPath: "a.md", titulo: "A", gancho: "g" }], transcrito: "USUÁRIO: oi" });
    expect(p).toContain("MEMÓRIAS JÁ SALVAS:\n- a.md — A: g");
    expect(p).toContain("CONVERSAS:\nUSUÁRIO: oi");
  });
});

describe("lerTranscritosDoHome", () => {
  it("pula conversa oculta, fala automática, mensagem antiga e conversa sem fala do usuário", async () => {
    const home = tempHome();
    const desde = AGORA - INTERVALO_CURADOR_MS;
    gravarThread(home, "visivel", [
      { type: "thread_meta", title: "x" },
      { type: "user", text: "fala velha", ts: iso(desde - 1000) },
      { type: "user", text: "não use yarn, use pnpm", ts: iso(AGORA - 5000) },
      { type: "user", text: "[hook] commit feito", automatico: true, ts: iso(AGORA - 4000) },
      { type: "assistant", text: "Entendido.", ts: iso(AGORA - 3000) },
      { type: "tool_use", name: "Bash", ts: iso(AGORA - 2000) },
    ]);
    gravarThread(home, "oculta", [
      { type: "thread_meta", oculta: true },
      { type: "user", text: "passo de time", ts: iso(AGORA - 1000) },
    ]);
    gravarThread(home, "so-agente", [
      { type: "user", text: "auto", automatico: true, ts: iso(AGORA - 1000) },
      { type: "assistant", text: "fiz sozinho", ts: iso(AGORA - 900) },
    ]);
    const antiga = gravarThread(home, "antiga", [{ type: "user", text: "de ontem", ts: iso(desde - 10_000) }]);
    utimesSync(antiga, new Date(desde - 10_000), new Date(desde - 10_000));

    const t = await lerTranscritosDoHome(home, desde);
    expect(t).toEqual([{ threadId: "visivel", texto: "USUÁRIO: não use yarn, use pnpm\nAGENTE: Entendido." }]);
  });

  it("sem pasta de conversas devolve vazio", async () => {
    expect(await lerTranscritosDoHome(tempHome(), 0)).toEqual([]);
  });
});

describe("fatiarTranscritos", () => {
  it("junta conversas num trecho e corta a que não cabe", () => {
    const curtas = fatiarTranscritos(
      [
        { threadId: "a", texto: "USUÁRIO: 1" },
        { threadId: "b", texto: "USUÁRIO: 2" },
      ],
      1000,
    );
    expect(curtas).toHaveLength(1);
    expect(curtas[0]).toContain("=== conversa a ===");
    expect(curtas[0]).toContain("=== conversa b ===");

    const longa = fatiarTranscritos([{ threadId: "x", texto: Array.from({ length: 10 }, (_, i) => `USUÁRIO: linha ${i} ${"z".repeat(30)}`).join("\n") }], 120);
    expect(longa.length).toBeGreaterThan(1);
    for (const t of longa) expect(t.length).toBeLessThanOrEqual(120);
    expect(longa[1]).toContain("=== conversa x (cont.) ===");
  });
});

describe("rodarCuradoria", () => {
  it("grava via proporMemoria com origem 'curador', conta as operações e avisa", async () => {
    const home = tempHome();
    proporMemoria(home, { op: "create", relPath: "pacotes.md", titulo: "Pacotes", gancho: "ao instalar", tipo: "decisao", corpo: "Monorepo com workspaces.", origem: "agente" });
    const { rodar, prompts } = modeloFalso([
      ["CRIA | correcao | sem-yarn.md | Nada de yarn | ao instalar dependência | Não usar yarn; o projeto usa pnpm.", "COMPLEMENTA | pacotes.md | Gerenciador: pnpm."].join("\n"),
    ]);
    const eventos: EventoMemoriaSalva[] = [];
    const ler = vi.fn(async () => [{ threadId: "t1", texto: "USUÁRIO: não use yarn, use pnpm" }]);
    const r = await rodarCuradoria({ home, rodar, modelo: () => "sonnet", ligado: () => true, agora: () => AGORA, lerTranscritos: ler, aoSalvar: (e) => eventos.push(e) });

    expect(r).toEqual({ operacoes: 2 });
    expect(ler).toHaveBeenCalledWith(AGORA - INTERVALO_CURADOR_MS);
    expect(prompts[0]!.ctx).toEqual({ home, modelo: "sonnet", tetoMs: TETO_CURADOR_MS });
    expect(prompts[0]!.prompt).toContain("- pacotes.md — Pacotes: ao instalar");
    expect(prompts[0]!.prompt).toContain("=== conversa t1 ===\nUSUÁRIO: não use yarn, use pnpm");
    expect(lerMemoria(home, "sem-yarn.md")).toMatchObject({ tipo: "correcao", origem: "curador" });
    const pacotes = lerMemoria(home, "pacotes.md")!;
    expect(pacotes.corpo).toContain("Monorepo com workspaces.");
    expect(pacotes.corpo).toContain("Gerenciador: pnpm.");
    expect(pacotes.origem).toBe("curador");
    expect(eventos.map((e) => [e.op, e.origem, e.threadId])).toEqual([
      ["create", "curador", undefined],
      ["update", "curador", undefined],
    ]);
  });

  it("desligado devolve 0 sem ler nem chamar o modelo", async () => {
    const home = tempHome();
    const { rodar, prompts } = modeloFalso([]);
    const ler = vi.fn(async () => [{ threadId: "t", texto: "USUÁRIO: x" }]);
    expect(await rodarCuradoria({ home, rodar, modelo: () => "x", ligado: () => false, lerTranscritos: ler })).toEqual({ operacoes: 0 });
    expect(ler).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(0);
  });

  it("trecho que falha não derruba os outros; nunca passa de MAX_TRECHOS chamadas", async () => {
    const home = tempHome();
    const { rodar, prompts } = modeloFalso([new Error("teto"), "CRIA | infra | nas.md | NAS | ao falar de backup | O backup vai para o NAS."]);
    const muitas = Array.from({ length: MAX_TRECHOS + 4 }, (_, i) => ({ threadId: `t${i}`, texto: `USUÁRIO: ${"x".repeat(59_000)}` }));
    const r = await rodarCuradoria({ home, rodar, modelo: () => "x", ligado: () => true, lerTranscritos: async () => muitas });
    expect(r.operacoes).toBe(1);
    expect(prompts).toHaveLength(MAX_TRECHOS);
    expect(lerMemoria(home, "nas.md")?.origem).toBe("curador");
  });

  it("leitor que lança não derruba: devolve 0", async () => {
    const home = tempHome();
    const { rodar } = modeloFalso([]);
    const r = await rodarCuradoria({ home, rodar, modelo: () => "x", ligado: () => true, lerTranscritos: async () => Promise.reject(new Error("disco")) });
    expect(r).toEqual({ operacoes: 0 });
  });
});

describe("iniciarCurador", () => {
  it("primeira rodada após o atraso inicial, grava o marco, repete no intervalo e para", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    const home = tempHome();
    const desdes: number[] = [];
    const { rodar } = modeloFalso([]);
    const parar = iniciarCurador({
      home,
      rodar,
      modelo: () => "x",
      ligado: () => true,
      intervaloMs: 10_000_000,
      lerTranscritos: async (d) => {
        desdes.push(d);
        return [];
      },
    });
    const marco = join(home, "run", "curador-memorias.json");

    await vi.advanceTimersByTimeAsync(ATRASO_INICIAL_CURADOR_MS - 1);
    expect(desdes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(desdes).toEqual([AGORA + ATRASO_INICIAL_CURADOR_MS - INTERVALO_CURADOR_MS]);
    expect(existsSync(marco)).toBe(true);
    const primeira = (JSON.parse(readFileSync(marco, "utf8")) as { ultimaEm: number }).ultimaEm;
    expect(primeira).toBe(AGORA + ATRASO_INICIAL_CURADOR_MS);

    // segunda rodada: janela começa na última curadoria (sem buraco nem repetição)
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(desdes).toHaveLength(2);
    expect(desdes[1]).toBe(primeira);

    parar();
    await vi.advanceTimersByTimeAsync(50_000_000);
    expect(desdes).toHaveLength(2);
  });

  it("marco recente adia a primeira rodada até completar o intervalo; desligado pula e reagenda", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    const home = tempHome();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "curador-memorias.json"), JSON.stringify({ ultimaEm: AGORA - 1000 }));
    let ligado = false;
    const ler = vi.fn(async () => []);
    const { rodar } = modeloFalso([]);
    const parar = iniciarCurador({ home, rodar, modelo: () => "x", ligado: () => ligado, lerTranscritos: ler });

    await vi.advanceTimersByTimeAsync(INTERVALO_CURADOR_MS - 1001);
    expect(ler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ler).not.toHaveBeenCalled(); // desligado na hora: pula
    ligado = true;
    await vi.advanceTimersByTimeAsync(INTERVALO_CURADOR_MS);
    expect(ler).toHaveBeenCalledTimes(1);
    parar();
  });
});
