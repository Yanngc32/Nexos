import type AdmZip from "adm-zip";
import type { ConversaImportada, Importador } from "./tipos.ts";

/**
 * Formato do export "Data export" da conta Claude.ai (Configurações → Conta → Export data):
 * `conversations.json` na raiz do zip, um array de conversas. Cada `chat_message` tem `sender`
 * ("human"/"assistant") e o texto ou em `.text` direto ou em `.content[].text` (blocos), a
 * depender de quando a conversa foi exportada — o formato mudou entre versões do export.
 */
type ChatMessageClaude = {
  sender?: string;
  text?: string;
  created_at?: string;
  content?: { type?: string; text?: string }[];
};

type ConversationClaude = {
  name?: string;
  chat_messages?: ChatMessageClaude[];
};

function textoDaMensagem(m: ChatMessageClaude): string {
  if (typeof m.text === "string" && m.text) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

export const claudeExport: Importador = {
  nome: "claude-export",
  reconhece(nomesDeArquivo) {
    return nomesDeArquivo.includes("conversations.json");
  },
  parse(zip: AdmZip): ConversaImportada[] {
    const entrada = zip.getEntry("conversations.json");
    if (!entrada) return [];
    const conversas = JSON.parse(entrada.getData().toString("utf8")) as ConversationClaude[];
    const out: ConversaImportada[] = [];
    for (const conversa of conversas) {
      const mensagens = (conversa.chat_messages ?? [])
        .map((m) => ({
          autor: (m.sender === "assistant" ? "assistant" : "user") as "user" | "assistant",
          texto: textoDaMensagem(m),
          ...(m.created_at ? { ts: m.created_at } : {}),
        }))
        .filter((m) => m.texto);
      if (!mensagens.length) continue;
      out.push({ ...(conversa.name ? { titulo: conversa.name } : {}), mensagens });
    }
    return out;
  },
};
