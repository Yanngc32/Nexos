import { describe, expect, it } from "vitest";
import {
  ACENO_MS,
  APONTA_MS,
  APONTA_REPETE_MS,
  avancarConvivio,
  CONVERSA_MS,
  convivioNovo,
  ESPIA_IDA_MS,
  livre,
  SORTEIO_MIN_MS,
  vizinhos,
} from "../torre/convivio.js";
import { POSES, POSES_DE_OCIO, REACOES } from "../torre/poses.js";
import { CRISTAIS, corDaConta, cristalDe, CRISTAL_APAGADO, mascaraDoMago, MAGO_H } from "../torre/arte.js";

const T0 = 500_000;
const mago = (chave, estado, extra = {}) => ({ chave, estado, comemorando: false, ...extra });
const mesas = (...chaves) => new Map(chaves.map((k, i) => [k, i]));
const fixo = (v) => () => v;

describe("convívio", () => {
  it("vizinhos: ao lado na fileira e o de cima/baixo na coluna", () => {
    const m = mesas("a", "b", "c", "d", "e", "f");
    expect(vizinhos(m, "a").sort()).toEqual(["b", "e"]);
    expect(vizinhos(m, "b").sort()).toEqual(["a", "c", "f"]);
    expect(vizinhos(m, "d")).toEqual(["c"]);
  });

  it("livre = ocioso/terminou sem comemorar; tarefa ativa e esperando nunca interagem", () => {
    expect(livre(mago("a", "ocioso"))).toBe(true);
    expect(livre(mago("a", "terminou", { comemorando: true }))).toBe(false);
    expect(livre(mago("a", "trabalhando"))).toBe(false);
    expect(livre(mago("a", "esperando"))).toBe(false);
  });

  it("sorteio: dois vizinhos livres conversam, alternando quem fala; o par para junto", () => {
    const c = convivioNovo();
    const magos = [mago("a", "ocioso"), mago("b", "ocioso")];
    const m = mesas("a", "b");
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0, sorteio: fixo(0) }).size).toBe(0);
    const t1 = T0 + SORTEIO_MIN_MS;
    const out = avancarConvivio(c, { magos, mesas: m, agora: t1, sorteio: fixo(0) });
    expect(out.get("a")).toMatchObject({ tipo: "conversando", alvo: "b", pose: "conversando", espelho: false });
    expect(out.get("b")).toMatchObject({ tipo: "conversando", alvo: "a", pose: "ouvindo", espelho: true });
    const depois = avancarConvivio(c, { magos, mesas: m, agora: t1 + 1_300, sorteio: fixo(0) });
    expect(depois.get("a").pose).toBe("ouvindo");
    expect(depois.get("b").pose).toBe("conversando");
    // "a" recebeu pedido: interrompe os dois na hora
    const fim = avancarConvivio(c, { magos: [mago("a", "trabalhando"), mago("b", "ocioso")], mesas: m, agora: t1 + 2_000, sorteio: fixo(0) });
    expect(fim.size).toBe(0);
    expect(avancarConvivio(c, { magos, mesas: m, agora: t1 + CONVERSA_MS + 1, sorteio: fixo(0) }).size).toBe(0);
  });

  it("sorteio: livre espia o vizinho que trabalha (vai, olha, volta); reduzido só olha", () => {
    const c = convivioNovo();
    const magos = [mago("a", "ocioso"), mago("b", "trabalhando")];
    const m = mesas("a", "b");
    avancarConvivio(c, { magos, mesas: m, agora: T0, sorteio: fixo(0.9) });
    const t1 = T0 + SORTEIO_MIN_MS + 18_000;
    expect(avancarConvivio(c, { magos, mesas: m, agora: t1, sorteio: fixo(0.9) }).get("a")).toMatchObject({ tipo: "espiando", progresso: 0 });
    const ida = avancarConvivio(c, { magos, mesas: m, agora: t1 + 400, sorteio: fixo(0.9) });
    expect(ida.get("a")).toMatchObject({ tipo: "espiando", alvo: "b", fase: "indo", pose: "andando" });
    expect(ida.get("a").progresso).toBeCloseTo(0.5);
    expect(ida.has("b")).toBe(false);
    const olha = avancarConvivio(c, { magos, mesas: m, agora: t1 + ESPIA_IDA_MS + 100, sorteio: fixo(0.9) });
    expect(olha.get("a")).toMatchObject({ fase: "olhando", pose: "espiando", progresso: 1 });
    const volta = avancarConvivio(c, { magos, mesas: m, agora: t1 + ESPIA_IDA_MS + 3_000 + 400, sorteio: fixo(0.9) });
    expect(volta.get("a")).toMatchObject({ fase: "voltando", pose: "andando", espelho: true });

    const r = convivioNovo();
    avancarConvivio(r, { magos, mesas: m, agora: T0, sorteio: fixo(0.9), reduzido: true });
    const red = avancarConvivio(r, { magos, mesas: m, agora: t1 + 100, sorteio: fixo(0.9), reduzido: true });
    expect(red.size).toBe(0); // sem andar: espiar nem começa com movimento reduzido
  });

  it("terminou: vizinhos livres comemoram junto, ocupados levantam a cabeça, esperando não", () => {
    const c = convivioNovo();
    // mesas: a=0, b=1, e=2 (fileira de cima); c=4 (embaixo de a)
    const magos = [mago("a", "terminou", { comemorando: true }), mago("b", "ocioso"), mago("e", "esperando"), mago("x", "ocioso"), mago("c", "trabalhando")];
    const m = mesas("a", "b", "e", "x", "c");
    const out = avancarConvivio(c, { magos, mesas: m, eventos: [{ tipo: "terminou", chave: "a" }], agora: T0, sorteio: fixo(0.9) });
    expect(out.get("b")).toMatchObject({ tipo: "comemorando-junto", alvo: "a" });
    expect(out.get("c")).toMatchObject({ tipo: "levanta-cabeca", alvo: "a" });
    expect(out.has("e")).toBe(false);
    expect(out.has("a")).toBe(false);
  });

  it("alguém espera você: livres apontam, ocupados olham; repete a cada 15 s enquanto durar", () => {
    const c = convivioNovo();
    const magos = [mago("q", "esperando"), mago("b", "ocioso"), mago("c", "trabalhando")];
    const m = mesas("q", "b", "c");
    const out = avancarConvivio(c, { magos, mesas: m, eventos: [{ tipo: "pergunta", chave: "q" }], agora: T0, sorteio: fixo(0.9) });
    expect(out.get("b")).toMatchObject({ tipo: "apontando", alvo: "q", espelho: true });
    expect(out.get("c")).toMatchObject({ tipo: "olhando", alvo: "q", espelho: true });
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0 + APONTA_MS + 10, sorteio: fixo(0.9) }).size).toBe(0);
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0 + APONTA_REPETE_MS + 1, sorteio: fixo(0.9) }).get("b")?.tipo).toBe("apontando");
    // respondeu: ninguém aponta mais
    const resp = [mago("q", "trabalhando"), mago("b", "ocioso"), mago("c", "trabalhando")];
    expect(avancarConvivio(c, { magos: resp, mesas: m, agora: T0 + 2 * APONTA_REPETE_MS + 5, sorteio: fixo(0.9) }).size).toBe(0);
  });

  it("quem já esperava quando a aba abriu: ninguém aponta no primeiro tique, só depois de 15 s", () => {
    const c = convivioNovo();
    const magos = [mago("q", "esperando"), mago("b", "ocioso")];
    const m = mesas("q", "b");
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0, sorteio: fixo(0.9) }).has("b")).toBe(false);
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0 + APONTA_REPETE_MS + 1, sorteio: fixo(0.9) }).get("b")?.tipo).toBe("apontando");
  });

  it("quem chega acena e os livres acenam de volta; ocupado não", () => {
    const c = convivioNovo();
    const magos = [mago("n", "ocioso"), mago("b", "ocioso"), mago("c", "trabalhando")];
    const m = mesas("n", "b", "c");
    const out = avancarConvivio(c, { magos, mesas: m, eventos: [{ tipo: "entrou", chave: "n" }], agora: T0, sorteio: fixo(0.9) });
    expect(out.get("n")).toMatchObject({ tipo: "acenando", alvo: "" });
    expect(out.get("b")).toMatchObject({ tipo: "acenando", alvo: "n" });
    expect(out.has("c")).toBe(false);
    expect(avancarConvivio(c, { magos, mesas: m, agora: T0 + ACENO_MS + 1, sorteio: fixo(0.9) }).size).toBe(0);
  });

  it("nunca duas interações no mesmo mago", () => {
    const c = convivioNovo();
    const magos = [mago("q", "esperando"), mago("b", "ocioso"), mago("n", "ocioso")];
    const m = mesas("q", "b", "n");
    const out = avancarConvivio(c, { magos, mesas: m, eventos: [{ tipo: "entrou", chave: "n" }], agora: T0, sorteio: fixo(0.9) });
    expect(out.get("b").tipo).toBe("acenando");
    expect(out.get("n").tipo).toBe("acenando");
    expect([...out.values()].filter((a) => a.tipo === "apontando")).toHaveLength(0);
  });

  it("toda pose do convívio e do ócio existe", () => {
    for (const p of ["conversando", "ouvindo", "espiando", "andando", "acenando", "apontando", "olhando", "comemorando-junto", "levanta-cabeca", ...POSES_DE_OCIO]) {
      expect(POSES[p] ?? REACOES[p], p).toBeTruthy();
    }
  });
});

describe("cores: gema e cristais", () => {
  it("cristal: cor estável por conta, nível pelo brilho; apagado é cinza", () => {
    expect(corDaConta("2d")).toBe(corDaConta("2D"));
    const a = cristalDe(corDaConta("2d"), "cheio");
    const b = cristalDe(corDaConta("2d"), "medio");
    const c = cristalDe(corDaConta("2d"), "pouco");
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(cristalDe(3, "apagado")).toBe(CRISTAL_APAGADO);
    expect(CRISTAIS.apagado).toBe(CRISTAL_APAGADO);
  });

  it("mago entrando no chapéu: corte some com o corpo, chapéu fica", () => {
    const m = mascaraDoMago("normal", "parado", 17);
    expect(m.slice(MAGO_H - 17).every((l) => !l.includes("c"))).toBe(true);
    expect(m[2]).toContain("c");
  });
});
