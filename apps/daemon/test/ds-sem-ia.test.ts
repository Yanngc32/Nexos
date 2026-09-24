import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { criarDs, estadoDs, tokensParaCss } from "../src/design-system.ts";
import { coletaVazia } from "../src/ds-coleta.ts";
import { conferirTokens, contraste, paraRgb } from "../src/ds-conformidade.ts";
import { designSemIa } from "../src/ds-sem-ia.ts";

function tokensDoEsqueleto(): unknown {
  const home = tempHome();
  const proj = mkdtempSync(join(tmpdir(), "nexo-semia-"));
  criarDs(proj, home, { nome: "Base" });
  return estadoDs(proj, home).ds!.tokens;
}

describe("conferirTokens", () => {
  it("o esqueleto padrão do Nexos passa (base e tema claro)", () => {
    expect(conferirTokens(tokensDoEsqueleto())).toEqual([]);
  });

  it("contraste calculado de verdade, por tema e seguindo referência", () => {
    expect(contraste(paraRgb("#000")!, paraRgb("#ffffff")!)).toBeCloseTo(21, 0);
    const tokens = {
      color: {
        bg: { $value: "#ffffff", $extensions: { "nexos.temas": { escuro: "#111111" } } },
        text: { $value: "#222222" },
        primary: { $value: "#ffcc00" },
        "on-primary": { $value: "{color.bg}" },
      },
    };
    const avisos = conferirTokens(tokens);
    expect(avisos.some((a) => a.includes("color.text sobre color.bg (tema escuro)"))).toBe(true);
    expect(avisos.some((a) => a.startsWith("contraste de color.on-primary sobre color.primary"))).toBe(true);
    expect(avisos.some((a) => a.startsWith("contraste de color.text sobre color.bg é"))).toBe(false);
  });

  it("escala de fonte, espaço e raio fora de ordem", () => {
    const avisos = conferirTokens({
      font: { size: { sm: { $value: "14px" }, md: { $value: "0.8rem" }, lg: { $value: { value: 20, unit: "px" } } } },
      space: { "1": { $value: "8px" }, "2": { $value: "4px" } },
      radius: { sm: { $value: "8px" }, md: { $value: "4px" } },
    });
    expect(avisos).toEqual([
      "font.size.md (12.8px) não é maior que font.size.sm (14px): a escala tem que subir",
      "escala de espaço com 2 passo(s): precisa de pelo menos 3 (space.1…)",
      "space.2 não é maior que space.1: a escala tem que subir",
      "radius.md é menor que radius.sm",
    ]);
  });
});

describe("designSemIa", () => {
  it("página clara de loja: papéis por luminância/saturação, secundária de outra matiz, tema antigo sai", () => {
    const r = designSemIa({
      nome: "Loja",
      base: tokensDoEsqueleto(),
      referencia: {
        url: "https://loja.test/",
        dados: {
          cores: {
            fundo: [["#ffffff", 200], ["#f5f5f5", 30], ["#ffe600", 12], ["#000000@40%", 50]],
            texto: [["#333333", 80], ["#737373", 20], ["#3483fa", 15]],
            borda: [["#e6e6e6", 10]],
          },
          botoes: [{ fundo: "#3483fa" }],
          fontes: [["Font Awesome", 3], ["Proxima Nova", 40]],
          tamanhos: [["16px", 40], ["14px", 30], ["12px", 10], ["20px", 5], ["24px", 3], ["36px", 1]],
          pesos: [["400", 50], ["600", 20], ["700", 5]],
          transicoes: [["0.2s ease-out", 10]],
        },
      },
    });
    const t = r.tokens as any;
    expect(t.color.bg).toEqual({ $value: "#ffffff" }); // sem o "claro" do esqueleto escuro
    expect(t.color.surface.$value).toBe("#f5f5f5");
    expect(t.color.text.$value).toBe("#333333");
    expect(t.color.muted.$value).toBe("#737373");
    expect(t.color.primary.$value).toBe("#3483fa");
    expect(t.color.secondary.$value).toBe("#ffe600");
    expect(t.color.success.$value).toBe("#22c55e"); // sem dado: fica o que era
    expect(t.font.family.body.$value).toEqual(["Proxima Nova", "system-ui", "sans-serif"]);
    expect(t.font.size.md.$value).toBe("16px");
    expect(["xs", "sm", "md", "lg", "xl", "2xl"].map((k) => t.font.size[k].$value)).toEqual(["12px", "14px", "16px", "20px", "24px", "36px"]);
    expect(t.motion.duration.base.$value).toBe("200ms");
    expect(conferirTokens(t)).toEqual([]);
    expect(tokensParaCss(t).vars.find((v) => v.nome === "--color-primary")!.valor).toBe("#3483fa");
    expect(r.designMd).toContain("| `--color-primary` | `#3483fa` |");
    expect(r.designMd).toContain("https://loja.test/");
  });

  it("só código: papéis pelas variáveis semânticas; sem dado nenhum, os tokens ficam como estavam", () => {
    const base = tokensDoEsqueleto();
    const coleta = { ...coletaVazia(), variaveis: [["--background", "#fafafa"], ["--foreground", "#0a0a0a"], ["--primary", "#2255ee"]] as [string, string][] };
    const t = designSemIa({ nome: "X", base, coleta }).tokens as any;
    expect([t.color.bg.$value, t.color.text.$value, t.color.primary.$value, t.color["on-primary"].$value]).toEqual(["#fafafa", "#0a0a0a", "#2255ee", "#ffffff"]);
    expect(designSemIa({ nome: "X", base, coleta: coletaVazia() }).tokens).toEqual(base);
  });

  it("aviso de conformidade vira Pendências no DESIGN.md", () => {
    const r = designSemIa({ nome: "X", base: { space: { "1": { $value: "4px" } } }, coleta: coletaVazia() });
    expect(r.designMd).toContain("## Pendências");
    expect(r.designMd).toContain("escala de espaço com 1 passo");
  });
});
