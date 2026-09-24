import { log } from "./log.ts";

/** Folga acima do intervalo que já conta como congelamento. */
export const CONGELOU_MS = 2000;
const TICK_MS = 500;

/**
 * Mede o atraso REAL do event loop: um timer de 500 ms que chega 2 s atrasado quer dizer que o
 * motor ficou esse tempo sem atender ninguém (nem o `/health`). Uma linha por evento, com a
 * duração — cruzada com as linhas vizinhas no log, aponta o culpado.
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
      log.aviso("congelamento", `motor ficou ${segundos} s sem responder`, { ms: Math.round(atraso + tick) });
    }
    esperado = t + tick;
  }, tick);
  timer.unref();
  return () => clearInterval(timer);
}
