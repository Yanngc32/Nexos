import { closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LOG_NIVEIS, type LogNivel } from "@nexos/shared";
import { configPath, tokenPath } from "./home.ts";

/**
 * Log do motor: `<home>/daemon.log`, uma linha por evento, no formato
 *
 *   2026-09-24T16:53:01.123-03:00 AVISO [motor] porta 7777 ocupada {"pid":1234}
 *
 * Hora local com fuso (é o relógio de quem vai ler), nível fixo em 5 caracteres, origem entre
 * colchetes e `dados` em JSON numa linha só — `grep` e `sort` bastam pra contar a história.
 *
 * **O logger é dono do arquivo.** Antes, o app abria `daemon.log` e passava o fd como stdout do
 * motor: o arquivo crescia pra sempre, e renomear pra rotacionar não adiantava (o fd continua
 * apontando pro arquivo renomeado). Aqui ele abre o próprio fd, confere o tamanho a cada escrita
 * e empurra `.1`→`.2`→`.3` quando passa do teto — com o motor ligado por semanas, fica em no
 * máximo 4 × 5 MB. O stdio do `nexos up` vai pra `daemon-saida.log`, que o app rotaciona na subida.
 *
 * Antes de `iniciarLog` (testes, comandos de terminal) a linha vai pro stderr, no mesmo formato.
 */

export type Origem =
  | "motor"
  | "saude"
  | "drive"
  | "copia"
  | "sync"
  | "turno"
  | "servico"
  | "hook"
  | "app"
  | "congelamento";

const PESO: Record<LogNivel, number> = { debug: 0, info: 1, aviso: 2, erro: 3 };
const ROTULO: Record<LogNivel, string> = { debug: "DEBUG", info: "INFO ", aviso: "AVISO", erro: "ERRO " };

/** Teto de cada arquivo e quantos antigos guarda (`.1`…`.3`). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_ANTIGOS = 3;
/** Uma linha nunca passa disto: `dados` gigante não pode empurrar a rotação sozinho. */
const LINHA_MAX = 16 * 1024;

type Estado = {
  caminho: string;
  fd: number | null;
  maxBytes: number;
  antigos: number;
};

let estado: Estado | null = null;
let nivelAtual: LogNivel = "info";
const segredos = new Set<string>();

function isNivel(v: unknown): v is LogNivel {
  return typeof v === "string" && (LOG_NIVEIS as readonly string[]).includes(v);
}

/**
 * `NEXOS_LOG` ganha do `logNivel` do config; nenhum dos dois = `info`. Lê o JSON direto (e não
 * `loadConfig`) pra não criar ciclo de import — o config também loga.
 */
export function nivelDoHome(home: string): LogNivel {
  const env = process.env.NEXOS_LOG?.trim().toLowerCase();
  if (isNivel(env)) return env;
  try {
    const raw = JSON.parse(readFileSync(configPath(home), "utf8")) as { logNivel?: unknown };
    if (isNivel(raw.logNivel)) return raw.logNivel;
  } catch {
    /* sem config ainda */
  }
  return "info";
}

/** Relido no `PUT /v1/config`: trocar o nível vale sem reiniciar o motor. */
export function recarregarNivel(home: string): LogNivel {
  nivelAtual = nivelDoHome(home);
  return nivelAtual;
}

export function nivelDoLog(): LogNivel {
  return nivelAtual;
}

/** Valor que nunca pode aparecer numa linha (o token do daemon, por exemplo). */
export function registrarSegredo(valor: string): void {
  const v = valor.trim();
  if (v.length >= 8) segredos.add(v);
}

export function iniciarLog(home: string, opts: { maxBytes?: number; antigos?: number } = {}): void {
  fecharLog();
  estado = {
    caminho: join(home, "daemon.log"),
    fd: null,
    maxBytes: opts.maxBytes ?? LOG_MAX_BYTES,
    antigos: opts.antigos ?? LOG_ANTIGOS,
  };
  recarregarNivel(home);
  try {
    if (existsSync(tokenPath(home))) registrarSegredo(readFileSync(tokenPath(home), "utf8"));
  } catch {
    /* sem token ainda */
  }
}

export function fecharLog(): void {
  if (estado?.fd != null) {
    try {
      closeSync(estado.fd);
    } catch {
      /* já fechado */
    }
  }
  estado = null;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** ISO com a hora LOCAL e o fuso (`-03:00`), não UTC. */
export function horaLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sinal = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sinal}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const CHAVE_SECRETA = /token|senha|password|secret|authorization|cookie|api_?key/i;

/** Chave com cara de segredo vira `***`; Error vira mensagem + stack. */
function limpar(valor: unknown, profundidade = 0): unknown {
  if (valor instanceof Error) return { erro: valor.message, stack: valor.stack };
  if (valor === null || typeof valor !== "object" || profundidade > 5) return valor;
  if (Array.isArray(valor)) return valor.map((v) => limpar(v, profundidade + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor)) out[k] = CHAVE_SECRETA.test(k) ? "***" : limpar(v, profundidade + 1);
  return out;
}

function mascarar(texto: string): string {
  let out = texto.replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1***");
  for (const s of segredos) out = out.split(s).join("***");
  return out;
}

export function formatarLinha(nivel: LogNivel, origem: Origem, msg: string, dados?: unknown, quando = new Date()): string {
  let json = "";
  if (dados !== undefined) {
    try {
      json = ` ${JSON.stringify(limpar(dados))}`;
    } catch {
      json = ' {"dados":"(não serializável)"}';
    }
  }
  const corpo = `${msg.replace(/\r?\n/g, " ⏎ ")}${json}`;
  let linha = mascarar(`${horaLocal(quando)} ${ROTULO[nivel]} [${origem}] ${corpo}`);
  if (linha.length > LINHA_MAX) linha = `${linha.slice(0, LINHA_MAX)} …(cortado)`;
  return `${linha}\n`;
}

/** Empurra `.1`→`.2`→… (o mais antigo some) e move o atual pra `.1`. */
function rotacionar(e: Estado): void {
  if (e.fd != null) {
    try {
      closeSync(e.fd);
    } catch {
      /* já fechado */
    }
    e.fd = null;
  }
  try {
    const ultimo = `${e.caminho}.${e.antigos}`;
    if (existsSync(ultimo)) unlinkSync(ultimo);
    for (let i = e.antigos - 1; i >= 1; i--) {
      const de = `${e.caminho}.${i}`;
      if (existsSync(de)) renameSync(de, `${e.caminho}.${i + 1}`);
    }
    renameSync(e.caminho, `${e.caminho}.1`);
  } catch {
    // arquivo preso por outro processo (hook de git no meio de um append): tenta na próxima escrita
  }
}

function escreverNoArquivo(e: Estado, linha: string): boolean {
  try {
    if (e.fd == null) e.fd = openSync(e.caminho, "a");
    const tamanho = fstatSync(e.fd).size;
    if (tamanho > 0 && tamanho + Buffer.byteLength(linha) > e.maxBytes) {
      rotacionar(e);
      e.fd = openSync(e.caminho, "a");
    }
    writeSync(e.fd, linha);
    return true;
  } catch {
    e.fd = null;
    return false;
  }
}

function escrever(nivel: LogNivel, origem: Origem, msg: string, dados?: unknown): void {
  if (PESO[nivel] < PESO[nivelAtual]) return;
  const linha = formatarLinha(nivel, origem, msg, dados);
  if (estado && escreverNoArquivo(estado, linha)) return;
  try {
    process.stderr.write(linha);
  } catch {
    /* sem stderr: nada a fazer */
  }
}

export const log = {
  debug: (origem: Origem, msg: string, dados?: unknown) => escrever("debug", origem, msg, dados),
  info: (origem: Origem, msg: string, dados?: unknown) => escrever("info", origem, msg, dados),
  aviso: (origem: Origem, msg: string, dados?: unknown) => escrever("aviso", origem, msg, dados),
  erro: (origem: Origem, msg: string, dados?: unknown) => escrever("erro", origem, msg, dados),
};

let errosLigados = false;

/**
 * Exceção sem dono vira linha `ERRO` com a stack. `uncaughtExceptionMonitor` e não
 * `uncaughtException`: o monitor só observa, e o processo cai como caía antes — seguir rodando
 * depois de uma exceção sem dono deixaria o motor num estado que ninguém conhece. Promessa
 * rejeitada sem `catch` também passa por ele (o Node a relança como exceção desde o v15).
 */
export function registrarErrosSemDono(): void {
  if (errosLigados) return;
  errosLigados = true;
  process.on("uncaughtExceptionMonitor", (err, origem) => {
    const e = err instanceof Error ? err : new Error(String(err));
    log.erro("motor", `${origem === "unhandledRejection" ? "promessa rejeitada sem catch" : "exceção sem dono"}: ${e.message}`, {
      stack: e.stack ?? "",
    });
  });
}
