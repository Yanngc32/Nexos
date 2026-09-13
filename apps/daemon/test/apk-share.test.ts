import { beforeEach, describe, expect, it } from "vitest";
import { APK_CODE_LEN, APK_MAX_ERROS, APK_TTL_MS, PAIR_ALFABETO } from "@nexo/shared";
import {
  abrirDownload,
  downloadAberto,
  fecharDownload,
  resetApkShareForTest,
  resgatarDownload,
} from "../src/apk-share.ts";

const T0 = 1_800_000_000_000;

beforeEach(resetApkShareForTest);

describe("abrir", () => {
  it("dá um código do tamanho declarado, todo dentro do alfabeto", () => {
    const d = abrirDownload(T0);
    expect(d.codigo).toMatch(new RegExp(`^[${PAIR_ALFABETO}]{${APK_CODE_LEN}}$`));
    expect(d.expiraEm).toBe(T0 + APK_TTL_MS);
  });

  it("pedir um novo invalida o anterior", () => {
    const velho = abrirDownload(T0);
    abrirDownload(T0);
    expect(resgatarDownload(velho.codigo, T0)).toMatchObject({ ok: false });
  });
});

describe("resgatar", () => {
  it("o código certo abre uma vez", () => {
    const d = abrirDownload(T0);
    expect(resgatarDownload(d.codigo, T0)).toEqual({ ok: true });
  });

  it("e SÓ uma vez: código reusável seria um link permanente", () => {
    const d = abrirDownload(T0);
    resgatarDownload(d.codigo, T0);
    expect(resgatarDownload(d.codigo, T0)).toMatchObject({ ok: false });
  });

  it("expira", () => {
    const d = abrirDownload(T0);
    expect(resgatarDownload(d.codigo, T0 + APK_TTL_MS)).toMatchObject({ ok: false });
    expect(downloadAberto(T0 + APK_TTL_MS)).toBeNull();
  });

  it("erro demais queima o código", () => {
    const d = abrirDownload(T0);
    for (let i = 0; i < APK_MAX_ERROS - 1; i++) {
      expect(resgatarDownload("ZZZZZZ", T0)).toMatchObject({ ok: false, motivo: "código errado" });
    }
    expect(resgatarDownload("ZZZZZZ", T0).ok).toBe(false);
    expect(downloadAberto(T0)).toBeNull();
    expect(resgatarDownload(d.codigo, T0)).toMatchObject({ ok: false });
  });
});

describe("estado independente do pareamento", () => {
  it("fechar o download não mexe num pareamento aberto em paralelo, e vice-versa — são módulos separados", () => {
    // a garantia real está em `apk-share.ts` ser um módulo com `vivo` próprio,
    // não importado de `pair.ts`; este teste só confere que abrir/fechar aqui
    // não lança nem depende de nada de fora
    const d = abrirDownload(T0);
    fecharDownload();
    expect(downloadAberto(T0)).toBeNull();
    expect(resgatarDownload(d.codigo, T0)).toMatchObject({ ok: false });
  });
});
