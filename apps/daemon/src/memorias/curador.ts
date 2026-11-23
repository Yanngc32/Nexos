/**
 * Curador diário: uma vez por dia relê as conversas das últimas 24 h atrás de correção ou
 * ensinamento EXPLÍCITO do usuário que o memorista deixou passar. Só acrescenta (CRIA ou
 * COMPLEMENTA), nunca apaga nem aposenta; escreve só por `proporMemoria` com `origem: "curador"`.
 *
 * O modelo roda num turno lateral (`RodarModelo`) que não grava conversa, então o curador nunca
 * relê a si mesmo. Conversas ocultas (passos de time, hooks) ficam de fora. O último dia rodado
 * fica em `<home>/run/curador-memorias.json`: reiniciar o daemon não faz rodar duas vezes no dia.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listarMemorias } from "./nucleo.ts";
import type { EventoMemoriaSalva, RodarModelo } from "./motor.ts";
import { aplicarOperacoes } from "./memorista.ts";
import { interpretarVeredito, montarPromptCurador } from "./memorista-prompt.ts";

export const INTERVALO_CURADOR_MS = 24 * 60 * 60_000;
/** Espera depois de o daemon subir antes da primeira curadoria (não disputa a partida). */
export const ATRASO_INICIAL_CURADOR_MS = 60_000;
export const TETO_CURADOR_MS = 120_000;
/** Tamanho de um trecho de transcrito por chamada do modelo. */
export const TAMANHO_TRECHO = 60_000;
/** Teto de trechos por curadoria: um dia muito longo não vira dezenas de chamadas. */
export const MAX_TRECHOS = 8;
const MAX_MENSAGEM = 4000;

export type DepsCurador = {
  home: string;
  rodar: RodarModelo;
  modelo: () => string;
  ligado: () => boolean;
  /** Transcritos desde `desdeMs`; padrão: `<home>/threads/*.jsonl`. */
  lerTranscritos?: (desdeMs: number) => Promise<{ threadId: string; texto: string }[]>;
  aoSalvar?: (ev: EventoMemoriaSalva) => void;
  agora?: () => number;
  /** Início da janela; padrão: agora − 24 h. */
  desdeMs?: number;
};

const corta = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Lê as conversas visíveis de `<home>/threads`, só as mensagens a partir de `desdeMs`. */
export async function lerTranscritosDoHome(home: string, desdeMs: number): Promise<{ threadId: string; texto: string }[]> {
  const dir = join(home, "threads");
  let nomes: string[];
  try {
    nomes = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const saida: { threadId: string; texto: string }[] = [];
  for (const nome of nomes.sort()) {
    const arq = join(dir, nome);
    try {
      if (statSync(arq).mtimeMs < desdeMs) continue;
      const linhas: string[] = [];
      let oculta = false;
      let temUsuario = false;
      for (const bruta of readFileSync(arq, "utf8").split("\n")) {
        if (!bruta.trim()) continue;
        let ev: { type?: string; ts?: string; text?: string; oculta?: boolean; automatico?: boolean };
        try {
          ev = JSON.parse(bruta);
        } catch {
          continue; // linha quebrada não derruba a conversa inteira
        }
        if (ev.type === "thread_meta" && ev.oculta) {
          oculta = true;
          break;
        }
        if (ev.type !== "user" && ev.type !== "assistant") continue;
        const ts = Date.parse(ev.ts ?? "");
        if (!Number.isFinite(ts) || ts < desdeMs) continue;
        const texto = typeof ev.text === "string" ? ev.text.trim() : "";
        if (!texto) continue;
        if (ev.type === "user") {
          if (ev.automatico) continue; // mensagem que o próprio Nexos mandou, não o usuário
          temUsuario = true;
          linhas.push(`USUÁRIO: ${corta(texto, MAX_MENSAGEM)}`);
        } else {
          linhas.push(`AGENTE: ${corta(texto, MAX_MENSAGEM)}`);
        }
      }
      if (oculta || !temUsuario) continue;
      saida.push({ threadId: nome.slice(0, -".jsonl".length), texto: linhas.join("\n") });
    } catch {
      // arquivo sumiu ou não abriu: segue para o próximo
    }
  }
  return saida;
}

/** Junta as conversas em trechos de até `TAMANHO_TRECHO`, sem partir uma mensagem se der. */
export function fatiarTranscritos(transcritos: readonly { threadId: string; texto: string }[], tamanho = TAMANHO_TRECHO): string[] {
  const trechos: string[] = [];
  let atual = "";
  const fechar = () => {
    if (atual.trim()) trechos.push(atual.trim());
    atual = "";
  };
  for (const t of transcritos) {
    const bloco = `=== conversa ${t.threadId} ===\n${t.texto.trim()}\n\n`;
    if (atual.length + bloco.length <= tamanho) {
      atual += bloco;
      continue;
    }
    fechar();
    if (bloco.length <= tamanho) {
      atual = bloco;
      continue;
    }
    // conversa maior que um trecho: corta em linhas
    let parte = "";
    for (const linha of bloco.split("\n")) {
      const l = corta(linha, tamanho);
      if (parte.length + l.length + 1 > tamanho) {
        if (parte.trim()) trechos.push(parte.trim());
        parte = `=== conversa ${t.threadId} (cont.) ===\n`;
      }
      parte += `${l}\n`;
    }
    atual = parte;
  }
  fechar();
  return trechos;
}

/** Uma curadoria: lê, pergunta ao modelo trecho a trecho e grava. Nunca lança. */
export async function rodarCuradoria(deps: DepsCurador): Promise<{ operacoes: number }> {
  let operacoes = 0;
  try {
    if (!deps.ligado()) return { operacoes };
    const agora = (deps.agora ?? Date.now)();
    const desde = deps.desdeMs ?? agora - INTERVALO_CURADOR_MS;
    const ler = deps.lerTranscritos ?? ((d: number) => lerTranscritosDoHome(deps.home, d));
    const transcritos = (await ler(desde)).filter((t) => t.texto.trim());
    const trechos = fatiarTranscritos(transcritos).slice(0, MAX_TRECHOS);
    for (const trecho of trechos) {
      if (!deps.ligado()) break; // desligou no meio: para
      // índice relido a cada trecho: o que o trecho anterior criou já conta como existente
      const memorias = listarMemorias(deps.home);
      let resposta: string;
      try {
        resposta = await deps.rodar(montarPromptCurador({ memorias, transcrito: trecho }), {
          home: deps.home,
          modelo: deps.modelo(),
          tetoMs: TETO_CURADOR_MS,
        });
      } catch {
        continue; // trecho que falhou não derruba os outros
      }
      const ativas = new Set(memorias.map((m) => m.relPath));
      const conhecidas = listarMemorias(deps.home, { incluirAposentadas: true }).map((m) => m.relPath);
      const ops = interpretarVeredito(resposta, conhecidas).filter((op) => op.op === "create" || ativas.has(op.relPath));
      if (ops.length) operacoes += aplicarOperacoes(deps.home, ops, "curador", undefined, deps.aoSalvar);
    }
  } catch {
    // nunca lança
  }
  return { operacoes };
}

const arquivoMarco = (home: string) => join(home, "run", "curador-memorias.json");

function lerMarco(home: string): number | undefined {
  try {
    const arq = arquivoMarco(home);
    if (!existsSync(arq)) return undefined;
    const v = (JSON.parse(readFileSync(arq, "utf8")) as { ultimaEm?: unknown }).ultimaEm;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function gravarMarco(home: string, ultimaEm: number): void {
  try {
    const arq = arquivoMarco(home);
    mkdirSync(dirname(arq), { recursive: true });
    writeFileSync(arq, JSON.stringify({ ultimaEm }));
  } catch {
    // sem marco o pior caso é rodar de novo depois de reiniciar
  }
}

/**
 * Liga o relógio do curador. A primeira rodada espera `ATRASO_INICIAL_CURADOR_MS` ou o que falta
 * para completar o intervalo desde a última (o maior dos dois); depois, a cada `intervaloMs`.
 * Desligado na hora de rodar: pula e reagenda. Devolve `parar`.
 */
export function iniciarCurador(deps: DepsCurador & { intervaloMs?: number }): () => void {
  const intervalo = deps.intervaloMs ?? INTERVALO_CURADOR_MS;
  const agora = deps.agora ?? Date.now;
  let parado = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const agendar = (esperaMs: number) => {
    if (parado) return;
    timer = setTimeout(() => void rodada(), Math.max(0, esperaMs));
    (timer as { unref?: () => void }).unref?.();
  };

  const rodada = async () => {
    timer = undefined;
    if (parado) return;
    try {
      if (deps.ligado()) {
        const inicio = agora();
        const ultima = lerMarco(deps.home);
        // janela: desde a última curadoria (sem buraco nem repetição), no máximo 24 h
        const desdeMs = deps.desdeMs ?? Math.max(inicio - INTERVALO_CURADOR_MS, ultima ?? Number.NEGATIVE_INFINITY);
        await rodarCuradoria({ ...deps, desdeMs });
        gravarMarco(deps.home, inicio);
      }
    } catch {
      // nunca lança
    }
    agendar(intervalo);
  };

  const ultima = lerMarco(deps.home);
  const falta = ultima === undefined ? 0 : ultima + intervalo - agora();
  agendar(Math.max(ATRASO_INICIAL_CURADOR_MS, falta));

  return () => {
    parado = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
