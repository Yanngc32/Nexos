import { describe, expect, it } from "vitest";
import {
  alturas,
  contagemPorTipo,
  disparosNaJanela,
  ESPERANDO_MS,
  faixaDeDisparos,
  filtrar,
  idDeNova,
  ignorados,
  normalizarMesmoTamanho,
  ordenar,
  pctUsou,
  previaNoPack,
  proximoIndice,
  resultadoDoDisparo,
  seriesDosKpis,
  tempoRelativo,
  trechosMarcados,
} from "../cerebro-painel-modelo.js";

const cap = (id, extra = {}) => {
  const [tipo, nome] = id.split(":");
  return { id, tipo, nome, descricao: "", gatilhos: [], comoUsar: "", origem: "auto", ligada: true, usos7d: 0, usos30d: 0, disparos30d: 0, usosAposDisparo30d: 0, ...extra };
};
const ITENS = [
  cap("ferramenta:nexo_perguntar", { usos7d: 20, usos30d: 148, disparos30d: 40, usosAposDisparo30d: 38, gatilhos: ["decisão"], ultimoUso: "2026-10-13T10:00:00Z", porDia: [0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 3, 0, 4, 5], disparosPorDia: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2] }),
  cap("skill:make-interfaces-feel-better", { usos7d: 2, usos30d: 10, descricao: "Acabamento de interface", gatilhos: ["ui", "tela"], ultimoUso: "2026-10-12T10:00:00Z", porDia: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }),
  cap("agente:explorador", { disparos30d: 7, gatilhos: ["onde fica"] }),
  cap("ferramenta:nexo_video_render"),
  cap("skill:nexo-times", { ligada: false, disparos30d: 3 }),
];

describe("filtrar e ordenar", () => {
  it("busca sem acento em nome, descrição e gatilhos; tipos e estados combinam por E", () => {
    expect(filtrar(ITENS, { busca: "decisao" }).map((c) => c.id)).toEqual(["ferramenta:nexo_perguntar"]);
    expect(filtrar(ITENS, { busca: "INTERFACE" }).map((c) => c.id)).toEqual(["skill:make-interfaces-feel-better"]);
    expect(filtrar(ITENS, { tipos: new Set(["skill"]) })).toHaveLength(2);
    expect(filtrar(ITENS, { estados: new Set(["nunca"]) }).map((c) => c.id)).toEqual(["agente:explorador", "ferramenta:nexo_video_render", "skill:nexo-times"]);
    expect(filtrar(ITENS, { estados: new Set(["nunca", "gatilho"]) }).map((c) => c.id)).toEqual(["agente:explorador"]);
    expect(filtrar(ITENS, { estados: new Set(["desligada"]) }).map((c) => c.id)).toEqual(["skill:nexo-times"]);
    expect(filtrar(ITENS, { usadas7d: true })).toHaveLength(2);
    expect(filtrar(ITENS, { ids: new Set(["agente:explorador"]) })).toHaveLength(1);
  });

  it("ordena por qualquer coluna; padrão usos desc; ignorados = disparos - usos após", () => {
    expect(ordenar(ITENS).map((c) => c.id)[0]).toBe("ferramenta:nexo_perguntar");
    expect(ordenar(ITENS, { coluna: "ignorados", dir: "desc" }).map((c) => c.id).slice(0, 2)).toEqual(["agente:explorador", "skill:nexo-times"]);
    expect(ordenar(ITENS, { coluna: "nome", dir: "asc" }).map((c) => c.nome)[0]).toBe("explorador");
    expect(ordenar(ITENS, { coluna: "ligada", dir: "asc" })[0].id).toBe("skill:nexo-times");
    expect(ordenar(ITENS, { coluna: "ultimo", dir: "desc" })[0].id).toBe("ferramenta:nexo_perguntar");
    expect(ignorados(ITENS[0])).toBe(2);
    expect(pctUsou(ITENS[0])).toBe(95);
    expect(pctUsou(ITENS[3])).toBeNull();
    expect(contagemPorTipo(ITENS)).toMatchObject({ ferramenta: 2, skill: 2, agente: 1, time: 0 });
  });
});

describe("séries, tempo e linha do tempo", () => {
  const agora = Date.parse("2026-10-13T12:00:00Z");
  it("séries dos KPIs somam por dia e contam capacidades distintas usadas", () => {
    const s = seriesDosKpis(ITENS);
    expect(s.usos.at(-1)).toBe(6);
    expect(s.usadas.at(-1)).toBe(2);
    expect(s.usadas[0]).toBe(1);
    expect(s.disparos.at(-1)).toBe(2);
    expect(alturas([0, 5, 10])).toEqual([0, 50, 100]);
    expect(alturas([0, 1, 100])).toEqual([0, 6, 100]);
    expect(alturas([0, 0])).toEqual([0, 0]);
  });

  it("tempo relativo e resultado do disparo (esperando só nos primeiros 15 min)", () => {
    expect(tempoRelativo(null, agora)).toBe("nunca");
    expect(tempoRelativo("2026-10-13T11:59:30Z", agora)).toBe("agora");
    expect(tempoRelativo("2026-10-13T11:48:00Z", agora)).toBe("há 12 min");
    expect(tempoRelativo("2026-10-13T09:00:00Z", agora)).toBe("há 3 h");
    expect(tempoRelativo("2026-10-10T12:00:00Z", agora)).toBe("há 3 d");
    expect(resultadoDoDisparo({ ts: "2026-10-13T11:59:00Z", usou: true }, agora)).toBe("usou");
    expect(resultadoDoDisparo({ ts: new Date(agora - ESPERANDO_MS + 1000).toISOString() }, agora)).toBe("esperando");
    expect(resultadoDoDisparo({ ts: "2026-10-13T10:00:00Z" }, agora)).toBe("ignorou");
  });

  it("faixa: 24 colunas por hora, 30 por dia; disparos fora da janela não entram", () => {
    const d = [
      { ts: "2026-10-13T11:55:00Z", chave: "a", usou: true },
      { ts: "2026-10-13T11:58:00Z", chave: "b" },
      { ts: "2026-10-13T01:30:00Z", chave: "a" },
      { ts: "2026-10-01T12:00:00Z", chave: "a", usou: true },
    ];
    const f24 = faixaDeDisparos(d, "24h", agora);
    expect(f24).toHaveLength(24);
    expect(f24.at(-1)).toEqual(["usou", "esperando"]);
    expect(f24.flat()).toHaveLength(3);
    const f30 = faixaDeDisparos(d, "30d", agora);
    expect(f30).toHaveLength(30);
    expect(f30.flat()).toHaveLength(4);
    expect(disparosNaJanela(d, "24h", agora)).toHaveLength(3);
    expect(disparosNaJanela(d, "30d", agora, "a")).toHaveLength(3);
  });
});

describe("texto", () => {
  it("normalizar mantém o tamanho; marcação pega palavra inteira sem acento", () => {
    expect(normalizarMesmoTamanho("Decisão É")).toBe("decisao e");
    expect(normalizarMesmoTamanho("Decisão É")).toHaveLength("Decisão É".length);
    const t = trechosMarcados("faz um MOCK da tela e o mockup, decisão", ["mock", "tela", "decisao"]);
    expect(t.filter((x) => x.marca).map((x) => x.texto)).toEqual(["MOCK", "tela", "decisão"]);
    expect(t.map((x) => x.texto).join("")).toBe("faz um MOCK da tela e o mockup, decisão");
    expect(trechosMarcados("", ["x"])).toEqual([]);
  });

  it("id de capacidade nova, prévia do pack e navegação", () => {
    expect(idDeNova("doc", "Guia de Uso")).toBe("doc:guia-de-uso");
    expect(idDeNova("skill", "  ")).toBe("");
    expect(previaNoPack({ gatilhos: ["deploy", "produção"], comoUsar: "Read docs/RUNBOOK.md" })).toBe("deploy / produção → Read docs/RUNBOOK.md");
    expect(previaNoPack({ descricao: "Como subir", comoUsar: "" })).toBe("Como subir → …");
    expect(proximoIndice(-1, 1, 5)).toBe(0);
    expect(proximoIndice(-1, -1, 5)).toBe(4);
    expect(proximoIndice(4, 1, 5)).toBe(4);
    expect(proximoIndice(2, -1, 5)).toBe(1);
    expect(proximoIndice(0, 1, 0)).toBe(-1);
  });
});
