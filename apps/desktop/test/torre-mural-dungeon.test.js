import { describe, expect, it } from "vitest";
import { COLUNAS, SALA_MS, faixasDosExploradores, gerarDungeon, posicaoNaDungeon, salaDaColuna } from "../torre/dungeon.js";
import {
  avancar,
  carregarQuadro,
  DESCIDA_MS,
  esvaziar,
  faseDaViagem,
  GESTO_MS,
  gestoDe,
  LAG_MS,
  muralNovo,
  receberMudanca,
  SUBIDA_MS,
} from "../torre/mural.js";

describe("dungeon", () => {
  it("mesma semente, mesmo mapa; sementes diferentes, mapas diferentes", () => {
    const a = gerarDungeon("toolu_01");
    const b = gerarDungeon("toolu_01");
    const c = gerarDungeon("toolu_02");
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("4 a 8 salas cobrindo todas as colunas, porta entre salas, baú na última", () => {
    for (let i = 0; i < 50; i++) {
      const m = gerarDungeon(`s${i}`);
      expect(m.salas.length).toBeGreaterThanOrEqual(4);
      expect(m.salas.length).toBeLessThanOrEqual(8);
      expect(m.salas[0].ini).toBe(0);
      expect(m.salas.at(-1).fim).toBe(COLUNAS - 1);
      for (let s = 1; s < m.salas.length; s++) expect(m.salas[s].ini).toBe(m.salas[s - 1].fim + 1);
      expect(m.portas).toEqual(m.salas.slice(1).map((s) => s.ini));
      expect(salaDaColuna(m, m.bau)).toBe(m.salas.length - 1);
      expect(m.paredes).toHaveLength(COLUNAS);
      expect(m.chao).toHaveLength(COLUNAS);
    }
  });

  it("explorador anda em ritmo fixo até o baú e depois vai e volta; visitadas acumulam", () => {
    const m = gerarDungeon("x");
    expect(posicaoNaDungeon(m, 0)).toMatchObject({ col: 0, sala: 0, espelho: false });
    const meio = posicaoNaDungeon(m, SALA_MS * 1.5);
    expect(meio.col).toBeCloseTo(1.5);
    const noBau = posicaoNaDungeon(m, m.bau * SALA_MS);
    expect(noBau.noBau).toBe(true);
    expect(noBau.visitadas.size).toBe(m.salas.length);
    const voltando = posicaoNaDungeon(m, m.bau * SALA_MS + SALA_MS);
    expect(voltando.espelho).toBe(true);
    expect(voltando.col).toBeCloseTo(m.bau - 1);
  });

  it("faixas: quem tem faixa fica; nova entra na primeira livre; teto corta", () => {
    const a = faixasDosExploradores([{ chave: "exp:1" }, { chave: "exp:2" }], null, 6);
    expect([...a]).toEqual([["exp:1", 0], ["exp:2", 1]]);
    const b = faixasDosExploradores([{ chave: "exp:3" }, { chave: "exp:2" }], a, 6);
    expect(b.get("exp:2")).toBe(1);
    expect(b.get("exp:3")).toBe(0);
    const c = faixasDosExploradores([{ chave: "a" }, { chave: "b" }, { chave: "c" }], null, 2);
    expect(c.size).toBe(2);
  });
});

describe("mural do Quadro", () => {
  const quadro = { colunas: [{ id: "c1", nome: "A fazer", ordem: 0 }, { id: "c2", nome: "Fazendo", ordem: 1 }, { id: "c3", nome: "Feito", ordem: 2 }] };
  const tarefas = [
    { id: "t1", titulo: "Um", colunaId: "c1", ordem: 0 },
    { id: "t2", titulo: "Dois", colunaId: "c1", ordem: 1, dependeDe: ["t1"], prioridade: "alta" },
    { id: "t3", titulo: "Três", colunaId: "c3", ordem: 0 },
  ];
  const T0 = 100_000;
  const mago = (chave, comPressa = false) => new Map([[chave, { comPressa }]]);
  const col = (m, id) => m.tarefas.find((t) => t.id === id)?.colunaId;

  function base() {
    const m = muralNovo();
    carregarQuadro(m, quadro, tarefas);
    return m;
  }

  it("carrega: fita em dependência aberta, selo de alta, carimbo na coluna final", () => {
    const m = base();
    expect(m.colunaFinal).toBe("c3");
    expect(m.tarefas.find((t) => t.id === "t2")).toMatchObject({ fita: true, alta: true, carimbo: false });
    expect(m.tarefas.find((t) => t.id === "t3").carimbo).toBe(true);
  });

  it("mudança da pessoa desliza sozinha com selo Você, sem viagem", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c2" }, { tipo: "voce" }, T0);
    avancar(m, T0, mago("conv:a"));
    expect(col(m, "t1")).toBe("c2");
    expect(m.viagens.size).toBe(0);
    expect(m.deslizes).toMatchObject([{ id: "t1", de: "c1", para: "c2", selo: "voce" }]);
  });

  it("mudança da conversa: o mago dela viaja e o pergaminho só muda quando ele chega", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c2", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    avancar(m, T0, mago("conv:a"));
    expect(m.viagens.get("conv:a").passos).toMatchObject([{ gesto: "despega-e-prega" }]);
    expect(col(m, "t1")).toBe("c1");
    expect(m.travados.get("t1")).toBe("conv:a");
    avancar(m, T0 + SUBIDA_MS - 1, mago("conv:a"));
    expect(col(m, "t1")).toBe("c1");
    avancar(m, T0 + SUBIDA_MS + 1, mago("conv:a"));
    expect(col(m, "t1")).toBe("c2");
    expect(m.travados.has("t1")).toBe(false);
    avancar(m, T0 + SUBIDA_MS + GESTO_MS + DESCIDA_MS + 1, mago("conv:a"));
    expect(m.viagens.size).toBe(0);
  });

  it("gestos por tipo", () => {
    const m = base();
    expect(gestoDe(m, { tipo: "criou" })).toBe("escreve-e-prega");
    expect(gestoDe(m, { tipo: "moveu", para: "c3" })).toBe("prega-e-carimba");
    expect(gestoDe(m, { tipo: "checklist" })).toBe("aponta");
    expect(gestoDe(m, { tipo: "comentou" })).toBe("aponta");
  });

  it("até 4 mudanças por viagem (2 com pressa); o resto aplica direto e vira balão +N", () => {
    const m = base();
    for (let i = 0; i < 6; i++) {
      receberMudanca(m, { tarefaId: `n${i}`, tipo: "criou", para: "c1", titulo: `N${i}`, via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    }
    avancar(m, T0, mago("conv:a"));
    expect(m.viagens.get("conv:a").passos).toHaveLength(4);
    expect(m.tarefas.filter((t) => t.id.startsWith("n"))).toHaveLength(2);
    expect(m.baloes.get("conv:a").n).toBe(2);

    const p = base();
    for (let i = 0; i < 3; i++) receberMudanca(p, { tarefaId: `n${i}`, tipo: "criou", para: "c1", via: "agente" }, { tipo: "conversa", threadId: "b" }, T0);
    avancar(p, T0, mago("conv:b", true));
    expect(p.viagens.get("conv:b").passos).toHaveLength(2);
    expect(p.baloes.get("conv:b").n).toBe(1);
  });

  it("atraso máximo de 15 s: viagem que não cabe vira deslize", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c2", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    // o mago só ficou disponível quando já não dava tempo de subir
    avancar(m, T0 + LAG_MS - SUBIDA_MS, mago("conv:a"));
    expect(m.viagens.size).toBe(0);
    expect(col(m, "t1")).toBe("c2");
    expect(m.deslizes[0].selo).toBe("");
  });

  it("mago indisponível (esperando você, fora da torre): desliza sozinho", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c2", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    avancar(m, T0, new Map());
    expect(m.viagens.size).toBe(0);
    expect(col(m, "t1")).toBe("c2");
  });

  it("o mesmo pergaminho nunca é levado por dois magos: o segundo espera o primeiro voltar", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c2", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    avancar(m, T0, new Map([["conv:a", {}], ["conv:b", {}]]));
    receberMudanca(m, { tarefaId: "t1", tipo: "comentou", de: "c2", para: "c2", via: "agente" }, { tipo: "conversa", threadId: "b" }, T0 + 100);
    avancar(m, T0 + 100, new Map([["conv:a", {}], ["conv:b", {}]]));
    expect(m.viagens.has("conv:b")).toBe(false);
    expect(m.fila).toHaveLength(1);
    // "a" chegou e pregou: "t1" liberou, "b" pode ir
    avancar(m, T0 + SUBIDA_MS + 10, new Map([["conv:a", {}], ["conv:b", {}]]));
    expect(m.viagens.has("conv:b")).toBe(true);
    expect(m.fila).toHaveLength(0);
  });

  it("aba oculta: aplica tudo direto sem animação", () => {
    const m = base();
    receberMudanca(m, { tarefaId: "t1", tipo: "moveu", de: "c1", para: "c3", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    avancar(m, T0, mago("conv:a"), false);
    expect(col(m, "t1")).toBe("c3");
    expect(m.tarefas.find((t) => t.id === "t1").carimbo).toBe(true);
    expect(m.viagens.size).toBe(0);
    expect(m.deslizes).toEqual([]);

    const p = base();
    receberMudanca(p, { tarefaId: "t1", tipo: "apagou", de: "c1", via: "agente" }, { tipo: "conversa", threadId: "a" }, T0);
    avancar(p, T0, mago("conv:a"));
    esvaziar(p);
    expect(p.tarefas.some((t) => t.id === "t1")).toBe(false);
    expect(p.travados.size).toBe(0);
  });

  it("fase da viagem no tempo", () => {
    const v = { desde: 0, passos: [{}, {}], aplicados: 0 };
    expect(faseDaViagem(v, 10).fase).toBe("subindo");
    expect(faseDaViagem(v, SUBIDA_MS + GESTO_MS + 1)).toMatchObject({ fase: "no-mural", passo: 1 });
    expect(faseDaViagem(v, SUBIDA_MS + 2 * GESTO_MS + 1).fase).toBe("descendo");
    expect(faseDaViagem(v, SUBIDA_MS + 2 * GESTO_MS + DESCIDA_MS).fase).toBe("fim");
  });
});
