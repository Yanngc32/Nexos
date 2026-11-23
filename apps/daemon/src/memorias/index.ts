/**
 * Memória do usuário do Nexos — API pública.
 *
 * As memórias ficam em `<home>/memorias` (um `.md` por memória + MEMORY.md
 * gerado + diário `.memorias.json`); os segredos, cifrados, em
 * `<home>/cofre/segredos.json`. Escrita só por `proporMemoria`.
 */
export type { Memoria, OrigemMemoria, PropostaMemoria, ResultadoProposta } from "./tipos.ts";
export { memoriasDir, validarCaminhoMemoria, escritaDiretaNegada } from "./caminho.ts";
export {
  proporMemoria,
  listarMemorias,
  lerMemoria,
  reconciliarMemorias,
  indiceMemorias,
  versaoCatalogo,
  statusMemorias,
  corpoParaPrompt,
} from "./nucleo.ts";
export { rankearMemorias, selecionarLexicamente } from "./busca.ts";
export { cofreDir, gravarSegredo, lerSegredo, listarSegredos } from "./cofre.ts";
export { varrerSegredos, redigirSegredos } from "./segredos.ts";
