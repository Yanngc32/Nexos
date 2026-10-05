import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { cabecalhosDoLink, entregarArquivo, promptWithAttachments, readAttachment, saveAttachments } from "../src/attachments.ts";
import { entregar } from "../src/entregar-arquivo.ts";
import { createApp } from "../src/http.ts";
import { attachmentsDir } from "../src/home.ts";
import { pack } from "../src/packer.ts";
import { addProfile } from "../src/profiles.ts";
import { getLive, postMessage } from "../src/session.ts";
import { createThread, readThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";
import type { ThreadEvent } from "@nexos/shared";

/** PNG 1x1 de verdade: o daemon confere a assinatura do formato. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function pngImage(name?: string) {
  return { mime: "image/png", data: PNG, ...(name ? { name } : {}) };
}

describe("attachments", () => {
  it("grava a imagem no home do nexo e devolve caminho absoluto", () => {
    const home = tempHome();
    const [a] = saveAttachments("t-abc", [pngImage("print.png")], home);
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
    const [a] = saveAttachments("t-abc", [pngImage("../../fora.png")], home);
    expect(a?.name).toBe("fora.png");
    expect(a?.path.startsWith(attachmentsDir("t-abc", home))).toBe(true);
  });

  it("imagem precisa casar com a assinatura; vazio é recusado", () => {
    const home = tempHome();
    expect(() =>
      saveAttachments("t-abc", [{ mime: "image/png", data: Buffer.from("<html>").toString("base64") }], home),
    ).toThrow(/não é image\/png/);
    expect(() => saveAttachments("t-abc", [{ mime: "image/png", data: "" }], home)).toThrow(/vazio/);
  });

  it("aceita qualquer arquivo: mime vem da extensão, não do que o cliente declara", () => {
    const home = tempHome();
    const pdf = Buffer.from("%PDF-1.4 teste").toString("base64");
    const [a, b, c] = saveAttachments(
      "t-abc",
      [
        { name: "relatorio.pdf", mime: "text/html", data: pdf },
        { name: "dados.CSV", mime: "", data: Buffer.from("a,b\n1,2").toString("base64") },
        { name: "sem-extensao", data: pdf },
      ],
      home,
    );
    expect(a?.file).toMatch(/^arq-[a-z0-9]+-[a-z0-9]+\.pdf$/);
    expect(a?.mime).toBe("application/pdf");
    expect(a?.name).toBe("relatorio.pdf");
    expect(b?.file.endsWith(".csv")).toBe(true);
    expect(b?.mime).toBe("text/csv");
    expect(c?.file.endsWith(".bin")).toBe(true);
    expect(c?.mime).toBe("application/octet-stream");
    expect(readAttachment("t-abc", a?.file ?? "", home).mime).toBe("application/pdf");
  });

  it("cabeçalhos do link: página vai em sandbox, texto como texto puro, desconhecido só baixa", () => {
    const html = cabecalhosDoLink("text/html", "pagina.html", false);
    expect(html["content-security-policy"]).toMatch(/^sandbox /);
    expect(html["content-security-policy"]).not.toContain("allow-same-origin");
    expect(cabecalhosDoLink("text/csv", "a.csv", false)["content-type"]).toBe("text/plain; charset=utf-8");
    expect(cabecalhosDoLink("application/pdf", "a.pdf", false)["content-disposition"]).toMatch(/^inline/);
    expect(cabecalhosDoLink("application/pdf", "a.pdf", true)["content-disposition"]).toMatch(/^attachment/);
    const zip = cabecalhosDoLink("application/zip", "relatório final.zip", false);
    expect(zip["content-type"]).toBe("application/octet-stream");
    expect(zip["content-disposition"]).toContain("attachment");
    expect(zip["content-disposition"]).toContain("filename*=UTF-8''relat%C3%B3rio%20final.zip");
    expect(zip["x-content-type-options"]).toBe("nosniff");
  });

  it("entregarArquivo copia pros anexos da conversa e acerta o nome", () => {
    const home = tempHome();
    const origem = join(home, "saida.csv");
    writeFileSync(origem, "a,b\n1,2");
    const a = entregarArquivo("t-abc", origem, home, "Vendas de setembro");
    expect(a.name).toBe("Vendas de setembro.csv");
    expect(a.mime).toBe("text/csv");
    expect(a.path.startsWith(attachmentsDir("t-abc", home))).toBe(true);
    expect(readFileSync(a.path, "utf8")).toBe("a,b\n1,2");
    expect(() => entregarArquivo("t-abc", join(home, "nao-existe.txt"), home)).toThrow(/não existe/);
    expect(() => entregarArquivo("t-abc", home, home)).toThrow(/não é um arquivo/);
  });

  it("recusa mais imagens que o teto por mensagem", () => {
    const home = tempHome();
    const many = Array.from({ length: 7 }, () => pngImage());
    expect(() => saveAttachments("t-abc", many, home)).toThrow(/no máximo/);
  });

  it("readAttachment só serve nome que casa com o padrão", () => {
    const home = tempHome();
    const [a] = saveAttachments("t-abc", [pngImage()], home);
    const got = readAttachment("t-abc", a?.file ?? "", home);
    expect(got.mime).toBe("image/png");
    expect(got.buf.length).toBe(a?.bytes);
    expect(() => readAttachment("t-abc", "../../../config.json", home)).toThrow(/inválido/);
    expect(() => readAttachment("t-abc", "img-a-b.png", home)).toThrow(/não existe/);
  });

  it("o prompt leva o caminho, não os bytes", () => {
    const home = tempHome();
    const attachments = saveAttachments("t-abc", [pngImage()], home);
    const prompt = promptWithAttachments("o que tem aqui?", attachments);
    expect(prompt).toContain("o que tem aqui?");
    expect(prompt).toContain(attachments[0]?.path ?? "");
    expect(prompt).not.toContain(PNG.slice(0, 20));
    expect(promptWithAttachments("só texto", [])).toBe("só texto");
  });

  it("o pack mantém o caminho da imagem nos turnos seguintes", () => {
    const home = tempHome();
    const [a] = saveAttachments("t-abc", [pngImage()], home);
    const events: ThreadEvent[] = [
      { ts: "2026-01-01T00:00:00.000Z", type: "user", threadId: "t-abc", text: "olha", attachments: [a!] },
    ];
    const out = pack(events, { keepLastMessages: 20, prefixCharBudget: 2000, compactar: true }, 8000);
    expect(out.text).toContain(`[anexo imagem.png: ${a?.path}]`);
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

describe("arquivo entregue pelo agente", () => {
  async function conversa() {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: home, profileId: "p1" }, home);
    return { home, app, t };
  }

  it("nexo_arquivo_entregar grava o cartão na conversa (caminho relativo ao projeto)", async () => {
    const { home, t } = await conversa();
    writeFileSync(join(home, "relatorio.md"), "# oi");
    const r = entregar(t.id, { caminho: "relatorio.md", descricao: "o resumo" }, home);
    expect(r.ok).toBe(true);
    const ev = readThread(t.id, home).find((e) => e.type === "arquivo_entregue");
    expect(ev?.type === "arquivo_entregue" && ev.arquivo.name).toBe("relatorio.md");
    expect(ev?.type === "arquivo_entregue" && ev.descricao).toBe("o resumo");
    const out = pack(readThread(t.id, home), { keepLastMessages: 20, prefixCharBudget: 2000, compactar: true }, 8000);
    expect(out.text).toContain("entregou na conversa o arquivo relatorio.md");
    expect(entregar(t.id, {}, home).ok).toBe(false);
    expect(entregar(t.id, { caminho: "sumiu.txt" }, home).texto).toMatch(/não existe/);
  });

  it("link assinado abre sem bearer; chave errada ou de outro arquivo não", async () => {
    const { home, app, t } = await conversa();
    writeFileSync(join(home, "pagina.html"), "<script>alert(1)</script>");
    entregar(t.id, { caminho: join(home, "pagina.html") }, home);
    const ev = readThread(t.id, home).find((e) => e.type === "arquivo_entregue");
    const file = ev?.type === "arquivo_entregue" ? ev.arquivo.file : "";

    const semToken = await app.request(`/v1/threads/${t.id}/attachments/${file}/link`);
    expect(semToken.status).toBe(401);
    const link = await app.request(`/v1/threads/${t.id}/attachments/${file}/link`, { headers: { authorization: "Bearer t" } });
    const { url } = (await link.json()) as { url: string };
    expect(url.startsWith(`/anexo/${t.id}/${file}?k=`)).toBe(true);
    expect(url).toMatch(/\?k=[a-f0-9]{32}$/);

    const aberto = await app.request(url);
    expect(aberto.status).toBe(200);
    expect(aberto.headers.get("content-type")).toBe("text/html");
    expect(aberto.headers.get("content-security-policy")).toMatch(/^sandbox/);
    const baixado = await app.request(`${url}&baixar=1&n=pagina.html`);
    expect(baixado.headers.get("content-disposition")).toMatch(/^attachment; filename="pagina.html"/);

    expect((await app.request(`/anexo/${t.id}/${file}?k=${"0".repeat(32)}`)).status).toBe(403);
    expect((await app.request(`/anexo/${t.id}/${file}`)).status).toBe(403);
    const k = new URL(url, "http://x").searchParams.get("k");
    expect((await app.request(`/anexo/${t.id}/arq-a-b.txt?k=${k}`)).status).toBe(403);
  });
});
