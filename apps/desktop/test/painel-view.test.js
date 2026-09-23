import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  celulasDeConta,
  janelasDaConta,
  linhasDeAtividade,
  mudancasDeLimite,
  nivelDoUso,
  transicoes,
} from "../painel-view.js";

const { bordaMaisProxima, retanguloNaBorda } = createRequire(import.meta.url)("../painel-borda.cjs");

const AGORA = 1_800_000_000_000;
const futuro = AGORA / 1000 + 3600;
const passado = AGORA / 1000 - 60;

describe("nivelDoUso", () => {
  it("faixas 0–49 / 50–79 / 80–99 / 100", () => {
    expect(nivelDoUso(0.49)).toBe("ok");
    expect(nivelDoUso(0.5)).toBe("medio");
    expect(nivelDoUso(0.8)).toBe("alto");
    expect(nivelDoUso(1)).toBe("cheio");
    expect(nivelDoUso(0.6, { atencao: 0.3, critico: 0.6 })).toBe("alto");
  });
});

describe("janelasDaConta", () => {
  it("marca como velha a janela cujo reset já passou", () => {
    const js = janelasDaConta(
      { limits: { fiveHour: { utilization: 0.9, resetsAt: passado }, sevenDay: { utilization: 0.3, resetsAt: futuro } } },
      AGORA,
    );
    expect(js.map((j) => [j.chave, j.velha])).toEqual([
      ["fiveHour", true],
      ["sevenDay", false],
    ]);
  });
});

describe("celulasDeConta", () => {
  it("usa a janela mais apertada que ainda vale e ordena pela mais usada", () => {
    const cs = celulasDeConta(
      [
        { id: "a", limits: { fiveHour: { utilization: 0.95, resetsAt: passado }, sevenDay: { utilization: 0.4, resetsAt: futuro } } },
        { id: "b", limits: { fiveHour: { utilization: 0.6, resetsAt: futuro } } },
        { id: "sem-dado", limits: null },
      ],
      AGORA,
    );
    expect(cs.map((c) => [c.id, c.pct, c.velha])).toEqual([
      ["b", 60, false],
      ["a", 40, false],
    ]);
  });

  it("só janela velha: mostra ela, marcada", () => {
    const [c] = celulasDeConta([{ id: "a", limits: { fiveHour: { utilization: 0.7, resetsAt: passado } } }], AGORA);
    expect(c.velha).toBe(true);
    expect(c.pct).toBe(70);
  });

  it("conta bloqueada fica no nível cheio", () => {
    const [c] = celulasDeConta([{ id: "a", limits: { status: "blocked", fiveHour: { utilization: 0.2, resetsAt: futuro } } }], AGORA);
    expect(c.nivel).toBe("cheio");
    expect(c.bloqueada).toBe(true);
  });
});

describe("transicoes", () => {
  const t = (threadId, busy, aguardando = false, lastTerminal = null) => ({ threadId, busy, aguardando, lastTerminal });

  it("detecta quem terminou e quem passou a esperar", () => {
    const r = transicoes([t("1", true), t("2", true), t("3", true)], [t("1", false, false, "done"), t("2", true, true), t("3", true)]);
    expect(r.terminou.map((a) => a.threadId)).toEqual(["1"]);
    expect(r.esperando.map((a) => a.threadId)).toEqual(["2"]);
  });

  it("erro não conta como terminou; sumir da lista em voo conta", () => {
    const r = transicoes([t("1", true), t("2", true)], [t("1", false, false, "error")]);
    expect(r.terminou.map((a) => a.threadId)).toEqual(["2"]);
  });

  it("esperando que continua esperando não repete", () => {
    expect(transicoes([t("1", true, true)], [t("1", true, true)]).esperando).toEqual([]);
  });
});

describe("linhasDeAtividade", () => {
  it("esperando primeiro, depois trabalhando, depois terminadas não vistas", () => {
    const terminadas = new Map([["9", { projectPath: "C:/x/proj", projeto: "proj", nome: "fim" }]]);
    const ls = linhasDeAtividade(
      [
        { threadId: "1", busy: true, projectPath: "C:/x/a", startedAt: AGORA - 5000 },
        { threadId: "2", busy: true, aguardando: true, projectPath: "C:/x/b" },
        { threadId: "3", busy: false },
      ],
      terminadas,
      AGORA,
    );
    expect(ls.map((l) => [l.threadId, l.estado])).toEqual([
      ["2", "esperando"],
      ["1", "trabalhando"],
      ["9", "terminou"],
    ]);
    expect(ls[1].ms).toBe(5000);
    expect(ls[1].projeto).toBe("a");
  });
});

describe("mudancasDeLimite", () => {
  const cel = (uso, resetsAt = futuro) => celulasDeConta([{ id: "a", limits: { fiveHour: { utilization: uso, resetsAt } } }], AGORA);

  it("primeira leitura não avisa; cruzar o crítico avisa uma vez", () => {
    const r1 = mudancasDeLimite(null, cel(0.7));
    expect(r1.avisos).toEqual([]);
    const r2 = mudancasDeLimite(r1.atual, cel(0.85));
    expect(r2.avisos).toMatchObject([{ tipo: "limiar", conta: "a", limiar: 0.8 }]);
    expect(mudancasDeLimite(r2.atual, cel(0.9)).avisos).toEqual([]);
  });

  it("pular de 70% pra 100% avisa só o 100%", () => {
    const r = mudancasDeLimite(mudancasDeLimite(null, cel(0.7)).atual, cel(1));
    expect(r.avisos.map((a) => a.limiar)).toEqual([1]);
  });

  it("limite crítico configurável", () => {
    const lim = { atencao: 0.3, critico: 0.6 };
    const r = mudancasDeLimite(mudancasDeLimite(null, cel(0.5), lim).atual, cel(0.65), lim);
    expect(r.avisos.map((a) => a.limiar)).toEqual([0.6]);
  });

  it("janela que passou do reset avisa que renovou", () => {
    const r = mudancasDeLimite(mudancasDeLimite(null, cel(0.9)).atual, cel(0.9, passado));
    expect(r.avisos).toMatchObject([{ tipo: "renovou", conta: "a" }]);
  });
});

describe("posição na borda", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };

  it("gruda na borda mais perto", () => {
    expect(bordaMaisProxima({ x: 1900, y: 500 }, area)).toEqual({ borda: "direita", pos: 500 / 1040 });
    expect(bordaMaisProxima({ x: 960, y: 5 }, area).borda).toBe("topo");
  });

  it("centraliza no ponto sem sair da tela e gira no topo", () => {
    expect(retanguloNaBorda("direita", 0.5, area, 300, 400)).toEqual({ x: 1620, y: 320, width: 300, height: 400 });
    expect(retanguloNaBorda("direita", 0, area, 300, 400).y).toBe(0);
    expect(retanguloNaBorda("topo", 0.5, area, 300, 400)).toEqual({ x: 760, y: 0, width: 400, height: 300 });
    expect(retanguloNaBorda("baixo", 1, area, 300, 400)).toEqual({ x: 1520, y: 740, width: 400, height: 300 });
  });
});
