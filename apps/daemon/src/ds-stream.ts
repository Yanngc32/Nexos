/**
 * Leitor incremental do protocolo de saída da geração do design system (spec §3):
 *
 *     <ds-tokens> …json DTCG… </ds-tokens>
 *     <ds-design-md> …markdown… </ds-design-md>
 *     <ds-card id="core-botoes" titulo="Botões" secao="core"> …html… </ds-card>
 *
 * O texto do motor chega em pedaços que cortam onde quiserem — inclusive no meio de uma tag.
 * Por isso o leitor guarda um rabo e só entrega o que com certeza não é começo de uma tag de
 * fechamento. É esse mesmo leitor que vai receber os deltas do streaming real (Fase 3): aqui ele
 * já emite `pedaco` conforme o conteúdo chega.
 *
 * Bloco sem fechamento (turno abortado, resposta cortada) NÃO é entregue em `fechou`: card pela
 * metade não vai pro disco.
 */

export type TipoBloco = "card" | "tokens" | "design-md";

export type Bloco = { tipo: TipoBloco; attrs: Record<string, string>; conteudo: string };

export type OuvintesLeitor = {
  abriu?: (b: Bloco) => void;
  pedaco?: (b: Bloco, texto: string) => void;
  fechou: (b: Bloco) => void;
};

const ABRE = /<ds-(card|tokens|design-md)\b([^>]*)>/;
/** Maior prefixo de tag que pode ficar pendurado no fim de um pedaço. */
const RABO_ABERTURA = 400;

function lerAttrs(bruto: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of bruto.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

export function criarLeitor(ouvintes: OuvintesLeitor) {
  let buf = "";
  let atual: Bloco | null = null;
  let fecha = "";
  let fechados = 0;

  function processar(): void {
    for (;;) {
      if (!atual) {
        const m = ABRE.exec(buf);
        if (!m) {
          // guarda só o que pode ser o começo de uma tag de abertura cortada
          const lt = buf.lastIndexOf("<");
          buf = lt >= 0 && buf.length - lt < RABO_ABERTURA ? buf.slice(lt) : "";
          return;
        }
        atual = { tipo: m[1] as TipoBloco, attrs: lerAttrs(m[2] ?? ""), conteudo: "" };
        fecha = `</ds-${m[1]}>`;
        buf = buf.slice(m.index + m[0].length);
        ouvintes.abriu?.(atual);
        continue;
      }
      const i = buf.indexOf(fecha);
      if (i >= 0) {
        const resto = buf.slice(0, i);
        if (resto) {
          atual.conteudo += resto;
          ouvintes.pedaco?.(atual, resto);
        }
        const b = atual;
        atual = null;
        buf = buf.slice(i + fecha.length);
        fechados += 1;
        ouvintes.fechou(b);
        continue;
      }
      // entrega tudo menos um rabo do tamanho da tag de fechamento (pode estar cortada)
      const seguro = buf.length - (fecha.length - 1);
      if (seguro > 0) {
        const texto = buf.slice(0, seguro);
        atual.conteudo += texto;
        ouvintes.pedaco?.(atual, texto);
        buf = buf.slice(seguro);
      }
      return;
    }
  }

  return {
    alimentar(texto: string): void {
      if (!texto) return;
      buf += texto;
      processar();
    },
    /** Quantos blocos já fecharam — pra saber se o fallback (texto final inteiro) é necessário. */
    fechados: () => fechados,
    /** Bloco aberto e nunca fechado é descartado. */
    terminar(): void {
      atual = null;
      buf = "";
    },
  };
}

/** Lê um texto inteiro de uma vez. */
export function lerBlocos(texto: string): Bloco[] {
  const out: Bloco[] = [];
  const l = criarLeitor({ fechou: (b) => out.push(b) });
  l.alimentar(texto);
  l.terminar();
  return out;
}

/** Tira cerca de código que o modelo às vezes põe em volta do conteúdo (```json … ```). */
export function semCerca(texto: string): string {
  const t = texto.trim();
  const m = t.match(/^```[a-zA-Z0-9-]*\s*\n([\s\S]*?)\n?```$/);
  return (m ? m[1]! : t).trim();
}
