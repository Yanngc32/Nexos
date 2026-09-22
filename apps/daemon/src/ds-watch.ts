import { watch, type FSWatcher } from "node:fs";

/**
 * Observa a pasta do design system ativo e avisa quem assina (o SSE do Canvas) quando um
 * arquivo muda — venha a mudança do agente (Write/Edit/shell), do próprio Canvas ou de um editor.
 *
 * Um `fs.watch` por PASTA, com contagem de assinantes: abre no primeiro Canvas conectado e fecha
 * quando o último sai, pra não deixar watcher vivo sem ninguém olhando. Debounce por arquivo
 * porque editor e `rename` atômico disparam vários eventos pra uma gravação só.
 */

export type DsMudanca = { type: "changed"; arquivo: string };
type Ouvinte = (ev: DsMudanca) => void;

const DEBOUNCE_MS = 150;

type Entrada = { watcher: FSWatcher; ouvintes: Set<Ouvinte>; timers: Map<string, NodeJS.Timeout> };

const porPasta = new Map<string, Entrada>();

/** Temporário da gravação atômica (`design-system.ts`) e lixo de editor: não é mudança de conteúdo. */
function ignorar(arquivo: string): boolean {
  return /\.tmp$|~$|\.swp$|(^|\/)\.#/.test(arquivo);
}

export function assinarDs(pasta: string, ouvinte: Ouvinte): () => void {
  let e = porPasta.get(pasta);
  if (!e) {
    const timers = new Map<string, NodeJS.Timeout>();
    const ouvintes = new Set<Ouvinte>();
    const watcher = watch(pasta, { recursive: true }, (_tipo, nome) => {
      const arquivo = String(nome ?? "").split("\\").join("/");
      if (!arquivo || ignorar(arquivo)) return;
      clearTimeout(timers.get(arquivo));
      timers.set(
        arquivo,
        setTimeout(() => {
          timers.delete(arquivo);
          for (const o of ouvintes) o({ type: "changed", arquivo });
        }, DEBOUNCE_MS),
      );
    });
    // pasta apagada/renomeada com o Canvas aberto: o watcher morre, e o erro não pode derrubar o daemon
    watcher.on("error", () => fechar(pasta));
    e = { watcher, ouvintes, timers };
    porPasta.set(pasta, e);
  }
  e.ouvintes.add(ouvinte);
  return () => {
    const atual = porPasta.get(pasta);
    if (!atual) return;
    atual.ouvintes.delete(ouvinte);
    if (atual.ouvintes.size === 0) fechar(pasta);
  };
}

function fechar(pasta: string): void {
  const e = porPasta.get(pasta);
  if (!e) return;
  porPasta.delete(pasta);
  for (const t of e.timers.values()) clearTimeout(t);
  try {
    e.watcher.close();
  } catch {
    /* já fechado */
  }
}

/** Só pra teste. */
export function pastasObservadas(): string[] {
  return [...porPasta.keys()];
}
