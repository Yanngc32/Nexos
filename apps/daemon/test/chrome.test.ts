import { beforeEach, describe, expect, it } from "vitest";
import { createThread } from "../src/threads.ts";
import { addProfile } from "../src/profiles.ts";
import {
  chromeBus,
  comandoChrome,
  extensaoConectou,
  extensaoConectada,
  extensaoRecente,
  ferramentasDoChrome,
  resetChromeForTest,
  responderChrome,
  statusDaExtensao,
} from "../src/chrome.ts";
import { responderPergunta, resetPerguntasForTest } from "../src/perguntas.ts";
import { createApp } from "../src/http.ts";
import { tempHome } from "./helpers.ts";

function setup() {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
  return { home, threadId: t.id };
}

function ouvir() {
  const eventos: Array<Record<string, unknown>> = [];
  chromeBus.on("comando", (ev) => eventos.push(ev as Record<string, unknown>));
  return eventos;
}

beforeEach(() => {
  resetChromeForTest();
  resetPerguntasForTest();
});

describe("conexão da extensão", () => {
  it("sem extensão, o comando falha na hora, sem esperar timeout", async () => {
    const eventos = ouvir();
    const r = await comandoChrome("t-1", { acao: "ler" });
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/não está conectada/);
    expect(eventos).toEqual([]);
  });

  it("conta streams abertos e lembra a queda recente", () => {
    const a = extensaoConectou("0.1.0");
    const b = extensaoConectou();
    expect(extensaoConectada()).toBe(true);
    a();
    a(); // fechar duas vezes não desconta de novo
    expect(extensaoConectada()).toBe(true);
    b();
    expect(extensaoConectada()).toBe(false);
    expect(extensaoRecente()).toBe(true);
    expect(extensaoRecente(Date.now() + 11 * 60_000)).toBe(false);
    expect(statusDaExtensao()).toMatchObject({ conectada: false, versao: "0.1.0" });
  });
});

describe("comandoChrome / responderChrome", () => {
  it("emite no chromeBus e retoma com o resultado do mesmo id", async () => {
    extensaoConectou();
    const eventos = ouvir();
    const chamada = comandoChrome("t-1", { acao: "abrir", url: "https://exemplo.com" });
    expect(eventos).toEqual([expect.objectContaining({ type: "chrome_comando", threadId: "t-1", acao: "abrir", url: "https://exemplo.com" })]);
    const id = eventos[0].id as string;
    expect(responderChrome("t-1", { ok: true, texto: "velho" }, "outro-id")).toBe(false);
    expect(responderChrome("t-1", { ok: true, texto: "aberto" }, id)).toBe(true);
    expect(await chamada).toEqual({ ok: true, texto: "aberto" });
  });

  it("um comando por conversa", async () => {
    extensaoConectou();
    ouvir();
    void comandoChrome("t-1", { acao: "ler" });
    const r = await comandoChrome("t-1", { acao: "ler" });
    expect(r).toMatchObject({ ok: false, texto: expect.stringMatching(/pendente/) });
  });
});

describe("ferramentasDoChrome", () => {
  it("expõe as 9 ferramentas", () => {
    const nomes = ferramentasDoChrome("t-1", tempHome(), "liberado")().map((f) => f.name);
    expect(nomes).toEqual([
      "nexo_chrome_abas_listar",
      "nexo_chrome_abrir",
      "nexo_chrome_ler",
      "nexo_chrome_markdown",
      "nexo_chrome_screenshot",
      "nexo_chrome_clicar",
      "nexo_chrome_digitar",
      "nexo_chrome_rolar",
      "nexo_chrome_tecla",
    ]);
  });

  it("modo questionar: clicar pergunta antes; 'não' cancela sem mandar nada pra extensão", async () => {
    const { home, threadId } = setup();
    extensaoConectou();
    const eventos = ouvir();
    const clicar = ferramentasDoChrome(threadId, home, "questionar")().find((f) => f.name === "nexo_chrome_clicar")!;
    const chamada = clicar.executar({ ref: "ref_3" });
    await new Promise((r) => setTimeout(r, 10));
    expect(responderPergunta(threadId, "não")).toBe(true);
    expect(await chamada).toMatchObject({ ok: false, texto: expect.stringMatching(/cancelado/) });
    expect(eventos).toEqual([]);
  });

  it("modo questionar: ler roda direto", async () => {
    const { home, threadId } = setup();
    extensaoConectou();
    const eventos = ouvir();
    const ler = ferramentasDoChrome(threadId, home, "questionar")().find((f) => f.name === "nexo_chrome_ler")!;
    const chamada = ler.executar({ aba: 12 });
    expect(eventos).toEqual([expect.objectContaining({ acao: "ler", aba: 12, threadId })]);
    responderChrome(threadId, { ok: true, texto: "ref_1: [link] Entrar" });
    expect(await chamada).toMatchObject({ ok: true });
  });
});

describe("rotas", () => {
  it("responder exige bearer e resolve o pendente", async () => {
    const app = createApp(tempHome(), "tok");
    extensaoConectou();
    const eventos = ouvir();
    const chamada = comandoChrome("t-9", { acao: "screenshot" });
    const id = eventos[0].id as string;
    const semAuth = await app.request("/v1/chrome/t-9/responder", { method: "POST", body: "{}" });
    expect(semAuth.status).toBe(401);
    const res = await app.request("/v1/chrome/t-9/responder", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ id, ok: true, texto: "print", imagem: { dataBase64: "AAA", mimeType: "image/jpeg" } }),
    });
    expect(res.status).toBe(200);
    expect(await chamada).toEqual({ ok: true, texto: "print", imagem: { dataBase64: "AAA", mimeType: "image/jpeg" } });
  });
});
