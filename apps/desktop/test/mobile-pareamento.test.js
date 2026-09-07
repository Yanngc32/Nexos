import { describe, expect, it, vi } from "vitest";
import { codigoDaUrl, credencialGuardada, esquecer, guardar, limparCodigo, limparUrl } from "../../mobile/pareamento.js";

/**
 * O app de celular mora em `apps/mobile`, que de propósito não tem
 * `package.json` — assim o pnpm o ignora e nada ali precisa de instalação. O
 * preço é que ele não tem vitest próprio, então os testes dele rodam por aqui.
 * Vale mais que a alternativa, que era não testá-lo.
 */

const store = () => {
  const mapa = new Map();
  return {
    getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
    setItem: (k, v) => mapa.set(k, String(v)),
    removeItem: (k) => mapa.delete(k),
  };
};

describe("codigoDaUrl", () => {
  it("lê o código que o QR pôs no fragmento", () => {
    expect(codigoDaUrl({ hash: "#c=004217" })).toBe("004217");
    expect(codigoDaUrl({ hash: "#c=000000" })).toBe("000000");
  });

  it("acha o código junto de outros pares", () => {
    expect(codigoDaUrl({ hash: "#a=1&c=123456" })).toBe("123456");
    expect(codigoDaUrl({ hash: "#c=123456&a=1" })).toBe("123456");
  });

  it("não é código o que não são exatamente 6 dígitos", () => {
    for (const hash of ["", "#", "#c=", "#c=12345", "#c=1234567", "#c=abcdef", "#codigo=123456", "#xc=123456"]) {
      expect(codigoDaUrl({ hash }), JSON.stringify(hash)).toBe("");
    }
  });

  it("ignora a query — o código vive no fragmento, que não trafega", () => {
    expect(codigoDaUrl({ hash: "", search: "?c=123456" })).toBe("");
  });
});

describe("limparUrl", () => {
  it("tira o fragmento da barra, preservando o caminho e a query", () => {
    const hist = { replaceState: vi.fn() };
    limparUrl({ hash: "#c=004217", pathname: "/app/", search: "?x=1" }, hist);
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", "/app/?x=1");
  });

  it("não mexe no histórico quando não há fragmento", () => {
    const hist = { replaceState: vi.fn() };
    limparUrl({ hash: "", pathname: "/app/", search: "" }, hist);
    expect(hist.replaceState).not.toHaveBeenCalled();
  });

  it("navegador que recusa replaceState não derruba a tela", () => {
    const hist = {
      replaceState: () => {
        throw new Error("bloqueado");
      },
    };
    expect(() => limparUrl({ hash: "#c=1", pathname: "/app/", search: "" }, hist)).not.toThrow();
  });
});

describe("limparCodigo", () => {
  it("tira o que o teclado do celular deixa passar", () => {
    expect(limparCodigo("004 217")).toBe("004217");
    expect(limparCodigo("004-217")).toBe("004217");
    expect(limparCodigo("0042170000")).toBe("004217");
    expect(limparCodigo(null)).toBe("");
  });
});

describe("credencial guardada", () => {
  it("guarda e devolve", () => {
    const s = store();
    guardar({ token: "abc", base: "http://x:1" }, s);
    expect(credencialGuardada(s)).toEqual({ token: "abc", base: "http://x:1" });
    esquecer(s);
    expect(credencialGuardada(s)).toBe(null);
  });

  it("lixo no localStorage não derruba o app", () => {
    const s = store();
    s.setItem("nexo.mobile.credencial", "{isso não é json");
    expect(credencialGuardada(s)).toBe(null);
    s.setItem("nexo.mobile.credencial", JSON.stringify({ base: "http://x:1" }));
    expect(credencialGuardada(s), "sem token não é credencial").toBe(null);
  });
});
