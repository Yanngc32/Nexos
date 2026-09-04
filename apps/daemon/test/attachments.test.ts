import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { promptWithAttachments, readAttachment, saveImages } from "../src/attachments.ts";
import { createApp } from "../src/http.ts";
import { attachmentsDir } from "../src/home.ts";
import { pack } from "../src/packer.ts";
import { addProfile } from "../src/profiles.ts";
import { getLive, postMessage } from "../src/session.ts";
import { createThread, readThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";
import type { ThreadEvent } from "@nexo/shared";

/** PNG 1x1 de verdade: o daemon confere a assinatura do formato. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function pngImage(name?: string) {
  return { mime: "image/png", data: PNG, ...(name ? { name } : {}) };
}

describe("attachments", () => {
  it("grava a imagem no home do nexo e devolve caminho absoluto", () => {
    const home = tempHome();
    const [a] = saveImages("t-abc", [pngImage("print.png")], home);
    expect(a?.file).toMatch(/^img-[a-z0-9]+-[a-z0-9]+\.png$/);
    expect(a?.name).toBe("print.png");
    expect(a?.mime).toBe("image/png");
    expect(a?.bytes).toBeGreaterThan(0);
    expect(a?.path).toBe(join(attachmentsDir("t-abc", home), a?.file ?? ""));
    expect(existsSync(a?.path ?? "")).toBe(true);
    expect(readFileSync(a?.path ?? "").length).toBe(a?.bytes);
  });

  it("nome de arquivo não sai do diretório da conversa", () => {
    const home = tempHome();
    const [a] = saveImages("t-abc", [pngImage("../../fora.png")], home);
    expect(a?.name).toBe("fora.png");
    expect(a?.path.startsWith(attachmentsDir("t-abc", home))).toBe(true);
  });

  it("recusa mime fora da lista e conteúdo que não casa com o mime", () => {
    const home = tempHome();
    expect(() => saveImages("t-abc", [{ mime: "text/html", data: PNG }], home)).toThrow(/não suportado/);
    expect(() =>
      saveImages("t-abc", [{ mime: "image/png", data: Buffer.from("<html>").toString("base64") }], home),
    ).toThrow(/não é image\/png/);
    expect(() => saveImages("t-abc", [{ mime: "image/png", data: "" }], home)).toThrow(/vazia/);
  });

  it("recusa mais imagens que o teto por mensagem", () => {
    const home = tempHome();
    const many = Array.from({ length: 7 }, () => pngImage());
    expect(() => saveImages("t-abc", many, home)).toThrow(/no máximo/);
  });

  it("readAttachment só serve nome que casa com o padrão", () => {
    const home = tempHome();
    const [a] = saveImages("t-abc", [pngImage()], home);
    const got = readAttachment("t-abc", a?.file ?? "", home);
    expect(got.mime).toBe("image/png");
    expect(got.buf.length).toBe(a?.bytes);
    expect(() => readAttachment("t-abc", "../../../config.json", home)).toThrow(/inválido/);
    expect(() => readAttachment("t-abc", "img-a-b.png", home)).toThrow(/não existe/);
  });

  it("o prompt leva o caminho, não os bytes", () => {
    const home = tempHome();
    const attachments = saveImages("t-abc", [pngImage()], home);
    const prompt = promptWithAttachments("o que tem aqui?", attachments);
    expect(prompt).toContain("o que tem aqui?");
    expect(prompt).toContain(attachments[0]?.path ?? "");
    expect(prompt).not.toContain(PNG.slice(0, 20));
    expect(promptWithAttachments("só texto", [])).toBe("só texto");
  });

  it("o pack mantém o caminho da imagem nos turnos seguintes", () => {
    const home = tempHome();
    const [a] = saveImages("t-abc", [pngImage()], home);
    const events: ThreadEvent[] = [
      { ts: "2026-01-01T00:00:00.000Z", type: "user", threadId: "t-abc", text: "olha", attachments: [a!] },
    ];
    const out = pack(events, { keepLastMessages: 20, prefixCharBudget: 2000 }, 8000);
    expect(out.text).toContain(`[imagem anexada: ${a?.path}]`);
  });
});

describe("attachments pela sessão", () => {
  it("postMessage grava o anexo no evento user e manda o caminho pro motor", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "descreve", home, [pngImage("tela.png")]);
    const user = readThread(t.id, home).find((e) => e.type === "user");
    expect(user?.type === "user" && user.attachments?.length).toBe(1);
    const path = user?.type === "user" ? (user.attachments?.[0]?.path ?? "") : "";
    expect(existsSync(path)).toBe(true);
    // O stub devolve echo do que recebeu: dá pra ver o que foi pro motor.
    const answer = readThread(t.id, home).find((e) => e.type === "assistant");
    expect(answer?.type === "assistant" && answer.text).toContain(path);
    expect(getLive(t.id)).toBeDefined();
  });
});

describe("attachments pelo http", () => {
  it("aceita mensagem só de imagem e serve o arquivo de volta", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const created = await app.request("/v1/threads", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ projectPath: "/proj", profileId: "p1" }),
    });
    const thread = (await created.json()) as { id: string };

    const sent = await app.request(`/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "", images: [pngImage()] }),
    });
    expect(sent.status).toBe(200);

    const user = readThread(thread.id, home).find((e) => e.type === "user");
    const file = user?.type === "user" ? (user.attachments?.[0]?.file ?? "") : "";
    const got = await app.request(`/v1/threads/${thread.id}/attachments/${file}`, {
      headers: { authorization: "Bearer t" },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect((await got.arrayBuffer()).byteLength).toBe(Buffer.from(PNG, "base64").length);
  });

  it("recusa mensagem sem texto e sem imagem, e anexo sem token", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const created = await app.request("/v1/threads", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ projectPath: "/proj", profileId: "p1" }),
    });
    const thread = (await created.json()) as { id: string };

    const vazia = await app.request(`/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(vazia.status).toBe(400);

    const semToken = await app.request(`/v1/threads/${thread.id}/attachments/img-a-b.png`);
    expect(semToken.status).toBe(401);
  });

  it("apagar a conversa apaga as imagens dela", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "olha", home, [pngImage()]);
    const dir = attachmentsDir(t.id, home);
    expect(existsSync(dir)).toBe(true);
    const res = await app.request(`/v1/threads/${t.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });
});
