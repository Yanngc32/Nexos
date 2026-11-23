import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { memoriasDir } from "./memorias/caminho.ts";

/**
 * Gate de plano do motor `claude`: hook PreToolUse (via `--settings`) que nega a PRIMEIRA escrita
 * do turno (Write/Edit/MultiEdit/NotebookEdit) quando o modelo ainda não declarou o plano com
 * TodoWrite/TaskCreate. Nega no máximo uma vez por turno: a negação fica no transcript com a
 * `MARCA_GATE`, e a segunda tentativa passa.
 *
 * Sem estado: a cada chamada o hook lê o transcript JSONL da sessão a partir da última mensagem
 * REAL da pessoa (tool_result não conta). Qualquer erro de leitura/parse libera — o gate nunca
 * pode travar um turno.
 *
 * O daemon roda empacotado (dist/nexos.mjs), então o script do hook não pode ser um .ts do repo:
 * a lógica mora numa string JS (`LOGICA_DO_GATE`), gravada em `run/gate-plano.cjs` e rodada com
 * `node`. `decisaoDoGate` é a MESMA string avaliada aqui, pra teste — fonte única, sem cópia em TS.
 */

export const MARCA_GATE = "[gate-plano]";

// Não conta que o bloqueio é só um: medido com haiku, o modelo lia isso e repetia a escrita sem plano.
export const MOTIVO_DO_GATE =
  `${MARCA_GATE} Escrita recusada: antes de editar arquivos neste turno, declare o plano com ` +
  "TaskCreate (ou TodoWrite) com os passos que vai seguir (um só, se a mudança for pequena). Só " +
  "depois repita esta edição.";

/** Ferramentas que escrevem — as únicas que o gate segura (é também o matcher do hook). */
const ESCRITAS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * Contam como plano: TodoWrite/TaskCreate/TaskUpdate declaram; Agent/Task delegam a um subagente
 * (que escreve no transcript DELE, não neste — sem isso o gate negaria o turno todo).
 */
const PLANO = ["TodoWrite", "TaskCreate", "TaskUpdate", "Agent", "Task"];

// JS puro (roda em `node` solto, sem bundler): nada de TS nem sintaxe que dependa de versão nova.
const LOGICA_DO_GATE = `
var MARCA = ${JSON.stringify(MARCA_GATE)};
var ESCRITAS = ${JSON.stringify(ESCRITAS)};
var PLANO = ${JSON.stringify(PLANO)};

function ehMensagemDaPessoa(o) {
  if (!o || o.type !== "user" || o.isSidechain || o.isMeta || o.isCompactSummary || !o.message) return false;
  var c = o.message.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  for (var i = 0; i < c.length; i++) if (c[i] && c[i].type === "text") return true;
  return false;
}

function decidir(texto, entrada) {
  entrada = entrada || {};
  // chamada de dentro de subagente: a negação iria pro transcript dele, nunca seria vista aqui
  if (entrada.agent_id || entrada.agent_type) return "allow";
  if (entrada.tool_name && ESCRITAS.indexOf(entrada.tool_name) === -1) return "allow";
  var linhas = String(texto).split(/\\r?\\n/);
  var objs = [];
  var inicio = -1;
  for (var i = 0; i < linhas.length; i++) {
    var o = null;
    if (linhas[i].trim()) {
      try { o = JSON.parse(linhas[i]); } catch (e) { o = null; }
    }
    objs.push(o);
    if (ehMensagemDaPessoa(o)) inicio = i;
  }
  // sem turno identificável (formato inesperado): não bloqueia
  if (inicio < 0) return "allow";
  for (var j = inicio + 1; j < linhas.length; j++) {
    // já negou neste turno: a negação volta como tool_result com a marca
    if (linhas[j].indexOf(MARCA) !== -1) return "allow";
    var a = objs[j];
    if (!a || a.type !== "assistant" || a.isSidechain || !a.message || !Array.isArray(a.message.content)) continue;
    for (var k = 0; k < a.message.content.length; k++) {
      var b = a.message.content[k];
      if (b && b.type === "tool_use" && PLANO.indexOf(b.name) !== -1) return "allow";
    }
  }
  return "deny";
}
`;

export type DecisaoDoGate = "allow" | "deny";
export type EntradaDoGate = { tool_name?: string; agent_id?: string; agent_type?: string };

/** Decisão pura (transcript em texto + entrada do hook) — a mesma lógica que roda no script. */
export const decisaoDoGate = new Function(`${LOGICA_DO_GATE}\nreturn decidir;`)() as (
  transcript: string,
  entrada?: EntradaDoGate,
) => DecisaoDoGate;

/** Script do hook: lê o JSON do stdin, decide e, se negar, imprime a decisão. Sempre sai com 0. */
export const SCRIPT_DO_GATE = `// Gerado pelo Nexos (gate-plano.ts) — não editar, é regravado quando muda.
"use strict";
${LOGICA_DO_GATE}
var MOTIVO = ${JSON.stringify(MOTIVO_DO_GATE)};
var dados = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (c) { dados += c; });
process.stdin.on("end", function () {
  try {
    var entrada = JSON.parse(dados);
    var texto = require("fs").readFileSync(entrada.transcript_path, "utf8");
    if (decidir(texto, entrada) === "deny") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: MOTIVO }
      }));
    }
  } catch (e) {}
  process.exit(0);
});
`;

/** Grava só se mudou: o arquivo é lido pelo CLI a cada turno, reescrever à toa não ganha nada. */
function gravarSeMudou(arquivo: string, conteudo: string): void {
  if (existsSync(arquivo) && readFileSync(arquivo, "utf8") === conteudo) return;
  writeFileSync(arquivo, conteudo, "utf8");
}

// barra normal: o hook roda num shell, e `\` dentro de aspas vira escape em bash
const barraNormal = (p: string) => p.replace(/\\/g, "/");

/**
 * Prepara script + settings do hook em `<home>/run` e devolve o caminho do settings pro
 * `--settings`. `--settings` SOMA hooks aos do perfil (ex.: o do rtk), não substitui.
 */
export function prepararGatePlano(home: string): string {
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "gate-plano.cjs");
  const settings = join(dir, "gate-plano-settings.json");
  gravarSeMudou(script, SCRIPT_DO_GATE);
  const comando = `node "${barraNormal(script)}"`;
  const conteudo = JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: ESCRITAS.join("|"), hooks: [{ type: "command", command: comando }] }] } },
    null,
    2,
  );
  gravarSeMudou(settings, conteudo);
  return settings;
}

/**
 * Recusa de escrita direta na pasta de memórias do usuário (`<home>/memorias`): a única porta de
 * escrita é a ferramenta `memory_propose`. Vale com ou sem gate de plano, e também dentro de
 * subagente. Mesmo esquema do gate: lógica numa string JS, gravada em `run/memoria-escrita.cjs`
 * e avaliada aqui para teste. A pasta chega ao script como argumento.
 */
export function motivoDaEscritaEmMemoria(dir: string): string {
  return (
    `Escrita recusada: a pasta de memórias (${dir}) não aceita escrita direta. Use a ferramenta ` +
    "memory_propose (mcp__nexo__memory_propose); rode memory_list antes para pegar a revisão atual."
  );
}

const LOGICA_DA_MEMORIA = `
var ESCRITAS_MEMORIA = ${JSON.stringify(ESCRITAS)};

function dentroDaPasta(path, win, dir, alvo, cwd) {
  var base = path.resolve(dir);
  var abs = path.resolve(cwd || base, alvo);
  if (win) { base = base.toLowerCase(); abs = abs.toLowerCase(); }
  var rel = path.relative(base, abs);
  return rel === "" || (rel.slice(0, 2) !== ".." && !path.isAbsolute(rel));
}

function decidirMemoria(path, win, dir, entrada) {
  entrada = entrada || {};
  if (!dir || ESCRITAS_MEMORIA.indexOf(entrada.tool_name) === -1) return "allow";
  var ti = entrada.tool_input || {};
  var alvo = ti.file_path || ti.notebook_path || ti.path;
  if (typeof alvo !== "string" || !alvo) return "allow";
  return dentroDaPasta(path, win, dir, alvo, entrada.cwd) ? "deny" : "allow";
}
`;

export type EntradaDaMemoria = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

const decidirMemoriaBruto = new Function(`${LOGICA_DA_MEMORIA}\nreturn decidirMemoria;`)() as (
  path: unknown,
  win: boolean,
  dir: string,
  entrada?: EntradaDaMemoria,
) => DecisaoDoGate;

/** Decisão pura do hook de memória — a mesma lógica que roda no script. */
export function decisaoDaMemoria(dir: string, entrada?: EntradaDaMemoria, plataforma: NodeJS.Platform = process.platform): DecisaoDoGate {
  const win = plataforma === "win32";
  return decidirMemoriaBruto(win ? win32 : posix, win, dir, entrada);
}

export const SCRIPT_DA_MEMORIA = `// Gerado pelo Nexos (gate-plano.ts) — não editar, é regravado quando muda.
"use strict";
${LOGICA_DA_MEMORIA}
var DIR = process.argv[2] || "";
var dados = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (c) { dados += c; });
process.stdin.on("end", function () {
  try {
    var entrada = JSON.parse(dados);
    if (decidirMemoria(require("path"), process.platform === "win32", DIR, entrada) === "deny") {
      var motivo = ${JSON.stringify(motivoDaEscritaEmMemoria("__DIR__"))}.replace("__DIR__", function () { return DIR; });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: motivo }
      }));
    }
  } catch (e) {}
  process.exit(0);
});
`;

/**
 * Settings único com os hooks do motor (só um `--settings` é seguro por chamada): o gate de plano
 * quando `gatePlano`, a recusa de escrita em memória quando `memorias`. `undefined` sem nenhum.
 */
export function prepararHooksDoMotor(home: string, o: { gatePlano: boolean; memorias: boolean }): string | undefined {
  if (!o.gatePlano && !o.memorias) return undefined;
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true });
  const entradas: { matcher: string; hooks: { type: "command"; command: string }[] }[] = [];
  if (o.gatePlano) {
    const script = join(dir, "gate-plano.cjs");
    gravarSeMudou(script, SCRIPT_DO_GATE);
    entradas.push({ matcher: ESCRITAS.join("|"), hooks: [{ type: "command", command: `node "${barraNormal(script)}"` }] });
  }
  if (o.memorias) {
    const script = join(dir, "memoria-escrita.cjs");
    gravarSeMudou(script, SCRIPT_DA_MEMORIA);
    const pasta = barraNormal(memoriasDir(home));
    entradas.push({ matcher: ESCRITAS.join("|"), hooks: [{ type: "command", command: `node "${barraNormal(script)}" "${pasta}"` }] });
  }
  const settings = join(dir, "hooks-do-motor-settings.json");
  gravarSeMudou(settings, JSON.stringify({ hooks: { PreToolUse: entradas } }, null, 2));
  return settings;
}
