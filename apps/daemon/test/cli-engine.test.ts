import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { addProfile, markReady, updateProfile } from "../src/profiles.ts";
import { claudeEngine, parseCliLine } from "../src/engines/cli.ts";
import { toolSummary } from "../src/engines/parse-claude.ts";
import { spawnCwd } from "../src/sandbox.ts";
import { tempHome } from "./helpers.ts";
import type { EngineEvent } from "@nexo/shared";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

/** argv sem o par --add-dir <caminho>: o caminho varia por home/thread. */
function semAddDir(args: string[]): string[] {
  const i = args.indexOf("--add-dir");
  return i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
}

function waitDone(events: EngineEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    const i = setInterval(() => {
      if (events.some((e) => e.type === "done" || e.type === "quota" || e.type === "error" || e.type === "auth")) {
        clearTimeout(t);
        clearInterval(i);
        resolve();
      }
    }, 20);
  });
}

describe("CliEngine", () => {
  it("passa CLAUDE_CONFIG_DIR e cwd do projeto", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c1", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    const engine = claudeEngine(home, "c1");
    const events: EngineEvent[] = [];
    const project = spawnCwd(".");
    await engine.start(
      { threadId: "t-1", projectPath: project, profileId: "c1", contextPack: "pack" },
      (ev) => events.push(ev),
    );
    expect(engine.lastEnv.CLAUDE_CONFIG_DIR).toContain("c1");
    expect(engine.lastCwd).toBe(project);
    expect(semAddDir(engine.lastArgs)).toEqual([
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ]);
    await engine.send("oi");
    await waitDone(events);
    const texts = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""));
    expect(texts.some((t) => t.includes("echo:oi") || t.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("quota no stderr não emite done", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c1", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    const engine = claudeEngine(home, "c1");
    const events: EngineEvent[] = [];
    await engine.start(
      { threadId: "t-1", projectPath: spawnCwd("."), profileId: "c1", contextPack: "pack" },
      (ev) => events.push(ev),
    );
    await engine.send("QUOTA");
    await waitDone(events);
    expect(events.some((e) => e.type === "quota")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});

describe("CliEngine flags", () => {
  it("modelo e esforço do perfil entram no argv", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c1", home);
    updateProfile("c1", home, { model: "sonnet", effort: "high", permissionMode: "plan" });
    process.env.NEXO_CLAUDE_BIN = fake;
    const engine = claudeEngine(home, "c1");
    await engine.start(
      { threadId: "t-1", projectPath: spawnCwd("."), profileId: "c1", contextPack: "pack" },
      () => {},
    );
    expect(semAddDir(engine.lastArgs)).toEqual([
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
    ]);
    // limpar volta pro padrão sem reiniciar o engine
    updateProfile("c1", home, { model: "", effort: "", permissionMode: "" });
    await engine.send("oi");
    expect(engine.lastArgs).not.toContain("--model");
    expect(engine.lastArgs).not.toContain("--effort");
    expect(engine.lastArgs).not.toContain("--permission-mode");
  });
});

describe("CliEngine auth", () => {
  it("falha de OAuth no stderr vira auth, sem done nem error", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c1", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    const engine = claudeEngine(home, "c1");
    const events: EngineEvent[] = [];
    await engine.start(
      { threadId: "t-1", projectPath: spawnCwd("."), profileId: "c1", contextPack: "pack" },
      (ev) => events.push(ev),
    );
    await engine.send("AUTH");
    await waitDone(events);
    expect(events.some((e) => e.type === "auth")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("toolSummary", () => {
  const winPath = String.raw`C:\Users\eu\proj\apps\daemon\src\http.ts`;
  const winDir = String.raw`C:\proj\apps\daemon\src`;

  it("resume por ferramenta, sem JSON cru", () => {
    expect(toolSummary("Read", { file_path: winPath })).toBe("…/daemon/src/http.ts");
    expect(toolSummary("Grep", { pattern: "content|role|messages", path: winDir, glob: "*.ts" })).toBe(
      "content|role|messages em …/apps/daemon/src (*.ts)",
    );
    expect(toolSummary("Bash", { command: "pnpm test\nsegunda linha" })).toBe("pnpm test");
    expect(toolSummary("Edit", { file_path: "src/a.ts", old_string: "const x = 1;" })).toBe(
      'src/a.ts · troca "const x = 1;"',
    );
    expect(toolSummary("TodoWrite", { todos: [1, 2, 3] })).toBe("3 item(s)");
    expect(toolSummary("Coisa", { a: "1", b: 2, c: true, obj: {} })).toBe("a=1 · b=2 · c=true");
  });

  it("corta longo e troca barra invertida por barra", () => {
    const resumo = toolSummary("Bash", { command: "x".repeat(400) });
    expect(resumo.length).toBeLessThanOrEqual(161);
    expect(resumo.endsWith("…")).toBe(true);
    expect(toolSummary("Read", { file_path: winPath })).not.toContain(String.fromCharCode(92));
  });

  it("evento tool usa o resumo legivel", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "foo", path: winDir } }] },
      }),
    );
    expect(evs).toEqual([{ type: "tool", name: "Grep", summary: "foo em …/apps/daemon/src" }]);
  });

  it("libera a pasta de anexo do thread com --add-dir (só no claude)", async () => {
    const home = tempHome();
    addProfile({ id: "c-img", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c-img", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    try {
      const engine = claudeEngine(home, "c-img");
      await engine.start(
        { threadId: "t-img", projectPath: spawnCwd("."), profileId: "c-img", contextPack: "" },
        () => {},
      );
      await engine.send("oi");
      const i = engine.lastArgs.indexOf("--add-dir");
      expect(i).toBeGreaterThan(-1);
      // a pasta liberada é a do thread, dentro do home do nexo — não a do projeto
      expect(engine.lastArgs[i + 1]).toContain("t-img");
      expect(engine.lastArgs[i + 1]).toContain(home);
      await engine.abort();
    } finally {
      delete process.env.NEXO_CLAUDE_BIN;
    }
  });

  it("assistant com usage manda context do request individual, antes do conteúdo", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "assistant",
        message: {
          usage: { input_tokens: 5, cache_read_input_tokens: 220_000, cache_creation_input_tokens: 100 },
          content: [{ type: "text", text: "ok" }],
        },
      }),
    );
    expect(evs).toEqual([
      { type: "context", contextTokens: 220_105 },
      { type: "text", text: "ok" },
    ]);
  });

  it("assistant sem usage não manda context", () => {
    const evs = parseCliLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    );
    expect(evs).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("parseCliLine", () => {
  it("lê stream-json do claude", () => {
    const text = parseCliLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "olá" }, { type: "tool_use", name: "Read", input: { path: "a.ts" } }] },
      }),
    );
    expect(text).toEqual([
      { type: "text", text: "olá" },
      { type: "tool", name: "Read", summary: "a.ts" },
    ]);
    expect(parseCliLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([
      { type: "session", contextWindow: 200_000 },
    ]);
    expect(parseCliLine(JSON.stringify({ type: "result", is_error: true, result: "rate_limit" }))).toEqual([
      {
        type: "quota",
        detail: "Limite de uso do Claude (rate limit). Espera um pouco ou troca de conta.",
      },
    ]);
    expect(
      parseCliLine(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "hit your rate limit" },
        }),
      ),
    ).toEqual([
      {
        type: "quota",
        detail: "Limite de uso do Claude (rate limit). Espera um pouco ou troca de conta.",
      },
    ]);
    const nested = parseCliLine(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "rate_limit",
        error: { type: "rate_limit_error" },
      }),
    );
    expect(nested[0]).toMatchObject({ type: "quota" });
    expect(JSON.stringify(nested)).not.toMatch(/\[object Object\]/);
    expect(parseCliLine("You've hit your session limit · resets 5:50pm (America/Sao_Paulo)")).toEqual([
      {
        type: "quota",
        detail: "You've hit your session limit · resets 5:50pm (America/Sao_Paulo)",
      },
    ]);
  });

  it("pensamento vira progresso, não texto duplicado", () => {
    const delta = parseCliLine(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: 120 } },
      }),
    );
    expect(delta).toEqual([{ type: "thinking", tokens: 120 }]);
    expect(
      parseCliLine(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
        }),
      ),
    ).toEqual([{ type: "thinking" }]);
    // text_delta é descartado: o texto final chega inteiro no assistant
    expect(
      parseCliLine(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "oi" } },
        }),
      ),
    ).toEqual([]);
    // thinking do assistant completo não repete o progresso
    expect(
      parseCliLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "oi" }] },
        }),
      ),
    ).toEqual([{ type: "text", text: "oi" }]);
  });

  it("rate_limit_event só vira quota quando bloqueia", () => {
    expect(
      parseCliLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })),
    ).toEqual([]);
    const blocked = parseCliLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "blocked", rateLimitType: "five_hour", resetsAt: 1788453600 },
      }),
    );
    expect(blocked[0]?.type).toBe("quota");
    expect(blocked[0] && blocked[0].type === "quota" ? blocked[0].detail : "").toMatch(/five_hour/);
  });

  it("unifiedWindows viram evento de limites mesmo liberado", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.38, resetsAt: 1788453600 },
            seven_day: { utilization: 0.49, resetsAt: 1788706800 },
          },
        },
      }),
    );
    expect(evs).toEqual([
      {
        type: "limits",
        status: "allowed",
        fiveHour: { utilization: 0.38, resetsAt: 1788453600 },
        sevenDay: { utilization: 0.49, resetsAt: 1788706800 },
      },
    ]);
  });

  it("allowed_warning é aviso, não quota: não termina o turno nem troca de conta", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          resetsAt: 1788706800,
          unifiedWindows: {
            five_hour: { utilization: 0.76, resetsAt: 1788453600 },
            seven_day: { utilization: 0.76, resetsAt: 1788706800 },
          },
        },
      }),
    );
    expect(evs.some((e) => e.type === "quota")).toBe(false);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "limits", status: "allowed_warning" });
  });

  it("status fora da família allowed continua virando quota", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day",
          unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1788706800 } },
        },
      }),
    );
    expect(evs.some((e) => e.type === "quota")).toBe(true);
  });

  it("result vira usage com contexto somado", () => {
    const evs = parseCliLine(
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.404336,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 40274,
          cache_read_input_tokens: 120,
          output_tokens: 4,
          output_tokens_details: { thinking_tokens: 30 },
        },
      }),
    );
    expect(evs).toEqual([
      {
        type: "usage",
        input: 2,
        output: 4,
        cacheRead: 120,
        cacheCreate: 40274,
        contextTokens: 40396,
        thinking: 30,
        costUsd: 0.404336,
      },
    ]);
  });

  it("system init informa modelo e janela de contexto", () => {
    expect(
      parseCliLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-opus-5[1m]",
          session_id: "abc",
          claude_code_version: "2.1.258",
        }),
      ),
    ).toEqual([
      { type: "session", contextWindow: 1_000_000, model: "claude-opus-5[1m]", sessionId: "abc", version: "2.1.258" },
    ]);
    expect(
      parseCliLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5" })),
    ).toEqual([{ type: "session", contextWindow: 200_000, model: "claude-sonnet-5" }]);
    expect(parseCliLine(JSON.stringify({ type: "system", subtype: "status", status: "requesting" }))).toEqual([]);
  });

  it("tool_result não vira quota nem erro (regressão do dump vermelho)", () => {
    // o app leu o próprio renderer.js, que fala de "quota" e "rate_limit":
    // isso virava um evento quota de 56k que a UI pintava de vermelho
    const arquivoLido = [
      "1\tconst state = { pendingQuota: null };",
      '2\tfunction showQuota(ev) { /* A quota de ... acabou */ }',
      '3\tif (/rate_limit/i.test(s)) return "Limite de uso do Claude (rate limit).";',
      `4\t// ${"x".repeat(2000)}`,
    ].join("\n");
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_1", type: "tool_result", content: arquivoLido }],
      },
    });
    expect(parseCliLine(line)).toEqual([]);
  });

  it("erro com texto gigante entra cortado", () => {
    const evs = parseCliLine(
      JSON.stringify({ type: "error", error: { message: "falhou: " + "y".repeat(5000) } }),
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe("error");
    const msg = evs[0] && evs[0].type === "error" ? evs[0].message : "";
    expect(msg.length).toBeLessThanOrEqual(601);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("objeto desconhecido e grande não vaza pro chat", () => {
    const grande = { coisa: "z".repeat(3000), outra: { mais: "w".repeat(3000) } };
    expect(parseCliLine(JSON.stringify({ type: "algo_novo", message: grande }))).toEqual([]);
  });

  it("aviso de quota curto continua sendo quota", () => {
    expect(
      parseCliLine(JSON.stringify({ type: "result", is_error: true, result: "rate_limit exceeded" })),
    ).toEqual([
      { type: "quota", detail: "Limite de uso do Claude (rate limit). Espera um pouco ou troca de conta." },
    ]);
    expect(parseCliLine("You've hit your session limit · resets 5:50pm")[0]?.type).toBe("quota");
  });

  it("separa falha de credencial de quota", () => {
    expect(parseCliLine("Failed to authenticate: OAuth session expired and could not be refreshed")).toEqual([
      {
        type: "auth",
        detail: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
    ]);
    expect(
      parseCliLine(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid_token" } })),
    ).toEqual([{ type: "auth", detail: "authentication_error: invalid_token" }]);
    expect(parseCliLine(JSON.stringify({ type: "result", is_error: true, result: "api error 401" }))).toEqual([
      { type: "auth", detail: "api error 401" },
    ]);
    // texto do assistente falando de auth não pode derrubar o perfil
    expect(
      parseCliLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "seu invalid_token vem do refresh" }] },
        }),
      ),
    ).toEqual([{ type: "text", text: "seu invalid_token vem do refresh" }]);
  });
});

describe("allowedTools no argv", () => {
  it("perfil com ferramenta liberada manda --allowed-tools", async () => {
    const home = tempHome();
    addProfile({ id: "c-allow", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c-allow", home);
    updateProfile("c-allow", home, { allowedTools: ["Bash(git *)", "Bash(gh *)"] });
    process.env.NEXO_CLAUDE_BIN = fake;
    try {
      const engine = claudeEngine(home, "c-allow");
      await engine.start(
        { threadId: "t-a", projectPath: spawnCwd("."), profileId: "c-allow", contextPack: "" },
        () => {},
      );
      const i = engine.lastArgs.indexOf("--allowed-tools");
      expect(i).toBeGreaterThan(-1);
      expect(engine.lastArgs.slice(i + 1, i + 3)).toEqual(["Bash(git *)", "Bash(gh *)"]);
    } finally {
      delete process.env.NEXO_CLAUDE_BIN;
    }
  });

  it("sem ferramenta liberada, o flag não aparece", async () => {
    const home = tempHome();
    addProfile({ id: "c-sem", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c-sem", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    try {
      const engine = claudeEngine(home, "c-sem");
      await engine.start(
        { threadId: "t-b", projectPath: spawnCwd("."), profileId: "c-sem", contextPack: "" },
        () => {},
      );
      expect(engine.lastArgs).not.toContain("--allowed-tools");
    } finally {
      delete process.env.NEXO_CLAUDE_BIN;
    }
  });
});
