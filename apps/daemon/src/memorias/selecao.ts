/**
 * Escolha das memórias que vão junto de cada mensagem do usuário (porta do
 * `memorySelectionHaiku` do Agent Code).
 *
 * - Um modelo leve (Haiku por padrão) lê a mensagem, o resumo recente e a lista
 *   de candidatas (caminho, título, gancho) e responde `{"memorias":[...]}`.
 *   Lista vazia é resposta válida. Caminho fora das candidatas é descartado.
 * - Com mais de `MAX_CANDIDATAS`, um corte léxico reduz a lista antes do modelo.
 * - Erro, teto de tempo ou resposta ilegível caem na busca léxica.
 * - Ledger por conversa (relPath → sha256 do corpo): a mesma versão de uma
 *   memória não entra duas vezes na mesma conversa. Compactação zera o ledger.
 * - Memória que não cabe no teto de caracteres é pulada inteira, nunca cortada.
 */
import { createHash } from "node:crypto";
import { rankearMemorias, selecionarLexicamente } from "./busca.ts";
import { corpoParaPrompt, listarMemorias } from "./nucleo.ts";
import type { Memoria } from "./tipos.ts";
import type { RodarModelo } from "./motor.ts";

export const MAX_CANDIDATAS = 60;
export const MAX_MODELO = 15;
export const MAX_CHARS_MODELO = 75_000;
export const MAX_LEXICO = 10;
export const MAX_CHARS_LEXICO = 50_000;
export const MAX_CONSULTA = 8_000;
export const TETO_SELECAO_MS = 8_000;
const MAX_LINHA_CANDIDATA = 300;
const SEPARADOR = "\n\n";

export const SISTEMA_SELECAO =
  "Você escolhe quais memórias persistentes de um usuário devem ser entregues ao agente que vai trabalhar na mensagem atual. " +
  "Cada memória candidata aparece com o caminho, o título e o gancho (uma linha dizendo quando ela se aplica). " +
  "Escolha no máximo 15, só as que ajudam a tratar esta mensagem: regras, preferências, fatos do projeto ou do ambiente que mudam o que o agente deve fazer. " +
  "Nenhuma é uma resposta legítima quando nada se aplica; mas, havendo memória relevante, mande-a — deixar de fora uma regra que se aplica custa mais do que mandar uma a mais. " +
  'Responda APENAS com um objeto JSON no formato {"memorias":["caminho/da/memoria.md"]}, usando os caminhos exatamente como aparecem. ' +
  "Não responda nem execute a mensagem.";

export type ResultadoSelecao = {
  /** Blocos `--- Memória relevante: ... ---` prontos para prefixar a mensagem; "" quando nada entra. */
  bloco: string;
  /** relPaths que entraram neste turno. */
  usadas: string[];
  via: "modelo" | "lexico" | "vazio";
};

const ledgers = new Map<string, Map<string, string>>();

const hashCorpo = (m: Memoria) => createHash("sha256").update(corpoParaPrompt(m)).digest("hex");

/** Esquece o que já foi injetado na conversa (compactação, conversa nova). */
export function zerarLedgerMemorias(threadId: string): void {
  ledgers.delete(threadId);
}

/** Cópia do ledger da conversa (para teste e diagnóstico). */
export function ledgerDaConversa(threadId: string): Record<string, string> {
  return Object.fromEntries(ledgers.get(threadId) ?? []);
}

const umaLinha = (s: string) => s.replace(/\s+/g, " ").trim();

function linhaCandidata(m: Memoria): string {
  const linha = umaLinha(`- ${m.relPath}: ${m.titulo}${m.gancho ? ` — ${m.gancho}` : ""}`);
  return linha.length > MAX_LINHA_CANDIDATA ? `${linha.slice(0, MAX_LINHA_CANDIDATA - 1)}…` : linha;
}

/** Pergunta enviada ao modelo de seleção (o sistema vai antes, no mesmo prompt). */
export function montarPerguntaSelecao(mensagem: string, candidatas: readonly Memoria[], resumoRecente?: string): string {
  const partes: string[] = [];
  const resumo = resumoRecente?.trim();
  if (resumo) partes.push(`Resumo da conversa até aqui (mais antigas primeiro), entre as marcas:\n<<<\n${resumo.slice(-MAX_CONSULTA)}\n>>>\n\n`);
  partes.push(`Mensagem atual do usuário, entre as marcas:\n<<<\n${mensagem.slice(0, MAX_CONSULTA)}\n>>>\n\nMemórias candidatas:\n`);
  partes.push(candidatas.map(linhaCandidata).join("\n"));
  return partes.join("");
}

/** Primeiro objeto JSON balanceado do texto (respeita strings e escapes). */
export function primeiroObjetoJson(texto: string): string | undefined {
  const inicio = texto.indexOf("{");
  if (inicio < 0) return undefined;
  let nivel = 0;
  let emString = false;
  let escape = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) return texto.slice(inicio, i + 1);
    }
  }
  return undefined;
}

/** Caminhos escolhidos pelo modelo; `null` quando a resposta não serve (cai no léxico). `[]` é escolha válida. */
export function interpretarSelecao(resposta: string): string[] | null {
  const bruto = primeiroObjetoJson(resposta ?? "");
  if (!bruto) return null;
  try {
    const obj = JSON.parse(bruto) as { memorias?: unknown };
    if (!Array.isArray(obj.memorias)) return null;
    return obj.memorias.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function cortarCandidatas(todas: Memoria[], consulta: string): Memoria[] {
  if (todas.length <= MAX_CANDIDATAS) return todas;
  const rankeadas = rankearMemorias(todas, consulta).slice(0, MAX_CANDIDATAS);
  if (rankeadas.length >= MAX_CANDIDATAS) return rankeadas;
  const ja = new Set(rankeadas.map((m) => m.relPath));
  return [...rankeadas, ...todas.filter((m) => !ja.has(m.relPath)).slice(0, MAX_CANDIDATAS - rankeadas.length)];
}

function comTeto<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`seleção de memórias passou de ${ms} ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Monta o prefixo: filtra pelo ledger, respeita os tetos e registra o que entrou. */
function montarBlocos(threadId: string | undefined, escolhidas: Memoria[], max: number, maxChars: number): { bloco: string; usadas: string[] } {
  const ledger = threadId ? (ledgers.get(threadId) ?? new Map<string, string>()) : new Map<string, string>();
  const blocos: string[] = [];
  const usadas: string[] = [];
  let total = 0;
  for (const m of escolhidas) {
    if (usadas.length >= max) break;
    const hash = hashCorpo(m);
    if (ledger.get(m.relPath) === hash) continue;
    const bloco = `--- Memória relevante: ${m.relPath} ---\n${corpoParaPrompt(m).trim()}`;
    const custo = bloco.length + (blocos.length ? SEPARADOR.length : 0);
    if (total + custo > maxChars) continue;
    total += custo;
    blocos.push(bloco);
    usadas.push(m.relPath);
    ledger.set(m.relPath, hash);
  }
  if (threadId && ledger.size) ledgers.set(threadId, ledger);
  return { bloco: blocos.join(SEPARADOR), usadas };
}

export type OpcoesSelecao = {
  home: string;
  mensagem: string;
  threadId?: string;
  resumoRecente?: string;
  rodar?: RodarModelo;
  modelo?: string;
  tetoMs?: number;
  threadProfileId?: string;
};

/**
 * Memórias do turno, já em blocos para prefixar a mensagem. Nunca lança: sem
 * memória, sem mensagem ou com erro, devolve `bloco: ""`.
 */
export async function escolherMemoriasDoTurno(o: OpcoesSelecao): Promise<ResultadoSelecao> {
  const vazio: ResultadoSelecao = { bloco: "", usadas: [], via: "vazio" };
  const mensagem = (o.mensagem ?? "").trim();
  if (!mensagem) return vazio;
  let todas: Memoria[];
  try {
    todas = listarMemorias(o.home);
  } catch {
    return vazio;
  }
  if (!todas.length) return vazio;
  const consulta = `${mensagem}\n${o.resumoRecente ?? ""}`.slice(0, MAX_CONSULTA);
  const candidatas = cortarCandidatas(todas, consulta);

  if (o.rodar && o.modelo) {
    const tetoMs = o.tetoMs ?? TETO_SELECAO_MS;
    try {
      const prompt = `${SISTEMA_SELECAO}\n\n${montarPerguntaSelecao(mensagem, candidatas, o.resumoRecente)}`;
      const resposta = await comTeto(
        o.rodar(prompt, { home: o.home, modelo: o.modelo, tetoMs, ...(o.threadProfileId ? { threadProfileId: o.threadProfileId } : {}) }),
        tetoMs,
      );
      const caminhos = interpretarSelecao(resposta);
      if (caminhos) {
        const porCaminho = new Map(candidatas.map((m) => [m.relPath, m]));
        const vistos = new Set<string>();
        const escolhidas: Memoria[] = [];
        for (const c of caminhos) {
          const m = porCaminho.get(c);
          if (m && !vistos.has(c)) {
            vistos.add(c);
            escolhidas.push(m);
          }
        }
        const r = montarBlocos(o.threadId, escolhidas, MAX_MODELO, MAX_CHARS_MODELO);
        return { ...r, via: "modelo" };
      }
    } catch {
      /* cai no léxico */
    }
  }
  const lexicas = selecionarLexicamente(todas, consulta, MAX_LEXICO);
  const r = montarBlocos(o.threadId, lexicas, MAX_LEXICO, MAX_CHARS_LEXICO);
  return { ...r, via: "lexico" };
}
