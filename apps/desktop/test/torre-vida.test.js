import { describe, expect, it } from "vitest";
import { andarDaFerramenta, aplicarEventoAgente, aplicarRetrato, feedVazio } from "../torre/feed.js";
import { avancarIdas, DESLOCAMENTO_MS, idasNovo, LINGER_MS } from "../torre/idas.js";
import { APAGANDO_MS, avancarMana, contaApagada, LUGARES, manaNovo, todasApagadas } from "../torre/mana.js";
import { aplicarEventosNasFalas, avancarFalas, falasNovo, frase, FRASES, MAX_NA_TELA, OCIO_MIN_MS, PRIORIDADE } from "../torre/falas.js";
import { avancarLazer, IDA_MS, lazerNovo, LUGARES as POIS, SORTEIO_MIN_MS, VOLTA_CORRENDO_MS } from "../torre/lazer.js";
import { avancarConvivio, convivioNovo, cumprimentar, OLHA_ESTRELA_MS } from "../torre/convivio.js";
import { retratoDaTorre, torreEventos } from "../torre/eventos.js";
import { torreModelo } from "../torre/modelo.js";
import { POSES, REACOES } from "../torre/poses.js";

const T0 = 2_000_000;
const mago = (chave, estado, extra = {}) => ({ chave, estado, comemorando: false, ...extra });
const fixo = (v) => () => v;

describe("idas aos andares pela ferramenta", () => {
  it("classifica a ferramenta por andar", () => {
    expect(andarDaFerramenta("mcp__nexo__nexo_mock_salvar", {})).toEqual({ andar: "atelie", gravando: true });
    expect(andarDaFerramenta("mcp__nexo__nexo_plano_ler", {})).toEqual({ andar: "observatorio", gravando: false });
    expect(andarDaFerramenta("mcp__nexo__nexo_plano_card_criar", {})).toEqual({ andar: "observatorio", gravando: true });
    expect(andarDaFerramenta("Read", { file_path: "C:\\x\\memoria\\MEMORIA.md" })).toEqual({ andar: "biblioteca", gravando: false });
    expect(andarDaFerramenta("Edit", { file_path: "/p/instintos/a.md" })).toEqual({ andar: "biblioteca", gravando: true });
    expect(andarDaFerramenta("Read", { file_path: "/p/src/a.ts" })).toBeNull();
    expect(andarDaFerramenta("Bash", {})).toBeNull();
  });

  it("o feed guarda as idas e o mago vai, fica enquanto durar a sequência e volta", () => {
    const f = feedVazio();
    aplicarRetrato(f, [{ threadId: "t1", projectPath: "C:/p", busy: true, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], preview: "x" }], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "mcp__nexo__nexo_mock_salvar", input: {} }, T0 + 100);
    expect(f.idasRecentes).toMatchObject([{ threadId: "t1", andar: "atelie" }]);
    const i = idasNovo();
    const magos = [mago("conv:t1", "trabalhando")];
    let r = avancarIdas(i, { magos, sinais: f.idasRecentes, agora: T0 + 200 });
    expect(r.get("conv:t1")).toMatchObject({ andar: "atelie", fase: "indo", pose: "andando" });
    r = avancarIdas(i, { magos, sinais: f.idasRecentes, agora: T0 + 200 + DESLOCAMENTO_MS });
    expect(r.get("conv:t1")).toMatchObject({ fase: "la", pose: "pintando" });
    // nova chamada do mesmo andar prolonga
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "mcp__nexo__nexo_ds_card_salvar", input: {} }, T0 + 3000);
    r = avancarIdas(i, { magos, sinais: f.idasRecentes, agora: T0 + 3000 + LINGER_MS - 10 });
    expect(r.get("conv:t1").fase).toBe("la");
    r = avancarIdas(i, { magos, sinais: f.idasRecentes, agora: T0 + 3000 + LINGER_MS + 10 });
    expect(r.get("conv:t1").fase).toBe("voltando");
    r = avancarIdas(i, { magos, sinais: [], agora: T0 + 3000 + LINGER_MS + DESLOCAMENTO_MS + 20 });
    expect(r.size).toBe(0);
  });

  it("pergunta no meio: volta na hora; andar diferente: termina e vai pra outra; reduzido não anda", () => {
    const i = idasNovo();
    const sinais = [{ threadId: "t1", andar: "biblioteca", gravando: true, em: T0 }];
    avancarIdas(i, { magos: [mago("conv:t1", "trabalhando")], sinais, agora: T0 + 10 });
    let r = avancarIdas(i, { magos: [mago("conv:t1", "trabalhando")], sinais, agora: T0 + DESLOCAMENTO_MS + 10 });
    expect(r.get("conv:t1").pose).toBe("escrevendo-estante");
    r = avancarIdas(i, { magos: [mago("conv:t1", "esperando")], sinais, agora: T0 + DESLOCAMENTO_MS + 20 });
    expect(r.get("conv:t1").fase).toBe("voltando");

    const j = idasNovo();
    avancarIdas(j, { magos: [mago("conv:t1", "trabalhando")], sinais, agora: T0 });
    const r2 = avancarIdas(j, { magos: [mago("conv:t1", "trabalhando")], sinais: [{ threadId: "t1", andar: "atelie", em: T0 + 500 }], agora: T0 + 500 });
    expect(r2.get("conv:t1").fase).toBe("voltando");

    const k = idasNovo();
    const r3 = avancarIdas(k, { magos: [mago("conv:t1", "trabalhando")], sinais, agora: T0, reduzido: true });
    expect(r3.get("conv:t1")).toMatchObject({ fase: "la", pose: "escrevendo-estante" });
  });
});

describe("fila nos cristais e apagão", () => {
  const contasOk = [{ id: "a", uso: 0.3 }, { id: "b", uso: 0.5 }];
  const contasZero = [{ id: "a", uso: 1 }, { id: "b", bloqueada: true, uso: 0.2 }];

  it("conta apagada e todas apagadas", () => {
    expect(contaApagada({ uso: 1 })).toBe(true);
    expect(contaApagada({ uso: 0.9 })).toBe(false);
    expect(contaApagada({ semDado: true })).toBe(false);
    expect(todasApagadas(contasZero)).toBe(true);
    expect(todasApagadas(contasOk)).toBe(false);
    expect(todasApagadas([])).toBe(false);
  });

  it("fila por ordem de chegada, 4 lugares, avança quando abre vaga; quem recupera mana volta correndo", () => {
    const m = manaNovo();
    const magos = [mago("a", "sem-mana"), mago("b", "sem-mana")];
    let r = avancarMana(m, { magos, contas: contasOk, agora: T0 });
    expect(r.fila.get("a")).toMatchObject({ lugar: "banco-0", indice: 0, pose: "sentado-banco" });
    expect(r.fila.get("b")).toMatchObject({ lugar: "banco-1", indice: 1 });
    r = avancarMana(m, { magos: [...magos, mago("c", "sem-mana"), mago("d", "sem-mana"), mago("e", "sem-mana")], contas: contasOk, agora: T0 + 1 });
    expect(r.fila.get("c").pose).toBe("esperando-de-pe");
    expect(r.fila.get("e").escondido).toBe(true);
    expect(LUGARES).toHaveLength(4);
    // "a" recuperou: sai correndo e "b" passa pro banco-0
    r = avancarMana(m, { magos: [mago("a", "trabalhando"), mago("b", "sem-mana"), mago("c", "sem-mana")], contas: contasOk, agora: T0 + 2 });
    expect(r.voltaram).toEqual(["a"]);
    expect(r.fila.get("b").lugar).toBe("banco-0");
    expect(r.fila.get("c").lugar).toBe("banco-1");
  });

  it("apagão: todas as contas zeradas → luzes caem, susto, papéis por semente; volta = todos correm", () => {
    const m = manaNovo();
    const magos = [mago("a", "ocioso"), mago("b", "trabalhando"), mago("c", "ocioso")];
    avancarMana(m, { magos, contas: contasOk, agora: T0 });
    let r = avancarMana(m, { magos, contas: contasZero, agora: T0 + 100 });
    expect(r.apagao.fase).toBe("apagando");
    expect(r.luzes).toBe(1); // o apagão começa agora
    r = avancarMana(m, { magos, contas: contasZero, agora: T0 + 400 });
    expect(r.luzes).toBeCloseTo(1 - 300 / APAGANDO_MS, 2);
    expect([...r.apagao.papeis.values()].filter((p) => p === "tocha")).toHaveLength(1);
    expect([...r.apagao.pose.values()].every((p) => p === "susto")).toBe(true);
    r = avancarMana(m, { magos, contas: contasZero, agora: T0 + 100 + APAGANDO_MS + 10 });
    expect(r.apagao.fase).toBe("festa");
    expect(r.luzes).toBe(0);
    expect([...r.apagao.pose.values()].sort()).toEqual(["dancando", "dancando", "procurando-com-tocha"]);
    // mesma turma, mesma festa
    const m2 = manaNovo();
    avancarMana(m2, { magos, contas: contasZero, agora: T0 });
    expect([...m2.apagao.papeis]).toEqual([...m.apagao.papeis]);
    // voltou uma conta: luzes acendem, todo mundo corre
    r = avancarMana(m, { magos, contas: [{ id: "a", uso: 0.2 }, { id: "b", bloqueada: true }], agora: T0 + 5000 });
    expect(r.apagao).toBeNull();
    expect(r.voltaram.sort()).toEqual(["a", "b", "c"]);
    expect(r.acendendo).toBe(true);
    expect(r.voltando).toBe(true);
    expect(r.luzes).toBe(0);
  });

  it("primeiro retrato já no escuro: sem susto", () => {
    const m = manaNovo();
    const r = avancarMana(m, { magos: [mago("a", "ocioso")], contas: contasZero, agora: T0 });
    expect(r.apagao.pose.get("a")).toBe("dancando");
  });
});

describe("falas", () => {
  it("sorteia sem repetir antes de todas saírem e corta em 72", () => {
    const f = falasNovo();
    const vistas = new Set();
    for (let i = 0; i < FRASES.pedido.length; i++) vistas.add(frase(f, "pedido", {}, fixo(0)));
    expect(vistas.size).toBe(FRASES.pedido.length);
    const longa = frase(f, "pergunta", { texto: "x".repeat(200) }, fixo(0));
    expect(longa.length).toBeLessThanOrEqual(72);
    expect(longa.endsWith("…")).toBe(true);
  });

  it("eventos viram falas com prioridade; a de maior prioridade não é atropelada", () => {
    const f = falasNovo();
    aplicarEventosNasFalas(f, [{ tipo: "pedido", chave: "a" }], T0, fixo(0));
    expect(f.porMago.get("a").prioridade).toBe(PRIORIDADE.pedido);
    aplicarEventosNasFalas(f, [{ tipo: "mural", chave: "a", mudanca: "concluiu", titulo: "Login" }], T0 + 10, fixo(0));
    expect(f.porMago.get("a").categoria).toBe("pedido"); // 45 < 50, fica o pedido
    aplicarEventosNasFalas(f, [{ tipo: "voltou", chave: "a", ok: false }], T0 + 20, fixo(0));
    expect(f.porMago.get("a").categoria).toBe("pedido"); // 40 < 50 e o pedido ainda vale
    aplicarEventosNasFalas(f, [{ tipo: "voltou", chave: "a", ok: false }], T0 + 8_000, fixo(0)); // pedido expirou
    expect(FRASES.voltouMal).toContain(f.porMago.get("a").texto);
    const out = avancarFalas(f, [mago("a", "trabalhando")], T0 + 8_030, fixo(0));
    expect(out).toEqual([{ chave: "a", texto: f.porMago.get("a").texto, prioridade: PRIORIDADE.resultado, categoria: "resultado" }]);
    expect(avancarFalas(f, [mago("a", "trabalhando")], T0 + 20_000, fixo(0))).toEqual([]);
  });

  it("fixas pelo estado (pergunta, erro, mana, apagão) e teto de 7 na tela", () => {
    const f = falasNovo();
    const out = avancarFalas(f, [mago("q", "esperando", { pergunta: { texto: "Login com Google?" } }), mago("e", "erro"), mago("m", "sem-mana", { resetHora: "16:40" })], T0, fixo(0));
    expect(out.map((o) => o.categoria)).toEqual(["pergunta", "erro", "mana"]);
    expect(out[0].texto).toContain("Login com Google?");
    expect(out[2].texto).toContain("16:40");
    // respondeu: a fixa some
    expect(avancarFalas(f, [mago("q", "trabalhando")], T0 + 1, fixo(0))).toEqual([]);
    const g = falasNovo();
    const muitos = Array.from({ length: 10 }, (_, i) => mago(`m${i}`, "sem-mana"));
    expect(avancarFalas(g, muitos, T0, fixo(0))).toHaveLength(MAX_NA_TELA);
    const h = falasNovo();
    const ap = avancarFalas(h, [mago("a", "ocioso")], T0, fixo(0), { apagao: true, apagaoHora: "17:00" });
    expect(ap[0].categoria).toBe("apagao");
  });

  it("ócio: fala a cada 40–120 s com 60% de chance", () => {
    const f = falasNovo();
    const magos = [mago("a", "ocioso")];
    expect(avancarFalas(f, magos, T0, fixo(0))).toEqual([]);
    expect(avancarFalas(f, magos, T0 + OCIO_MIN_MS - 1, fixo(0))).toEqual([]);
    const out = avancarFalas(f, magos, T0 + OCIO_MIN_MS, fixo(0));
    expect(out[0].categoria).toBe("ocio");
    const g = falasNovo();
    avancarFalas(g, magos, T0, fixo(0.9));
    expect(avancarFalas(g, magos, T0 + 120_000, fixo(0.9))).toEqual([]); // 0.9 ≥ 60%: calado
  });
});

describe("lazer com saídas", () => {
  it("sorteia um lugar com vaga, fica e volta; pedido no meio = volta correndo", () => {
    const l = lazerNovo();
    const magos = [mago("a", "ocioso")];
    avancarLazer(l, { magos, agora: T0, sorteio: fixo(0) });
    let r = avancarLazer(l, { magos, agora: T0 + SORTEIO_MIN_MS, sorteio: fixo(0) });
    expect(r.get("a")).toMatchObject({ lugar: "janela", fase: "indo", pose: "andando" });
    r = avancarLazer(l, { magos, agora: T0 + SORTEIO_MIN_MS + IDA_MS, sorteio: fixo(0) });
    expect(r.get("a")).toMatchObject({ fase: "la", pose: "olhando-janela" });
    r = avancarLazer(l, { magos: [mago("a", "trabalhando")], agora: T0 + SORTEIO_MIN_MS + IDA_MS + 100, sorteio: fixo(0) });
    expect(r.get("a")).toMatchObject({ fase: "correndo", pose: "correndo" });
    r = avancarLazer(l, { magos: [mago("a", "trabalhando")], agora: T0 + SORTEIO_MIN_MS + IDA_MS + 100 + VOLTA_CORRENDO_MS, sorteio: fixo(0) });
    expect(r.size).toBe(0);
  });

  it("lugares têm teto; caldeirão tem fila e preparo; não repete o último; ocupado por outra camada não sai", () => {
    const l = lazerNovo();
    const magos = [mago("a", "ocioso"), mago("b", "ocioso"), mago("c", "ocioso")];
    avancarLazer(l, { magos, agora: T0, sorteio: fixo(0.99) });
    let r = avancarLazer(l, { magos, agora: T0 + SORTEIO_MIN_MS + 19_999, sorteio: fixo(0.99) });
    // 0.99 escolhe o último lugar com vaga: banco (2 vagas) pra a e b; c cai no anterior (caldeirão)
    expect(r.get("a").lugar).toBe("banco");
    expect(r.get("b").lugar).toBe("banco");
    expect(r.get("c").lugar).toBe("caldeirao");
    const t = T0 + SORTEIO_MIN_MS + 19_999 + IDA_MS + 10;
    r = avancarLazer(l, { magos, agora: t, sorteio: fixo(0.99) });
    expect(r.get("c").pose).toBe("servindo-cha");
    r = avancarLazer(l, { magos, agora: t + POIS.caldeirao.preparo, sorteio: fixo(0.99) });
    expect(r.get("c").pose).toBe("bebendo-cha");
    expect(POIS.estante.vagas).toBe(3);
    const o = lazerNovo();
    avancarLazer(o, { magos: [mago("z", "ocioso")], agora: T0, sorteio: fixo(0) });
    expect(avancarLazer(o, { magos: [mago("z", "ocioso")], agora: T0 + SORTEIO_MIN_MS, sorteio: fixo(0), ocupados: new Set(["z"]) }).size).toBe(0);
    expect(avancarLazer(o, { magos: [mago("z", "ocioso")], agora: T0 + 2 * SORTEIO_MIN_MS, sorteio: fixo(0), reduzido: true }).size).toBe(0);
  });
});

describe("estrela acesa e aceno ao clique", () => {
  it("estrela nova no mapa vira evento; livres olham pra cima, ocupados levantam a cabeça", () => {
    const f = feedVazio();
    const ag = (estrelas) => {
      f.planos.set("c:/p", [{ slug: "p", titulo: "P", estrelas }]);
      aplicarRetrato(f, [{ threadId: "t1", projectPath: "C:/p", busy: true, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], preview: "x" }], T0);
      return retratoDaTorre(torreModelo(f, T0), T0);
    };
    const r1 = ag(["feita", "pendente"]);
    const r2 = ag(["feita", "feita"]);
    const evs = torreEventos(r1, r2);
    expect(evs).toEqual([{ tipo: "estrela", torre: "c:/p" }]);
    const c = convivioNovo();
    const out = avancarConvivio(c, { magos: [mago("a", "ocioso"), mago("b", "trabalhando")], mesas: new Map([["a", 0], ["b", 1]]), eventos: evs, agora: T0, sorteio: fixo(0.9) });
    expect(out.get("a").pose).toBe("olhando-cima");
    expect(out.get("b").pose).toBe("levanta-cabeca");
    expect(avancarConvivio(c, { magos: [mago("a", "ocioso"), mago("b", "trabalhando")], mesas: new Map([["a", 0], ["b", 1]]), agora: T0 + OLHA_ESTRELA_MS + 1, sorteio: fixo(0.9) }).size).toBe(0);
  });

  it("clique: acena mesmo trabalhando", () => {
    const c = convivioNovo();
    expect(cumprimentar(c, "a", T0)).toBe(true);
    const out = avancarConvivio(c, { magos: [mago("a", "trabalhando")], mesas: new Map([["a", 0]]), agora: T0 + 10, sorteio: fixo(0) });
    expect(out.get("a").pose).toBe("acenando");
  });

  it("toda pose nova existe", () => {
    for (const p of ["olhando-janela", "lendo-estante", "escrevendo-estante", "servindo-cha", "bebendo-cha", "cochilando-banco", "esperando-de-pe", "correndo", "olhando-cima", "susto", "dancando", "procurando-com-tocha", "sentado-banco", "pintando", "olhando-telescopio", "acenando", "levanta-cabeca"]) {
      expect(POSES[p] ?? REACOES[p], p).toBeTruthy();
    }
  });
});
