import { describe, it, expect } from "vitest";
import { portaDaUrl, safeUrl, urlDoCelular } from "../url.js";

/*
 * `safeUrl` decide o que o iframe do preview carrega. O CSP da janela deixa
 * `frame-src http: https: about: data: blob:` — mais largo que isto de
 * propósito, pra não brigar com redirect de servidor de dev — então quem
 * segura `javascript:` e `file:` é esta função, não o CSP.
 */

describe("safeUrl", () => {
  it("vazio vira about:blank", () => {
    expect(safeUrl("")).toBe("about:blank");
    expect(safeUrl(null)).toBe("about:blank");
    expect(safeUrl("   ")).toBe("about:blank");
  });

  it("sem esquema assume https", () => {
    expect(safeUrl("exemplo.com")).toBe("https://exemplo.com/");
    expect(safeUrl("127.0.0.1:5173")).toBe("https://127.0.0.1:5173/");
  });

  it("http e https passam inteiros", () => {
    expect(safeUrl("http://127.0.0.1:5173/a?b=1")).toBe("http://127.0.0.1:5173/a?b=1");
    expect(safeUrl("https://exemplo.com/x#y")).toBe("https://exemplo.com/x#y");
  });

  it("javascript: não passa", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("about:blank");
    expect(safeUrl("  JaVaScRiPt:alert(1)  ")).toBe("about:blank");
  });

  it("file:, data: e blob: não passam", () => {
    expect(safeUrl("file:///etc/passwd")).toBe("about:blank");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("about:blank");
    expect(safeUrl("blob:https://exemplo.com/abc")).toBe("about:blank");
  });

  it("about: qualquer coisa normaliza pra about:blank", () => {
    expect(safeUrl("about:blank")).toBe("about:blank");
    expect(safeUrl("about:config")).toBe("about:blank");
  });

  it("esquema desconhecido cai em about:blank, não vira https", () => {
    // o prefixo https só entra quando NÃO há esquema; "algo:" já é um
    expect(safeUrl("algumacoisa:payload")).toBe("about:blank");
  });
});

describe("portaDaUrl", () => {
  it("porta explícita", () => {
    expect(portaDaUrl("http://127.0.0.1:5173/")).toBe(5173);
  });

  it("porta implícita por protocolo", () => {
    expect(portaDaUrl("http://a.b/")).toBe(80);
    expect(portaDaUrl("https://a.b/")).toBe(443);
  });

  it("url inválida vira 0 em vez de estourar", () => {
    expect(portaDaUrl("nada disso")).toBe(0);
    expect(portaDaUrl("")).toBe(0);
  });
});

describe("urlDoCelular", () => {
  it("monta o endereço que o celular abre", () => {
    expect(urlDoCelular("192.168.0.42", 7432)).toBe("http://192.168.0.42:7432/app/");
    expect(urlDoCelular("192.168.0.42", 7432, "AB3K9Z")).toBe("http://192.168.0.42:7432/app/#c=AB3K9Z");
  });

  it("põe IPv6 entre colchetes", () => {
    // endereço de Tailscale é IPv6, e sem colchete o navegador lê `fd7a` como
    // host e `115c` como porta — QR ninguém corrige na mão
    expect(urlDoCelular("fd7a:115c:a1e0::1", 7432, "AB3K9Z")).toBe(
      "http://[fd7a:115c:a1e0::1]:7432/app/#c=AB3K9Z",
    );
    expect(new URL(urlDoCelular("fd7a:115c:a1e0::1", 7432)).port).toBe("7432");
    // já entre colchetes não ganha um segundo par
    expect(urlDoCelular("[::1]", 7432)).toBe("http://[::1]:7432/app/");
  });

  it("só aceita o formato exato do código, e ignora o resto", () => {
    // o que não for código não entra no fragmento em vez de entrar torto: um QR
    // com código quebrado dentro é pior que um QR sem código
    const ruins = [
      "AB3K9", // curto
      "AB3K9ZZ", // comprido
      "ab3k9z", // minúscula não é o que o daemon sorteia
      "AB3K9I", // I, L, O e U estão fora do alfabeto
      "AB3K9L",
      "AB3K9O",
      "AB3K9U",
      "AB 3K9Z",
      "",
      null,
      undefined,
    ];
    for (const ruim of ruins) {
      expect(urlDoCelular("127.0.0.1", 7432, ruim), String(ruim)).toBe("http://127.0.0.1:7432/app/");
    }
  });

  it("aceita todo caractere que o alfabeto tem", () => {
    // se o regex esquecer uma faixa, o QR só perde o código em parte dos
    // sorteios — falha intermitente é a pior de achar
    const alfabeto = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (const c of alfabeto) {
      const codigo = c.repeat(6);
      expect(urlDoCelular("127.0.0.1", 7432, codigo), codigo).toContain(`#c=${codigo}`);
    }
  });

  it("cai no padrão quando host ou porta faltam", () => {
    expect(urlDoCelular("", 0)).toBe("http://127.0.0.1:7432/app/");
    expect(urlDoCelular(undefined, undefined)).toBe("http://127.0.0.1:7432/app/");
  });
});
