import { afterEach, describe, expect, it } from "vitest";
import { sessionBus } from "../src/bus.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { ferramentaDePainel, montarPedido, resetPaineisForTest, responderPainel } from "../src/paineis.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const TUDO = { modo: "sempre" as const, paineis: ["navegador", "design", "planejamento", "tarefas", "arquivo", "terminal"] as const, trazerPraFrente: true };
const cfg = (o: Partial<typeof TUDO> = {}) => ({ ...TUDO, paineis: [...(o.paineis ?? TUDO.paineis)], ...o }) as never;

afterEach(() => resetPaineisForTest());

describe("montarPedido", () => {
  it("valida painel, url, caminho e respeita os liberados na config", () => {
    expect(montarPedido({ painel: "navegador", url: "http://localhost:5173/login" }, "liberado", cfg())).toEqual({
      painel: "navegador",
      url: "http://localhost:5173/login",
      frente: true,
    });
    expect(montarPedido({ painel: "janela" }, "liberado", cfg())).toMatch(/painel inválido/);
    expect(montarPedido({ painel: "navegador", url: "javascript:alert(1)" }, "liberado", cfg())).toMatch(/url precisa/);
    // navegador negado pra conta: abre o painel, mas não navega
    expect(montarPedido({ painel: "navegador", url: "http://x.dev" }, "negado", cfg())).toMatch(/desligado/);
    expect(montarPedido({ painel: "navegador" }, "negado", cfg())).toEqual({ painel: "navegador", frente: true });
    expect(montarPedido({ painel: "arquivo", caminho: "../fora.txt" }, "liberado", cfg())).toMatch(/relativo/);
    expect(montarPedido({ painel: "arquivo", caminho: "src\\a.ts" }, "liberado", cfg())).toMatchObject({ caminho: "src/a.ts" });
    expect(montarPedido({ painel: "design", card: "login", sistema: "mocks" }, "liberado", cfg({ trazerPraFrente: false }))).toEqual({
      painel: "design",
      card: "login",
      sistema: "mocks",
      frente: false,
    });
    expect(montarPedido({ painel: "terminal" }, "liberado", cfg({ paineis: ["design"] as never }))).toMatch(/não deixa/);
  });
});

describe("ferramenta", () => {
  it("some com a config em nunca; pede ao app e devolve a resposta dele", async () => {
    const home = tempHome();
    expect(ferramentaDePainel("t1", "liberado", home)().map((f) => f.name)).toEqual(["nexo_abrir_painel"]);

    const pedidos: Record<string, unknown>[] = [];
    const ouvir = (ev: Record<string, unknown>) => {
      if (ev.type !== "abrir_painel") return;
      pedidos.push(ev);
      responderPainel(String(ev.id), { ok: true, texto: `painel ${String(ev.painel)} aberto` });
    };
    sessionBus.on("*", ouvir);
    try {
      const [f] = ferramentaDePainel("t1", "liberado", home)();
      const r = await f!.executar({ painel: "design", card: "login" });
      expect(r).toEqual({ ok: true, texto: "painel design aberto" });
      expect(pedidos[0]).toMatchObject({ type: "abrir_painel", threadId: "t1", painel: "design", card: "login", frente: true });
    } finally {
      sessionBus.off("*", ouvir);
    }

    saveConfig(home, { paineisDoAgente: { modo: "nunca", paineis: ["design"], trazerPraFrente: true } });
    expect(ferramentaDePainel("t1", "liberado", home)()).toEqual([]);
  });

  it("config: patch parcial mantém o resto e ignora painel desconhecido", () => {
    const home = tempHome();
    expect(loadConfig(home).paineisDoAgente).toEqual({ ...TUDO, paineis: [...TUDO.paineis] });
    saveConfig(home, { paineisDoAgente: { paineis: ["design", "xyz", "navegador"] } as never });
    expect(loadConfig(home).paineisDoAgente).toEqual({ modo: "sempre", paineis: ["navegador", "design"], trazerPraFrente: true });
    saveConfig(home, { paineisDoAgente: { modo: "perguntar", trazerPraFrente: false } as never });
    expect(loadConfig(home).paineisDoAgente).toEqual({ modo: "perguntar", paineis: ["navegador", "design"], trazerPraFrente: false });
  });

  it("MCP: conversa normal lista nexo_abrir_painel; com nunca, não", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const app = createApp(home, "tk");
    const nomes = async () => {
      const res = await app.request(`/v1/mcp?projectPath=%2Fproj&threadId=${t.id}`, {
        method: "POST",
        headers: { authorization: "Bearer tk", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    };
    expect(await nomes()).toContain("nexo_abrir_painel");
    saveConfig(home, { paineisDoAgente: { modo: "nunca" } as never });
    expect(await nomes()).not.toContain("nexo_abrir_painel");
  });
});
