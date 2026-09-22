import AdmZip from "adm-zip";
import { describe, it, expect } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { listThreads, readThread } from "../src/threads.ts";
import { importarZip } from "../src/importadores/importar-zip.ts";
import { tempHome } from "./helpers.ts";

function zipDeExportClaude(conversas: unknown[]): Buffer {
  const zip = new AdmZip();
  zip.addFile("conversations.json", Buffer.from(JSON.stringify(conversas), "utf8"));
  zip.addFile("users.json", Buffer.from("[]", "utf8"));
  return zip.toBuffer();
}

describe("importarZip", () => {
  it("zip do export do Claude.ai vira uma thread global por conversa, com os eventos na ordem", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const zip = zipDeExportClaude([
      {
        name: "Sobre gatos",
        chat_messages: [
          { sender: "human", text: "gatos gostam de caixa?", created_at: "2025-01-01T00:00:00.000Z" },
          { sender: "assistant", text: "sim, é instinto de esconderijo", created_at: "2025-01-01T00:00:05.000Z" },
        ],
      },
    ]);

    const resultado = importarZip(zip, "p1", home);
    expect(resultado.threadsCriadas).toBe(1);
    expect(resultado.avisos).toEqual([]);

    const globais = listThreads(undefined, home);
    expect(globais).toHaveLength(1);
    expect(globais[0]?.preview).toBe("Sobre gatos");

    const eventos = readThread(globais[0]!.id, home);
    expect(eventos.map((e) => e.type)).toEqual(["thread_meta", "user", "assistant"]);
    expect(eventos[1]).toMatchObject({ type: "user", text: "gatos gostam de caixa?" });
    expect(eventos[2]).toMatchObject({ type: "assistant", text: "sim, é instinto de esconderijo" });
  });

  it("mensagem em blocos (content[].text) é lida igual à de texto direto", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const zip = zipDeExportClaude([
      {
        name: "Em blocos",
        chat_messages: [{ sender: "human", content: [{ type: "text", text: "oi" }] }],
      },
    ]);
    importarZip(zip, "p1", home);
    const [head] = listThreads(undefined, home);
    const eventos = readThread(head!.id, home);
    expect(eventos[1]).toMatchObject({ type: "user", text: "oi" });
  });

  it("conversa sem mensagem com texto é pulada, sem criar thread vazia", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const zip = zipDeExportClaude([{ name: "Vazia", chat_messages: [] }]);
    const resultado = importarZip(zip, "p1", home);
    expect(resultado.threadsCriadas).toBe(0);
    expect(listThreads(undefined, home)).toHaveLength(0);
  });

  it("zip sem conversations.json (formato não reconhecido) lança erro claro", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const zip = new AdmZip();
    zip.addFile("nada.txt", Buffer.from("x", "utf8"));
    expect(() => importarZip(zip.toBuffer(), "p1", home)).toThrow(/não reconhecido/);
  });

  it("duas conversas do mesmo zip viram duas threads globais independentes", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const zip = zipDeExportClaude([
      { name: "A", chat_messages: [{ sender: "human", text: "1" }] },
      { name: "B", chat_messages: [{ sender: "human", text: "2" }] },
    ]);
    const resultado = importarZip(zip, "p1", home);
    expect(resultado.threadsCriadas).toBe(2);
    expect(listThreads(undefined, home).map((t) => t.preview).sort()).toEqual(["A", "B"]);
  });
});
