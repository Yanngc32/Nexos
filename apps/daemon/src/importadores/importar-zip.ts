import AdmZip from "adm-zip";
import type { ThreadEvent } from "@nexo/shared";
import { appendEvent, createThread } from "../threads.ts";
import { claudeExport } from "./claude-export.ts";
import type { Importador } from "./tipos.ts";

const IMPORTADORES: Importador[] = [claudeExport];

export type ResultadoImport = { threadsCriadas: number; avisos: string[] };

/**
 * Importa um zip de export de outra ferramenta como conversas GLOBAIS (sem projeto) — é o
 * chat geral que hospeda o que veio de fora. Cada conversa do zip vira uma thread própria,
 * com `thread_meta` seguido dos eventos `user`/`assistant` na ordem original.
 */
export function importarZip(buffer: Buffer, profileId: string, home: string): ResultadoImport {
  const zip = new AdmZip(buffer);
  const nomes = zip.getEntries().map((e) => e.entryName);
  const importador = IMPORTADORES.find((i) => i.reconhece(nomes));
  if (!importador) throw new Error("zip não reconhecido — nenhum formato de origem bate com o conteúdo");

  const conversas = importador.parse(zip);
  const avisos: string[] = [];
  let threadsCriadas = 0;
  for (const conversa of conversas) {
    try {
      const { id } = createThread({ profileId, ...(conversa.titulo ? { title: conversa.titulo } : {}) }, home);
      for (const m of conversa.mensagens) {
        const ts = m.ts ?? new Date().toISOString();
        const evento: ThreadEvent =
          m.autor === "assistant" ? { ts, type: "assistant", threadId: id, text: m.texto } : { ts, type: "user", threadId: id, text: m.texto };
        appendEvent(evento, home);
      }
      threadsCriadas++;
    } catch (e) {
      avisos.push(`conversa "${conversa.titulo ?? "sem título"}": ${(e as Error).message}`);
    }
  }
  return { threadsCriadas, avisos };
}
