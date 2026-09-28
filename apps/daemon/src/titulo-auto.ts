/**
 * Nome automático da conversa, dado depois da 1ª resposta (ver `talvezTitular` em session.ts).
 * Antes disto o nome era os primeiros 72 caracteres do 1º pedido — "oi tudo bem", um log colado
 * ou um caminho de arquivo viravam o nome da conversa. Aqui fica só o que é puro: a regra sem IA
 * (reserva quando a IA falha ou a conta não é claude) e o pedido/limpeza da resposta da IA.
 */

/** Teto do nome automático (o manual vai até `TITULO_MAX`, threads.ts). */
export const TITULO_AUTO_MAX = 60;

const SAUDACAO =
  /^(?:oi+|ol[aá]|opa|e a[ií]|eai|fala|salve|bom dia|boa tarde|boa noite|hey|hello|hi|tudo bem|td bem|tudo certo|beleza|blz)\b[\s,!.?:;~-]*/i;

/** Linha que é colagem (log, stack, caminho, JSON, código) e não fala da pessoa. */
const LINHA_COLADA = /^\s*(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|at\s|[A-Za-z]:[\\/]|\/[\w.-]+\/|[{[<]|\$\s|>\s|#{1,6}\s*$|[-=*_]{3,})/;

/** Corta no fim de palavra, sem deixar pontuação pendurada. */
function cortar(texto: string, max: number): string {
  let t = texto.trim();
  if (t.length > max) {
    t = t.slice(0, max);
    const espaco = t.lastIndexOf(" ");
    if (espaco > max * 0.5) t = t.slice(0, espaco);
  }
  return t.replace(/[\s,;:.!?…—–-]+$/u, "").trim();
}

function maiuscula(t: string): string {
  return t ? t[0]!.toLocaleUpperCase("pt-BR") + t.slice(1) : t;
}

/**
 * Nome tirado do pedido, sem IA: sem bloco de código, link, @menção, linha colada e saudação;
 * fica a 1ª frase. Devolve "" quando não sobra nada que sirva (a lista mostra o preview de sempre).
 */
export function tituloPorRegra(pedido: string): string {
  const semCodigo = pedido
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@[\w.-]+/g, "$1");
  const linhas = semCodigo
    .split(/\r?\n/)
    .filter((l) => !LINHA_COLADA.test(l))
    .map((l) => l.trim())
    .filter((l) => /\p{L}{2,}/u.test(l));
  let texto = linhas.join(" ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const sem = texto.replace(SAUDACAO, "");
    if (sem === texto) break;
    texto = sem;
  }
  const frase = texto.split(/(?<=[.!?])\s+/)[0] ?? "";
  const nome = maiuscula(cortar(frase, TITULO_AUTO_MAX));
  // curto demais ("De a") é pior que o preview de sempre: aí não dá nome nenhum
  return nome.length >= 8 ? nome : "";
}

/** Pedido pro modelo barato: só o título, nada mais. */
export function pedidoDeTitulo(pedido: string, resposta: string): string {
  const trecho = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 1500);
  return [
    "Dê um título curto para esta conversa: de 3 a 6 palavras, em português, dizendo o assunto",
    "(ignore saudações). Responda SÓ o título, sem aspas, sem ponto final, sem explicação.",
    "",
    "Pedido da pessoa:",
    trecho(pedido),
    "",
    "Começo da resposta:",
    trecho(resposta),
  ].join("\n");
}

/** Limpa a resposta do modelo; "" se ela não parece um título (aí vale a regra). */
export function limparTitulo(bruto: string): string {
  const linha = bruto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!linha) return "";
  const t = linha
    .replace(/^(?:t[ií]tulo|title)\s*:\s*/i, "")
    .replace(/^[#>*_\s]+|[*_\s]+$/g, "")
    .replace(/^["'“”‘’«]+|["'“”‘’»]+$/g, "");
  const nome = maiuscula(cortar(t, TITULO_AUTO_MAX));
  const palavras = nome.split(/\s+/).filter(Boolean).length;
  return nome.length >= 3 && palavras <= 10 ? nome : "";
}
