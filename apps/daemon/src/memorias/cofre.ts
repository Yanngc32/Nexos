/**
 * Cofre de segredos das memórias: `<home>/cofre/segredos.json`.
 *
 * Mesmo envelope e mesma cifra do Agent Code — `{version:2, key, records}`,
 * AES-256-GCM com iv(12)|tag(16)|corpo em base64 — e a chave no PRÓPRIO
 * arquivo: chave e texto cifrado só valem em par, e num arquivo só copiar a
 * pasta leva os dois. O que protege: senha nunca em texto puro no disco. O que
 * NÃO protege: quem tem o arquivo tem a chave.
 *
 * Gravação atômica (tmp + rename) e 0600 quando o sistema deixa. Arquivo
 * inválido nunca derruba o daemon: leitura devolve vazio, e a gravação recusa
 * com erro em vez de gerar chave nova por cima — isso tornaria indecifrável
 * todo segredo já salvo.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nomeSegredoValido } from "./segredos.ts";

const ALGORITMO = "aes-256-gcm";
const BYTES_CHAVE = 32;
const BYTES_IV = 12;
const BYTES_TAG = 16;
const MAX_REGISTROS = 1000;
const MAX_VALOR = 64 * 1024;

interface Registro {
  name: string;
  createdAt: string;
  updatedAt: string;
  ciphertext: string;
}

interface Envelope {
  version: 2;
  key: string;
  records: Registro[];
}

/** Pasta do cofre: `<home>/cofre`. */
export function cofreDir(home: string): string {
  return join(home, "cofre");
}

function arquivoCofre(home: string): string {
  return join(cofreDir(home), "segredos.json");
}

const dataValida = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * Envelope do disco: `null` quando o arquivo não existe (cofre novo),
 * `"invalido"` quando existe mas não é um envelope que dá para usar.
 */
function carregar(home: string): Envelope | null | "invalido" {
  const arq = arquivoCofre(home);
  if (!existsSync(arq)) return null;
  try {
    const dado = JSON.parse(readFileSync(arq, "utf8")) as Partial<Envelope> | null;
    if (!dado || dado.version !== 2 || typeof dado.key !== "string" || !Array.isArray(dado.records)) return "invalido";
    if (Buffer.from(dado.key, "base64").length !== BYTES_CHAVE) return "invalido";
    const nomes = new Set<string>();
    for (const r of dado.records) {
      if (!r || !nomeSegredoValido(r.name) || nomes.has(r.name) || !dataValida(r.createdAt) || !dataValida(r.updatedAt)) return "invalido";
      if (typeof r.ciphertext !== "string" || !r.ciphertext) return "invalido";
      nomes.add(r.name);
    }
    return { version: 2, key: dado.key, records: dado.records as Registro[] };
  } catch {
    return "invalido";
  }
}

function cifrar(chave: Buffer, valor: string): string {
  const iv = randomBytes(BYTES_IV);
  const cifra = createCipheriv(ALGORITMO, chave, iv);
  const corpo = Buffer.concat([cifra.update(valor, "utf8"), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), corpo]).toString("base64");
}

function decifrar(chave: Buffer, cifrado: string): string {
  const buf = Buffer.from(cifrado, "base64");
  if (buf.length <= BYTES_IV + BYTES_TAG) throw new Error("Texto cifrado do cofre é inválido.");
  const decifra = createDecipheriv(ALGORITMO, chave, buf.subarray(0, BYTES_IV));
  decifra.setAuthTag(buf.subarray(BYTES_IV, BYTES_IV + BYTES_TAG));
  return Buffer.concat([decifra.update(buf.subarray(BYTES_IV + BYTES_TAG)), decifra.final()]).toString("utf8");
}

function persistir(home: string, env: Envelope): void {
  const dir = cofreDir(home);
  mkdirSync(dir, { recursive: true });
  const arq = arquivoCofre(home);
  const tmp = `${arq}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(env, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, arq);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* sobra do tmp não importa */ }
    throw e;
  }
  try { chmodSync(arq, 0o600); } catch { /* Windows/FS sem permissão POSIX */ }
}

/**
 * Grava (ou troca) o segredo `nome`. Lança quando o nome ou o valor é inválido
 * ou quando o arquivo do cofre existe mas está corrompido — quem chama trata.
 */
export function gravarSegredo(home: string, nome: string, valor: string): void {
  if (!nomeSegredoValido(nome)) throw new Error(`Nome de segredo inválido: "${String(nome)}".`);
  if (typeof valor !== "string" || !valor) throw new Error("Valor de segredo vazio.");
  if (Buffer.byteLength(valor, "utf8") > MAX_VALOR) throw new Error("Valor de segredo grande demais.");
  const atual = carregar(home);
  if (atual === "invalido") {
    throw new Error(`O cofre (${arquivoCofre(home)}) está ilegível; não gravo por cima para não perder os segredos que ele guarda.`);
  }
  const env: Envelope = atual ?? { version: 2, key: randomBytes(BYTES_CHAVE).toString("base64"), records: [] };
  const chave = Buffer.from(env.key, "base64");
  const agora = new Date().toISOString();
  const anterior = env.records.find((r) => r.name === nome);
  const registros = env.records.filter((r) => r.name !== nome);
  if (!anterior && registros.length >= MAX_REGISTROS) throw new Error("O cofre chegou ao limite de segredos.");
  registros.push({ name: nome, createdAt: anterior?.createdAt ?? agora, updatedAt: agora, ciphertext: cifrar(chave, valor) });
  persistir(home, { version: 2, key: env.key, records: registros });
}

/** Valor do segredo, ou `undefined` (ausente, cofre ilegível ou registro adulterado). Nunca lança. */
export function lerSegredo(home: string, nome: string): string | undefined {
  const env = carregar(home);
  if (!env || env === "invalido") return undefined;
  const reg = env.records.find((r) => r.name === nome);
  if (!reg) return undefined;
  try {
    return decifrar(Buffer.from(env.key, "base64"), reg.ciphertext);
  } catch {
    return undefined;
  }
}

/** Nomes e data da última troca — nunca os valores. Cofre ilegível = lista vazia. */
export function listarSegredos(home: string): { nome: string; atualizadoEm: string }[] {
  const env = carregar(home);
  if (!env || env === "invalido") return [];
  return env.records
    .map((r) => ({ nome: r.name, atualizadoEm: r.updatedAt }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}
