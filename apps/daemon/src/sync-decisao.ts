/**
 * Decisão de sync em 3 vias (base da última rodada, lado A, lado B), por MD5. Mora aqui, fora de
 * drive-sync.ts, porque a biblioteca (biblioteca.ts) usa a mesma regra e é chamada pelo drive-sync —
 * juntas no mesmo arquivo virariam import circular.
 */

export type Acao =
  | "nada"
  | "subir"
  | "baixar"
  | "apagar-local"
  | "apagar-remoto"
  | "mesclar";

/**
 * Decisão pura de um arquivo. `base`/`local`/`remoto` são MD5 (undefined = não existe).
 * `mtimeLocal`/`mtimeRemoto` só desempatam conflito de arquivo que não é conversa.
 */
export function decidir(
  base: string | undefined,
  local: string | undefined,
  remoto: string | undefined,
  opts: { jsonl: boolean; mtimeLocal: number; mtimeRemoto: number },
): Acao {
  if (local === remoto) return "nada";
  if (base === undefined) {
    // nunca sincronizado: só um lado tem, ou os dois têm coisas diferentes
    if (local === undefined) return "baixar";
    if (remoto === undefined) return "subir";
    return opts.jsonl ? "mesclar" : opts.mtimeLocal >= opts.mtimeRemoto ? "subir" : "baixar";
  }
  const localMudou = local !== base;
  const remotoMudou = remoto !== base;
  if (!localMudou) return remoto === undefined ? "apagar-local" : "baixar";
  if (!remotoMudou) return local === undefined ? "apagar-remoto" : "subir";
  // os dois mudaram (e são diferentes entre si)
  if (local === undefined) return "baixar"; // apagou aqui, editou lá: a edição ganha da exclusão
  if (remoto === undefined) return "subir";
  return opts.jsonl ? "mesclar" : opts.mtimeLocal >= opts.mtimeRemoto ? "subir" : "baixar";
}
