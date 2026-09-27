import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@nexos/shared";
import { medirConsumo, pesoRelativo } from "../src/medir-consumo.ts";
import { addProfile, engineEnv, getProfile } from "../src/profiles.ts";
import { appendEvent, createThread } from "../src/threads.ts";
import { memoriaPath } from "../src/memoria.ts";
import { tempHome } from "./helpers.ts";

const agora = Date.now();
const iso = (msAtras: number) => new Date(agora - msAtras).toISOString();
const uso = (threadId: string, model: string, msAtras: number, input: number): ThreadEvent =>
  ({ ts: iso(msAtras), type: "usage", threadId, model, input, output: 10, cacheRead: 0, cacheCreate: 0, contextTokens: input }) as ThreadEvent;

/** Linhas no formato da transcrição do CLI `claude` (`projects/<cwd>/<sessao>.jsonl`). */
function transcricao(dir: string, nome: string, cwd: string, texto: string, msAtras: number, model: string): void {
  mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 5, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 3 };
  const linhas = [
    { type: "user", cwd, timestamp: iso(msAtras), message: { role: "user", content: texto } },
    // mesmo request em duas linhas (um bloco por linha): tem que contar uma vez só
    { type: "assistant", cwd, timestamp: iso(msAtras), requestId: `req-${nome}`, message: { model, usage } },
    { type: "assistant", cwd, timestamp: iso(msAtras), requestId: `req-${nome}`, message: { model, usage } },
  ];
  writeFileSync(join(dir, `${nome}.jsonl`), linhas.map((l) => JSON.stringify(l)).join("\n"), "utf8");
}

describe("medirConsumo", () => {
  it("separa por origem, conta ping/resumo das transcrições e acha compactação de codex", () => {
    const home = tempHome();
    addProfile({ id: "cl", engine: "claude" }, home, { skipBinCheck: true });
    addProfile({ id: "cx", engine: "codex" }, home, { skipBinCheck: true });
    const projeto = join(home, "proj");
    mkdirSync(projeto);

    const chat = createThread({ projectPath: projeto, profileId: "cl" }, home);
    appendEvent({ ts: iso(60_000), type: "user", threadId: chat.id, text: "oi de verdade" } as ThreadEvent, home);
    appendEvent(uso(chat.id, "claude-opus-5", 60_000, 1000), home);
    // fora da janela de 7 dias: não entra
    appendEvent(uso(chat.id, "claude-opus-5", 30 * 24 * 60 * 60_000, 999_999), home);

    const cx = createThread({ projectPath: projeto, profileId: "cx" }, home);
    appendEvent(uso(cx.id, "gpt-5", 50_000, 500), home);
    appendEvent({ ts: iso(40_000), type: "compacted", threadId: cx.id, text: "r", cobertos: 3, tokensAntes: 7000, tokensDepois: 900 } as ThreadEvent, home);

    const projetos = join(engineEnv(getProfile("cl", home)!, home).CLAUDE_CONFIG_DIR!, "projects", "x");
    // ping com a pessoa ativa (mensagem 1 min antes) e ping de madrugada (5h sem mensagem)
    transcricao(projetos, "ping-1", home, "oi", 30_000, "claude-opus-5");
    transcricao(projetos, "ping-2", home, "oi", 5 * 60 * 60_000, "claude-opus-5");
    transcricao(projetos, "resumo", projeto, "Resuma a conversa abaixo para que OUTRO agente possa continuar o trabalho", 20_000, "claude-sonnet-5");
    // turno normal do chat: já contado pela thread, não pode entrar de novo
    transcricao(projetos, "normal", projeto, "oi", 10_000, "claude-opus-5");

    writeFileSync(memoriaPath(projeto, home), "m".repeat(10_000), "utf8");

    const r = medirConsumo(home, new Date(agora - 7 * 24 * 60 * 60_000));
    const linha = (origem: string, modelo: string) => r.linhas.find((l) => l.origem === origem && l.modelo === modelo);

    expect(linha("chat", "claude-opus-5")).toMatchObject({ turnos: 1, input: 1000 });
    expect(linha("ping de uso", "claude-opus-5")).toMatchObject({ turnos: 2, cacheCreate: 40_000 });
    expect(linha("resumo (compactação)", "claude-sonnet-5")).toMatchObject({ turnos: 1 });
    expect(r.linhas.filter((l) => l.origem === "ping de uso" || l.origem === "resumo (compactação)").reduce((s, l) => s + l.turnos, 0)).toBe(3);
    expect(r.ping).toEqual({ sessoes: 2, semMensagemHa2h: 1 });
    expect(r.compactacoes).toEqual([{ engine: "codex", quantas: 1, tokensAntes: 7000 }]);
    expect(r.memoria[0]).toMatchObject({ caracteres: 10_000, sessoesNovas: 2, excessoTotal: 4000 });
  });

  it("peso: opus pesa mais que haiku pro mesmo token; modelo sem preço fica 0", () => {
    const t = { input: 1000, cacheCreate: 20_000, cacheRead: 0, output: 10 };
    expect(pesoRelativo({ modelo: "claude-opus-5", ...t })).toBeGreaterThan(pesoRelativo({ modelo: "claude-haiku-4-5", ...t }));
    expect(pesoRelativo({ modelo: "gpt-5", ...t })).toBe(0);
  });
});
