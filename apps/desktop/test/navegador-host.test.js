import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { criarNavegadorHost, jpegParaBase64 } from "../navegador-host.js";
import { CANAL_NAVEGADOR, TIMEOUT_NAVEGADOR_MS } from "../navegador-protocolo.js";

function criarWebviewFake(over = {}) {
  return {
    send: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    capturePage: vi.fn(() =>
      Promise.resolve({
        isEmpty: () => false,
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

  it("já está na URL: não chama loadURL de novo (voltar pra conversa não recarrega)", async () => {
    const wv = criarWebviewFake({ getURL: () => "https://exemplo.com/" });
    wv.dataset = { href: "https://exemplo.com/" };
    const host = criarNavegadorHost({ getWebview: () => wv });
    const r = await host.abrir("https://exemplo.com/");
    expect(wv.loadURL).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
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
        Promise.resolve({
          isEmpty: () => false,
          getSize: () => ({ width: 3840, height: 2160 }),
          resize,
          toJPEG: () => ({ toString: () => "nao deveria usar este" }),
        })
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

  it("<webview> sem área visível (capturePage 0x0): erro claro, não manda base64 vazio pro cliente MCP", async () => {
    const wv = criarWebviewFake({
      capturePage: vi.fn(() =>
        Promise.resolve({
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          toJPEG: () => ({ toString: () => "" }),
        })
      ),
    });
    const { host } = criarHost(wv);
    const r = await host.screenshot();
    expect(r.ok).toBe(false);
    expect(r.imagem).toBeUndefined();
    expect(r.texto).toMatch(/visível/);
  });

  it("Uint8Array (o que o renderer Electron devolve) vira Base64 de verdade, não lista de bytes", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const wv = criarWebviewFake({
      capturePage: vi.fn(() =>
        Promise.resolve({
          isEmpty: () => false,
          getSize: () => ({ width: 800, height: 600 }),
          toJPEG: () => jpeg,
        })
      ),
    });
    const { host } = criarHost(wv);
    const r = await host.screenshot();
    expect(r.ok).toBe(true);
    expect(r.imagem.dataBase64).toBe(jpegParaBase64(jpeg));
    expect(r.imagem.dataBase64).not.toContain(",");
    expect(r.imagem.dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
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

  it("duas threads em paralelo: cada uma espera a própria resposta", async () => {
    const wvA = criarWebviewFake();
    const wvB = criarWebviewFake();
    const host = criarNavegadorHost({
      getWebview: (tid) => (tid === "t-a" ? wvA : wvB),
    });
    const a = host.ler("t-a");
    const b = host.ler("t-b");
    host.receberLido({ itens: [{ ref: "ref_a", papel: "button", texto: "A" }] }, "t-a");
    host.receberLido({ itens: [{ ref: "ref_b", papel: "link", texto: "B" }] }, "t-b");
    expect(await a).toEqual({ ok: true, texto: "ref_a: [button] A" });
    expect(await b).toEqual({ ok: true, texto: "ref_b: [link] B" });
  });
});
