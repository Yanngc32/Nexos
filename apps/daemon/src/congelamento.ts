import { log } from "./log.ts";

/** Folga acima do intervalo que já conta como congelamento. */
export const CONGELOU_MS = 2000;
const TICK_MS = 500;
/** Rota que passa disto vira linha no log, com ou sem congelamento (pista do que é lento). */
export const ROTA_LENTA_MS = 2000;
const GUARDADAS = 80;

/**
 * Atividades recentes (rotas HTTP e rotinas periódicas): quando o motor congela, o aviso diz
 * quem estava rodando naquela janela. Código síncrono que segura o event loop (fs no Google
 * Drive, `execFileSync`) termina junto com o congelamento e sobrepõe a janela inteira — é o
 * suspeito número um da linha.
 */
type Atividade = { rotulo: string; inicio: number; fim?: number };
const abertas = new Set<Atividade>();
const recentes: Atividade[] = [];
let relogio: () => number = () => performance.now();

/** Marca o começo de uma atividade; a função devolvida fecha e diz quanto durou (ms). */
export function comecarAtividade(rotulo: string): () => number {
  const a: Atividade = { rotulo, inicio: relogio() };
  abertas.add(a);
  return () => {
    if (a.fim !== undefined) return a.fim - a.inicio;
    a.fim = relogio();
    abertas.delete(a);
    recentes.push(a);
    if (recentes.length > GUARDADAS) recentes.shift();
    return a.fim - a.inicio;
  };
}

/** Roda `f` como atividade (só a parte síncrona conta, que é a que trava o motor). */
export function medirAtividade<T>(rotulo: string, f: () => T): T {
  const fim = comecarAtividade(rotulo);
  try {
    return f();
  } finally {
    fim();
  }
}

/** Quem estava rodando entre `de` e `ate`, de quem mais cobriu a janela pra quem menos. */
export function suspeitosDoCongelamento(de: number, ate: number, max = 3): { rotulo: string; ms: number; aberta: boolean }[] {
  const todas = [...recentes, ...abertas];
  return todas
    .filter((a) => a.inicio <= de && (a.fim ?? ate) >= de)
    .map((a) => ({ rotulo: a.rotulo, ms: Math.round((a.fim ?? ate) - a.inicio), aberta: a.fim === undefined, cobre: Math.min(a.fim ?? ate, ate) - de }))
    .sort((x, y) => y.cobre - x.cobre)
    .slice(0, max)
    .map(({ rotulo, ms, aberta }) => ({ rotulo, ms, aberta }));
}

/** Só pra teste. */
export function resetAtividadesForTest(agora?: () => number): void {
  abertas.clear();
  recentes.length = 0;
  relogio = agora ?? (() => performance.now());
}

/**
 * Mede o atraso REAL do event loop: um timer de 500 ms que chega 2 s atrasado quer dizer que o
 * motor ficou esse tempo sem atender ninguém (nem o `/health`). Uma linha por evento, com a
 * duração e as atividades que cobriam a janela (`suspeitos`).
 *
 * Timer simples e não `monitorEventLoopDelay`: aquele só dá estatística agregada (média,
 * percentis), não o MOMENTO em que travou, que é o que ajuda a achar a causa.
 */
export function vigiarCongelamento(opts: { tickMs?: number; limiteMs?: number; agora?: () => number } = {}): () => void {
  const tick = opts.tickMs ?? TICK_MS;
  const limite = opts.limiteMs ?? CONGELOU_MS;
  const agora = opts.agora ?? (() => performance.now());
  let esperado = agora() + tick;
  const timer = setInterval(() => {
    const t = agora();
    const atraso = t - esperado;
    if (atraso > limite) {
      const segundos = Math.round((atraso + tick) / 100) / 10;
      const suspeitos = suspeitosDoCongelamento(esperado, t).map((s) => `${s.rotulo} (${Math.round(s.ms / 100) / 10} s${s.aberta ? ", ainda rodando" : ""})`);
      log.aviso("congelamento", `motor ficou ${segundos} s sem responder`, {
        ms: Math.round(atraso + tick),
        suspeitos: suspeitos.length ? suspeitos : ["nenhuma rota ou rotina medida"],
      });
    }
    esperado = t + tick;
  }, tick);
  timer.unref();
  return () => clearInterval(timer);
}
