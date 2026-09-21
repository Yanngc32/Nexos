import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/engines/parse-codex.ts";

/*
 * Toda linha usada aqui foi COPIADA da saída do `codex exec --json` de verdade
 * (codex-cli 0.153.4), dirigido contra um provedor OpenAI-compatível local. Não
 * há linha inventada neste arquivo: o esquema do codex não tem nada a ver com o
 * `stream-json` do Claude, e um fixture escrito de cabeça só testaria a minha
 * suposição.
 */

describe("parseCodexLine", () => {
  it("agent_message vira texto do assistente", () => {
    const linha = '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Terminei."}}';
    expect(parseCodexLine(linha)).toEqual([{ type: "text", text: "Terminei." }]);
  });

  it("turn.completed fecha o turno e traz o uso, com o contexto somado", () => {
    const linha =
      '{"type":"turn.completed","usage":{"input_tokens":30,"cached_input_tokens":3,"cache_write_input_tokens":2,"output_tokens":7,"reasoning_output_tokens":4}}';
    expect(parseCodexLine(linha)).toEqual([
      { type: "usage", input: 30, output: 7, cacheRead: 3, cacheCreate: 2, thinking: 4, contextTokens: 35 },
      { type: "done" },
    ]);
  });

  it("comando executado vira linha de ferramenta COM argumentos, mais a saída pareada pelo id", () => {
    /*
     * O `id`, o `command` e o `aggregated_output` sempre estiveram nesta linha —
     * o parser é que os jogava fora, e o chat do codex ficava cego: não dava pra
     * ver o que o agente rodou nem o que voltou. É o `id` que faz a bolha de
     * resultado encaixar na de ferramenta (`data-tool-id`, renderer.js), do
     * mesmo jeito que já acontece no motor claude.
     */
    const linha =
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'echo alo\'","aggregated_output":"alo\\n","exit_code":0,"status":"completed"}}';
    expect(parseCodexLine(linha)).toEqual([
      {
        type: "tool",
        name: "command_execution",
        summary: "/bin/bash -lc 'echo alo' (exit 0)",
        id: "item_1",
        input: { command: "/bin/bash -lc 'echo alo'", exit_code: 0 },
      },
      { type: "tool_result", id: "item_1", result: "alo" },
    ]);
  });

  it("exit code diferente de zero marca o resultado como erro", () => {
    // é o que acende o ✕ na bolha; sem isso, comando que falhou parece ter dado certo
    const linha =
      '{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"/bin/bash -lc \'sai 1\'","aggregated_output":"não achei\\n","exit_code":1,"status":"completed"}}';
    const evs = parseCodexLine(linha);
    expect(evs[1]).toEqual({ type: "tool_result", id: "item_9", result: "não achei", isError: true });
  });

  it("comando sem saída e sem falha não gera bolha de resultado vazia", () => {
    const linha =
      '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/bash -lc \'true\'","aggregated_output":"","exit_code":0,"status":"completed"}}';
    const evs = parseCodexLine(linha);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("tool");
  });

  it("falha silenciosa ainda vira resultado, dizendo o exit", () => {
    const linha =
      '{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"/bin/bash -lc \'false\'","aggregated_output":"","exit_code":1,"status":"completed"}}';
    expect(parseCodexLine(linha)[1]).toEqual({
      type: "tool_result",
      id: "item_4",
      result: "(sem saída, exit 1)",
      isError: true,
    });
  });

  it("saída enorme é cortada, como no parser do claude", () => {
    const grande = "x".repeat(900);
    const linha = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_5",
        type: "command_execution",
        command: "cat grande.txt",
        aggregated_output: grande,
        exit_code: 0,
        status: "completed",
      },
    });
    const res = parseCodexLine(linha)[1] as { result: string };
    expect(res.result).toHaveLength(601);
    expect(res.result.endsWith("…")).toBe(true);
  });

  it("tipo não medido repassa o payload cru, em vez de inventar nome de campo", () => {
    /*
     * Só `command_execution` foi dirigido contra o codex de verdade. Passar o
     * item cru é o que faz a bolha mostrar o payload REAL de `file_change` na
     * primeira vez que alguém rodar um — é assim que a medição que falta vai
     * acontecer, em vez de eu chutar o formato agora.
     */
    const linha =
      '{"type":"item.completed","item":{"id":"item_7","type":"file_change","path":"/repo/a.ts","status":"completed"}}';
    expect(parseCodexLine(linha)).toEqual([
      { type: "tool", name: "file_change", summary: "/repo/a.ts", id: "item_7", input: { path: "/repo/a.ts" } },
    ]);
  });

  /*
   * O caso que mais importa, e o que só apareceu dirigindo: o `codex` manda
   * `error` pra coisa que NÃO derruba o turno. Traduzir isso pro `error` do
   * Nexo abortaria turno saudável — e o turno de onde estas duas linhas saíram
   * terminou com `turn.completed` normal.
   */
  it("aviso e retentativa NÃO são erro: viram linha visível, não abortam o turno", () => {
    const aviso =
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `fake-1` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}';
    const rede = '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion)"}';
    for (const linha of [aviso, rede]) {
      const evs = parseCodexLine(linha);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.type).toBe("tool");
      expect(evs.some((e) => e.type === "error" || e.type === "done")).toBe(false);
    }
  });

  it("turn.failed é o canal fatal, e é o único", () => {
    const evs = parseCodexLine('{"type":"turn.failed","error":{"message":"o modelo recusou"}}');
    expect(evs).toEqual([{ type: "error", message: "o modelo recusou" }]);
  });

  it("turn.failed sem mensagem ainda diz algo: erro vazio na tela não ajuda ninguém", () => {
    const evs = parseCodexLine('{"type":"turn.failed"}');
    expect(evs[0]).toMatchObject({ type: "error" });
    expect((evs[0] as { message: string }).message.length).toBeGreaterThan(10);
  });

  /*
   * Sem isto, sessão OAuth vencida vira "error" genérico pra sempre: o daemon
   * nunca marca o perfil como precisando de login (markAuthFailed em session.ts
   * só dispara em `type: "auth"`), e toda mensagem repete o mesmo ciclo até
   * "motor morreu" — sem nunca sugerir refazer login.
   */
  it("turn.failed de token vencido vira auth, não error genérico", () => {
    const evs = parseCodexLine('{"type":"turn.failed","error":{"message":"OAuth token expired, please run codex login again"}}');
    expect(evs).toEqual([{ type: "auth", detail: "OAuth token expired, please run codex login again" }]);
  });

  it("turn.failed com 401 puro também vira auth", () => {
    const evs = parseCodexLine('{"type":"turn.failed","error":{"message":"request failed: 401"}}');
    expect(evs).toEqual([{ type: "auth", detail: "request failed: 401" }]);
  });

  it("thread.started vira session com o id da sessão, SEM janela de contexto", () => {
    /*
     * O id é o que permite `exec resume <UUID>` — retomar a conversa em vez de
     * reenviar o histórico inteiro todo turno. Vai sem `contextWindow` porque o
     * codex não reporta janela nenhuma: 0 faria o medidor da tela mostrar "/0",
     * e informação errada é pior que ausência.
     */
    expect(parseCodexLine('{"type":"thread.started","thread_id":"01a080ab-5677-7af0-8e63-60b7b4f88859"}')).toEqual([
      { type: "session", sessionId: "01a080ab-5677-7af0-8e63-60b7b4f88859" },
    ]);
  });

  it("thread.started sem id não vira sessão pela metade", () => {
    expect(parseCodexLine('{"type":"thread.started"}')).toEqual([]);
  });

  it("turn.started não gera evento", () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual([]);
  });

  /*
   * `item.started` chega ANTES do `item.completed` do mesmo id, com
   * `exit_code: null`. Mostrar os dois duplicaria a linha no chat, e só o
   * completo sabe como o comando terminou.
   */
  it("item.started é ignorado: o completo é que tem o resultado", () => {
    const linha =
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'echo alo\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
    expect(parseCodexLine(linha)).toEqual([]);
  });

  it("linha que não é JSON não vira texto do assistente", () => {
    // o codex escreve log solto assim, e o parser antigo (do Claude) recebia tudo isto
    for (const ruim of [
      "",
      "   ",
      "Reading prompt from stdin...",
      "2026-09-08T10:49:16.712525Z ERROR codex_api::endpoint: failed to connect",
      "{quebrado",
      "[1,2,3]",
    ]) {
      expect(parseCodexLine(ruim)).toEqual([]);
    }
  });

  it("uso sem raciocínio não inventa o campo thinking", () => {
    const linha =
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}';
    const usage = parseCodexLine(linha)[0] as Record<string, unknown>;
    expect("thinking" in usage).toBe(false);
  });

  it("tipo de item desconhecido é ignorado, não vira ferramenta sem nome", () => {
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"coisa_nova"}}')).toEqual([]);
  });
});
