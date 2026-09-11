import type { PackConfig, ThreadEvent } from "@nexo/shared";

export type PackResult = {
  text: string;
  trimmed?: { keptMessages: number; droppedMessages: number };
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function render(event: ThreadEvent): string | undefined {
  switch (event.type) {
    case "thread_meta":
    case "context_trimmed":
    case "cleared":
    case "compacted":
    case "usage":
      return undefined;
    case "user":
      // O caminho da imagem entra no pack: nos turnos seguintes o motor ainda sabe abrir.
      return event.attachments?.length
        ? [`User: ${event.text}`, ...event.attachments.map((a) => `[imagem anexada: ${a.path}]`)].join("\n")
        : `User: ${event.text}`;
    case "assistant":
      return `Assistant: ${event.text}`;
    case "tool":
      return `Agente executou ${event.name}: ${event.summary}`;
    case "switched":
      return `System: switched ${event.fromProfileId} -> ${event.toProfileId} (${event.reason})`;
    case "error":
      return `System: error ${event.message}`;
  }
}

function isKeepable(event: ThreadEvent): boolean {
  return event.type === "user" || event.type === "assistant";
}

/**
 * Teto do pack quando a janela do motor é desconhecida. Era o teto ÚNICO até
 * aqui, então manter esse valor é o que garante que nada regride: motor sem
 * janela conhecida continua se comportando exatamente como antes.
 */
export const TOKEN_CAP_PISO = 8000;

/**
 * Metade da janela vai pro histórico. A outra metade não é folga: ela paga o
 * system prompt, as instruções do agente, a definição das ferramentas, o
 * resultado de cada ida e volta de ferramenta DENTRO do turno, e a resposta.
 * Mandar histórico até encostar na janela faria o turno estourar no meio.
 */
const FRACAO = 0.5;

/**
 * Teto do teto. O pack vai inteiro em TODO turno, então uma janela de 1M sem
 * limite mandaria 500 mil tokens por mensagem — dólares por turno numa
 * conversa que ninguém pediu que fosse caro. 128k já é uma conversa longuíssima;
 * o que passa disso vale menos que o que custa.
 */
const TETO = 128_000;

/**
 * Quanto de histórico cabe, dada a janela do motor.
 *
 * Existe porque o teto era 8000 pra toda conta: uma janela de 1M recebia o
 * mesmo corte de uma de 8k, e conversa longa "esquecia" coisa que caberia
 * folgado. O `estimateTokens` acima é aproximado (4 chars por token), e a
 * fração também absorve esse erro.
 */
export function tetoDeToken(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return TOKEN_CAP_PISO;
  const alvo = Math.floor(contextWindow * FRACAO);
  return Math.min(TETO, Math.max(TOKEN_CAP_PISO, alvo));
}

/**
 * Onde o histórico que vai pro motor começa, e o que vem escrito antes dele.
 *
 * Dois eventos cortam o passado, e o MAIS RECENTE ganha:
 *
 * - `cleared` ("/clear") joga o passado fora sem substituto.
 * - `compacted` põe um resumo no lugar dele.
 *
 * O `compacted` guarda um índice no arquivo (`cobertos`) em vez de vir gravado
 * no meio do JSONL, porque JSONL é append-only: não há como inserir. O índice é
 * estável pra sempre justamente por isso — o arquivo só cresce no fim.
 */
export function escopo(events: ThreadEvent[]): { eventos: ThreadEvent[]; resumo: string } {
  let corte = -1;
  let resumo = "";
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (e.type === "cleared") {
      corte = i + 1;
      resumo = "";
    } else if (e.type === "compacted") {
      // o resumo cobre do começo do ARQUIVO até `cobertos`; o que vier depois
      // dele (inclusive o que chegou enquanto o resumo era feito) fica verbatim
      corte = Math.max(corte, e.cobertos);
      resumo = e.text;
    }
  }
  const eventos = corte === -1 ? events : events.slice(corte);
  return { eventos: eventos.filter((e) => e.type !== "compacted"), resumo };
}

/** Cabeçalho do resumo. Rotulado, pra o motor não confundir com fala de alguém. */
export const CABECALHO = "Resumo do que veio antes nesta conversa:";

/**
 * A partir de quanto do teto vale resumir.
 *
 * Não em 100%: compactar leva um turno inteiro, e nesse tempo o turno seguinte
 * já teria sido cortado em silêncio. 80% dá a folga pra o resumo chegar antes
 * de a perda acontecer.
 */
const LIMIAR = 0.8;

/** Tokens que o histórico ocuparia — o mesmo cálculo que o `pack` usa. */
export function tokensDoHistorico(events: ThreadEvent[]): number {
  const { eventos, resumo } = escopo(events);
  const corpo = eventos
    .map(render)
    .filter((t): t is string => t !== undefined)
    .join("\n");
  return estimateTokens(resumo ? `${CABECALHO} ${resumo}\n${corpo}` : corpo);
}

/**
 * Vale resumir agora?
 *
 * O gatilho usa o MAIOR entre duas medidas: a estimativa (chars/4 sobre o que
 * o `pack` renderiza) e o `contextTokens` REAL do último turno (do evento
 * `usage`, tokenizado de verdade pelo motor). Por quê as duas: a estimativa
 * ignora system prompt, definição de ferramenta e o próprio corpo de resposta
 * do turno — só conta o texto de user/assistant/resumo de ferramenta. Numa
 * conta com muitas ferramentas MCP isso já fica muito abaixo do que o motor
 * realmente usa (visto na prática: ~40k estimado contra 230k reais no mesmo
 * turno), e o gatilho nunca disparava mesmo com a janela real estourada. O
 * real vira `0` só antes do primeiro turno (nenhum `usage` ainda) — aí a
 * estimativa é o único sinal que existe, e continua servindo.
 *
 * Além do limiar, exige que haja o que resumir: se quase tudo é recente e
 * ficaria verbatim de qualquer jeito, o resumo custaria um turno pra não
 * economizar nada.
 */
export function precisaCompactar(
  events: ThreadEvent[],
  packCfg: PackConfig,
  tokenCap: number,
  contextTokensReal = 0,
): boolean {
  const ocupado = Math.max(tokensDoHistorico(events), contextTokensReal);
  if (ocupado < tokenCap * LIMIAR) return false;
  return aResumir(events, packCfg, tokenCap).length > 0;
}

/**
 * Quais eventos entram no resumo.
 *
 * Duas fronteiras, e as duas importam:
 *
 * 1. **as últimas mensagens ficam de fora** e seguem verbatim, porque recência
 *    é o que mais importa pro turno seguinte;
 * 2. **o pedaço é LIMITADO por `tetoTokens`**, tomado dos mais ANTIGOS pra
 *    frente. Sem isso o resumo receberia o histórico inteiro do disco, que não
 *    tem teto nenhum: uma conversa de meses tem megabytes de JSONL, e mandar
 *    isso num turno estoura a janela do modelo e o turno falha inteiro.
 *
 * Quando não cabe tudo, sobra pra próxima: cada compactação come o pedaço mais
 * antigo que couber, e o resumo anterior entra na entrada da seguinte pra que o
 * resultado continue sendo UM resumo, e não uma pilha deles.
 */
export function aResumir(events: ThreadEvent[], packCfg: PackConfig, tetoTokens: number): ThreadEvent[] {
  const { eventos } = escopo(events);
  const idx = eventos.map((e, i) => ({ e, i })).filter(({ e }) => isKeepable(e));
  if (idx.length <= packCfg.keepLastMessages) return [];
  const corte = idx[idx.length - packCfg.keepLastMessages]?.i ?? 0;
  const candidatos = eventos.slice(0, corte);

  const cabe: ThreadEvent[] = [];
  let soma = 0;
  for (const e of candidatos) {
    const t = render(e);
    if (t === undefined) {
      cabe.push(e);
      continue;
    }
    const custo = estimateTokens(t);
    if (soma + custo > tetoTokens && cabe.length) break;
    soma += custo;
    cabe.push(e);
  }
  return cabe;
}

/**
 * Quantos eventos do ARQUIVO um resumo desses cobriria.
 *
 * É índice absoluto porque é o que o `compacted` grava, e o escopo pode já
 * começar depois de um `/clear` ou de um resumo anterior.
 */
export function cobertosPor(events: ThreadEvent[], packCfg: PackConfig, tetoTokens: number): number {
  const resumiveis = aResumir(events, packCfg, tetoTokens);
  const ultimo = resumiveis[resumiveis.length - 1];
  if (!ultimo) return 0;
  return events.lastIndexOf(ultimo) + 1;
}

export function pack(events: ThreadEvent[], packCfg: PackConfig, tokenCap: number): PackResult {
  const { eventos: scoped, resumo } = escopo(events);

  const lines: { event: ThreadEvent; text: string; keepable: boolean }[] = [];
  for (const event of scoped) {
    const text = render(event);
    if (text === undefined) continue;
    lines.push({ event, text, keepable: isKeepable(event) });
  }

  const cabeca = resumo ? `${CABECALHO} ${resumo}` : "";
  const corpo = lines.map((l) => l.text).join("\n");
  const full = cabeca ? `${cabeca}\n${corpo}`.trim() : corpo;
  if (estimateTokens(full) <= tokenCap) return { text: full };

  const keepable = lines.filter((l) => l.keepable);
  const kept = keepable.slice(-packCfg.keepLastMessages);
  const dropped = keepable.slice(0, Math.max(0, keepable.length - kept.length));
  const prefixRaw = dropped.map((l) => l.text).join(" ");
  const prefix = prefixRaw.slice(0, packCfg.prefixCharBudget);
  const suffix = kept.map((l) => l.text).join("\n");
  /*
   * O corte continua existindo como ÚLTIMO recurso: resumo pronto que ainda não
   * cabe, compactação desligada, ou motor que falhou em resumir. O resumo vai
   * na frente do corte — se ele existe, é a parte mais valiosa do que sobrou.
   */
  const text = [cabeca, `Contexto anterior (cortado):${prefix ? ` ${prefix}` : ""}`, suffix]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    text,
    trimmed: {
      keptMessages: kept.length,
      droppedMessages: dropped.length,
    },
  };
}
