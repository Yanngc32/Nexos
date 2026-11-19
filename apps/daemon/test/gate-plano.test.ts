import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decisaoDoGate, MARCA_GATE, MOTIVO_DO_GATE, prepararGatePlano } from "../src/gate-plano.ts";

const pessoa = (texto: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: texto }] } });
const ferramenta = (name: string, id = name) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const resultado = (id: string, content: string, is_error = false) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
});
const jsonl = (...linhas: object[]) => linhas.map((l) => JSON.stringify(l)).join("\n") + "\n";

const ESCRITA = { tool_name: "Write" };

describe("decisaoDoGate", () => {
  it("nega a primeira escrita do turno sem plano", () => {
    expect(decisaoDoGate(jsonl(pessoa("faz X"), ferramenta("Read"), resultado("Read", "ok")), ESCRITA)).toBe("deny");
  });

  it("libera quando o turno já tem TodoWrite", () => {
    const t = jsonl(pessoa("faz X"), ferramenta("TodoWrite"), resultado("TodoWrite", "ok"));
    expect(decisaoDoGate(t, ESCRITA)).toBe("allow");
  });

  it("libera a segunda tentativa depois de uma negação do gate", () => {
    const t = jsonl(pessoa("faz X"), ferramenta("Write", "w1"), resultado("w1", `PreToolUse:Write hook: ${MOTIVO_DO_GATE}`, true));
    expect(decisaoDoGate(t, ESCRITA)).toBe("allow");
  });

  it("plano de turno ANTERIOR não vale: tool_result não abre turno, mensagem da pessoa abre", () => {
    const anterior = jsonl(pessoa("turno 1"), ferramenta("TodoWrite"), resultado("TodoWrite", "ok"));
    expect(decisaoDoGate(anterior + jsonl(pessoa("turno 2"), ferramenta("Read"), resultado("Read", "ok")), ESCRITA)).toBe("deny");
    // negação do turno anterior também não conta
    const negado = jsonl(pessoa("turno 1"), resultado("w1", MOTIVO_DO_GATE, true));
    expect(decisaoDoGate(negado + jsonl({ type: "user", message: { role: "user", content: "turno 2" } }), ESCRITA)).toBe("deny");
  });

  it("delegar a subagente conta como plano, e chamada de dentro de subagente nunca é negada", () => {
    expect(decisaoDoGate(jsonl(pessoa("faz X"), ferramenta("Agent")), ESCRITA)).toBe("allow");
    expect(decisaoDoGate(jsonl(pessoa("faz X")), { tool_name: "Edit", agent_id: "a1" })).toBe("allow");
  });

  it("transcript ilegível ou sem mensagem da pessoa libera", () => {
    expect(decisaoDoGate("{lixo\n não é json", ESCRITA)).toBe("allow");
    expect(decisaoDoGate("", ESCRITA)).toBe("allow");
  });

  it("ferramenta que não escreve passa", () => {
    expect(decisaoDoGate(jsonl(pessoa("faz X")), { tool_name: "Bash" })).toBe("allow");
  });
});

describe("script do hook (node solto)", () => {
  const home = mkdtempSync(join(tmpdir(), "nexo-gate-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const settingsPath = prepararGatePlano(home);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hook = settings.hooks.PreToolUse[0];
  const script = join(home, "run", "gate-plano.cjs");

  function rodar(entrada: object): { status: number | null; stdout: string } {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(entrada), encoding: "utf8" });
    return { status: r.status, stdout: r.stdout };
  }

  it("settings aponta o matcher de escrita e o comando node com caminho entre aspas", () => {
    expect(hook.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(hook.hooks[0].command).toBe(`node "${script.replace(/\\/g, "/")}"`);
  });

  it("nega sem plano com o JSON de PreToolUse e exit 0", () => {
    const transcript = join(home, "t1.jsonl");
    writeFileSync(transcript, jsonl(pessoa("faz X")));
    const r = rodar({ tool_name: "Write", transcript_path: transcript, session_id: "s", cwd: home });
    expect(r.status).toBe(0);
    const saida = JSON.parse(r.stdout);
    expect(saida.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(saida.hookSpecificOutput.permissionDecisionReason).toContain(MARCA_GATE);
    expect(saida.hookSpecificOutput.permissionDecisionReason).toContain("TodoWrite");
  });

  it("libera (sem saída, exit 0) com TodoWrite, transcript inexistente ou stdin inválido", () => {
    const transcript = join(home, "t2.jsonl");
    writeFileSync(transcript, jsonl(pessoa("faz X"), ferramenta("TodoWrite")));
    expect(rodar({ tool_name: "Edit", transcript_path: transcript })).toEqual({ status: 0, stdout: "" });
    expect(rodar({ tool_name: "Edit", transcript_path: join(home, "nao-existe.jsonl") })).toEqual({ status: 0, stdout: "" });
    const r = spawnSync(process.execPath, [script], { input: "não é json", encoding: "utf8" });
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
  });

  it("regravar sem mudança não altera os arquivos", () => {
    const antes = readFileSync(script, "utf8");
    expect(prepararGatePlano(home)).toBe(settingsPath);
    expect(readFileSync(script, "utf8")).toBe(antes);
  });
});
