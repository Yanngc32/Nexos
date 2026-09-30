import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABERTO_RECOLHE_MS, COMPACTO_SOME_MS, ILHA, Ilha, caixaDaIlha, faixaDeDespertar, tamanhoDaIlha } from "../painel-ilha.js";

describe("Ilha (recolhido → compacto → aberto)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mouse acorda o compacto; sem mouse, volta pro traço", () => {
    const ilha = new Ilha();
    ilha.entrou();
    expect(ilha.modo).toBe("compacto");
    ilha.saiu();
    vi.advanceTimersByTime(COMPACTO_SOME_MS - 1);
    expect(ilha.modo).toBe("compacto");
    vi.advanceTimersByTime(1);
    expect(ilha.modo).toBe("recolhido");
  });

  it("clique no compacto abre; aberta sem mouse desce um degrau por vez", () => {
    const ilha = new Ilha();
    ilha.entrou();
    expect(ilha.clicar()).toBe(true);
    expect(ilha.modo).toBe("aberto");
    // aberta, o clique é dos botões de dentro
    expect(ilha.clicar()).toBe(false);
    ilha.saiu();
    expect(ilha.recolheEm).toBeGreaterThan(0);
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS);
    expect(ilha.modo).toBe("compacto");
    vi.advanceTimersByTime(COMPACTO_SOME_MS);
    expect(ilha.modo).toBe("recolhido");
  });

  it("mouse de volta cancela a contagem", () => {
    const ilha = new Ilha();
    ilha.abrir();
    expect(ilha.recolheEm).toBeGreaterThan(0);
    ilha.entrou();
    expect(ilha.recolheEm).toBe(0);
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS * 2);
    expect(ilha.modo).toBe("aberto");
  });

  it("pergunta esperando resposta (pinada) não fecha sozinha, nem com o mouse longe", () => {
    const ilha = new Ilha();
    ilha.abrir({ pinado: true });
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS * 10);
    expect(ilha.modo).toBe("aberto");
    ilha.entrou();
    ilha.saiu();
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS * 10);
    expect(ilha.modo).toBe("aberto");
    // respondida (ou recolhida à mão): solta o pino e segue o caminho normal
    ilha.recolher();
    expect(ilha.modo).toBe("compacto");
    expect(ilha.pinado).toBe(false);
    vi.advanceTimersByTime(COMPACTO_SOME_MS);
    expect(ilha.modo).toBe("recolhido");
  });

  it('"terminou" espia pelo tempo pedido e recolhe', () => {
    const ilha = new Ilha();
    ilha.abrir({ ms: 3000 });
    vi.advanceTimersByTime(2999);
    expect(ilha.modo).toBe("aberto");
    vi.advanceTimersByTime(1);
    expect(ilha.modo).toBe("compacto");
  });

  it("conversa começou: espia só o compacto, e só se estava recolhida", () => {
    const ilha = new Ilha();
    ilha.espiar(5000);
    expect(ilha.modo).toBe("compacto");
    vi.advanceTimersByTime(5000);
    expect(ilha.modo).toBe("recolhido");
    ilha.abrir({ pinado: true });
    ilha.espiar(5000);
    expect(ilha.modo).toBe("aberto");
  });

  it('"manter aberto" segura a ilha aberta até desligar', () => {
    const ilha = new Ilha();
    ilha.abrir();
    ilha.fixar(true);
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS * 5);
    expect(ilha.modo).toBe("aberto");
    ilha.fixar(false);
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS);
    expect(ilha.modo).toBe("compacto");
  });

  it('painel "fixo": o compacto é o piso, nunca volta pro traço', () => {
    const ilha = new Ilha();
    ilha.definirPiso("compacto");
    expect(ilha.modo).toBe("compacto");
    ilha.abrir();
    vi.advanceTimersByTime(ABERTO_RECOLHE_MS + COMPACTO_SOME_MS * 5);
    expect(ilha.modo).toBe("compacto");
    // voltou pro dinâmico: recolhe
    ilha.definirPiso("recolhido");
    vi.advanceTimersByTime(COMPACTO_SOME_MS);
    expect(ilha.modo).toBe("recolhido");
  });

  it("avisa quem pinta a cada troca de modo", () => {
    const ilha = new Ilha();
    const trocas = [];
    ilha.aoMudar = (de, para) => de !== para && trocas.push(`${de}>${para}`);
    ilha.entrou();
    ilha.clicar();
    ilha.recolher();
    expect(trocas).toEqual(["recolhido>compacto", "compacto>aberto", "aberto>compacto"]);
  });
});

describe("geometria da ilha", () => {
  const janela = { w: 720, h: 420 };

  it("o traço acompanha a borda: deitado em cima/embaixo, em pé nas laterais", () => {
    expect(tamanhoDaIlha("recolhido", "topo")).toEqual({ w: ILHA.tracoComp, h: ILHA.tracoEsp });
    expect(tamanhoDaIlha("recolhido", "direita")).toEqual({ w: ILHA.tracoEsp, h: ILHA.tracoComp });
    expect(tamanhoDaIlha("compacto", "direita")).toEqual({ w: ILHA.compactoW, h: ILHA.compactoH });
    expect(tamanhoDaIlha("aberto", "topo", 203.6)).toEqual({ w: ILHA.abertoW, h: 204 });
  });

  it("encosta na borda certa, centrada no ponto escolhido", () => {
    const tam = { w: 300, h: 36 };
    expect(caixaDaIlha("topo", 360, janela, tam)).toMatchObject({ x: 210, y: 0, w: 300, h: 36 });
    expect(caixaDaIlha("baixo", 360, janela, tam)).toMatchObject({ x: 210, y: 384 });
    expect(caixaDaIlha("direita", 210, janela, tam)).toMatchObject({ x: 420, y: 192 });
    expect(caixaDaIlha("esquerda", 210, janela, tam)).toMatchObject({ x: 0, y: 192 });
  });

  it("perto do canto a ilha não sai da janela", () => {
    const aberta = { w: 660, h: 200 };
    const c = caixaDaIlha("topo", 20, janela, aberta);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(janela.w);
    expect(c.centro).toBe(660 / 2 + ILHA.margem);
    const lado = caixaDaIlha("direita", 9999, janela, aberta);
    expect(lado.y + lado.h).toBeLessThanOrEqual(janela.h);
  });

  it("a faixa de despertar fica colada na mesma borda", () => {
    expect(faixaDeDespertar("topo", 360, janela)).toEqual({ x: 300, y: 0, w: 120, h: 24 });
    expect(faixaDeDespertar("direita", 210, janela)).toEqual({ x: 696, y: 150, w: 24, h: 120 });
  });
});
