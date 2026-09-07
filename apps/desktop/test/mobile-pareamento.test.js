import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CODIGO_LEN,
  codigoDaUrl,
  credencialGuardada,
  esquecer,
  guardar,
  limparCodigo,
  limparUrl,
} from "../../mobile/pareamento.js";

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
    expect(codigoDaUrl({ hash: "#c=AB3K9Z" })).toBe("AB3K9Z");
    expect(codigoDaUrl({ hash: "#c=000000" })).toBe("000000");
  });

  it("acha o código junto de outros pares", () => {
    expect(codigoDaUrl({ hash: "#a=1&c=AB3K9Z" })).toBe("AB3K9Z");
    expect(codigoDaUrl({ hash: "#c=AB3K9Z&a=1" })).toBe("AB3K9Z");
  });

  it("recusa o que o daemon não poderia ter sorteado", () => {
    const naoServe = [
      "",
      "#",
      "#c=",
      "#c=AB3K9", // curto
      "#c=AB3K9ZZ", // comprido
      "#c=ab3k9z", // o QR carrega maiúscula; minúscula não é o que ele gera
      "#c=AB3K9I", // I, L, O e U não existem no alfabeto
      "#c=AB3K9L",
      "#c=AB3K9O",
      "#c=AB3K9U",
      "#codigo=AB3K9Z",
      "#xc=AB3K9Z",
    ];
    for (const hash of naoServe) expect(codigoDaUrl({ hash }), JSON.stringify(hash)).toBe("");
  });

  it("ignora a query — o código vive no fragmento, que não trafega", () => {
    expect(codigoDaUrl({ hash: "", search: "?c=AB3K9Z" })).toBe("");
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
  /**
   * A MESMA tabela que `normalizarCodigo` usa no `pair.test.ts` do daemon. É
   * cópia de propósito: o app de celular é JS servido a um navegador e não
   * carrega o TypeScript do pacote compartilhado, então o que impede as duas
   * regras de divergirem é este par de testes.
   */
  it("desfaz só o que é confusão de leitura", () => {
    expect(limparCodigo("ab3-k9z")).toBe("AB3K9Z");
    expect(limparCodigo(" a b 3 ")).toBe("AB3");
    expect(limparCodigo("IL0O")).toBe("1100");
    expect(limparCodigo("")).toBe("");
    expect(limparCodigo(null)).toBe("");
  });

  it("tira o que não é do alfabeto", () => {
    expect(limparCodigo("a!b@3#k$9%z^")).toBe("AB3K9Z");
  });

  it("corta no tamanho do campo — e é só aqui que se corta", () => {
    // o daemon NÃO corta: lá, tentativa comprida é tentativa errada. Aqui corta
    // porque isto está moldando um campo de entrada.
    expect(limparCodigo("AB3K9ZZZZ")).toBe("AB3K9Z");
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

describe("o campo do código", () => {
  /**
   * Isto olha o HTML porque o defeito vive lá, não no módulo: o navegador corta
   * pelo `maxlength` ANTES de o `limparCodigo` rodar. Com `maxlength="6"`,
   * digitar "AB3 K9Z" virava "AB3 K9" e depois "AB3K9" — código incompleto, sem
   * pista do motivo. Achei driblando o app num navegador de verdade, e este
   * teste existe pra ninguém "arrumar" o 24 de volta pra 6.
   */
  const html = readFileSync(new URL("../../mobile/index.html", import.meta.url), "utf8");
  const campo = /<input\b[^>]*\bid="codigo"[^>]*>/s.exec(html)?.[0] ?? "";

  it("dá folga pra separador, porque quem conta é o limparCodigo", () => {
    const max = Number(/\bmaxlength="(\d+)"/.exec(campo)?.[1]);
    expect(campo, "campo #codigo não encontrado no HTML").not.toBe("");
    expect(max).toBeGreaterThan(CODIGO_LEN);
    // e o que o campo aceita tem que sobreviver à normalização inteiro
    expect(limparCodigo("AB3 K9Z".slice(0, max))).toBe("AB3K9Z");
    expect(limparCodigo("ab3-k9z".slice(0, max))).toBe("AB3K9Z");
  });

  it("não pede teclado numérico — o código tem letras", () => {
    expect(campo).not.toContain('inputmode="numeric"');
    expect(campo).toContain('autocapitalize="characters"');
  });
});
