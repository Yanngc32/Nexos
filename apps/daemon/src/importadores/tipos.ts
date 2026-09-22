import type AdmZip from "adm-zip";

/** Uma conversa já traduzida do formato de origem, pronta pra virar thread do Nexo. */
export type ConversaImportada = {
  titulo?: string;
  mensagens: { autor: "user" | "assistant"; texto: string; ts?: string }[];
};

/**
 * Um adaptador por ferramenta de origem (Claude.ai, ChatGPT, backup de outra máquina do próprio
 * Nexo...). `reconhece` decide sozinho, olhando só os nomes dos arquivos do zip — sem abrir nada
 * ainda, pra `importarZip` escolher o adaptador certo antes de gastar tempo parseando.
 */
export type Importador = {
  nome: string;
  reconhece(nomesDeArquivo: string[]): boolean;
  parse(zip: AdmZip): ConversaImportada[];
};
