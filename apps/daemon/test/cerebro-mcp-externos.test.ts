import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogoDoCerebro, esquecerCatalogo } from "../src/cerebro-catalogo.ts";
import {
  descobrirFerramentas,
  ferramentasExternasEmCache,
  flagsCodexDosExternos,
  listarMcpExternos,
  mcpServersParaClaude,
  mcpToolsExternos,
  removerMcpExterno,
  salvarMcpExterno,
  semSegredos,
} from "../src/cerebro-mcp-externos.ts";
import { esquecerUsoDoCerebro } from "../src/cerebro-uso.ts";
import { configDeMcpAutoria } from "../src/mcp.ts";
import { addProfile } from "../src/profiles.ts";
import { projectDir } from "../src/projeto-dir.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  esquecerCatalogo();
  esquecerUsoDoCerebro();
});

function casa(): { home: string; projeto: string } {
  const home = tempHome();
  addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
  const projeto = join(home, "proj");
  mkdirSync(projeto, { recursive: true });
  return { home, projeto };
}

describe("MCP externos por projeto", () => {
  it("salva por adesão em projectDir/cerebro/mcp.json, valida, mascara segredo e entra no --mcp-config junto do nexo", () => {
    const { home, projeto } = casa();
    expect(() => salvarMcpExterno(projeto, "nexo", { transporte: "http", url: "http://x" }, home)).toThrow(/reservado|próprio Nexos/);
    expect(() => salvarMcpExterno(projeto, "Ruim Nome", { transporte: "http", url: "http://x" }, home)).toThrow(/nome inválido/);
    expect(() => salvarMcpExterno(projeto, "gh", { transporte: "stdio" }, home)).toThrow(/comando/);
    expect(() => salvarMcpExterno(projeto, "gh", { transporte: "http", url: "ftp://x" }, home)).toThrow(/url/);

    const gh = salvarMcpExterno(projeto, "github", { transporte: "stdio", comando: "npx", args: ["-y", "@mcp/github"], env: { GITHUB_TOKEN: "ghp_segredo123" }, descricao: "Issues e PRs" }, home);
    expect(gh).toMatchObject({ nome: "github", transporte: "stdio", ligado: true, env: { GITHUB_TOKEN: "ghp_segredo123" } });
    expect(semSegredos(gh).env).toEqual({ GITHUB_TOKEN: "•••" });
    salvarMcpExterno(projeto, "docs", { transporte: "http", url: "https://mcp.exemplo.com/mcp", headers: { Authorization: "Bearer abc" }, ligado: false }, home);

    const arquivo = JSON.parse(readFileSync(join(projectDir(projeto, home), "cerebro", "mcp.json"), "utf8")) as { servidores: Record<string, unknown> };
    expect(Object.keys(arquivo.servidores).sort()).toEqual(["docs", "github"]);

    // `•••` de volta mantém o segredo salvo
    const de_novo = salvarMcpExterno(projeto, "github", { env: { GITHUB_TOKEN: "•••", OUTRA: "x" } }, home);
    expect(de_novo.env).toEqual({ GITHUB_TOKEN: "ghp_segredo123", OUTRA: "x" });

    const claude = mcpServersParaClaude(projeto, home);
    expect(claude).toEqual({ github: { type: "stdio", command: "npx", args: ["-y", "@mcp/github"], env: { GITHUB_TOKEN: "ghp_segredo123", OUTRA: "x" } } });
    const cfg = JSON.parse(configDeMcpAutoria(4000, "tok", projeto, undefined, "t1", claude)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["github", "nexo"]);
    expect(mcpToolsExternos(projeto, home)).toEqual(["mcp__github"]);
    expect(flagsCodexDosExternos(projeto, home)).toEqual(["-c", 'mcp_servers.github={command="npx",args=["-y","@mcp/github"],env={GITHUB_TOKEN="ghp_segredo123",OUTRA="x"}}']);

    // ligar o http: entra também, na forma dele
    salvarMcpExterno(projeto, "docs", { ligado: true }, home);
    expect(mcpServersParaClaude(projeto, home).docs).toEqual({ type: "http", url: "https://mcp.exemplo.com/mcp", headers: { Authorization: "Bearer abc" } });
    expect(flagsCodexDosExternos(projeto, home).join(" ")).toContain('mcp_servers.docs={url="https://mcp.exemplo.com/mcp"');

    expect(removerMcpExterno(projeto, "docs", home)).toBe(true);
    expect(removerMcpExterno(projeto, "docs", home)).toBe(false);
    expect(listarMcpExternos(projeto, home).map((m) => m.nome)).toEqual(["github"]);
    expect(mcpServersParaClaude(undefined, home)).toEqual({});
  });

  it("descobre as ferramentas de um servidor stdio e elas viram capacidades mcp-externo no catálogo", async () => {
    const { home, projeto } = casa();
    // servidor MCP mínimo em node: responde initialize e tools/list por linha
    const servidor = join(home, "mcp-fake.cjs");
    writeFileSync(
      servidor,
      [
        'const rl = require("readline").createInterface({ input: process.stdin });',
        'rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; }',
        '  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } } }) + "\\n");',
        '  if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "buscar_issue", description: "Busca issues no GitHub." }, { name: "abrir_pr" }] } }) + "\\n");',
        "});",
      ].join("\n"),
      "utf8",
    );
    salvarMcpExterno(projeto, "github", { transporte: "stdio", comando: "node", args: [servidor] }, home);

    // antes de descobrir: o servidor aparece como capacidade única
    expect(catalogoDoCerebro(projeto, home).find((c) => c.id === "mcp-externo:github")).toMatchObject({ tipo: "mcp-externo", escopo: "projeto" });

    const r = await descobrirFerramentas(projeto, "github", home);
    expect(r.erro).toBeUndefined();
    expect(r.ferramentas).toEqual([
      { name: "buscar_issue", description: "Busca issues no GitHub." },
      { name: "abrir_pr", description: "" },
    ]);
    expect(ferramentasExternasEmCache(projeto, home).github!.ferramentas).toHaveLength(2);

    esquecerCatalogo();
    const itens = catalogoDoCerebro(projeto, home);
    expect(itens.find((c) => c.id === "mcp-externo:github")).toBeUndefined();
    expect(itens.find((c) => c.id === "mcp-externo:github/buscar_issue")).toMatchObject({ tipo: "mcp-externo", descricao: "Busca issues no GitHub." });
    expect(itens.find((c) => c.id === "mcp-externo:github/buscar_issue")!.comoUsar).toContain("mcp__github__buscar_issue");

    // servidor que não responde: erro gravado, sem derrubar nada
    salvarMcpExterno(projeto, "mudo", { transporte: "stdio", comando: "node", args: ["-e", "process.exit(3)"] }, home);
    const falha = await descobrirFerramentas(projeto, "mudo", home);
    expect(falha.ferramentas).toEqual([]);
    expect(falha.erro).toMatch(/exit 3|saiu/);
    await expect(descobrirFerramentas(projeto, "nada", home)).rejects.toThrow(/não existe/);
  }, 30_000);
});
