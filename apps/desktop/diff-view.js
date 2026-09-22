/**
 * Diff das edições que o agente faz, pra conversa mostrar O QUE mudou no
 * arquivo em vez do JSON cru dos argumentos.
 *
 * Sem biblioteca: um diff de linhas por LCS cabe em algumas dezenas de linhas,
 * e o projeto já escreve o próprio parser de markdown pelo mesmo motivo —
 * dependência nova custa mais que o código que ela substitui aqui.
 *
 * O HTML sai por DOM (`createElement`/`textContent`), nunca por `innerHTML`:
 * o conteúdo é código de arquivo, vindo de um modelo, e é exatamente o tipo de
 * texto que carrega `<script>` sem querer. `textContent` fecha isso por
 * construção, em vez de depender de eu lembrar de escapar em cada ponto.
 */

/** Acima disto o LCS (quadrático) trava a tela; edição grande vira bloco inteiro. */
const MAX_LINHAS = 600;

/** Linhas iguais mostradas em volta de cada mudança, como no `git diff`. */
const CONTEXTO = 3;

/**
 * O daemon corta string de argumento em 2000 chars ao gravar no JSONL
 * (`capInputPraPersistir`, session.ts) e marca o corte com "…" — então o
 * resultado tem exatamente 2001 chars. Ao vivo chega inteiro; reabrindo uma
 * conversa antiga, não. Detectar importa porque um diff feito de texto cortado
 * inventa uma remoção no fim que nunca aconteceu, e isso é pior que não
 * mostrar diff nenhum: parece que o agente apagou código.
 */
export function foiCortado(s) {
  return typeof s === "string" && s.length === 2001 && s.endsWith("…");
}

function linhasDe(s) {
  if (!s) return [];
  return String(s).replace(/\r\n/g, "\n").split("\n");
}

/**
 * Diff de linhas por LCS. Devolve `[{tipo: " "|"-"|"+", texto}]` na ordem de
 * leitura, que é a forma que a renderização e os testes precisam.
 */
export function diffLinhas(velho, novo) {
  const a = linhasDe(velho);
  const b = linhasDe(novo);

  if (a.length > MAX_LINHAS || b.length > MAX_LINHAS) {
    return [...a.map((texto) => ({ tipo: "-", texto })), ...b.map((texto) => ({ tipo: "+", texto }))];
  }

  const n = a.length;
  const m = b.length;
  const larg = m + 1;
  const tab = new Uint32Array((n + 1) * larg);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      tab[i * larg + j] =
        a[i] === b[j] ? tab[(i + 1) * larg + j + 1] + 1 : Math.max(tab[(i + 1) * larg + j], tab[i * larg + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tipo: " ", texto: a[i] });
      i++;
      j++;
    } else if (tab[(i + 1) * larg + j] >= tab[i * larg + j + 1]) {
      out.push({ tipo: "-", texto: a[i] });
      i++;
    } else {
      out.push({ tipo: "+", texto: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ tipo: "-", texto: a[i++] });
  while (j < m) out.push({ tipo: "+", texto: b[j++] });
  return out;
}

/**
 * Some com os trechos longos sem mudança, deixando `CONTEXTO` linhas de cada
 * lado. Sem isto, um Edit no meio de um bloco grande vira uma parede de linhas
 * cinzas onde ninguém acha as duas que mudaram.
 */
export function colapsarContexto(linhas, contexto = CONTEXTO) {
  const manter = new Array(linhas.length).fill(false);
  linhas.forEach((l, i) => {
    if (l.tipo === " ") return;
    for (let k = Math.max(0, i - contexto); k <= Math.min(linhas.length - 1, i + contexto); k++) manter[k] = true;
  });
  // diff sem mudança nenhuma (Edit que não mexeu em linha): mostra como está
  if (!manter.some(Boolean)) return linhas;

  const out = [];
  let pulando = 0;
  for (let i = 0; i < linhas.length; i++) {
    if (manter[i]) {
      if (pulando) {
        out.push({ tipo: "…", texto: `${pulando} linha${pulando > 1 ? "s" : ""} sem mudança` });
        pulando = 0;
      }
      out.push(linhas[i]);
    } else {
      pulando++;
    }
  }
  if (pulando) out.push({ tipo: "…", texto: `${pulando} linha${pulando > 1 ? "s" : ""} sem mudança` });
  return out;
}

function bloco(velho, novo) {
  const linhas = colapsarContexto(diffLinhas(velho, novo));
  return {
    linhas,
    cortado: foiCortado(velho) || foiCortado(novo),
  };
}

/**
 * Traduz os argumentos de uma ferramenta de edição num diff pronto pra pintar,
 * ou `null` quando a ferramenta não edita arquivo (Bash, Read, Grep…).
 *
 * `Write` é o caso honesto-porém-parcial: ele não manda o conteúdo anterior, e
 * o daemon não guarda o arquivo em lugar nenhum, então não há de onde tirar o
 * "antes". Sai tudo como adição — que é a verdade quando o arquivo é novo, e
 * uma meia-verdade quando ele já existia. `arquivoNovo` marca essa diferença
 * pra tela poder dizer o que está mostrando.
 */
export function diffDeFerramenta(name, input) {
  if (!input || typeof input !== "object") return null;
  const arquivo = typeof input.file_path === "string" ? input.file_path : "";

  let blocos = null;
  if (name === "Edit" && typeof input.new_string === "string") {
    blocos = [bloco(input.old_string ?? "", input.new_string)];
  } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
    blocos = input.edits
      .filter((e) => e && typeof e === "object")
      .map((e) => bloco(e.old_string ?? "", e.new_string ?? ""));
  } else if (name === "Write" && typeof input.content === "string") {
    blocos = [bloco("", input.content)];
  }
  if (!blocos || !blocos.length) return null;

  let adicionadas = 0;
  let removidas = 0;
  for (const b of blocos) {
    for (const l of b.linhas) {
      if (l.tipo === "+") adicionadas++;
      if (l.tipo === "-") removidas++;
    }
  }
  return {
    arquivo,
    blocos,
    adicionadas,
    removidas,
    cortado: blocos.some((b) => b.cortado),
    arquivoNovo: name === "Write",
  };
}

/** "+12 −3" pra linha colapsada da ferramenta. Menos de uma mudança não vira rótulo. */
export function resumoDoDiff(diff) {
  if (!diff) return "";
  const partes = [];
  if (diff.adicionadas) partes.push(`+${diff.adicionadas}`);
  if (diff.removidas) partes.push(`−${diff.removidas}`);
  return partes.join(" ");
}

/** Só o nome do arquivo (sem pasta) — o chip da ferramenta mostra isto, não o caminho inteiro. */
export function nomeArquivo(caminho) {
  if (!caminho) return "";
  const partes = String(caminho).split(/[/\\]/);
  return partes[partes.length - 1] || caminho;
}

function linhaEl(l) {
  const div = document.createElement("div");
  if (l.tipo === "…") {
    div.className = "diff-linha diff-pulo";
    div.textContent = `⋯ ${l.texto}`;
    return div;
  }
  div.className = `diff-linha${l.tipo === "+" ? " diff-add" : l.tipo === "-" ? " diff-del" : ""}`;
  const sinal = document.createElement("span");
  sinal.className = "diff-sinal";
  sinal.textContent = l.tipo === " " ? " " : l.tipo;
  const texto = document.createElement("span");
  texto.className = "diff-texto";
  // textContent, nunca innerHTML: isto é código vindo do modelo
  texto.textContent = l.texto;
  div.append(sinal, texto);
  return div;
}

/** Pinta o diff dentro de `el` (que é esvaziado antes). */
export function renderDiff(el, diff) {
  el.replaceChildren();
  if (!diff) return;

  if (diff.arquivoNovo) {
    const nota = document.createElement("p");
    nota.className = "diff-nota";
    nota.textContent = "Arquivo escrito inteiro — o conteúdo anterior, se havia, não vem na ferramenta.";
    el.append(nota);
  }
  if (diff.cortado) {
    const nota = document.createElement("p");
    nota.className = "diff-nota diff-nota-aviso";
    nota.textContent = "Edição longa: o histórico guarda só o começo, então este diff está incompleto.";
    el.append(nota);
  }

  diff.blocos.forEach((b, i) => {
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "diff-sep";
      sep.textContent = `edição ${i + 1}`;
      el.append(sep);
    }
    const pre = document.createElement("div");
    pre.className = "diff";
    for (const l of b.linhas) pre.append(linhaEl(l));
    el.append(pre);
  });
}
