import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, registrarSegredo } from "./log.ts";
import { MCP_PROTOCOL } from "./mcp.ts";
import { projectDir } from "./projeto-dir.ts";
import { esquecerTexto, lerTextoEmCache } from "./texto-em-cache.ts";

/**
 * MCP externos por projeto (Cérebro, etapa 6). Lista por ADESÃO em `projectDir/cerebro/mcp.json`
 * (sincroniza): nunca importa o `~/.claude.json` inteiro — o `--strict-mcp-config` continua, e só o
 * que está aqui entra no `--mcp-config` junto com o `nexo`. No codex, `-c mcp_servers.<nome>=…`
 * do mesmo jeito que o `nexo` (mcp.ts).
 *
 * Cada ferramenta de cada servidor vira capacidade `mcp-externo:<nome>/<ferramenta>` no catálogo.
 * A lista de ferramentas vem de `descobrirFerramentas` (fala MCP com o servidor uma vez, grava em
 * `mcp-ferramentas.json`) — o catálogo lê só o cache, nunca conecta.
 *
 * Segredos (`env`, `headers`) entram no mascaramento do daemon.log ao serem lidos.
 */

export type McpExterno = {
  nome: string;
  transporte: "stdio" | "http";
  comando?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  ligado: boolean;
  descricao?: string;
  atualizadoEm: string;
};
export type FerramentaExterna = { name: string; description: string };
type ArquivoMcp = { versao: 1; servidores: Record<string, Omit<McpExterno, "nome">> };
type ArquivoFerramentas = { versao: 1; servidores: Record<string, { em: string; erro?: string; ferramentas: FerramentaExterna[] }> };

export const NOME_MCP_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MCP_EXTERNOS_MAX = 12;
const DESCOBERTA_TIMEOUT_MS = 15_000;

function cerebroDir(projectPath: string, home: string): string {
  return join(projectDir(projectPath, home), "cerebro");
}
function mcpPath(projectPath: string, home: string): string {
  return join(cerebroDir(projectPath, home), "mcp.json");
}
function ferramentasPath(projectPath: string, home: string): string {
  return join(cerebroDir(projectPath, home), "mcp-ferramentas.json");
}

function lerJson<T>(caminho: string, vazio: T, valido: (raw: unknown) => raw is T): T {
  let lido: { texto: string } | null;
  try {
    lido = lerTextoEmCache(caminho);
  } catch (err) {
    log.aviso("cerebro", "não consegui ler arquivo de MCP externos", { caminho, erro: String(err) });
    return vazio;
  }
  if (!lido) return vazio;
  try {
    const raw = JSON.parse(lido.texto) as unknown;
    if (valido(raw)) return raw;
  } catch (err) {
    log.aviso("cerebro", "arquivo de MCP externos ilegível", { caminho, erro: String(err) });
  }
  return vazio;
}

function gravarJson(caminho: string, dado: unknown): void {
  mkdirSync(join(caminho, ".."), { recursive: true });
  writeFileSync(`${caminho}.tmp`, JSON.stringify(dado, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(`${caminho}.tmp`, caminho);
  esquecerTexto(caminho);
}

const ehArquivoMcp = (raw: unknown): raw is ArquivoMcp =>
  !!raw && typeof raw === "object" && (raw as ArquivoMcp).versao === 1 && typeof (raw as ArquivoMcp).servidores === "object";
const ehArquivoFerramentas = (raw: unknown): raw is ArquivoFerramentas =>
  !!raw && typeof raw === "object" && (raw as ArquivoFerramentas).versao === 1 && typeof (raw as ArquivoFerramentas).servidores === "object";

function lerArquivo(projectPath: string, home: string): ArquivoMcp {
  const a = lerJson(mcpPath(projectPath, home), { versao: 1, servidores: {} } as ArquivoMcp, ehArquivoMcp);
  for (const s of Object.values(a.servidores)) {
    for (const v of Object.values(s.env ?? {})) registrarSegredo(v);
    for (const v of Object.values(s.headers ?? {})) registrarSegredo(v.replace(/^Bearer\s+/i, ""));
  }
  return a;
}

export function listarMcpExternos(projectPath: string, home: string): McpExterno[] {
  const a = lerArquivo(projectPath, home);
  return Object.entries(a.servidores)
    .map(([nome, s]) => ({ nome, ...s }))
    .sort((x, y) => x.nome.localeCompare(y.nome));
}

/** Versão sem segredo (valores de env/headers trocados por `•••`) pra UI e pro log. */
export function semSegredos(m: McpExterno): McpExterno {
  const mascarar = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.keys(o).map((k) => [k, "•••"])) : undefined);
  return { ...m, ...(m.env ? { env: mascarar(m.env) } : {}), ...(m.headers ? { headers: mascarar(m.headers) } : {}) };
}

function erro(status: number, msg: string): Error {
  return Object.assign(new Error(msg), { status });
}

function mapaDeTexto(v: unknown, campo: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw erro(400, `${campo} tem que ser objeto chave→valor`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k)) throw erro(400, `${campo}: chave inválida "${k}"`);
    if (typeof val !== "string") throw erro(400, `${campo}.${k} tem que ser texto`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Cria/atualiza um servidor. `body` cru da rota; valor de env/headers igual a `•••` mantém o que
 * já estava (a UI manda o mascarado de volta). Nome `nexo` é reservado.
 */
export function salvarMcpExterno(projectPath: string, nome: string, body: Record<string, unknown>, home: string): McpExterno {
  if (!NOME_MCP_RE.test(nome)) throw erro(400, "nome inválido: minúsculas, números, - e _ (até 32)");
  if (nome === "nexo") throw erro(400, "nexo é o servidor do próprio Nexos");
  const a = lerArquivo(projectPath, home);
  const atual = a.servidores[nome];
  if (!atual && Object.keys(a.servidores).length >= MCP_EXTERNOS_MAX) throw erro(400, `teto de ${MCP_EXTERNOS_MAX} servidores por projeto`);
  const transporte = (body.transporte ?? atual?.transporte) as McpExterno["transporte"] | undefined;
  if (transporte !== "stdio" && transporte !== "http") throw erro(400, "transporte tem que ser stdio ou http");
  const def: Omit<McpExterno, "nome"> = {
    transporte,
    ligado: body.ligado === undefined ? (atual?.ligado ?? true) : body.ligado === true,
    atualizadoEm: new Date().toISOString(),
  };
  const descricao = body.descricao === undefined ? atual?.descricao : String(body.descricao ?? "").trim().slice(0, 200);
  if (descricao) def.descricao = descricao;
  if (transporte === "stdio") {
    const comando = body.comando === undefined ? atual?.comando : String(body.comando ?? "").trim();
    if (!comando) throw erro(400, "stdio precisa de comando");
    def.comando = comando;
    const args = body.args === undefined ? atual?.args : body.args;
    if (args !== undefined) {
      if (!Array.isArray(args) || args.some((x) => typeof x !== "string")) throw erro(400, "args tem que ser lista de textos");
      if (args.length) def.args = args as string[];
    }
  } else {
    const url = body.url === undefined ? atual?.url : String(body.url ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) throw erro(400, "http precisa de url http(s)://");
    def.url = url;
  }
  const manterMascarado = (novo: Record<string, string> | undefined, antigo: Record<string, string> | undefined) => {
    if (!novo) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(novo)) {
      if (v === "•••") {
        if (antigo?.[k] !== undefined) out[k] = antigo[k];
      } else out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const env = body.env === undefined ? atual?.env : manterMascarado(mapaDeTexto(body.env, "env"), atual?.env);
  if (env) def.env = env;
  const headers = body.headers === undefined ? atual?.headers : manterMascarado(mapaDeTexto(body.headers, "headers"), atual?.headers);
  if (headers) def.headers = headers;
  for (const v of Object.values(def.env ?? {})) registrarSegredo(v);
  for (const v of Object.values(def.headers ?? {})) registrarSegredo(v.replace(/^Bearer\s+/i, ""));
  a.servidores[nome] = def;
  gravarJson(mcpPath(projectPath, home), a);
  log.info("cerebro", "MCP externo salvo", { projectPath, nome, transporte, ligado: def.ligado });
  return { nome, ...def };
}

export function removerMcpExterno(projectPath: string, nome: string, home: string): boolean {
  const a = lerArquivo(projectPath, home);
  if (!(nome in a.servidores)) return false;
  delete a.servidores[nome];
  gravarJson(mcpPath(projectPath, home), a);
  const f = lerJson(ferramentasPath(projectPath, home), { versao: 1, servidores: {} } as ArquivoFerramentas, ehArquivoFerramentas);
  if (nome in f.servidores) {
    delete f.servidores[nome];
    gravarJson(ferramentasPath(projectPath, home), f);
  }
  return true;
}

/** Entradas de `mcpServers` do `--mcp-config` do claude (só os ligados). */
export function mcpServersParaClaude(projectPath: string | undefined, home: string): Record<string, unknown> {
  if (!projectPath) return {};
  const out: Record<string, unknown> = {};
  for (const m of listarMcpExternos(projectPath, home)) {
    if (!m.ligado) continue;
    out[m.nome] =
      m.transporte === "stdio"
        ? { type: "stdio", command: m.comando, args: m.args ?? [], ...(m.env ? { env: m.env } : {}) }
        : { type: "http", url: m.url, ...(m.headers ? { headers: m.headers } : {}) };
  }
  return out;
}

/** Nomes pro `--allowed-tools`: `mcp__<nome>` libera todas as ferramentas do servidor. */
export function mcpToolsExternos(projectPath: string | undefined, home: string): string[] {
  if (!projectPath) return [];
  return listarMcpExternos(projectPath, home)
    .filter((m) => m.ligado)
    .map((m) => `mcp__${m.nome}`);
}

function toml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `-c mcp_servers.<nome>={…}` do codex, um por servidor ligado (mesma forma do `nexo`, mcp.ts). */
export function flagsCodexDosExternos(projectPath: string | undefined, home: string): string[] {
  if (!projectPath) return [];
  const out: string[] = [];
  for (const m of listarMcpExternos(projectPath, home)) {
    if (!m.ligado) continue;
    const campos: string[] = [];
    if (m.transporte === "stdio") {
      campos.push(`command=${toml(m.comando ?? "")}`);
      campos.push(`args=[${(m.args ?? []).map(toml).join(",")}]`);
      if (m.env) campos.push(`env={${Object.entries(m.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`);
    } else {
      campos.push(`url=${toml(m.url ?? "")}`);
      if (m.headers) campos.push(`http_headers={${Object.entries(m.headers).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(",")}}`);
    }
    out.push("-c", `mcp_servers.${m.nome}={${campos.join(",")}}`);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Descoberta de ferramentas (fala MCP com o servidor)
 * ------------------------------------------------------------------------- */

function pedido(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
const INIT = { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "nexos", version: "1" } };

function ferramentasDe(resultado: unknown): FerramentaExterna[] {
  const lista = (resultado as { tools?: unknown })?.tools;
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((t) => t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
    .map((t) => ({ name: (t as { name: string }).name, description: String((t as { description?: unknown }).description ?? "") }));
}

async function descobrirHttp(m: McpExterno): Promise<FerramentaExterna[]> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(m.headers ?? {}) };
  const chamar = async (corpo: string, extra: Record<string, string> = {}) => {
    const r = await fetch(m.url!, { method: "POST", headers: { ...headers, ...extra }, body: corpo, signal: AbortSignal.timeout(DESCOBERTA_TIMEOUT_MS) });
    const sessao = r.headers.get("mcp-session-id") ?? undefined;
    const texto = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 200)}`);
    // streamable-http pode responder em SSE: pega a última linha `data:`
    const dados = texto.includes("data:") ? texto.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()) : [texto];
    const ultimo = dados.filter(Boolean).at(-1) ?? "{}";
    return { json: JSON.parse(ultimo) as { result?: unknown; error?: { message?: string } }, sessao };
  };
  const init = await chamar(pedido(1, "initialize", INIT));
  if (init.json.error) throw new Error(init.json.error.message ?? "initialize falhou");
  const sess: Record<string, string> = init.sessao ? { "mcp-session-id": init.sessao } : {};
  await fetch(m.url!, { method: "POST", headers: { ...headers, ...sess }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(DESCOBERTA_TIMEOUT_MS) }).catch(() => undefined);
  const lista = await chamar(pedido(2, "tools/list", {}), sess);
  if (lista.json.error) throw new Error(lista.json.error.message ?? "tools/list falhou");
  return ferramentasDe(lista.json.result);
}

function descobrirStdio(m: McpExterno): Promise<FerramentaExterna[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(m.comando!, m.args ?? [], { env: { ...process.env, ...(m.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let buf = "";
    let acabou = false;
    const fim = (err?: Error, r?: FerramentaExterna[]) => {
      if (acabou) return;
      acabou = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* já morreu */
      }
      if (err) reject(err);
      else resolve(r ?? []);
    };
    const timer = setTimeout(() => fim(new Error(`sem resposta em ${DESCOBERTA_TIMEOUT_MS / 1000} s`)), DESCOBERTA_TIMEOUT_MS);
    child.on("error", (e) => fim(e));
    child.on("exit", (code) => fim(new Error(`processo saiu (exit ${code}) antes de listar ferramentas`)));
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const linha = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!linha) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(linha) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return fim(new Error(msg.error.message ?? "initialize falhou"));
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${pedido(2, "tools/list", {})}\n`);
        } else if (msg.id === 2) {
          if (msg.error) return fim(new Error(msg.error.message ?? "tools/list falhou"));
          fim(undefined, ferramentasDe(msg.result));
        }
      }
    });
    child.stdin.write(`${pedido(1, "initialize", INIT)}\n`);
  });
}

/** Conecta uma vez, lista as ferramentas e grava no cache. Erro fica gravado (a UI mostra). */
export async function descobrirFerramentas(projectPath: string, nome: string, home: string): Promise<{ ferramentas: FerramentaExterna[]; erro?: string }> {
  const m = listarMcpExternos(projectPath, home).find((x) => x.nome === nome);
  if (!m) throw erro(404, `MCP externo não existe: ${nome}`);
  let ferramentas: FerramentaExterna[] = [];
  let falha: string | undefined;
  try {
    ferramentas = m.transporte === "http" ? await descobrirHttp(m) : await descobrirStdio(m);
  } catch (e) {
    falha = (e as Error).message;
    log.aviso("cerebro", "descoberta de ferramentas do MCP externo falhou", { nome, erro: falha });
  }
  const f = lerJson(ferramentasPath(projectPath, home), { versao: 1, servidores: {} } as ArquivoFerramentas, ehArquivoFerramentas);
  f.servidores[nome] = { em: new Date().toISOString(), ferramentas, ...(falha ? { erro: falha } : {}) };
  gravarJson(ferramentasPath(projectPath, home), f);
  return { ferramentas, ...(falha ? { erro: falha } : {}) };
}

/** O que o cache sabe das ferramentas de cada servidor (pro catálogo e pra UI). */
export function ferramentasExternasEmCache(projectPath: string | undefined, home: string): Record<string, { em: string; erro?: string; ferramentas: FerramentaExterna[] }> {
  if (!projectPath) return {};
  return lerJson(ferramentasPath(projectPath, home), { versao: 1, servidores: {} } as ArquivoFerramentas, ehArquivoFerramentas).servidores;
}
