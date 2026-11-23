import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESPERA_PO_MS, FilaPO, juntarLotes, juntarPedidos, MAX_CHAMADAS_PO, type LotePO } from "../src/po/fila.ts";

const lote = (texto: string, extra: Partial<LotePO> = {}): LotePO => ({
  textos: [texto],
  chamadas: [],
  mensagens: [],
  turnos: 1,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FilaPO", () => {
  it("fora da espera roda na hora e devolve a promessa da rodada", async () => {
    const rodadas: LotePO[] = [];
    const fila = new FilaPO(async (_k, l) => {
      rodadas.push(l);
    });
    await fila.pedir("th", "fechamento", lote("a"));
    expect(rodadas.map((l) => l.textos)).toEqual([["a"]]);
  });

  it("turnos dentro dos 60 s juntam num lote só, que roda quando a espera acaba", async () => {
    const rodadas: LotePO[] = [];
    const fila = new FilaPO(async (_k, l) => {
      rodadas.push(l);
    });
    await fila.pedir("th", "fechamento", lote("a", { resposta: "r1" }));
    await fila.pedir("th", "fechamento", lote("b", { resposta: "r2" }));
    await fila.pedir("th", "fechamento", lote("c", { resposta: "r3", proximo: "depois" }));
    expect(rodadas).toHaveLength(1);
    expect(fila.pendenteDe("th", "fechamento")?.turnos).toBe(2);
    // Fase e conversa diferentes não esperam pela outra.
    await fila.pedir("th", "abertura", lote("x"));
    await fila.pedir("outra", "fechamento", lote("y"));
    expect(rodadas).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS - 1);
    expect(rodadas).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(rodadas).toHaveLength(4);
    const junto = rodadas[3]!;
    expect(junto.textos).toEqual(["b", "c"]);
    expect(junto.turnos).toBe(2);
    expect(junto.resposta).toBe("r3");
    expect(junto.proximo).toBe("depois");
    expect(junto.mensagens).toEqual(["(turno anterior) r2"]);
    expect(fila.pendenteDe("th", "fechamento")).toBeUndefined();
  });

  it("rodada que falha tenta de novo 60 s depois, no máximo 2 vezes", async () => {
    let chamadas = 0;
    const fila = new FilaPO(async () => {
      chamadas++;
      throw new Error("motor fora");
    });
    await expect(fila.pedir("th", "fechamento", lote("a"))).resolves.toBeUndefined();
    expect(chamadas).toBe(1);
    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS);
    expect(chamadas).toBe(2);
    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS);
    expect(chamadas).toBe(3);
    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS * 5);
    expect(chamadas).toBe(3);
    expect(fila.pendenteDe("th", "fechamento")).toBeUndefined();
  });

  it("falha seguida de sucesso para de tentar", async () => {
    let chamadas = 0;
    const fila = new FilaPO(async () => {
      chamadas++;
      if (chamadas === 1) throw new Error("uma vez");
    });
    await fila.pedir("th", "abertura", lote("a"));
    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS * 4);
    expect(chamadas).toBe(2);
  });

  it("esvaziar cancela a espera e roda o pendente uma vez", async () => {
    const rodadas: LotePO[] = [];
    const fila = new FilaPO(async (_k, l) => {
      rodadas.push(l);
    });
    await fila.pedir("th", "fechamento", lote("a"));
    await fila.pedir("th", "fechamento", lote("b"));
    await fila.esvaziar();
    expect(rodadas.map((l) => l.textos)).toEqual([["a"], ["b"]]);
    await vi.advanceTimersByTimeAsync(ESPERA_PO_MS * 2);
    expect(rodadas).toHaveLength(2);
  });
});

describe("juntar", () => {
  it("chamadas ficam nas últimas 60 e a resposta anterior é a do primeiro", () => {
    const muitas = (p: string) => Array.from({ length: 40 }, (_, i) => ({ ferramenta: "Bash", detalhe: `${p}${i}` }));
    const j = juntarLotes(
      lote("a", { chamadas: muitas("a"), respostaAnterior: "antes-a" }),
      lote("b", { chamadas: muitas("b"), respostaAnterior: "antes-b" }),
    );
    expect(j.chamadas).toHaveLength(MAX_CHAMADAS_PO);
    expect(j.chamadas.at(-1)!.detalhe).toBe("b39");
    expect(j.respostaAnterior).toBe("antes-a");
  });

  it("juntarPedidos numera quando há mais de um", () => {
    expect(juntarPedidos(["só um"])).toBe("só um");
    expect(juntarPedidos(["a", " ", "b"])).toBe("(1) a\n\n(2) b");
  });
});
