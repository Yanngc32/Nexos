import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { criarInspectorHost } from "../inspector-host.js";
import { FASE } from "../inspector-estado.js";
import { CANAL, TIMEOUT_HANDSHAKE_MS } from "../inspector-protocolo.js";

function criarWebviewFake({ sendImpl } = {}) {
  return { send: vi.fn(sendImpl ?? (() => Promise.resolve())) };
}

function criarHost({ webview, disponivel = true } = {}) {
  const wv = webview ?? criarWebviewFake();
  const onMudarEstado = vi.fn();
  const host = criarInspectorHost({
    getWebview: () => wv,
    temPreview: () => disponivel,
    onMudarEstado,
  });
  return { host, wv, onMudarEstado };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ligar", () => {
  it("manda TOGGLE true e fica ARMANDO até o PRONTO", () => {
    const { host, wv } = criarHost();
    host.ligar();
    expect(wv.send).toHaveBeenCalledWith(CANAL.TOGGLE, true);
    expect(host.estadoAtual().fase).toBe(FASE.ARMANDO);
    expect(host.botaoPressionado()).toBe(false);

    host.receberPronto();
    expect(host.estadoAtual().fase).toBe(FASE.LIGADO);
    expect(host.botaoPressionado()).toBe(true);
  });

  it("sem preview disponível, vai direto pro erro sem mandar nada", () => {
    const { host, wv } = criarHost({ disponivel: false });
    host.ligar();
    expect(wv.send).not.toHaveBeenCalled();
    expect(host.estadoAtual().fase).toBe(FASE.ERRO);
  });

  it("sem PRONTO dentro do timeout, cai em erro e destrava o botão", () => {
    const { host } = criarHost();
    host.ligar();
    vi.advanceTimersByTime(TIMEOUT_HANDSHAKE_MS);
    expect(host.estadoAtual().fase).toBe(FASE.ERRO);
    expect(host.botaoPressionado()).toBe(false);
  });

  it("PRONTO chegando depois do timeout não pressiona o botão de volta", () => {
    const { host } = criarHost();
    host.ligar();
    vi.advanceTimersByTime(TIMEOUT_HANDSHAKE_MS);
    host.receberPronto();
    expect(host.estadoAtual().fase).toBe(FASE.ERRO);
  });
});

describe("send() rejeitando", () => {
  it("não escapa como unhandled rejection — só some no timeout", async () => {
    const wv = criarWebviewFake({ sendImpl: () => Promise.reject(new Error("preview não anexado")) });
    const { host } = criarHost({ webview: wv });
    expect(() => host.ligar()).not.toThrow();
    // dá um tick pro .catch interno rodar antes do timeout disparar
    await Promise.resolve();
    vi.advanceTimersByTime(TIMEOUT_HANDSHAKE_MS);
    expect(host.estadoAtual().fase).toBe(FASE.ERRO);
  });
});

describe("desligar", () => {
  it("manda TOGGLE false e zera a seleção", () => {
    const { host, wv } = criarHost();
    host.ligar();
    host.receberPronto();
    host.receberSelecionado({ seletor: "#a" });
    host.desligar();
    expect(wv.send).toHaveBeenCalledWith(CANAL.TOGGLE, false);
    expect(host.estadoAtual()).toEqual({ fase: FASE.DESLIGADO, selecionados: [] });
  });
});

describe("recarregar (dom-ready/did-navigate do webview)", () => {
  it("ligado -recarrega-> reabre o handshake sozinho", () => {
    const { host, wv } = criarHost();
    host.ligar();
    host.receberPronto();
    wv.send.mockClear();

    host.aoRecarregarPreview();
    expect(host.estadoAtual().fase).toBe(FASE.ARMANDO);
    expect(wv.send).toHaveBeenCalledWith(CANAL.TOGGLE, true);

    host.receberPronto();
    expect(host.estadoAtual().fase).toBe(FASE.LIGADO);
  });

  it("desligado -recarrega-> não faz nada", () => {
    const { host, wv } = criarHost();
    host.aoRecarregarPreview();
    expect(host.estadoAtual().fase).toBe(FASE.DESLIGADO);
    expect(wv.send).not.toHaveBeenCalled();
  });
});

describe("esc dentro do guest", () => {
  it("sincroniza o host pra desligado sem reenviar TOGGLE (o guest já desligou sozinho)", () => {
    const { host, wv } = criarHost();
    host.ligar();
    host.receberPronto();
    wv.send.mockClear();

    host.receberEsc();
    expect(host.estadoAtual().fase).toBe(FASE.DESLIGADO);
    expect(wv.send).not.toHaveBeenCalled();
  });
});

describe("remover/realçar selecionado", () => {
  it("removerSelecionado manda DESMARCAR com índice 1-based e tira da lista", () => {
    const { host, wv } = criarHost();
    host.ligar();
    host.receberPronto();
    host.receberSelecionado({ seletor: "#a" });
    host.receberSelecionado({ seletor: "#b" });

    host.removerSelecionado(0);
    expect(wv.send).toHaveBeenCalledWith(CANAL.DESMARCAR, 1);
    expect(host.estadoAtual().selecionados).toEqual([{ seletor: "#b" }]);
  });

  it("realcarSelecionado manda REALCAR com índice 1-based", () => {
    const { host, wv } = criarHost();
    host.realcarSelecionado(2);
    expect(wv.send).toHaveBeenCalledWith(CANAL.REALCAR, 3);
  });
});
