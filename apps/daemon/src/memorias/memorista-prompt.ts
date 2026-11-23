/**
 * Prompt e protocolo do memorista (e do curador, que fala o mesmo protocolo).
 *
 * O modelo responde em linhas, uma operação por linha, e nada mais:
 *
 *   OK
 *   CRIA | <tipo> | <caminho.md> | <título> | <gancho> | <o fato>
 *   COMPLEMENTA | <caminho.md> | <o fato novo>
 *
 * `NOVA` é aceito como sinônimo de `CRIA` (é o verbo do Agent Code). A leitura é fail-closed por
 * linha: linha fora do formato, tipo fora da lista, caminho inválido, CRIA num caminho que já
 * existe, COMPLEMENTA num caminho que não existe (inventado) ou campo vazio — a linha cai e as
 * outras seguem. Nunca passa de `MAX_OPERACOES`.
 */
import { TIPOS_MEMORIA } from "./arquivo.ts";
import { normalizarCaminho, validarCaminhoMemoria } from "./caminho.ts";

/** Janela por conversa: dois turnos dentro dela viram uma análise só. */
export const COOLDOWN_MEMORISTA_MS = 60_000;
/** Teto de um turno do modelo do memorista. */
export const TETO_MEMORISTA_MS = 60_000;
export const MAX_FALA_USUARIO = 4000;
export const MAX_RESPOSTA = 4000;
export const MAX_USADAS = 10;
export const MAX_MEMORIAS_NO_PROMPT = 40;
export const MAX_GANCHO = 160;
export const MAX_TITULO = 80;
export const MAX_FATO = 600;
export const MAX_OPERACOES = 3;

export type OperacaoMemoria =
  | { op: "create"; relPath: string; tipo: string; titulo: string; gancho: string; fato: string }
  | { op: "update"; relPath: string; fato: string };

/** O que o prompt mostra de uma memória: o índice, nunca o corpo. */
export type ItemIndice = { relPath: string; titulo: string; gancho: string };

/** O que cada tipo quer dizer — vai igual para o memorista e o curador. */
export const DESCRICAO_TIPOS: Record<(typeof TIPOS_MEMORIA)[number], string> = {
  instrucao: "regra que o usuário deu para o agente seguir (\"sempre rode X antes de Y\")",
  preferencia: "gosto ou jeito de trabalhar do usuário (estilo, ferramenta, formato)",
  conhecimento: "fato do domínio ou do negócio que não está no código",
  decisao: "escolha tomada junto com o motivo dela",
  infra: "máquina, serviço, conta, caminho, porta, ambiente",
  correcao: "correção explícita do usuário a algo que o agente fez ou supôs errado",
};

const linhaDeTipos = (): string => TIPOS_MEMORIA.map((t) => `- ${t}: ${DESCRICAO_TIPOS[t]}`).join("\n");

export const PROMPT_MEMORISTA = `Você é o memorista do Nexos. Lê um turno de conversa entre o usuário e o agente e decide se nasceu ali um fato que vale guardar como memória do usuário para as próximas conversas.

SALVE (o tipo vai entre parênteses):
${linhaDeTipos()}

NÃO SALVE:
- o que já está no código, no git ou no CLAUDE.md do projeto;
- estado passageiro (o que está rodando agora, o branch atual, o erro de agora);
- o próprio pedido da tarefa ("crie a tela X");
- depuração que o agente resolveu sozinho;
- credenciais, senhas, tokens.

TESTE DE CORTE: se este fato aparecer na conversa daqui a um mês, ele muda o que o agente faz? Se não muda, cale.

FORMATO — uma operação por linha, nada antes nem depois:
CRIA | <tipo> | <caminho.md> | <título> | <gancho> | <o fato>
COMPLEMENTA | <caminho.md> | <o fato novo>
ou exatamente:
OK
Na dúvida, responda OK.

REGRAS:
- <tipo> é exatamente um de: ${TIPOS_MEMORIA.join(", ")}.
- Mesmo assunto de uma memória da lista "MEMÓRIAS JÁ SALVAS": use COMPLEMENTA com o caminho dela, nunca CRIA de novo.
- COMPLEMENTA só com um caminho que está na lista; não invente caminho.
- CRIA só com caminho novo, em kebab-case, terminando em .md, no máximo uma pasta (ex.: "deploy-vercel.md" ou "infra/servidor-casa.md").
- Um fato por memória. O fato se explica sozinho, sem "como dito acima".
- O gancho diz QUANDO a memória importa (até ${MAX_GANCHO} caracteres); o título é curto (até ${MAX_TITULO}).
- No máximo ${MAX_OPERACOES} operações.
- Nada de texto fora das linhas de operação.`;

const umaLinha = (s: string): string => s.replace(/\s+/g, " ").trim();

const corta = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Índice das memórias já salvas, como o modelo vê: `caminho — título: gancho`. */
export function blocoIndice(itens: readonly ItemIndice[], max = MAX_MEMORIAS_NO_PROMPT): string {
  if (!itens.length) return "(nenhuma ainda)";
  const linhas = itens.slice(0, max).map((m) => `- ${m.relPath} — ${umaLinha(m.titulo)}: ${corta(umaLinha(m.gancho), MAX_GANCHO)}`);
  if (itens.length > max) linhas.push(`(+${itens.length - max} omitidas)`);
  return linhas.join("\n");
}

/** Falas numeradas "(1) … (2) …"; acima do teto, sai a mais antiga primeiro. */
export function juntarFalas(falas: readonly string[], max = MAX_FALA_USUARIO): string {
  const limpas = falas.map((f) => f.trim()).filter(Boolean);
  let lista = limpas;
  const juntar = (l: readonly string[]) => (l.length === 1 ? l[0]! : l.map((f, i) => `(${i + 1}) ${f}`).join("\n"));
  while (lista.length > 1 && juntar(lista).length > max) lista = lista.slice(1);
  return corta(juntar(lista), max);
}

/** Prompt completo de uma análise do memorista. */
export function montarPromptMemorista(a: {
  memorias: readonly ItemIndice[];
  usadas: readonly ItemIndice[];
  falasUsuario: readonly string[];
  resposta: string;
}): string {
  const usadas = a.usadas.slice(0, MAX_USADAS);
  return [
    PROMPT_MEMORISTA,
    "",
    "MEMÓRIAS JÁ SALVAS:",
    blocoIndice(a.memorias),
    "",
    "MEMÓRIAS QUE O AGENTE JÁ TINHA NESTE TURNO (o que está aqui não é novidade):",
    usadas.length ? blocoIndice(usadas, MAX_USADAS) : "(nenhuma)",
    "",
    "O QUE O USUÁRIO DISSE:",
    juntarFalas(a.falasUsuario) || "(nada)",
    "",
    "O QUE O AGENTE RESPONDEU:",
    corta(a.resposta.trim(), MAX_RESPOSTA) || "(nada)",
  ].join("\n");
}

/** Minúsculas, sem acento: "Instrução" → "instrucao". */
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const SINONIMOS_TIPO: Record<string, string> = { infraestrutura: "infra" };

function tipoDoModelo(bruto: string): string | undefined {
  const n = normalizar(bruto);
  const t = SINONIMOS_TIPO[n] ?? n;
  return (TIPOS_MEMORIA as readonly string[]).includes(t) ? t : undefined;
}

const CRIA = /^(?:CRIA|NOVA)\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/i;
const COMPLEMENTA = /^COMPLEMENTA\s*\|([^|]+)\|(.+)$/i;

/**
 * Lê a resposta do modelo. `conhecidos` = caminhos das memórias que existem (ativas e, de
 * preferência, aposentadas também): CRIA neles cai; COMPLEMENTA só vale neles.
 */
export function interpretarVeredito(texto: string, conhecidos: Iterable<string>): OperacaoMemoria[] {
  const porMinusculo = new Map<string, string>();
  for (const c of conhecidos) porMinusculo.set(normalizarCaminho(c).toLowerCase(), normalizarCaminho(c));
  const vistos = new Set<string>();
  const ops: OperacaoMemoria[] = [];
  for (const cru of String(texto ?? "").split(/\r?\n/)) {
    if (ops.length >= MAX_OPERACOES) break;
    const linha = cru.replace(/^[\s>*`-]+/, "").replace(/`+\s*$/, "").trim();
    if (!linha || /^OK\b/i.test(linha)) continue;
    const cria = CRIA.exec(linha);
    if (cria) {
      const tipo = tipoDoModelo(cria[1]!);
      const relPath = normalizarCaminho(cria[2]!);
      const titulo = umaLinha(cria[3]!);
      const gancho = umaLinha(cria[4]!);
      const fato = cria[5]!.trim();
      const chave = relPath.toLowerCase();
      if (!tipo || validarCaminhoMemoria(relPath) || porMinusculo.has(chave) || vistos.has(chave)) continue;
      if (!titulo || !gancho || !fato) continue;
      vistos.add(chave);
      ops.push({ op: "create", relPath, tipo, titulo: corta(titulo, MAX_TITULO), gancho: corta(gancho, MAX_GANCHO), fato: corta(fato, MAX_FATO) });
      continue;
    }
    const comp = COMPLEMENTA.exec(linha);
    if (comp) {
      const chave = normalizarCaminho(comp[1]!).toLowerCase();
      const relPath = porMinusculo.get(chave);
      const fato = comp[2]!.trim();
      if (!relPath || vistos.has(chave) || !fato) continue;
      vistos.add(chave);
      ops.push({ op: "update", relPath, fato: corta(fato, MAX_FATO) });
    }
    // Qualquer outra linha: fora do protocolo, ignorada.
  }
  return ops;
}

/**
 * Curador diário: relê as conversas do dia atrás do que o memorista deixou passar. Só correção
 * ou ensinamento EXPLÍCITO do usuário; complementa, nunca apaga nem aposenta. Mesmo protocolo.
 */
export const PROMPT_CURADOR = `Você é o curador de memórias do Nexos. Relê as conversas das últimas 24 horas entre o usuário e o agente atrás do que vale guardar e ainda não está nas memórias.

GUARDE SÓ o que o usuário disse EXPLICITAMENTE:
- uma correção ("não, o certo é...", "para de fazer X") — tipo correcao;
- um ensinamento, regra ou preferência dita com todas as letras — tipos instrucao, preferencia, conhecimento, decisao ou infra.
Não deduza nada do que o agente fez; não guarde o que o agente disse sozinho.

Tipos aceitos:
${linhaDeTipos()}

NÃO GUARDE: o que já está no código, no git ou no CLAUDE.md; estado passageiro; o pedido da tarefa; credenciais, senhas, tokens.

TESTE DE CORTE: se este fato aparecer na conversa daqui a um mês, ele muda o que o agente faz? Se não muda, cale.

Você só ACRESCENTA: nunca apaga, nunca aposenta, nunca reescreve uma memória. Fato sobre um assunto que já tem memória na lista: COMPLEMENTA nela.

FORMATO — uma operação por linha, nada antes nem depois:
CRIA | <tipo> | <caminho.md> | <título> | <gancho> | <o fato>
COMPLEMENTA | <caminho.md> | <o fato novo>
ou exatamente:
OK
Na dúvida, responda OK.

REGRAS:
- <tipo> é exatamente um de: ${TIPOS_MEMORIA.join(", ")}.
- COMPLEMENTA só com um caminho da lista "MEMÓRIAS JÁ SALVAS"; não invente caminho.
- CRIA só com caminho novo, em kebab-case, terminando em .md, no máximo uma pasta.
- Um fato por memória, que se explica sozinho. No máximo ${MAX_OPERACOES} operações.
- Nada de texto fora das linhas de operação.`;

/** Prompt de um trecho de transcrito para o curador. */
export function montarPromptCurador(a: { memorias: readonly ItemIndice[]; transcrito: string }): string {
  return [PROMPT_CURADOR, "", "MEMÓRIAS JÁ SALVAS:", blocoIndice(a.memorias), "", "CONVERSAS:", a.transcrito.trim() || "(nada)"].join("\n");
}

/** Corpo com o fato acrescentado no fim, ou `null` quando o fato já está lá. */
export function anexarFato(corpo: string, fato: string): string | null {
  const limpo = fato.trim();
  if (!limpo) return null;
  const n = (s: string) => normalizar(s).replace(/\s+/g, " ");
  if (n(corpo).includes(n(limpo))) return null;
  return `${corpo.trimEnd()}\n${limpo}\n`;
}
