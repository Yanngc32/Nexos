/**
 * Detecção heurística de segredos no texto de uma memória.
 *
 * Existe para tirar a credencial ÓBVIA do Markdown e do índice, não para ser um
 * detector completo: senha curta sem formato reconhecível passa, e um
 * identificador aleatório pode casar. Resultado limpo quer dizer "nada óbvio",
 * nunca "não há segredo". Regras e filtros iguais aos do Agent Code.
 */

/** O que substitui o valor no Markdown: `{{secret:<nome>}}`. */
export const PREFIXO_SEGREDO = "{{secret:";
export const SUFIXO_SEGREDO = "}}";
/** Nomes também são chaves do cofre: mesmo alfabeto que o cofre aceita. */
export const NOME_SEGREDO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function marcadorSegredo(nome: string): string {
  return `${PREFIXO_SEGREDO}${nome}${SUFIXO_SEGREDO}`;
}

export function nomeSegredoValido(valor: unknown): valor is string {
  return typeof valor === "string" && NOME_SEGREDO.test(valor);
}

interface Regra {
  tipo: string;
  padrao: RegExp;
  /** Grupo que guarda o valor; 0 = o casamento inteiro. */
  grupo?: number;
}

// Do mais específico ao mais genérico: a primeira regra que pega um trecho
// ganha, então `password=sk-...` sai uma vez só, como chave do provedor.
const REGRAS: readonly Regra[] = [
  { tipo: "private-key", padrao: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { tipo: "openai-key", padrao: /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{20,}/g },
  { tipo: "github-token", padrao: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { tipo: "slack-token", padrao: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { tipo: "google-key", padrao: /\bAIza[A-Za-z0-9_-]{35}/g },
  { tipo: "aws-access-key", padrao: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { tipo: "jwt", padrao: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { tipo: "bearer-token", padrao: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, grupo: 1 },
  // Connection string: postgres://usuario:SENHA@host
  { tipo: "url-password", padrao: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]{4,})@/g, grupo: 1 },
  // chave=valor / "chave": "valor" — é a atribuição que faz o segredo; a frase
  // que só cita "senha" não basta. `(?<![A-Za-z])` em vez de `\b` porque `_` é
  // caractere de palavra e `\b` perderia o comum `DB_PASSWORD=`.
  {
    tipo: "assigned-secret",
    padrao:
      /(?<![A-Za-z])(?:pass(?:word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|chave[_-]?api|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)(?![A-Za-z])\s*[:=]\s*["'`]?([^\s"'`,;)]{6,})["'`]?/gi,
    grupo: 1,
  },
];

/** Valores com cara de regra, mas sem segredo nenhum. */
const LACUNAS =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\}|null|none|undefined|empty|vazio|todo|changeme|your[_-]?\w+|seu[_-]?\w+|preencha\w*|redacted|omitido|example|exemplo|placeholder|secret|senha|password|token|apikey|api[_-]?key)$/i;

function ehLacuna(valor: string): boolean {
  if (LACUNAS.test(valor)) return true;
  // `password=<preencha aqui>`: o valor para no espaço e o `>` nunca chega.
  if (valor.startsWith("<") || valor.startsWith("[") || valor.startsWith("{")) return true;
  // Já no cofre, ou referência a variável/template: nada a mover.
  return valor.startsWith(PREFIXO_SEGREDO) || valor.startsWith("${") || valor.startsWith("$env");
}

/**
 * Trechos com cara de segredo, em ordem de posição e sem sobreposição. `fim` é
 * exclusivo: `texto.slice(inicio, fim)` é o valor.
 */
export function varrerSegredos(texto: string): { inicio: number; fim: number; tipo: string }[] {
  if (typeof texto !== "string" || !texto) return [];
  // O próprio marcador `{{secret:nome}}` casaria a regra `secret: valor`; o que
  // cai dentro de um marcador já está no cofre e não é trecho novo.
  const marcadores = [...texto.matchAll(/\{\{secret:[^}]*\}\}/g)].map((m) => ({ inicio: m.index ?? 0, fim: (m.index ?? 0) + m[0].length }));
  const trechos: { inicio: number; fim: number; tipo: string }[] = [];
  for (const regra of REGRAS) {
    // Regex nova por chamada: o estado do /g não vaza entre invocações.
    const padrao = new RegExp(regra.padrao.source, regra.padrao.flags);
    for (const achado of texto.matchAll(padrao)) {
      const grupo = regra.grupo ?? 0;
      const valor = achado[grupo];
      if (typeof valor !== "string" || !valor.trim() || ehLacuna(valor.trim())) continue;
      const desvio = grupo === 0 ? 0 : achado[0].indexOf(valor);
      if (desvio < 0) continue;
      const inicio = (achado.index ?? 0) + desvio;
      const fim = inicio + valor.length;
      if (marcadores.some((t) => inicio < t.fim && fim > t.inicio)) continue;
      if (trechos.some((t) => inicio < t.fim && fim > t.inicio)) continue;
      trechos.push({ inicio, fim, tipo: regra.tipo });
    }
  }
  return trechos.sort((a, b) => a.inicio - b.inicio);
}

/** Valores distintos com cara de segredo, na ordem em que aparecem. */
export function valoresSegredo(texto: string): string[] {
  const vistos = new Set<string>();
  for (const t of varrerSegredos(texto)) vistos.add(texto.slice(t.inicio, t.fim));
  return [...vistos];
}

/**
 * Troca cada ocorrência de cada valor pelo marcador. Valor mais longo primeiro,
 * para um valor contido em outro não ser trocado pela metade.
 */
export function substituirSegredos(texto: string, atribuicoes: ReadonlyMap<string, string>): string {
  let saida = texto;
  const porTamanho = [...atribuicoes].sort((a, b) => b[0].length - a[0].length);
  for (const [valor, nome] of porTamanho) {
    if (!valor) continue;
    saida = saida.split(valor).join(marcadorSegredo(nome));
  }
  return saida;
}

/** `<slug-da-memoria>.1`, `.2`… — estável, legível e nome válido no cofre. */
export function nomeSegredoDerivado(nomeBase: string, indice: number): string {
  const base = String(nomeBase ?? "")
    .replace(/\.md$/i, "")
    .replace(/[\\/]+/g, ".")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 100);
  return `${base || "memoria"}.${indice}`;
}

/**
 * Redige os segredos achados em `texto`, com nomes derivados de `nomeBase`
 * (`<base>.1`, `<base>.2`…). NÃO grava no cofre: devolve os pares para quem
 * chama guardar antes de persistir o texto.
 */
export function redigirSegredos(texto: string, nomeBase: string): { texto: string; segredos: { nome: string; valor: string }[] } {
  const segredos = valoresSegredo(texto).map((valor, i) => ({ nome: nomeSegredoDerivado(nomeBase, i + 1), valor }));
  if (!segredos.length) return { texto, segredos };
  return { texto: substituirSegredos(texto, new Map(segredos.map((s) => [s.valor, s.nome]))), segredos };
}
