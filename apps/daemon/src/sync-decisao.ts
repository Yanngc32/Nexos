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

/** Espelho de agentes/times/hooks/skills na raiz dos projetos (biblioteca.ts reexporta). */
export const PASTA_BIBLIOTECA = "_biblioteca";

/**
 * **Uma fonte só** do que o Nexos grava dentro da pasta de um projeto (`projectDir` e quem o usa:
 * memoria.ts, tarefas.ts, repo-map-indice.ts, threads.ts, planejamento.ts, design-system.ts) —
 * mais o ícone escolhido à mão (`icone-manual.<ext>`, project-logo.ts). O `meta.json` fica fora:
 * guarda o caminho do projeto NESTA máquina e não sincroniza. Um teste-guarda falha se o daemon
 * passar a gravar outra coisa ali sem entrar nesta lista.
 */
export const DADOS_DO_PROJETO: readonly string[] = [
  "memoria",
  "tarefas",
  "repo-map",
  "conversas",
  "planejamento",
  "design-system",
  "design-system.json",
];
export const PREFIXO_ICONE_MANUAL = "icone-manual.";

/** Item de 1º nível dentro da pasta de um projeto que é dado do Nexos. */
export function dadoDoProjeto(nome: string): boolean {
  return DADOS_DO_PROJETO.includes(nome) || nome.startsWith(PREFIXO_ICONE_MANUAL);
}

/**
 * Caminho relativo à raiz dos projetos (arquivo OU pasta) que o sync pode tocar: tudo da
 * `_biblioteca` e, em cada projeto, só os dados do Nexos. O mesmo filtro vale na varredura local,
 * na remota, no estado base e na cópia da pasta manual — filtrar só um lado faria o sync achar que
 * o arquivo foi apagado do outro.
 *
 * Por quê: pasta de projeto que coincidia com o próprio repo (`projetosDir` apontando pra pasta dos
 * repos) subia o repo inteiro, `node_modules` junto, e a rodada nunca terminava. Fora da lista o
 * sync só IGNORA: nunca apaga, nem local nem remoto.
 */
export function sincronizavel(rel: string): boolean {
  const [topo, item] = rel.split("/");
  if (!topo || item === undefined) return false;
  return topo === PASTA_BIBLIOTECA || dadoDoProjeto(item);
}

/** Contagem do que ficou de fora, por pasta, pro log do fim da varredura. */
export class Ignorados {
  total = 0;
  private porPasta = new Map<string, number>();
  anotar(rel: string, n = 1): void {
    this.total += n;
    const pasta = rel.split("/").slice(0, 2).join("/");
    this.porPasta.set(pasta, (this.porPasta.get(pasta) ?? 0) + n);
  }
  maiores(n = 3): { pasta: string; itens: number }[] {
    return [...this.porPasta.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([pasta, itens]) => ({ pasta, itens }));
  }
}
