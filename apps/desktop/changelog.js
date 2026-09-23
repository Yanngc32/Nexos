/**
 * Seção `## [versão]` do CHANGELOG.md (Keep a Changelog), pronta pro `renderMd`:
 * o markdown do app não junta linha de continuação num item de lista, então item
 * quebrado em várias linhas vira uma linha só; subseção sem item (`### Segurança`
 * vazia) sai. Sem a versão no arquivo, devolve "".
 */
export function secaoDaVersao(md, versao) {
  const linhas = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const alvo = `## [${versao}]`;
  const ini = linhas.findIndex((l) => l.startsWith(alvo));
  if (ini === -1) return "";
  let fim = linhas.findIndex((l, i) => i > ini && /^## /.test(l));
  if (fim === -1) fim = linhas.length;

  const juntas = [];
  for (const l of linhas.slice(ini + 1, fim)) {
    const continua = /^\s+\S/.test(l) && !/^\s*([-*+]|\d+[.)])\s/.test(l);
    if (continua && juntas.length && juntas.at(-1).trim()) juntas[juntas.length - 1] += ` ${l.trim()}`;
    else juntas.push(l);
  }

  const out = [];
  for (let i = 0; i < juntas.length; i++) {
    if (/^### /.test(juntas[i])) {
      let j = i + 1;
      while (j < juntas.length && !juntas[j].trim()) j++;
      if (j >= juntas.length || /^### /.test(juntas[j])) continue;
    }
    out.push(juntas[i]);
  }
  return out.join("\n").trim();
}
