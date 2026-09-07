import { beforeEach, describe, expect, it } from "vitest";
import { PAIR_ALFABETO, PAIR_CODE_LEN, PAIR_MAX_ERROS, PAIR_TTL_MS, normalizarCodigo } from "@nexo/shared";
import {
  abrirPareamento,
  fecharPareamento,
  pareamentoAberto,
  resetPairForTest,
  resgatar,
} from "../src/pair.ts";

const T0 = 1_800_000_000_000;

beforeEach(resetPairForTest);

describe("abrir", () => {
  it("dá um código do tamanho declarado, todo dentro do alfabeto", () => {
    const p = abrirPareamento(T0);
    expect(p.codigo).toMatch(new RegExp(`^[${PAIR_ALFABETO}]{${PAIR_CODE_LEN}}$`));
    expect(p.expiraEm).toBe(T0 + PAIR_TTL_MS);
  });

  it("nunca encurta, e nunca sorteia I, L, O nem U", () => {
    // as três primeiras se confundem com 1, 1 e 0 numa tela lida de longe, e a
    // normalização as aceita de volta — sortear uma delas criaria o código que
    // é impossível digitar certo
    for (let i = 0; i < 400; i++) {
      const c = abrirPareamento(T0).codigo;
      expect(c).toHaveLength(PAIR_CODE_LEN);
      expect(c).not.toMatch(/[ILOU]/);
    }
  });

  it("usa o alfabeto inteiro — um sorteio enviesado encolheria o espaço", () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 3000; i++) for (const c of abrirPareamento(T0).codigo) vistos.add(c);
    expect([...vistos].sort().join("")).toBe([...PAIR_ALFABETO].sort().join(""));
  });

  it("pedir um novo invalida o anterior: código vivo a mais é chance a mais", () => {
    const velho = abrirPareamento(T0);
    abrirPareamento(T0);
    expect(resgatar(velho.codigo, T0)).toMatchObject({ ok: false });
  });
});

describe("resgatar", () => {
  it("o código certo abre uma vez", () => {
    const p = abrirPareamento(T0);
    expect(resgatar(p.codigo, T0)).toEqual({ ok: true });
  });

  it("e SÓ uma vez: código reusável seria um token curto", () => {
    const p = abrirPareamento(T0);
    resgatar(p.codigo, T0);
    expect(resgatar(p.codigo, T0)).toMatchObject({ ok: false });
  });

  it("expira", () => {
    const p = abrirPareamento(T0);
    expect(resgatar(p.codigo, T0 + PAIR_TTL_MS)).toMatchObject({ ok: false });
    expect(pareamentoAberto(T0 + PAIR_TTL_MS)).toBeNull();
  });

  it("erro demais queima o código, e é isso que faz 6 caracteres bastarem", () => {
    const p = abrirPareamento(T0);
    for (let i = 0; i < PAIR_MAX_ERROS - 1; i++) {
      expect(resgatar("ZZZZZZ", T0)).toMatchObject({ ok: false, motivo: "código errado" });
    }
    // a última tentativa errada não só falha: derruba o pareamento
    expect(resgatar("ZZZZZZ", T0).ok).toBe(false);
    expect(pareamentoAberto(T0)).toBeNull();
    expect(resgatar(p.codigo, T0)).toMatchObject({ ok: false });
  });

  it("sem pareamento aberto não vaza se o código existia ou expirou", () => {
    const a = resgatar("ZZZZZZ", T0).ok === false ? resgatar("ZZZZZZ", T0) : null;
    abrirPareamento(T0);
    const b = resgatar("ZZZZZZ", T0 + PAIR_TTL_MS);
    expect(a && "motivo" in a && a.motivo).toBe(b && "motivo" in b && b.motivo);
  });

  it("recusa o que não é string sem quebrar", () => {
    abrirPareamento(T0);
    for (const lixo of [null, undefined, 123456, {}, []]) {
      expect(resgatar(lixo, T0)).toMatchObject({ ok: false });
    }
  });

  it("espaço em volta não atrapalha: o celular cola com espaço", () => {
    const p = abrirPareamento(T0);
    expect(resgatar(`  ${p.codigo} `, T0)).toEqual({ ok: true });
  });

  it("aceita minúscula, separador, e o I lido no lugar do 1", () => {
    // quem lê o código na tela erra por confusão de forma, não por desatenção;
    // cobrar uma tentativa por isso gastaria o teto de 5 em falha nossa
    const p = abrirPareamento(T0);
    const digitado = p.codigo
      .toLowerCase()
      .replace(/1/g, "i")
      .replace(/0/g, "o")
      .split("")
      .join(" ");
    expect(resgatar(digitado, T0)).toEqual({ ok: true });
  });

  it("normalizar não abre atalho: código com sobra é código errado", () => {
    const p = abrirPareamento(T0);
    // cortar no tamanho faria o prefixo certo valer pelo código inteiro
    expect(resgatar(p.codigo + "Z", T0)).toMatchObject({ ok: false });
  });
});

describe("normalizarCodigo", () => {
  it("desfaz só o que é confusão de leitura", () => {
    expect(normalizarCodigo("ab3-k9z")).toBe("AB3K9Z");
    expect(normalizarCodigo(" a b 3 ")).toBe("AB3");
    expect(normalizarCodigo("IL0O")).toBe("1100");
    expect(normalizarCodigo("")).toBe("");
    expect(normalizarCodigo(null)).toBe("");
  });

  it("tira o que não é do alfabeto, e não trunca", () => {
    expect(normalizarCodigo("a!b@3#k$9%z^")).toBe("AB3K9Z");
    expect(normalizarCodigo("ABC123XYZ")).toBe("ABC123XYZ");
  });

  it("é idempotente — normalizar duas vezes dá o mesmo", () => {
    for (const s of ["ab3-k9z", "IL0O", "a!b@3", "0123456789"]) {
      expect(normalizarCodigo(normalizarCodigo(s))).toBe(normalizarCodigo(s));
    }
  });
});

describe("pareamentoAberto", () => {
  it("some quando fecha e quando expira", () => {
    abrirPareamento(T0);
    expect(pareamentoAberto(T0)).not.toBeNull();
    fecharPareamento();
    expect(pareamentoAberto(T0)).toBeNull();
  });
});
