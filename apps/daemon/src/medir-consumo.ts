import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThreadEvent } from "@nexos/shared";
import { getRun } from "./runs.ts";
import { listTeams } from "./teams.ts";
import { engineEnv, listProfiles } from "./profiles.ts";
import { projetosConhecidos, readThread } from "./threads.ts";
import { readMemoria, readMemoriaGlobal } from "./memoria.ts";
import { MEMORIA_NO_PACK_MAX } from "./session.ts";

/**
 * Onde a quota foi gasta, a partir do que já está no disco — nada aqui chama modelo.
 *
 * Duas fontes, porque nenhuma sozinha vê tudo:
 * - `threads/*.jsonl`: cada turno de conversa grava `usage` (modelo + tokens), e o `thread_meta`
 *   diz de onde a conversa veio (chat, passo de time, supervisor, hook, DS).
 * - transcrições do próprio CLI `claude` no `CLAUDE_CONFIG_DIR` de cada conta: é o único lugar
 *   onde aparecem os turnos em motor descartável (ping de uso, resumo da compactação), que não
 *   têm thread. Só esses dois são lidos de lá — o resto já foi contado pela thread.
 */

export type Tokens = { turnos: number; input: number; cacheCreate: number; cacheRead: number; output: number };

export type Linha = Tokens & { origem: string; modelo: string };

export type Relatorio = {
  desde: string;
  linhas: Linha[];
  /** `compacted` gravados, por motor da conta: no codex com sessão, cada um foi turno jogado fora. */
  compactacoes: { engine: string; quantas: number; tokensAntes: number }[];
  ping: { sessoes: number; semMensagemHa2h: number };
  memoria: { projeto: string; caracteres: number; sessoesNovas: number; excessoTotal: number }[];
};

const PREFIXO_RESUMO = "Resuma a conversa abaixo para que OUTRO agente possa continuar";
const OCIOSO_MS = 2 * 60 * 60_000;

function vazio(): Tokens {
  return { turnos: 0, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
}

function somar(mapa: Map<string, Linha>, origem: string, modelo: string, t: Partial<Tokens>): void {
  const chave = `${origem}\u0000${modelo}`;
  const l = mapa.get(chave) ?? { origem, modelo, ...vazio() };
  l.turnos += 1;
  l.input += t.input ?? 0;
  l.cacheCreate += t.cacheCreate ?? 0;
  l.cacheRead += t.cacheRead ?? 0;
  l.output += t.output ?? 0;
  mapa.set(chave, l);
}

/** Caminho comparável no Windows e no Linux. */
function chave(p: string): string {
  return resolve(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

function origemDaThread(meta: Extract<ThreadEvent, { type: "thread_meta" }>, home: string, hooks: Set<string>): string {
  if (meta.mcpRunId) return "supervisor de time";
  if (meta.runId) {
    const run = getRun(meta.runId, home);
    if (run && hooks.has(run.teamId)) return "hook (post-commit etc.)";
    return "passo de time";
  }
  if (meta.planejamento) return "planejamento (Manager)";
  if (meta.handoff) return "implementação de plano";
  if (meta.oculta) return "interno do Nexos (DS)";
  return "chat";
}

function arquivosJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...arquivosJsonl(p));
    else if (nome.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function textoDoUsuario(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

type SessaoDescartavel = { tipo: "ping de uso" | "resumo (compactação)"; inicio: number };

/** Lê uma transcrição do CLI e devolve o gasto dela, se for ping ou resumo; senão `undefined`. */
function lerTranscricao(
  arquivo: string,
  cwdDoPing: string,
  desde: number,
  mapa: Map<string, Linha>,
): SessaoDescartavel | undefined {
  let linhas: string[];
  try {
    linhas = readFileSync(arquivo, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  let tipo: SessaoDescartavel["tipo"] | undefined;
  let inicio = 0;
  const vistos = new Set<string>();
  for (const bruta of linhas) {
    if (!bruta.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(bruta) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = (d.message ?? {}) as Record<string, unknown>;
    if (!tipo) {
      if (d.type !== "user") continue;
      const texto = textoDoUsuario(msg.content).trim();
      const cwd = typeof d.cwd === "string" ? chave(d.cwd) : "";
      if (texto === "oi" && cwd === cwdDoPing) tipo = "ping de uso";
      else if (texto.startsWith(PREFIXO_RESUMO)) tipo = "resumo (compactação)";
      else return undefined;
      inicio = Date.parse(String(d.timestamp ?? "")) || 0;
      continue;
    }
    if (d.type !== "assistant") continue;
    const u = msg.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    // o CLI grava um bloco por linha, com o mesmo `usage` repetido: conta uma vez por request
    const id = String(d.requestId ?? msg.id ?? bruta);
    if (vistos.has(id)) continue;
    vistos.add(id);
    const ts = Date.parse(String(d.timestamp ?? "")) || inicio;
    if (ts < desde) continue;
    somar(mapa, tipo, String(msg.model ?? "?"), {
      input: Number(u.input_tokens) || 0,
      cacheCreate: Number(u.cache_creation_input_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
    });
  }
  return tipo && inicio >= desde ? { tipo, inicio } : undefined;
}

export function medirConsumo(home: string, desde: Date): Relatorio {
  const desdeMs = desde.getTime();
  const mapa = new Map<string, Linha>();
  const perfis = new Map(listProfiles(home).map((p) => [p.id, p]));
  const hooks = new Set(listTeams(home).filter((t) => t.origem === "hook").map((t) => t.id));
  const compactacoes = new Map<string, { quantas: number; tokensAntes: number }>();
  const mensagensDaPessoa: number[] = [];
  const sessoesPorProjeto = new Map<string, number>();

  const threadsDir = join(home, "threads");
  const ids = existsSync(threadsDir)
    ? readdirSync(threadsDir).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length))
    : [];
  for (const id of ids) {
    let eventos: ThreadEvent[];
    try {
      eventos = readThread(id, home);
    } catch {
      continue;
    }
    const meta = eventos.find((e) => e.type === "thread_meta");
    if (!meta || meta.type !== "thread_meta") continue;
    const origem = origemDaThread(meta, home, hooks);
    if (Date.parse(meta.ts) >= desdeMs) {
      const proj = meta.projectPath ? chave(meta.projectPath) : "";
      sessoesPorProjeto.set(proj, (sessoesPorProjeto.get(proj) ?? 0) + 1);
    }
    let perfil = meta.profileId;
    for (const e of eventos) {
      if (e.type === "switched") perfil = e.toProfileId;
      if (Date.parse(e.ts) < desdeMs) continue;
      if (e.type === "usage") somar(mapa, origem, e.model ?? "?", e);
      else if (e.type === "user" && !e.automatico) mensagensDaPessoa.push(Date.parse(e.ts));
      else if (e.type === "compacted") {
        const engine = perfis.get(perfil)?.engine ?? "?";
        const c = compactacoes.get(engine) ?? { quantas: 0, tokensAntes: 0 };
        c.quantas += 1;
        c.tokensAntes += e.tokensAntes;
        compactacoes.set(engine, c);
      }
    }
  }

  mensagensDaPessoa.sort((a, b) => a - b);
  const pessoaFalouAntes = (t: number) => mensagensDaPessoa.some((m) => m <= t && t - m <= OCIOSO_MS);
  const ping = { sessoes: 0, semMensagemHa2h: 0 };
  const cwdDoPing = chave(home);
  for (const p of perfis.values()) {
    if (p.engine !== "claude") continue;
    const dir = engineEnv(p, home).CLAUDE_CONFIG_DIR;
    if (!dir) continue;
    for (const arquivo of arquivosJsonl(join(dir, "projects"))) {
      const s = lerTranscricao(arquivo, cwdDoPing, desdeMs, mapa);
      if (s?.tipo !== "ping de uso") continue;
      ping.sessoes += 1;
      if (!pessoaFalouAntes(s.inicio)) ping.semMensagemHa2h += 1;
    }
  }

  const memoria: Relatorio["memoria"] = [];
  const medirMemoria = (projeto: string, texto: string, sessoesNovas: number) => {
    const caracteres = texto.trim().length;
    if (!caracteres) return;
    memoria.push({ projeto, caracteres, sessoesNovas, excessoTotal: Math.max(0, caracteres - MEMORIA_NO_PACK_MAX) * sessoesNovas });
  };
  for (const projeto of projetosConhecidos(home)) {
    medirMemoria(projeto, readMemoria(projeto, home), sessoesPorProjeto.get(chave(projeto)) ?? 0);
  }
  medirMemoria("(chat geral)", readMemoriaGlobal(home), sessoesPorProjeto.get("") ?? 0);

  return {
    desde: desde.toISOString(),
    linhas: [...mapa.values()].sort((a, b) => pesoRelativo(b) - pesoRelativo(a)),
    compactacoes: [...compactacoes].map(([engine, c]) => ({ engine, ...c })),
    ping,
    memoria: memoria.sort((a, b) => b.excessoTotal - a.excessoTotal),
  };
}

/**
 * Preço de API por milhão (entrada, saída) — só pra PESAR um modelo contra o outro. A assinatura
 * não publica como converte token em quota; o que se sabe é que modelo maior gasta mais, e isso
 * é o que este número preserva. Modelo desconhecido (codex, gpt) fica sem peso.
 */
function precoPorMilhao(modelo: string): [number, number] | undefined {
  const m = modelo.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return [10, 50];
  if (/opus-5-5|opus-5\.5/.test(m)) return [4, 20];
  if (m.includes("opus")) return [5, 25];
  if (/sonnet-[34]/.test(m)) return [3, 15];
  if (m.includes("sonnet")) return [2, 10];
  if (m.includes("haiku")) return [1, 5];
  return undefined;
}

/** Equivalente em US$ de API: escrita de cache 1,25×, leitura 0,1×. `0` quando o modelo não tem preço conhecido. */
export function pesoRelativo(l: Pick<Linha, "modelo" | "input" | "cacheCreate" | "cacheRead" | "output">): number {
  const preco = precoPorMilhao(l.modelo);
  if (!preco) return 0;
  const [entrada, saida] = preco;
  return (l.input * entrada + l.cacheCreate * entrada * 1.25 + l.cacheRead * entrada * 0.1 + l.output * saida) / 1_000_000;
}
