import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aprendizadoLigado, type TipoDeSinal } from "./instintos.ts";
import { log } from "./log.ts";
import { daPessoa, readThread, threadHead, type ThreadHead } from "./threads.ts";

/**
 * Coleta determinística dos sinais de correção (sem LLM, sem hook, sem observador em background):
 * o motor já é dono do JSONL e dos eventos — parar turno, mensagem injetada no meio do turno, mock
 * reprovado e a mensagem seguinte da pessoa que tem cara de correção. Cada sinal marca um trecho da
 * conversa (id + posição no JSONL + data) pra `aprendizado-analise.ts` olhar quando ela parar.
 *
 * As marcas ficam só nesta máquina (`~/.nexos/aprendizado/sinais.json`): é fila de trabalho, não
 * dado do projeto. O que vira aprendizado é que sincroniza (`instintos.ts`).
 */

export type Sinal = {
  id: string;
  threadId: string;
  projectPath: string;
  /** Quantos eventos a conversa tinha na hora: o trecho é o que está em volta disto. */
  posicao: number;
  ts: string;
  tipo: TipoDeSinal;
  /** Fala da pessoa ligada ao sinal (motivo do mock, texto injetado, a correção), quando há. */
  trecho?: string;
  /** Quando foi analisada (cada marca é analisada uma vez só). */
  analisadoEm?: string;
  tentativas?: number;
};

/**
 * "Tem cara de correção" — filtro barato em pt-BR pra mensagem seguinte (num lugar só, coberto por
 * teste). Deixar escapar alguma correção é aceitável: parar turno, inject e mock reprovado cobrem.
 */
export const REGEX_CORRECAO = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    [
      "n[ãa]o[,.!]",
      "n[ãa]o\\s+(?:era|é|foi|quero|precisa|usa|use|fa[çc]a|mexe|mexa)",
      "na\\s+verdade",
      "errad[oa]s?",
      "em\\s+vez\\s+de",
      "ao\\s+inv[ée]s\\s+de",
      "(?:eu|j[áa])\\s+(?:disse|falei|pedi)",
      "de\\s+novo",
      "volt[ae]",
      "desfa[zçc]",
      "par[ae]\\s+de",
      "nunca\\s+(?:use|usa|fa[çc]a)",
      "sempre\\s+(?:use|usa)",
      "prefiro",
    ].join("|") +
    ")(?![\\p{L}\\p{N}])",
  "iu",
);

export function pareceCorrecao(texto: string): boolean {
  const t = texto.trim();
  if (!t || t.length > 2000) return false;
  return REGEX_CORRECAO.test(t);
}

/** Conversa que pode gerar aprendizado: da pessoa, com projeto, fora de plano e fora do próprio analisador. */
export function observavel(head: ThreadHead | undefined): head is ThreadHead & { projectPath: string } {
  if (!head?.projectPath) return false;
  if (!daPessoa(head) || head.oculta || head.planejamento) return false;
  if (head.id.startsWith(PREFIXO_DO_ANALISADOR)) return false;
  return true;
}

/** threadId do motor descartável da análise: nunca é conversa, e nunca é observado. */
export const PREFIXO_DO_ANALISADOR = "aprendizado-";

function arquivo(home: string): string {
  return join(home, "aprendizado", "sinais.json");
}

let cache: { home: string; sinais: Sinal[] } | null = null;

export function lerSinais(home: string): Sinal[] {
  if (cache?.home === home) return cache.sinais;
  let sinais: Sinal[] = [];
  const p = arquivo(home);
  if (existsSync(p)) {
    try {
      const o = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (Array.isArray(o)) sinais = o as Sinal[];
    } catch (e) {
      log.aviso("aprendizado", "fila de sinais ilegível; começando vazia", { erro: (e as Error).message });
    }
  }
  cache = { home, sinais };
  return sinais;
}

/** Marca analisada há mais disto sai do arquivo (a evidência já está no aprendizado). */
const GUARDA_ANALISADOS_MS = 30 * 24 * 60 * 60_000;

export function gravarSinais(home: string, sinais: Sinal[]): void {
  const agora = Date.now();
  const vivos = sinais.filter((s) => !s.analisadoEm || agora - Date.parse(s.analisadoEm) < GUARDA_ANALISADOS_MS);
  const p = arquivo(home);
  mkdirSync(join(home, "aprendizado"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(vivos, null, 1), "utf8");
  renameSync(tmp, p);
  cache = { home, sinais: vivos };
}

export function resetSinaisForTest(): void {
  cache = null;
}

/** Até onde a fala da pessoa vai na marca (a evidência corta de novo, em ~140). */
const TRECHO_MAX = 600;

/**
 * Marca um sinal. Nunca lança: aprender é secundário e não pode derrubar parar, inject ou envio.
 * `false` = não marcou (conversa fora do escopo, aprendizado desligado ou erro).
 */
export function marcarSinal(home: string, input: { threadId: string; tipo: TipoDeSinal; trecho?: string }): boolean {
  try {
    const head = threadHead(input.threadId, home);
    if (!observavel(head)) return false;
    if (!aprendizadoLigado(head.projectPath, home)) return false;
    const posicao = readThread(input.threadId, home).length;
    const sinais = lerSinais(home);
    // o mesmo ponto da conversa não vira duas marcas do mesmo tipo (clique duplo no parar)
    if (sinais.some((s) => s.threadId === input.threadId && s.posicao === posicao && s.tipo === input.tipo)) return false;
    const trecho = input.trecho?.trim().slice(0, TRECHO_MAX);
    sinais.push({
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      threadId: input.threadId,
      projectPath: head.projectPath,
      posicao,
      ts: new Date().toISOString(),
      tipo: input.tipo,
      ...(trecho ? { trecho } : {}),
    });
    gravarSinais(home, sinais);
    log.debug("aprendizado", "sinal marcado", { threadId: input.threadId, tipo: input.tipo });
    return true;
  } catch (e) {
    log.avisoUmaVez("aprendizado-marcar", "aprendizado", "não consegui marcar um sinal de correção", { erro: (e as Error).message });
    return false;
  }
}

/**
 * Mensagem da pessoa logo depois de uma resposta: vira sinal só se tiver cara de correção. A regex
 * roda antes de qualquer leitura de disco — quase toda mensagem para ali.
 */
export function talvezMarcarMensagemSeguinte(home: string, threadId: string, texto: string): boolean {
  if (!pareceCorrecao(texto)) return false;
  try {
    const ultimo = readThread(threadId, home)
      .filter((e) => e.type === "user" || e.type === "assistant")
      .at(-1);
    if (ultimo?.type !== "assistant") return false;
  } catch {
    return false;
  }
  return marcarSinal(home, { threadId, tipo: "mensagem_seguinte", trecho: texto });
}
