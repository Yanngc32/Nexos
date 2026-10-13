import { catalogoDoCerebro, type Capacidade } from "./cerebro-catalogo.ts";
import { medirBlocoDoCerebro, type MedidaDoBloco } from "./cerebro-gatilhos.ts";
import { palavrasSemGatilho, relatorioDeUso, ultimosDisparos, type TipoDeConversa } from "./cerebro-uso.ts";
import { threadHead } from "./threads.ts";

/**
 * "O Cérebro sugere" da aba: conselhos tirados das medições, sem LLM.
 *
 * - `ignorado`: gatilho dispara e o agente não usa (5+ disparos, 0 usos depois) — descrição fraca?
 * - `sem-gatilho`: ferramentas ligadas, nunca usadas e sem gatilho — só ocupam o catálogo.
 * - `gatilho`: palavras que aparecem nas mensagens antes de a capacidade ser usada SEM lembrete
 *   (3+ mensagens) e que ainda não são gatilho — candidatas a virar.
 * - `bloco`: quanto o bloco `# Cérebro` ocupa no pack e o que ficou de fora pelo teto.
 */

export type Sugestao = {
  tipo: "ignorado" | "sem-gatilho" | "gatilho" | "bloco";
  nivel: "atencao" | "info";
  /** Capacidade alvo (quando é sobre uma só). */
  id?: string;
  titulo: string;
  texto: string;
  /** `gatilho`: termos sugeridos, mais vistos primeiro. */
  gatilhos?: string[];
  /** `sem-gatilho`/`bloco`: capacidades envolvidas. */
  ids?: string[];
};

export const MIN_DISPAROS_IGNORADOS = 5;
export const MIN_MENSAGENS_PRA_GATILHO = 3;
export const MIN_SEM_GATILHO = 5;

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Gatilhos sugeridos pra uma capacidade (palavras vistas antes de usos sem lembrete). */
export function gatilhosSugeridos(c: Pick<Capacidade, "gatilhos" | "nome">, palavras: Record<string, number> | undefined, max = 3): Array<{ termo: string; vezes: number }> {
  if (!palavras) return [];
  const ja = new Set(c.gatilhos.map(norm));
  const nome = norm(c.nome);
  return Object.entries(palavras)
    .filter(([p, n]) => n >= MIN_MENSAGENS_PRA_GATILHO && !ja.has(norm(p)) && !nome.includes(norm(p)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([termo, vezes]) => ({ termo, vezes }));
}

/** Puro: monta as sugestões a partir do catálogo, das palavras e da medida do bloco. */
export function montarSugestoes(itens: Capacidade[], palavras: Record<string, Record<string, number>>, medida: MedidaDoBloco | null): Sugestao[] {
  const out: Sugestao[] = [];
  const ignorados = itens
    .filter((c) => c.ligada && c.disparos30d >= MIN_DISPAROS_IGNORADOS && c.usosAposDisparo30d === 0)
    .sort((a, b) => b.disparos30d - a.disparos30d)
    .slice(0, 2);
  for (const c of ignorados) {
    out.push({
      tipo: "ignorado",
      nivel: "atencao",
      id: c.id,
      titulo: c.id,
      texto: `${c.disparos30d} disparos, 0 usos. O agente ignora o lembrete — descrição ou "como usar" fraco? Teste outra frase.`,
    });
  }
  const mortas = itens.filter((c) => c.tipo === "ferramenta" && c.ligada && !c.gatilhos.length && !c.ultimoUso && c.usos30d === 0);
  if (mortas.length >= MIN_SEM_GATILHO) {
    out.push({
      tipo: "sem-gatilho",
      nivel: "atencao",
      titulo: `${mortas.length} ferramentas sem gatilho e sem uso`,
      texto: "Ocupam o catálogo mas nunca entram no bloco do pack. Desligar aqui tira do mapa; o agente ainda acha via `nexo_cerebro`.",
      ids: mortas.map((c) => c.id),
    });
  }
  const comPalavras = itens
    .filter((c) => c.ligada)
    .map((c) => ({ c, sug: gatilhosSugeridos(c, palavras[c.id] ?? palavras[chaveDeUso(c.id)]) }))
    .filter((x) => x.sug.length)
    .sort((a, b) => b.sug[0]!.vezes - a.sug[0]!.vezes)
    .slice(0, 3);
  for (const { c, sug } of comPalavras) {
    const termos = sug.map((s) => `"${s.termo}"`).join(", ");
    out.push({
      tipo: "gatilho",
      nivel: "info",
      id: c.id,
      titulo: c.id,
      texto: `Mensagens com ${termos} vieram antes de usos sem lembrete (${sug[0]!.vezes}× a mais vista): vale virar gatilho.`,
      gatilhos: sug.map((s) => s.termo),
    });
  }
  if (medida && (medida.caracteres || medida.fora.length)) {
    const sobra = medida.max - medida.caracteres;
    out.push({
      tipo: "bloco",
      nivel: "info",
      titulo: `Bloco \`# Cérebro\` no pack: ${medida.caracteres.toLocaleString("pt-BR")} / ${medida.max.toLocaleString("pt-BR")} chars`,
      texto: medida.fora.length
        ? `${medida.fora.length} capacidade(s) com gatilho ficaram de fora por falta de espaço.`
        : `Cabem mais ~${Math.max(0, Math.floor(sobra / 110))} linha(s).`,
      ids: medida.fora,
    });
  }
  return out;
}

/** Delegação conta no agente/time alvo no catálogo; as palavras ficaram na chave do contador. */
function chaveDeUso(id: string): string {
  if (id.startsWith("agente:")) return `delegar:agente/${id.slice(7)}`;
  if (id.startsWith("time:")) return `delegar:time/${id.slice(5)}`;
  return id;
}

export function sugestoesDoCerebro(projectPath: string | undefined, home: string): Sugestao[] {
  const itens = catalogoDoCerebro(projectPath, home);
  const medida = medirBlocoDoCerebro(itens, { tipo: "chat" });
  return montarSugestoes(itens, palavrasSemGatilho(home), medida);
}

/* ---------------------------------------------------------------------------
 * Detalhe de uma capacidade (linha aberta da tabela)
 * ------------------------------------------------------------------------- */

export type DetalheDeUso = {
  id: string;
  porConversa: Record<TipoDeConversa, number>;
  porDia: number[];
  disparosPorDia: number[];
  ultimos: Array<{ ts: string; threadId: string; titulo: string; tipo: TipoDeConversa }>;
  gatilhosSugeridos: Array<{ termo: string; vezes: number }>;
};

const tituloCache = new Map<string, string>();
/** Título da conversa (o mesmo da barra lateral), com cache curto por id. */
export function tituloDaConversa(threadId: string, home: string): string {
  const c = tituloCache.get(threadId);
  if (c !== undefined) return c;
  let t = "";
  try {
    t = threadHead(threadId, home)?.preview ?? "";
  } catch {
    t = "";
  }
  t = t.replace(/\s+/g, " ").trim().slice(0, 80) || "conversa sem título";
  if (tituloCache.size > 500) tituloCache.clear();
  tituloCache.set(threadId, t);
  return t;
}

export function detalheDeUso(id: string, projectPath: string | undefined, home: string): DetalheDeUso | null {
  const cap = catalogoDoCerebro(projectPath, home).find((c) => c.id === id);
  if (!cap) return null;
  const rel = relatorioDeUso(home, projectPath !== undefined ? { projectPath } : {});
  const chaves = new Set([id, chaveDeUso(id)]);
  const usos = rel.capacidades.filter((u) => chaves.has(u.chave));
  const zeros = () => Array.from({ length: 14 }, () => 0);
  const porDia = zeros();
  const disparosPorDia = zeros();
  const porConversa: Record<TipoDeConversa, number> = { chat: 0, run: 0, time: 0, oculta: 0 };
  const ultimos: DetalheDeUso["ultimos"] = [];
  for (const u of usos) {
    u.porDia.forEach((n, i) => (porDia[i]! += n));
    u.disparosPorDia.forEach((n, i) => (disparosPorDia[i]! += n));
    for (const k of Object.keys(porConversa) as TipoDeConversa[]) porConversa[k] += u.porConversa[k];
    for (const x of u.ultimos) ultimos.push({ ts: x.ts, threadId: x.threadId, tipo: x.tipo, titulo: tituloDaConversa(x.threadId, home) });
  }
  ultimos.sort((a, b) => b.ts.localeCompare(a.ts));
  const palavras = palavrasSemGatilho(home);
  return {
    id,
    porConversa,
    porDia,
    disparosPorDia,
    ultimos: ultimos.slice(0, 8),
    gatilhosSugeridos: gatilhosSugeridos(cap, palavras[id] ?? palavras[chaveDeUso(id)]),
  };
}

/** Linha do tempo com o título de cada conversa. */
export function disparosComTitulo(home: string, opts: { projectPath?: string; max?: number }) {
  return ultimosDisparos(home, opts).map((d) => ({ ...d, titulo: tituloDaConversa(d.threadId, home) }));
}
