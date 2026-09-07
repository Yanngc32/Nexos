import { beforeEach, describe, expect, it } from "vitest";
import { PAIR_CODE_DIGITS, PAIR_MAX_ERROS, PAIR_TTL_MS } from "@nexo/shared";
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
  it("dá um código do tamanho declarado, só dígitos", () => {
    const p = abrirPareamento(T0);
    expect(p.codigo).toMatch(new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`));
    expect(p.expiraEm).toBe(T0 + PAIR_TTL_MS);
  });

  it("zero à esquerda é código válido: o espaço é 10^N, não 'número de N dígitos'", () => {
    // sortear 10^6 vezes acharia um, mas o que importa é a forma: nunca encurta
    for (let i = 0; i < 300; i++) {
      expect(abrirPareamento(T0).codigo).toHaveLength(PAIR_CODE_DIGITS);
    }
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

  it("erro demais queima o código, e é isso que faz 6 dígitos bastarem", () => {
    const p = abrirPareamento(T0);
    for (let i = 0; i < PAIR_MAX_ERROS - 1; i++) {
      expect(resgatar("000000", T0)).toMatchObject({ ok: false, motivo: "código errado" });
    }
    // a última tentativa errada não só falha: derruba o pareamento
    expect(resgatar("000000", T0).ok).toBe(false);
    expect(pareamentoAberto(T0)).toBeNull();
    expect(resgatar(p.codigo, T0)).toMatchObject({ ok: false });
  });

  it("sem pareamento aberto não vaza se o código existia ou expirou", () => {
    const a = resgatar("123456", T0).ok === false ? resgatar("123456", T0) : null;
    abrirPareamento(T0);
    const b = resgatar("123456", T0 + PAIR_TTL_MS);
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
});

describe("pareamentoAberto", () => {
  it("some quando fecha e quando expira", () => {
    abrirPareamento(T0);
    expect(pareamentoAberto(T0)).not.toBeNull();
    fecharPareamento();
    expect(pareamentoAberto(T0)).toBeNull();
  });
});
