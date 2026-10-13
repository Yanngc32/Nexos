import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThreadEvent } from "@nexos/shared";
import { log } from "./log.ts";
import { aoGravarEvento, readThread } from "./threads.ts";

/**
 * Cérebro — contador de uso por capacidade (linha de base da telemetria).
 *
 * Lê os eventos `tool` das conversas e conta, por dia, quantas vezes o modelo usou cada capacidade:
 * ferramenta `nexo_*`, skill (`Skill`), subagente (`Agent`/`Task` → `subagent_type`), delegação
 * (`nexo_delegar` → agente/time), `ToolSearch` e ferramenta de MCP externo. Separado por tipo de
 * conversa (chat / run / time / oculta) e por projeto, pra responder "o run usa subagente?" sem
 * varrer JSONL a cada consulta.
 *
 * Incremental: um ouvinte de `appendEvent` conta o evento na hora em que é gravado; a varredura
 * (`varrerConversas`) cobre o que ficou pra trás (conversas antes desta versão, motor fechado no
 * meio). Cada conversa tem um cursor = quantos eventos `tool` dela já foram contados, então as duas
 * vias nunca contam o mesmo evento duas vezes.
 *
 * Fica só nesta máquina (`~/.nexos/cerebro/uso.json`): é medição, não configuração. Gatilhos
 * (`registrarDisparo`) entram no mesmo arquivo pra medir "disparou × usou".
 */

export type TipoDeConversa = "chat" | "run" | "time" | "oculta";
export type TipoDeCapacidade = "ferramenta" | "skill" | "agente" | "delegar" | "mcp-externo";
export type Capacidade = { tipo: TipoDeCapacidade; nome: string; nota?: string };

export const DIAS_GUARDADOS = 35;
const ULTIMOS_MAX = 20;
/** Quantas mensagens da pessoa depois do disparo ainda contam como "usou por causa dele". */
export const JANELA_DO_DISPARO = 3;
const GRAVA_APOS_MS = 1500;

/** Contagem por segmento `tipoDeConversa|projeto` (projeto vazio = chat geral). */
type PorSegmento = Record<string, number>;
type Dia = { usos?: Record<string, PorSegmento>; disparos?: Record<string, PorSegmento>; usosAposDisparo?: Record<string, PorSegmento> };
type UltimoUso = { ts: string; threadId: string; tipo: TipoDeConversa; projectPath?: string; nota?: string };
/** Um disparo de gatilho, pra linha do tempo da aba: `usou` vira true se a capacidade foi usada na janela. */
export type DisparoRegistrado = { ts: string; threadId: string; chave: string; tipo: TipoDeConversa; projectPath?: string; usou?: boolean };
type Arquivo = {
  versao: 1;
  cursores: Record<string, number>;
  ultimaVarredura?: string;
  dias: Record<string, Dia>;
  capacidades: Record<string, { ultimoUso?: string; ultimos: UltimoUso[] }>;
  disparos?: DisparoRegistrado[];
  /**
   * Palavras das mensagens da pessoa que vieram antes de um uso SEM gatilho ter disparado:
   * capacidade → palavra → em quantas mensagens. É de onde sai a sugestão "vale virar gatilho".
   */
  palavras?: Record<string, Record<string, number>>;
};
const PALAVRAS_POR_CAPACIDADE = 40;
/** Palavra curta demais ou vazia de sentido não vira sugestão de gatilho. */
const PALAVRAS_VAZIAS = new Set(
  ("para pra pelo pela pelos pelas como mais menos isso isto esse essa este esta aqui agora tambem também quando onde qual quais " +
    "porque entao então depois antes ainda sobre entre cada tudo todos todas nada algo alguma algum fazer faz faça faca vamos " +
    "voce você tenho temos fica ficou ser estar está esta quero queria preciso podemos pode poder deve dever seria seja sempre " +
    "nunca muito pouco outra outro outros outras mesmo mesma coisa coisas assim the and that this with from have will what your").split(" "),
);

/** Palavras "de conteúdo" de uma mensagem (minúsculas, 4+ letras, sem as vazias), sem repetir. */
export function palavrasDaMensagem(texto: string): string[] {
  const out = new Set<string>();
  for (const bruta of texto.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const p = bruta.replace(/^[-_]+|[-_]+$/g, "");
    if (p.length < 4 || p.length > 30 || /^\d/.test(p) || PALAVRAS_VAZIAS.has(p)) continue;
    out.add(p);
  }
  return [...out].slice(0, 40);
}

function anotarPalavras(a: Arquivo, chave: string, palavras: string[]): void {
  if (!palavras.length) return;
  const mapa = ((a.palavras ??= {})[chave] ??= {});
  for (const p of palavras) mapa[p] = (mapa[p] ?? 0) + 1;
  const entradas = Object.entries(mapa);
  if (entradas.length > PALAVRAS_POR_CAPACIDADE) {
    entradas.sort((x, y) => y[1] - x[1]);
    a.palavras[chave] = Object.fromEntries(entradas.slice(0, PALAVRAS_POR_CAPACIDADE));
  }
}

/** Palavras mais vistas antes de usos sem gatilho, por capacidade (pra sugestões). */
export function palavrasSemGatilho(home: string): Record<string, Record<string, number>> {
  return carregar(home).palavras ?? {};
}
const DISPAROS_MAX = 200;

/** Evento ao vivo pra aba Cérebro (`GET /v1/cerebro/events`): contador mudou. */
export type EventoDoCerebro = { tipo: "uso" | "disparo"; chave: string; threadId: string; ts: string; projectPath?: string; usou?: boolean };
type OuvinteDoCerebro = (ev: EventoDoCerebro) => void;
const ouvintes = new Set<OuvinteDoCerebro>();
export function aoMudarUsoDoCerebro(fn: OuvinteDoCerebro): () => void {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}
function avisar(ev: EventoDoCerebro): void {
  for (const fn of ouvintes) {
    try {
      fn(ev);
    } catch (e) {
      log.aviso("cerebro", "ouvinte do Cérebro falhou", { erro: (e as Error).message });
    }
  }
}

export function cerebroDir(home: string): string {
  return join(home, "cerebro");
}
function usoPath(home: string): string {
  return join(cerebroDir(home), "uso.json");
}

/** Chave da capacidade no arquivo: `tipo:nome`. */
export function chaveDaCapacidade(c: { tipo: string; nome: string }): string {
  return `${c.tipo}:${c.nome}`;
}
export function capacidadeDaChave(chave: string): { tipo: TipoDeCapacidade; nome: string } {
  const i = chave.indexOf(":");
  return { tipo: chave.slice(0, i) as TipoDeCapacidade, nome: chave.slice(i + 1) };
}

/** Caminho comparável no Windows e no Linux. */
function chaveDoProjeto(p: string | undefined): string {
  return p ? resolve(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase() : "";
}

export function tipoDaConversa(meta: { mcpRunId?: string; runId?: string; oculta?: boolean; semRoteamento?: boolean }): TipoDeConversa {
  if (meta.mcpRunId) return "time";
  if (meta.runId) return "run";
  if (meta.oculta || meta.semRoteamento) return "oculta";
  return "chat";
}

const FERRAMENTAS_DE_SUBAGENTE = new Set(["Agent", "Task"]);
const MCP_RE = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

function campo(input: unknown, nome: string): string | undefined {
  const v = (input as Record<string, unknown> | undefined)?.[nome];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Que capacidade uma chamada de ferramenta exercitou — `null` quando é ferramenta nativa do CLI
 * (Bash, Read…), que não é capacidade do Nexos. Puro: só nome + argumentos.
 */
export function capacidadeDaChamada(nome: string, input: unknown): Capacidade | null {
  if (nome === "Skill") {
    const skill = campo(input, "skill");
    return skill ? { tipo: "skill", nome: skill.replace(/^\//, "") } : null;
  }
  if (FERRAMENTAS_DE_SUBAGENTE.has(nome)) {
    const tipo = campo(input, "subagent_type") ?? "general-purpose";
    return { tipo: "agente", nome: tipo, ...(campo(input, "description") ? { nota: campo(input, "description") } : {}) };
  }
  if (nome === "ToolSearch") {
    const q = campo(input, "query");
    return { tipo: "ferramenta", nome: "ToolSearch", ...(q ? { nota: q.slice(0, 120) } : {}) };
  }
  // codex: o nome vem como tipo do item e servidor/ferramenta nos argumentos
  if (nome === "mcp_tool_call") {
    const servidor = campo(input, "server");
    const ferramenta = campo(input, "name") ?? campo(input, "tool");
    if (!ferramenta) return null;
    nome = servidor ? `mcp__${servidor}__${ferramenta}` : ferramenta;
  }
  const m = MCP_RE.exec(nome);
  const servidor = m?.[1];
  const ferramenta = m?.[2] ?? nome;
  if (servidor && servidor !== "nexo") return { tipo: "mcp-externo", nome: `${servidor}/${ferramenta}` };
  if (!ferramenta.startsWith("nexo_")) return null;
  if (ferramenta === "nexo_delegar") {
    const agente = campo(input, "agentId");
    const time = campo(input, "teamId");
    if (agente || time) return { tipo: "delegar", nome: agente ? `agente/${agente}` : `time/${time}` };
  }
  return { tipo: "ferramenta", nome: ferramenta };
}

function vazio(): Arquivo {
  return { versao: 1, cursores: {}, dias: {}, capacidades: {} };
}

const memoria = new Map<string, Arquivo>();
const gravacoes = new Map<string, NodeJS.Timeout>();

function carregar(home: string): Arquivo {
  const c = memoria.get(home);
  if (c) return c;
  let a = vazio();
  const path = usoPath(home);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Arquivo>;
      if (raw && typeof raw === "object" && raw.versao === 1) a = { ...vazio(), ...raw };
    } catch (err) {
      log.aviso("cerebro", "uso.json ilegível, recomeçando a contagem", { erro: String(err) });
    }
  }
  memoria.set(home, a);
  return a;
}

function gravarAgora(home: string): void {
  const a = memoria.get(home);
  if (!a) return;
  podar(a);
  try {
    mkdirSync(cerebroDir(home), { recursive: true });
    const path = usoPath(home);
    writeFileSync(`${path}.tmp`, JSON.stringify(a), "utf8");
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    log.aviso("cerebro", "não consegui gravar uso.json", { erro: String(err) });
  }
}

function agendarGravacao(home: string): void {
  if (gravacoes.has(home)) return;
  const t = setTimeout(() => {
    gravacoes.delete(home);
    gravarAgora(home);
  }, GRAVA_APOS_MS);
  t.unref?.();
  gravacoes.set(home, t);
}

/** Grava o que estiver pendente (fechamento do motor, teste). */
export function gravarUsoDoCerebro(home: string): void {
  const t = gravacoes.get(home);
  if (t) {
    clearTimeout(t);
    gravacoes.delete(home);
  }
  gravarAgora(home);
}

/** Esquece o cache em memória (teste). */
export function esquecerUsoDoCerebro(home?: string): void {
  if (home === undefined) memoria.clear();
  else memoria.delete(home);
}

function diaDe(ts: string): string {
  return ts.slice(0, 10);
}

function podar(a: Arquivo, agora = Date.now()): void {
  const limite = diaDe(new Date(agora - DIAS_GUARDADOS * 86_400_000).toISOString());
  for (const dia of Object.keys(a.dias)) if (dia < limite) delete a.dias[dia];
}

function somar(dia: Dia, campo: keyof Dia, chave: string, segmento: string, n = 1): void {
  const porCap = (dia[campo] ??= {});
  const porSeg = (porCap[chave] ??= {});
  porSeg[segmento] = (porSeg[segmento] ?? 0) + n;
}

type Contexto = { tipo: TipoDeConversa; projectPath?: string };
const contextos = new Map<string, Contexto>();
/** Conversas cujo cursor já bate com o arquivo delas nesta execução (ouvinte pode só incrementar). */
const emDia = new Set<string>();
/** Disparos recentes por conversa: capacidade → mensagens da pessoa que ainda contam o uso como "após disparo". */
const disparosAbertos = new Map<string, Map<string, number>>();

function contextoDe(eventos: ThreadEvent[]): Contexto | undefined {
  const meta = eventos.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return undefined;
  return { tipo: tipoDaConversa(meta), ...(meta.projectPath ? { projectPath: meta.projectPath } : {}) };
}

function segmentoDe(ctx: Contexto): string {
  return `${ctx.tipo}|${chaveDoProjeto(ctx.projectPath)}`;
}

/** Mensagem da pessoa em curso por conversa: as palavras dela entram 1× por capacidade usada sem gatilho. */
type MensagemEmCurso = { palavras: string[]; contadas: Set<string> };
const mensagemEmCurso = new Map<string, MensagemEmCurso>();

function contarUso(a: Arquivo, ctx: Contexto, threadId: string, ts: string, cap: Capacidade, msg?: MensagemEmCurso): void {
  const chave = chaveDaCapacidade(cap);
  const dia = (a.dias[diaDe(ts)] ??= {});
  const seg = segmentoDe(ctx);
  somar(dia, "usos", chave, seg);
  const abertos = disparosAbertos.get(threadId);
  let usou = false;
  if (abertos?.has(chave)) {
    somar(dia, "usosAposDisparo", chave, seg);
    abertos.delete(chave);
    usou = true;
    // marca o disparo mais recente desta capacidade nesta conversa como "usou" (linha do tempo)
    const d = [...(a.disparos ?? [])].reverse().find((x) => x.threadId === threadId && x.chave === chave && !x.usou);
    if (d) d.usou = true;
  } else if (msg && !msg.contadas.has(chave)) {
    msg.contadas.add(chave);
    anotarPalavras(a, chave, msg.palavras);
  }
  const c = (a.capacidades[chave] ??= { ultimos: [] });
  if (!c.ultimoUso || c.ultimoUso < ts) c.ultimoUso = ts;
  c.ultimos.push({ ts, threadId, tipo: ctx.tipo, ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}), ...(cap.nota ? { nota: cap.nota } : {}) });
  if (c.ultimos.length > ULTIMOS_MAX) c.ultimos.splice(0, c.ultimos.length - ULTIMOS_MAX);
  avisar({ tipo: "uso", chave, threadId, ts, ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}), ...(usou ? { usou: true } : {}) });
}

/**
 * Conta os eventos `tool` de uma conversa a partir do cursor dela. Devolve quantos entraram.
 * `eventos` opcional evita reler o JSONL quando quem chama já o tem.
 */
export function contarConversa(threadId: string, home: string, eventos?: ThreadEvent[]): number {
  const a = carregar(home);
  let evs = eventos;
  if (!evs) {
    try {
      evs = readThread(threadId, home);
    } catch {
      return 0;
    }
  }
  const ctx = contextoDe(evs);
  if (!ctx) return 0;
  contextos.set(threadId, ctx);
  const cursor = a.cursores[threadId] ?? 0;
  let vistos = 0;
  let novos = 0;
  let msg: MensagemEmCurso | undefined;
  for (const e of evs) {
    if (e.type === "user") {
      msg = e.automatico ? undefined : { palavras: palavrasDaMensagem(e.text ?? ""), contadas: new Set() };
      continue;
    }
    if (e.type !== "tool") continue;
    vistos += 1;
    if (vistos <= cursor) continue;
    const cap = capacidadeDaChamada(e.name, e.input);
    if (cap) contarUso(a, ctx, threadId, e.ts, cap, msg);
    novos += 1;
  }
  if (msg) mensagemEmCurso.set(threadId, msg);
  if (vistos !== cursor) a.cursores[threadId] = vistos;
  emDia.add(threadId);
  if (novos) agendarGravacao(home);
  return novos;
}

/**
 * Varre as conversas do disco que mudaram desde a última varredura (mtime), contando o que ainda não
 * entrou. Assíncrona em fatias pra não travar o event loop no boot — são centenas de JSONL.
 */
export async function varrerConversas(home: string, opts: { tudo?: boolean } = {}): Promise<{ conversas: number; novos: number }> {
  const a = carregar(home);
  const dir = join(home, "threads");
  if (!existsSync(dir)) return { conversas: 0, novos: 0 };
  const desde = !opts.tudo && a.ultimaVarredura ? Date.parse(a.ultimaVarredura) : 0;
  const inicio = new Date().toISOString();
  let conversas = 0;
  let novos = 0;
  let fatia = 0;
  for (const nome of readdirSync(dir)) {
    if (!nome.endsWith(".jsonl")) continue;
    const id = nome.slice(0, -".jsonl".length);
    try {
      if (statSync(join(dir, nome)).mtimeMs < desde - 60_000 && a.cursores[id] !== undefined) continue;
    } catch {
      continue;
    }
    conversas += 1;
    novos += contarConversa(id, home);
    if (++fatia % 20 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  a.ultimaVarredura = inicio;
  agendarGravacao(home);
  return { conversas, novos };
}

let desligarOuvinte: (() => void) | undefined;

/**
 * Liga a contagem ao vivo: todo `tool` gravado entra na hora. Primeira vez que uma conversa aparece
 * nesta execução, ela é lida inteira (cursor pode estar atrás); depois é só incrementar.
 */
export function ligarContadorDoCerebro(): () => void {
  if (desligarOuvinte) return desligarOuvinte;
  desligarOuvinte = aoGravarEvento((ev, home) => {
    if (ev.type === "thread_meta") {
      contextos.set(ev.threadId, { tipo: tipoDaConversa(ev), ...(ev.projectPath ? { projectPath: ev.projectPath } : {}) });
      return;
    }
    // toda mensagem fecha um pouco a janela do disparo (em run cada passo é uma mensagem automática)
    if (ev.type === "user") {
      if (ev.automatico) mensagemEmCurso.delete(ev.threadId);
      else mensagemEmCurso.set(ev.threadId, { palavras: palavrasDaMensagem(ev.text ?? ""), contadas: new Set() });
      const abertos = disparosAbertos.get(ev.threadId);
      if (!abertos) return;
      for (const [chave, restam] of abertos) {
        if (restam <= 1) abertos.delete(chave);
        else abertos.set(chave, restam - 1);
      }
      return;
    }
    if (ev.type !== "tool") return;
    if (!emDia.has(ev.threadId)) {
      contarConversa(ev.threadId, home);
      return;
    }
    const ctx = contextos.get(ev.threadId);
    if (!ctx) return;
    const a = carregar(home);
    a.cursores[ev.threadId] = (a.cursores[ev.threadId] ?? 0) + 1;
    const cap = capacidadeDaChamada(ev.name, ev.input);
    if (cap) contarUso(a, ctx, ev.threadId, ev.ts, cap, mensagemEmCurso.get(ev.threadId));
    agendarGravacao(home);
  });
  return () => {
    desligarOuvinte?.();
    desligarOuvinte = undefined;
  };
}

/**
 * Um gatilho lembrou o modelo desta capacidade nesta conversa. Se ela for usada nas próximas
 * `JANELA_DO_DISPARO` mensagens, o uso conta como "após disparo" (mede se o lembrete serviu).
 */
export function registrarDisparo(threadId: string, capacidade: { tipo: string; nome: string }, home: string, ts = new Date().toISOString()): void {
  const a = carregar(home);
  let ctx = contextos.get(threadId);
  if (!ctx) {
    try {
      ctx = contextoDe(readThread(threadId, home));
    } catch {
      ctx = undefined;
    }
    if (!ctx) return;
    contextos.set(threadId, ctx);
  }
  const chave = chaveDaCapacidade(capacidade);
  somar((a.dias[diaDe(ts)] ??= {}), "disparos", chave, segmentoDe(ctx));
  let abertos = disparosAbertos.get(threadId);
  if (!abertos) disparosAbertos.set(threadId, (abertos = new Map()));
  abertos.set(chave, JANELA_DO_DISPARO);
  const registro: DisparoRegistrado = { ts, threadId, chave, tipo: ctx.tipo, ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}) };
  (a.disparos ??= []).push(registro);
  if (a.disparos.length > DISPAROS_MAX) a.disparos.splice(0, a.disparos.length - DISPAROS_MAX);
  agendarGravacao(home);
  avisar({ tipo: "disparo", chave, threadId, ts, ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}) });
}

/** Últimos disparos de gatilho (mais novo primeiro), pra linha do tempo da aba. `projectPath` filtra. */
export function ultimosDisparos(home: string, opts: { projectPath?: string; max?: number } = {}): DisparoRegistrado[] {
  const a = carregar(home);
  const filtro = opts.projectPath === undefined ? undefined : chaveDoProjeto(opts.projectPath);
  return [...(a.disparos ?? [])]
    .reverse()
    .filter((d) => filtro === undefined || chaveDoProjeto(d.projectPath) === filtro)
    .slice(0, opts.max ?? 50);
}

export type UsoDeCapacidade = {
  chave: string;
  tipo: TipoDeCapacidade;
  nome: string;
  usos7d: number;
  usos30d: number;
  disparos7d: number;
  disparos30d: number;
  usosAposDisparo7d: number;
  usosAposDisparo30d: number;
  /** Usos de 30 dias por tipo de conversa. */
  porConversa: Record<TipoDeConversa, number>;
  /** Usos por dia, do mais antigo pro mais novo (14 dias, hoje por último). */
  porDia: number[];
  /** Disparos de gatilho por dia, mesma grade de `porDia`. */
  disparosPorDia: number[];
  ultimoUso?: string;
  ultimos: UltimoUso[];
};

export type RelatorioDeUso = {
  desde7d: string;
  desde30d: string;
  projectPath?: string;
  capacidades: UsoDeCapacidade[];
  /** Total de usos de 30 dias por tipo de conversa. */
  porConversa: Record<TipoDeConversa, number>;
  ultimaVarredura?: string;
};

const TIPOS: TipoDeConversa[] = ["chat", "run", "time", "oculta"];
function zeros(): Record<TipoDeConversa, number> {
  return { chat: 0, run: 0, time: 0, oculta: 0 };
}

/**
 * Relatório pra UI e linha de comando. `projectPath` filtra um projeto (ausente = todos; `""` = só
 * chat geral). Lê só memória/disco — nunca chama modelo.
 */
export function relatorioDeUso(home: string, opts: { projectPath?: string; agora?: number } = {}): RelatorioDeUso {
  const a = carregar(home);
  const agora = opts.agora ?? Date.now();
  const d7 = diaDe(new Date(agora - 7 * 86_400_000).toISOString());
  const d30 = diaDe(new Date(agora - 30 * 86_400_000).toISOString());
  const dias14 = Array.from({ length: 14 }, (_, i) => diaDe(new Date(agora - (13 - i) * 86_400_000).toISOString()));
  const filtroProjeto = opts.projectPath === undefined ? undefined : chaveDoProjeto(opts.projectPath);
  const porChave = new Map<string, UsoDeCapacidade>();
  const totalPorConversa = zeros();
  const item = (chave: string): UsoDeCapacidade => {
    let u = porChave.get(chave);
    if (!u) {
      const { tipo, nome } = capacidadeDaChave(chave);
      u = {
        chave,
        tipo,
        nome,
        usos7d: 0,
        usos30d: 0,
        disparos7d: 0,
        disparos30d: 0,
        usosAposDisparo7d: 0,
        usosAposDisparo30d: 0,
        porConversa: zeros(),
        porDia: dias14.map(() => 0),
        disparosPorDia: dias14.map(() => 0),
        ultimos: [],
      };
      porChave.set(chave, u);
    }
    return u;
  };
  const somaDosSegmentos = (seg: PorSegmento, fn: (tipo: TipoDeConversa, n: number) => void) => {
    for (const [s, n] of Object.entries(seg)) {
      const [tipo, proj] = s.split("|") as [TipoDeConversa, string];
      if (filtroProjeto !== undefined && proj !== filtroProjeto) continue;
      if (!TIPOS.includes(tipo)) continue;
      fn(tipo, n);
    }
  };
  for (const [dia, d] of Object.entries(a.dias)) {
    if (dia < d30) continue;
    const em7 = dia >= d7;
    const idx14 = dias14.indexOf(dia);
    for (const [chave, seg] of Object.entries(d.usos ?? {})) {
      somaDosSegmentos(seg, (tipo, n) => {
        const u = item(chave);
        u.usos30d += n;
        u.porConversa[tipo] += n;
        totalPorConversa[tipo] += n;
        if (em7) u.usos7d += n;
        if (idx14 >= 0) u.porDia[idx14] = (u.porDia[idx14] ?? 0) + n;
      });
    }
    for (const [chave, seg] of Object.entries(d.disparos ?? {})) {
      somaDosSegmentos(seg, (_t, n) => {
        const u = item(chave);
        u.disparos30d += n;
        if (em7) u.disparos7d += n;
        if (idx14 >= 0) u.disparosPorDia[idx14] = (u.disparosPorDia[idx14] ?? 0) + n;
      });
    }
    for (const [chave, seg] of Object.entries(d.usosAposDisparo ?? {})) {
      somaDosSegmentos(seg, (_t, n) => {
        const u = item(chave);
        u.usosAposDisparo30d += n;
        if (em7) u.usosAposDisparo7d += n;
      });
    }
  }
  for (const u of porChave.values()) {
    const c = a.capacidades[u.chave];
    if (!c) continue;
    const ultimos = c.ultimos.filter((x) => filtroProjeto === undefined || chaveDoProjeto(x.projectPath) === filtroProjeto);
    u.ultimos = ultimos.slice(-10).reverse();
    const ultimo = ultimos.at(-1)?.ts ?? (filtroProjeto === undefined ? c.ultimoUso : undefined);
    if (ultimo) u.ultimoUso = ultimo;
  }
  const capacidades = [...porChave.values()].sort((x, y) => y.usos30d - x.usos30d || x.chave.localeCompare(y.chave));
  return {
    desde7d: d7,
    desde30d: d30,
    ...(opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {}),
    capacidades,
    porConversa: totalPorConversa,
    ...(a.ultimaVarredura ? { ultimaVarredura: a.ultimaVarredura } : {}),
  };
}

/** Último uso conhecido de uma capacidade (qualquer projeto), pra quem só precisa da data. */
export function ultimoUsoDe(capacidade: Pick<Capacidade, "tipo" | "nome">, home: string): string | undefined {
  return carregar(home).capacidades[chaveDaCapacidade(capacidade)]?.ultimoUso;
}
