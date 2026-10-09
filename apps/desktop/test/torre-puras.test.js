import { describe, expect, it } from "vitest";
import { MAGO_H } from "../torre/arte.js";
import { cenaDaTorre } from "../torre/cena.js";
import { contasDaTorre, horaDoReset, textoDoCristal } from "../torre/contas.js";
import { aplicarRetrato, feedVazio } from "../torre/feed.js";
import { torreModelo } from "../torre/modelo.js";
import { pontoDaFila, pontoDaMesa, pontoDoAndar, pontoDoLazer, pontoNaRota, pontosDaRota } from "../torre/trajetos.js";
import { NIVEL_GERAL, TORRES_TETO, nivelInicial, ordemDasTorres, resumoDaIlha, resumoGeral, rotuloDaTorre, torreAtiva, torresDaPaisagem } from "../torre/visao.js";
import { conversaEsperando, torresDaIlha } from "../painel-torres.js";

const T0 = 9_000_000;
const ag = (id, p, extra = {}) => ({ threadId: id, projectPath: p, busy: false, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], preview: `C ${id}`, updatedAt: new Date(T0).toISOString(), ...extra });
function modeloDe(agentes) {
  const feed = feedVazio();
  aplicarRetrato(feed, agentes, T0);
  return torreModelo(feed, T0, {});
}

describe("trajetos: pelo chão e pela escada", () => {
  const cena = cenaDaTorre({ faixas: 2, contas: 3 });
  it("mesmo andar: reta; outro andar: até a escada, ao longo dela e até o destino", () => {
    const a = pontoDaMesa(cena, 1);
    const b = pontoDaMesa(cena, 3);
    expect(pontosDaRota(cena, a, b)).toEqual([a, b]);
    const mural = pontoDoAndar(cena, "mural");
    const pts = pontosDaRota(cena, a, mural);
    expect(pts).toHaveLength(4);
    expect(pts[1].x).toBe(cena.escada.x + 1);
    expect(pts[2]).toEqual({ x: cena.escada.x + 1, y: mural.y });
  });

  it("pontoNaRota começa na origem, termina no destino e usa as poses da escada no trecho vertical", () => {
    const de = pontoDaMesa(cena, 2);
    const para = pontoDoAndar(cena, "mural");
    expect(pontoNaRota(cena, de, para, 0)).toMatchObject({ x: de.x, y: de.y });
    expect(pontoNaRota(cena, de, para, 1)).toMatchObject({ x: para.x, y: para.y });
    const poses = new Set([0.1, 0.3, 0.5, 0.7, 0.9].map((p) => pontoNaRota(cena, de, para, p).pose));
    expect(poses.has("subindo-escada")).toBe(true);
    expect(poses.has("andando")).toBe(true);
    // descendo (Observatório → Salão) é a escada ao contrário
    expect(new Set([0.4, 0.5, 0.6].map((p) => pontoNaRota(cena, para, de, p).pose)).has("descendo-escada")).toBe(true);
  });

  it("andar pra esquerda espelha o sprite; pra direita não", () => {
    const de = pontoDaMesa(cena, 3);
    const esq = pontoDaMesa(cena, 0);
    expect(pontoNaRota(cena, de, esq, 0.5).espelho).toBe(true);
    expect(pontoNaRota(cena, esq, de, 0.5).espelho).toBe(false);
  });

  it("cada andar tem o seu chão: o pé do mago encosta no piso", () => {
    for (const andar of ["biblioteca", "observatorio"]) expect(pontoDoAndar(cena, andar).y + MAGO_H).toBe(cena.andares.get(andar).piso);
    expect(pontoDoLazer(cena, "caldeirao", 0).y + MAGO_H).toBe(cena.andares.get("porao").piso);
    expect(pontoDaFila(cena, "banco-0").y + MAGO_H).toBe(cena.andares.get("mana").piso);
    // 3 vagas na estante e na fila do chá: lugares diferentes
    expect(new Set([0, 1, 2].map((v) => pontoDoLazer(cena, "estante", v).x)).size).toBe(3);
    expect(new Set([0, 1, 2].map((v) => pontoDoLazer(cena, "caldeirao", v).x)).size).toBe(3);
  });
});

describe("contas: limites viram cristais", () => {
  const agora = 1_000_000_000_000;
  it("mana restante, semana, bloqueio e conta sem leitura", () => {
    const c = contasDaTorre(
      [
        { id: "a", limits: { fiveHour: { utilization: 0.38, resetsAt: (agora + 3_600_000) / 1000 }, sevenDay: { utilization: 0.4, resetsAt: (agora + 9e8) / 1000 } } },
        { id: "b", nickname: "Gmail", limits: { status: "blocked", fiveHour: { utilization: 1, resetsAt: (agora + 3_600_000) / 1000 } } },
        { id: "c", limits: null },
        { id: "d", status: "unauthenticated", limits: null },
        { id: "e", limits: { fiveHour: { utilization: 0.9, resetsAt: (agora - 1000) / 1000 } } },
      ],
      agora,
    );
    expect(c.map((x) => [x.id, x.semDado, x.bloqueada])).toEqual([["a", false, false], ["b", false, true], ["c", true, false], ["d", false, true], ["e", true, false]]);
    expect(c[1].nome).toBe("Gmail");
    expect(c[0].uso).toBeCloseTo(0.38);
    expect(c[0].semana).toBeCloseTo(0.4);
    expect(c.map(textoDoCristal)).toEqual(["62% livre", `volta às ${horaDoReset((agora + 3_600_000) / 1000)}`, "sem leitura", "esgotado", "sem leitura"]);
  });
  it("entrada ruim não quebra", () => {
    expect(contasDaTorre(null)).toEqual([]);
    expect(contasDaTorre([null, {}, { id: "x" }])).toHaveLength(1);
    expect(horaDoReset(0)).toBe("");
  });
});

describe("visão geral: torres, ordem, resumo e nível inicial", () => {
  const m = modeloDe([
    ag("a", "C:/p/nexos", { busy: true }),
    ag("b", "C:/p/nexos", { aguardando: true }),
    ag("c", "C:/p/outro", { busy: true }),
    ag("d", "C:/p/parado", { lastTerminal: "done", updatedAt: new Date(T0 - 3_600_000).toISOString() }),
  ]);

  it("quem espera você vem primeiro; parada por último", () => {
    expect(ordemDasTorres(m.torres).map((t) => t.nome)).toEqual(["nexos", "outro", "parado"]);
    expect(torreAtiva(m.torres.find((t) => t.nome === "nexos"))).toBe(true);
    expect(torreAtiva(m.torres.find((t) => t.nome === "parado"))).toBe(false);
  });

  it("resumo e rótulo acessível só trazem o que é > 0", () => {
    const nexos = m.torres.find((t) => t.nome === "nexos");
    expect(rotuloDaTorre(nexos)).toBe("nexos: 1 trabalhando, 1 esperando você");
    expect(rotuloDaTorre(m.torres.find((t) => t.nome === "parado"))).toBe("parado: parada");
    expect(resumoGeral(m.torres)).toBe("3 projetos · 2 trabalhando · 1 esperando você");
  });

  it("teto de 8 torres: o resto vira +N projetos parados", () => {
    const muitas = modeloDe(Array.from({ length: 11 }, (_, i) => ag(`t${i}`, `C:/p/proj${i}`, { busy: i < 3 })));
    const { visiveis, escondidas } = torresDaPaisagem(muitas.torres);
    expect(visiveis).toHaveLength(TORRES_TETO);
    expect(escondidas).toHaveLength(3);
    expect(visiveis.slice(0, 3).every((t) => t.contagem.trabalhando === 1)).toBe(true);
  });

  it("abre na visão geral com 2+ projetos ativos, direto na torre com 1, no projeto aberto sem nenhum; a escolha da sessão vence", () => {
    expect(nivelInicial(m.torres, "c:/p/x", "")).toBe(NIVEL_GERAL);
    const um = modeloDe([ag("a", "C:/p/nexos", { busy: true })]);
    expect(nivelInicial(um.torres, "c:/p/x", "")).toBe("c:/p/nexos");
    expect(nivelInicial(modeloDe([]).torres, "c:/p/aberto", "")).toBe("c:/p/aberto");
    expect(nivelInicial(modeloDe([]).torres, null, "")).toBe(NIVEL_GERAL);
    expect(nivelInicial(m.torres, "c:/p/x", "c:/p/nexos")).toBe("c:/p/nexos");
  });

  it("ilha: quantas torres ativas, quem espera e o texto do leitor de tela", () => {
    const r = resumoDaIlha(m.torres);
    expect(r).toMatchObject({ ativas: 2, esperando: true, primeiraEsperando: "c:/p/nexos", aria: "Torres: 2 projetos ativos, 1 esperando você" });
    expect(resumoDaIlha([]).aria).toBe("Torres: nenhum projeto ativo");
  });
});

describe("painel-torres: o retrato da ilha vira torres", () => {
  it("só as ativas, e a conversa que espera resposta pro clique no ?", () => {
    const r = torresDaIlha([ag("a", "C:/p/nexos", { busy: true }), ag("b", "C:/p/nexos", { aguardando: true }), ag("z", "C:/p/zzz", { lastTerminal: "done" })], T0);
    expect(r.torres.map((t) => t.nome)).toEqual(["nexos"]);
    expect(r.ativas).toBe(1);
    expect(conversaEsperando(r.torres[0])).toEqual({ threadId: "b", projectPath: "C:/p/nexos" });
    expect(conversaEsperando(null)).toBeNull();
  });
  it("sem retrato: nada ativo", () => {
    expect(torresDaIlha(null).ativas).toBe(0);
    expect(torresDaIlha([]).aria).toBe("Torres: nenhum projeto ativo");
  });
});
