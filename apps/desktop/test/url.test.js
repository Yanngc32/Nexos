import { describe, it, expect } from "vitest";
import { portaDaUrl, safeUrl } from "../url.js";

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
