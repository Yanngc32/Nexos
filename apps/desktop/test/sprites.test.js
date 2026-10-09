import { describe, expect, it } from "vitest";
import {
  anim,
  indiceNoTempo,
  MAGO_ILHA,
  passoDoClipe,
  PET_FRAME_MS,
  PET_FRAMES,
  PET_IDLE_SPICE,
  PET_NEXT,
  PET_WORK_SPICE,
  podeAnimar,
  proximaTroca,
  quadroNoTempo,
  quadroParado,
  tamanhoDaMascara,
  trechosDaMascara,
} from "../sprites.js";
import {
  CRISTAIS,
  ESTANDARTES,
  FORMAS_DE_OLHO,
  ICONES,
  MAGO_H,
  MAGO_W,
  FORMAS_DE_PERNA,
  PALETA,
  PROPS,
  TILES_DUNGEON,
  escurecer,
  gemaDe,
  mascaraDaTorreMini,
  mascaraDoIcone,
  mascaraDoMago,
  paletaCom,
} from "../torre/arte.js";
import { POSES, REACOES } from "../torre/poses.js";
import { decidir, cerebroNovo } from "../torre/cerebro.js";

describe("núcleo de animação", () => {
  const a = anim([["a", 100], ["b", 50], ["c", 200]]);

  it("quadro da vez pelo tempo, dando a volta", () => {
    expect(a.total).toBe(350);
    expect(quadroNoTempo(a, 0)).toBe("a");
    expect(quadroNoTempo(a, 99)).toBe("a");
    expect(quadroNoTempo(a, 100)).toBe("b");
    expect(quadroNoTempo(a, 150)).toBe("c");
    expect(quadroNoTempo(a, 350)).toBe("a");
    expect(proximaTroca(a, 120)).toBe(30);
  });

  it("quadro de 0 ms encerra o clipe (sem loop)", () => {
    const pulo = anim([["x", 100], ["y", 100], ["fim", 0], ["nunca", 50]]);
    expect(pulo.loop).toBe(false);
    expect(pulo.quadros.map((f) => f.q)).toEqual(["x", "y", "fim"]);
    expect(quadroNoTempo(pulo, 5000)).toBe("fim");
    expect(proximaTroca(pulo, 5000)).toBe(Infinity);
  });

  it("lista de quadros com um tempo só (formato do pet da janela)", () => {
    const b = anim(["p", "q"], 120);
    expect(quadroNoTempo(b, 130)).toBe("q");
    expect(indiceNoTempo(b, 250)).toBe(0);
    expect(quadroParado(b)).toBe("p");
  });

  it("um quadro só nunca agenda troca", () => {
    expect(proximaTroca(anim([["off", 0]]), 0)).toBe(Infinity);
    expect(quadroNoTempo(anim([["off", 0]]), 999)).toBe("off");
  });

  it("não anima com aba escondida nem com movimento reduzido", () => {
    const win = (reduz) => ({ matchMedia: () => ({ matches: reduz }) });
    expect(podeAnimar({ hidden: true }, win(false))).toBe(false);
    expect(podeAnimar({ hidden: false }, win(true))).toBe(false);
    expect(podeAnimar({ hidden: false }, win(false))).toBe(true);
  });
});

describe("tabelas do maguinho migradas sem mudança visível", () => {
  it("ilha: mesmos clipes e tempos de antes", () => {
    expect(MAGO_ILHA.parado).toEqual([["idle", 2600], ["idle-breath", 700], ["idle", 1800], ["idle-blink-half", 70], ["idle-blink", 110], ["idle-blink-half", 70]]);
    expect(MAGO_ILHA.terminou.at(-1)).toEqual(["idle", 0]);
    expect(Object.keys(MAGO_ILHA)).toEqual(["off", "parado", "trabalhando", "esperando", "terminou"]);
    // o passo do painel dá a volta no clipe igual ao índice cru de antes
    expect(passoDoClipe(MAGO_ILHA.esperando, 7)).toEqual({ nome: "wait-0", ms: 900 });
    // e a sequência pelo tempo bate com a de passo em passo
    const a = anim(MAGO_ILHA.trabalhando);
    let t = 0;
    for (let i = 0; i < MAGO_ILHA.trabalhando.length * 2; i++) {
      const { nome, ms } = passoDoClipe(MAGO_ILHA.trabalhando, i);
      expect(quadroNoTempo(a, t)).toBe(nome);
      t += ms;
    }
  });

  it("janela: mesmos quadros, próximos estados e tempos", () => {
    expect(PET_FRAMES.off).toEqual(["off", "off-z1", "off-z2", "off-z1"]);
    expect(PET_FRAMES.wake).toEqual(["idle-hide", "idle-in2", "idle-in1", "idle-blink-half", "idle-blink", "idle-blink-half", "idle"]);
    expect(PET_FRAMES.idle).toBe(PET_IDLE_SPICE[0]);
    expect(PET_FRAMES.work).toBe(PET_WORK_SPICE[0]);
    expect(PET_IDLE_SPICE).toHaveLength(3);
    expect(PET_WORK_SPICE[1]).toHaveLength(10);
    expect(PET_NEXT).toEqual({ wake: "idle", done: "idle", sai: "fora" });
    expect(PET_FRAME_MS).toEqual({ off: 700, wake: 220, idle: 400, think: 380, work: 120, done: 120, sai: 140, espera: 650 });
  });
});

describe("arte da torre", () => {
  const paleta = paletaCom({ estandarte: ESTANDARTES[0], cristal: CRISTAIS.cheio });

  it("toda máscara só usa cores da paleta e tem linhas do mesmo tamanho", () => {
    const todas = [
      ...FORMAS_DE_OLHO.map((o) => mascaraDoMago(o)),
      ...FORMAS_DE_PERNA.map((p) => mascaraDoMago("normal", p)),
      ...Object.values(PROPS),
      ...ICONES.map(mascaraDoIcone),
      ...Object.values(TILES_DUNGEON),
      mascaraDaTorreMini({ salao: 3, porao: 1 }),
    ];
    for (const m of todas) {
      expect(() => trechosDaMascara(m, paleta)).not.toThrow();
      expect(new Set(m.map((l) => l.length)).size).toBe(1);
    }
  });

  it("mago 18×24, redução exata do original: gema quadrada à direita da ponta; olhos só no rosto", () => {
    expect([MAGO_W, MAGO_H]).toEqual([18, 24]);
    const n = mascaraDoMago("normal");
    const f = mascaraDoMago("fechado");
    expect(n.slice(0, 19)).toEqual(f.slice(0, 19));
    expect(n[21]).not.toEqual(f[21]);
    expect(tamanhoDaMascara(n)).toEqual({ w: 18, h: 24 });
    // gema 2×2 com brilho no canto de cima à esquerda, encostada na ponta do chapéu (como no mago.txt)
    expect(n[0].slice(9, 11)).toBe("Gg");
    expect(n[1].slice(9, 11)).toBe("gg");
    expect(n[2].slice(8, 11)).toBe("cgg");
    // olhos simétricos em torno da ponta (colunas 8–9)
    expect(n[20][7]).toBe("k");
    expect(n[20][11]).toBe("k");
  });

  it("tiles da dungeon são 16×16", () => {
    for (const t of Object.values(TILES_DUNGEON)) expect(tamanhoDaMascara(t)).toEqual({ w: 16, h: 16 });
  });

  it("trechos agrupam cores iguais na linha", () => {
    expect(trechosDaMascara(["aab.", ".bb"], { a: "#1", b: "#2" })).toEqual([
      { x: 0, y: 0, w: 2, cor: "#1" },
      { x: 2, y: 0, w: 1, cor: "#2" },
      { x: 1, y: 1, w: 2, cor: "#2" },
    ]);
    expect(() => trechosDaMascara(["z"], {})).toThrow(/fora da paleta/);
  });

  it("gema: a do mago por padrão; cor do agente quando houver", () => {
    expect(gemaDe("")).toEqual([PALETA.G, PALETA.g]);
    expect(gemaDe("#FF0000")).toEqual(["#ff0000", escurecer("#ff0000", 0.62)]);
  });

  it("janelas da mini-torre acendem por andar", () => {
    const m = mascaraDaTorreMini({ salao: 2 }).join("\n");
    expect(m).toContain("lllll");
    expect(mascaraDaTorreMini({}).join("\n")).not.toContain("l");
  });
});

describe("poses", () => {
  it("todo objeto de pose existe; todo quadro tem olhos válidos", () => {
    for (const a of [...Object.values(POSES), ...Object.values(REACOES)]) {
      for (const { q } of a.quadros) {
        expect(FORMAS_DE_OLHO).toContain(q.o);
        for (const [nome] of q.props) expect(PROPS[nome], nome).toBeTruthy();
      }
    }
  });

  it("toda pose que o cérebro escolhe existe", () => {
    const c = cerebroNovo();
    const estados = ["esperando", "pensando", "trabalhando", "segundo-plano", "sem-mana", "terminou", "erro", "ocioso"];
    const ferramentas = ["Edit", "Read", "Bash", "WebFetch", "Agent", "mcp__x"];
    for (const estado of estados) {
      for (const ferramenta of ferramentas) {
        for (const t of [0, 300, 3000]) {
          const d = decidir(c, { chave: "k", semente: 1, estado, ferramenta, faseEm: 0, comemorando: estado === "terminou" }, t, () => 0.5);
          expect(POSES[d.pose], d.pose).toBeTruthy();
        }
      }
    }
  });
});
