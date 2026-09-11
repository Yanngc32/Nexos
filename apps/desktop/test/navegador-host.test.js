import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { criarNavegadorHost } from "../navegador-host.js";
import { CANAL_NAVEGADOR, TIMEOUT_NAVEGADOR_MS } from "../navegador-protocolo.js";

function criarWebviewFake(over = {}) {
  return {
    send: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    capturePage: vi.fn(() =>
      Promise.resolve({
        getSize: () => ({ width: 800, height: 600 }),
        toJPEG: () => ({ toString: () => "QUJD" }),
      })
    ),
    ...over,
  };
}

function criarHost(webview) {
  const wv = webview ?? criarWebviewFake();
  const host = criarNavegadorHost({ getWebview: () => wv });
  return { host, wv };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("abrir", () => {
  it("chama loadURL do <webview> direto, sem passar pelo preload", async () => {
    const { host, wv } = criarHost();
    const r = await host.abrir("https://exemplo.com");
    expect(wv.loadURL).toHaveBeenCalledWith("https://exemplo.com");
    expect(wv.send).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it("sem <webview> disponível, erro claro sem lançar", async () => {
    const host = criarNavegadorHost({ getWebview: () => null });
    const r = await host.abrir("https://exemplo.com");
    expect(r.ok).toBe(false);
  });
});

describe("screenshot", () => {
  it("chama capturePage e devolve a imagem em base64 como JPEG (não PNG cru, que estoura limite de tamanho do cliente MCP em página densa)", async () => {
    const { host, wv } = criarHost();
    const r = await host.screenshot();
    expect(wv.capturePage).toHaveBeenCalled();
    expect(r).toEqual({ ok: true, texto: "print tirado", imagem: { dataBase64: "QUJD", mimeType: "image/jpeg" } });
  });

  it("tela mais larga que o teto: redimensiona antes de gerar o JPEG (evita payload gigante em monitor HiDPI/4K)", async () => {
    const resize = vi.fn(() => ({ toJPEG: () => ({ toString: () => "cortado" }) }));
    const wv = criarWebviewFake({
      capturePage: vi.fn(() =>
        Promise.resolve({ getSize: () => ({ width: 3840, height: 2160 }), resize, toJPEG: () => ({ toString: () => "nao deveria usar este" }) })
      ),
    });
    const { host } = criarHost(wv);
    const r = await host.screenshot();
    expect(resize).toHaveBeenCalledWith({ width: 1280 });
    expect(r.imagem.dataBase64).toBe("cortado");
  });

  it("tela dentro do teto: não redimensiona", async () => {
    const { host, wv } = criarHost();
    await host.screenshot();
    // o fake padrão (800x600) não tem `resize` — se o código tentasse chamar, isto já teria explodido
    expect(wv.capturePage).toHaveBeenCalled();
  });
});

describe("ler", () => {
  it("manda LER, espera LIDO via receberLido, e formata a árvore em texto", async () => {
    const { host, wv } = criarHost();
    const chamada = host.ler();
    expect(wv.send).toHaveBeenCalledWith(CANAL_NAVEGADOR.LER, undefined);
    host.receberLido({ itens: [{ ref: "ref_1", papel: "link", texto: "Entrar" }] });
    const r = await chamada;
    expect(r).toEqual({ ok: true, texto: "ref_1: [link] Entrar" });
  });

  it("página sem elemento interativo nenhum diz isso, não devolve vazio sem contexto", async () => {
    const { host } = criarHost();
    const chamada = host.ler();
    host.receberLido({ itens: [] });
    expect(await chamada).toEqual({ ok: true, texto: "(nenhum elemento interativo na página)" });
  });

  it("sem resposta do preload dentro do timeout, expira com erro claro", async () => {
    const { host } = criarHost();
    const chamada = host.ler();
    await vi.advanceTimersByTimeAsync(TIMEOUT_NAVEGADOR_MS);
    const r = await chamada;
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/não respondeu/);
  });
});

describe("clicar / digitar", () => {
  it("clicar manda o ref e espera o resultado do preload", async () => {
    const { host, wv } = criarHost();
    const chamada = host.clicar("ref_2");
    expect(wv.send).toHaveBeenCalledWith(CANAL_NAVEGADOR.CLICAR, "ref_2");
    host.receberAcaoResultado({ ok: true, texto: "clicado" });
    expect(await chamada).toEqual({ ok: true, texto: "clicado" });
  });

  it("digitar manda ref+texto juntos", async () => {
    const { host, wv } = criarHost();
    const chamada = host.digitar("ref_3", "oi@exemplo.com");
    expect(wv.send).toHaveBeenCalledWith(CANAL_NAVEGADOR.DIGITAR, { ref: "ref_3", texto: "oi@exemplo.com" });
    host.receberAcaoResultado({ ok: true, texto: "digitado" });
    expect(await chamada).toEqual({ ok: true, texto: "digitado" });
  });

  it("ref inválido: o preload responde ok:false, o host só repassa", async () => {
    const { host } = criarHost();
    const chamada = host.clicar("ref_velho");
    host.receberAcaoResultado({ ok: false, texto: "ref inválido: ref_velho — releia a página" });
    const r = await chamada;
    expect(r.ok).toBe(false);
  });
});
