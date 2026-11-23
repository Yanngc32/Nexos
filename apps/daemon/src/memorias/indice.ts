/**
 * MEMORY.md: o índice gerado a partir das memórias ativas.
 *
 *   <!-- aviso -->
 *
 *   - [titulo](relPath) — gancho          (memórias da raiz)
 *
 *   ## <pasta ou título da seção>
 *
 *   - [titulo](pasta/arquivo.md) — gancho
 *
 * O título de seção escrito à mão (`## Infra do servidor` sobre a pasta
 * `infra`) é preservado: o diário guarda em `secoes` e a renderização reusa.
 */

export const AVISO_INDICE = "<!-- Índice gerado pelo Nexos a partir das memórias. Edite as memórias, não este arquivo. -->";

export interface ItemIndice {
  relPath: string;
  titulo: string;
  gancho: string;
}

const pastaDoItem = (relPath: string): string => {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
};

const linha = (v: string): string => String(v ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

function marcador(item: ItemIndice): string {
  return `- [${linha(item.titulo)}](${item.relPath}) — ${linha(item.gancho)}`;
}

/** Conteúdo do MEMORY.md, ordenado por relPath. */
export function renderizarIndice(itens: readonly ItemIndice[], secoes: Readonly<Record<string, string>> = {}): string {
  const ordenados = [...itens].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const raiz: string[] = [];
  const porPasta = new Map<string, string[]>();
  for (const item of ordenados) {
    const pasta = pastaDoItem(item.relPath);
    if (!pasta) raiz.push(marcador(item));
    else porPasta.set(pasta, [...(porPasta.get(pasta) ?? []), marcador(item)]);
  }
  const blocos = [AVISO_INDICE];
  if (raiz.length) blocos.push(raiz.join("\n"));
  for (const pasta of [...porPasta.keys()].sort((a, b) => a.localeCompare(b))) {
    const titulo = linha(secoes[pasta] ?? "") || pasta;
    blocos.push(`## ${titulo}\n\n${porPasta.get(pasta)!.join("\n")}`);
  }
  return blocos.join("\n\n") + "\n";
}

/**
 * Títulos de seção de um MEMORY.md existente: pasta → título. Cada `## título`
 * pertence à pasta do primeiro item logo abaixo dele. Inclui o caso em que o
 * título é o próprio nome da pasta, para quem chama saber que a seção voltou ao
 * padrão.
 */
export function lerSecoesIndice(texto: string): Map<string, string> {
  const secoes = new Map<string, string>();
  let pendente: string | undefined;
  for (const bruta of String(texto ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const l = bruta.trim();
    const titulo = /^##\s+(.+?)\s*$/.exec(l);
    if (titulo) {
      pendente = titulo[1];
      continue;
    }
    const item = /^- \[(.+?)\]\(([^)]+\.md)\) — (.*)$/i.exec(l);
    if (!item || pendente === undefined) continue;
    const pasta = pastaDoItem(item[2]!.trim());
    if (pasta && !secoes.has(pasta)) secoes.set(pasta, pendente);
    pendente = undefined;
  }
  return secoes;
}
