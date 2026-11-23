/**
 * Bloco do catálogo de memórias que entra no pacote de instruções da conversa
 * (`instrucoesDoPack`). Leva o MEMORY.md inteiro e diz ao agente onde ficam os
 * arquivos e como gravar. Em sessão retomada, a mudança do catálogo chega pelo
 * `atualizacaoDasRegras` do motor (o bloco faz parte de `partes.instrucoes`).
 */
import { memoriasDir } from "./caminho.ts";
import { indiceMemorias } from "./nucleo.ts";

export const MARCA_CATALOGO = "[CATÁLOGO DE MEMÓRIAS]";

/** Texto do bloco; o índice vazio vira uma linha dizendo que ainda não há memória. */
export function blocoCatalogo(home: string): string {
  const dir = memoriasDir(home);
  let indice = "";
  try {
    indice = indiceMemorias(home).trim();
  } catch {
    indice = "";
  }
  return [
    MARCA_CATALOGO,
    `Memórias persistentes do usuário, guardadas em ${dir} (um arquivo .md por fato). O índice abaixo lista o que existe; para ler uma memória por inteiro, use Read no arquivo dentro dessa pasta.`,
    "Regras de escrita:",
    "- Grave SÓ pela ferramenta memory_propose (mcp__nexo__memory_propose). Write/Edit nessa pasta são recusados.",
    "- Um fato por arquivo. Antes de criar ou atualizar, rode memory_list para ver se já existe e pegar a revisão atual.",
    "- Para atualizar, informe expected_revision com a revisão atual que memory_list mostrou.",
    "- Senha, token ou chave vão no campo secrets da proposta, nunca no corpo; o corpo usa o placeholder {{secret:nome}}.",
    "",
    indice || "(nenhuma memória gravada ainda)",
  ].join("\n");
}
