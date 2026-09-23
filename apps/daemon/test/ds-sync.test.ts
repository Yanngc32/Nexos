import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { addProfile } from "../src/profiles.ts";
import { criarDs, estadoDs } from "../src/design-system.ts";
import { aplicarRessincronia, blocoDoDsParaPack, conformidade, exportar, ressincronizar } from "../src/ds-sync.ts";
import { createThread } from "../src/threads.ts";
import { getLive, postMessage } from "../src/session.ts";
import type { StubEngine } from "../src/engines/stub.ts";

let home: string;
let proj: string;
beforeEach(() => {
  home = tempHome();
  proj = mkdtempSync(join(tmpdir(), "nexo-sync-"));
  mkdirSync(join(proj, "src"));
  // esqueleto tem color.primary #c81e2c e color.bg #161616
  writeFileSync(
    join(proj, "src", "app.css"),
    [
      "/* #ffffff em comentário não conta */",
      "#main { color: #c81e2c; }", // seletor de id não conta; #c81e2c é exato
      ".a { background: #c91f2d; }", // quase o primário
      ".b { color: #00ff88; }", // fora da paleta
      ".c { color: #00ff88; } .d { border-color: #00ff88; } .e{color:#00ff88}",
    ].join("\n"),
  );
  writeFileSync(join(proj, "src", "App.tsx"), `export const A = () => <a href="#topo" style={{ color: "#161616" }}>x</a>;`);
});

describe("conformidade", () => {
  it("acha cor solta, diz o token exato ou o mais perto, e ignora comentário/âncora/seletor de id", () => {
    criarDs(proj, home, { nome: "Teste" });
    const r = conformidade(proj, home);
    const valores = r.achados.map((a) => a.valor.toLowerCase());
    expect(valores).not.toContain("#ffffff");
    expect(valores).not.toContain("#main");
    expect(valores).not.toContain("#topo");
    const exato = r.achados.find((a) => a.valor === "#c81e2c")!;
    expect(exato.exato).toBe("--color-primary");
    const quase = r.achados.find((a) => a.valor === "#c91f2d")!;
    expect(quase.sugestao?.token).toBe("--color-primary");
    expect(quase.sugestao!.distancia).toBeLessThan(40);
    expect(r.achados.find((a) => a.arquivo === "src/App.tsx")?.exato).toBe("--color-bg");
    expect(r.foraDaPaleta).toBeGreaterThanOrEqual(4);
    expect(r.porArquivo[0]!.arquivo).toBe("src/app.css");
    expect(r.achados.every((a) => a.tipo === "cor")).toBe(true);
  });

  it("tamanho solto em fonte, espaçamento e raio: token exato, perto (1px) ou fora da escala", () => {
    writeFileSync(
      join(proj, "src", "medidas.css"),
      [
        ".a { font-size: 13px; padding: 16px 1px 0 20px; }", // 13 = sm; 16 = space-4; 1px e 0 não contam; 20 fora (16 e 24)
        ".b { border-radius: 9px; gap: 1.5rem; }", // 9 ≈ md (8); 1.5rem = 24px = space-5
        ".c { width: 13px; font-size: var(--font-size-sm); } /* padding: 10px */",
      ].join("\n"),
    );
    writeFileSync(join(proj, "src", "Box.tsx"), `export const B = () => <div style={{ fontSize: "19px" }} />;`);
    criarDs(proj, home, { nome: "Teste" });
    const r = conformidade(proj, home);
    const t = r.achados.filter((a) => a.tipo === "tamanho");
    const de = (arquivo: string) => t.filter((a) => a.arquivo === arquivo).map((a) => [a.valor, a.classe, a.exato ?? a.sugestao?.token]);
    expect(de("src/medidas.css")).toEqual([
      ["13px", "exato", "--font-size-sm"],
      ["16px", "exato", "--space-4"],
      ["20px", "fora", "--space-4"],
      ["9px", "perto", "--radius-md"],
      ["1.5rem", "exato", "--space-5"],
    ]);
    expect(de("src/Box.tsx")).toEqual([["19px", "perto", "--font-size-lg"]]);
    expect(r.tamanhos).toBe(6);
    expect(r.total).toBe(r.cores + r.tamanhos);
  });
});

describe("ressincronizar", () => {
  it("cor usada 3+ vezes que nenhum token cobre aparece como nova; token sem uso aparece também", () => {
    criarDs(proj, home, { nome: "Teste" });
    const r = ressincronizar(proj, home);
    expect(r.coresNovas.map((c) => c.hex)).toContain("#00ff88");
    expect(r.coresNovas.map((c) => c.hex)).not.toContain("#c91f2d"); // coberta de perto pelo primário
    expect(r.coresSemUso.map((c) => c.token)).toContain("--color-warning");
    expect(r.coresNovas.find((c) => c.hex === "#00ff88")!.nomeSugerido).toBe("green");
  });

  it("valor alterado: o código redeclara um token com outro valor", () => {
    writeFileSync(join(proj, "src", "vars.css"), ":root { --color-primary: #ff0000; --color-bg: #161616; --space-4: 1rem; }");
    criarDs(proj, home, { nome: "Teste" });
    const r = ressincronizar(proj, home);
    expect(r.valoresAlterados).toEqual([
      { token: "--color-primary", noDs: "#c81e2c", noCodigo: "#ff0000" },
      { token: "--space-4", noDs: "16px", noCodigo: "1rem" },
    ]);
    // declaração de variável não é "cor solta" na conformidade (trocaria o token por ele mesmo)
    expect(conformidade(proj, home).achados.map((a) => a.valor)).not.toContain("#ff0000");
  });

  it("aplicar: adiciona cor/fonte, atualiza e remove token no tokens.json; recusa base velha e nome repetido", () => {
    criarDs(proj, home, { nome: "Teste" });
    const r = ressincronizar(proj, home);
    const ds = aplicarRessincronia(proj, home, r.base, [
      { acao: "adicionar-cor", hex: "#00FF88", nome: "green" },
      { acao: "adicionar-fonte", familia: "Inter", nome: "inter" },
      { acao: "atualizar", token: "--color-primary", valor: "#ff0000" },
      { acao: "remover", token: "--color-warning" },
    ]);
    const tok = ds.tokens as { color: Record<string, { $value: unknown }>; font: { family: Record<string, { $value: unknown }> } };
    expect(tok.color.green!.$value).toBe("#00ff88");
    expect(tok.color.primary!.$value).toBe("#ff0000");
    expect(tok.color.warning).toBeUndefined();
    expect(tok.font.family.inter!.$value).toEqual(["Inter", "system-ui", "sans-serif"]);
    expect(ds.css).toContain("--color-green: #00ff88;");
    // base velha (tokens.json mudou desde a leitura) → 409
    expect(() => aplicarRessincronia(proj, home, r.base, [{ acao: "remover", token: "--color-success" }])).toThrow(/mudou/);
    expect(() => aplicarRessincronia(proj, home, ds.tokensHash, [{ acao: "adicionar-cor", hex: "#123456", nome: "green" }])).toThrow(/já existe/);
    expect(() => aplicarRessincronia(proj, home, ds.tokensHash, [{ acao: "adicionar-cor", hex: "#123456", nome: "Verde!" }])).toThrow(/nome inválido/);
  });
});

describe("exportar", () => {
  it("css, tailwind4 (namespaces do v4, referência resolvida), tailwind3 e dtcg", () => {
    criarDs(proj, home, { nome: "Teste" });
    expect(exportar(proj, home, "css").texto).toContain("--color-primary: #c81e2c;");
    const tw4 = exportar(proj, home, "tailwind4").texto;
    expect(tw4).toContain("@theme {");
    expect(tw4).toContain("--color-primary: #c81e2c;");
    expect(tw4).toContain("--spacing-4: 16px;");
    expect(tw4).toContain("--text-sm: 13px;");
    expect(tw4).toContain('--font-body: "IBM Plex Sans", system-ui, sans-serif;');
    const tw3 = exportar(proj, home, "tailwind3").texto;
    expect(tw3).toContain('"primary": "#c81e2c"');
    expect(tw3).toContain('"body": [');
    expect(JSON.parse(exportar(proj, home, "dtcg").texto).color.primary.$value).toBe("#c81e2c");
  });
});

describe("design system no contexto do agente", () => {
  it("bloco com caminho, regras e tokens; entra no pack da conversa do projeto", async () => {
    expect(blocoDoDsParaPack(proj, home)).toBeNull();
    criarDs(proj, home, { nome: "Teste" });
    const bloco = blocoDoDsParaPack(proj, home)!;
    expect(bloco).toContain("# Design system do projeto: Teste");
    expect(bloco).toContain(estadoDs(proj, home).ds!.pastaAbs);
    expect(bloco).toContain("--color-primary: #c81e2c");
    expect(bloco).not.toContain("Avisos pendentes");
    // card editado à mão (pelo chat) com erro de lint: o aviso vai pro próximo turno
    writeFileSync(join(estadoDs(proj, home).ds!.pastaAbs, "cards", "botao-quebrado.html"), `<button style="color:#123456">x</button>`);
    expect(blocoDoDsParaPack(proj, home)).toMatch(/## Avisos pendentes no DS[\s\S]*cards\/botao-quebrado\.html/);

    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: proj, profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    expect((getLive(t.id)?.engine as StubEngine).lastStart?.contextPack).toContain("# Design system do projeto: Teste");
    // conversa de trabalho do próprio DS não recebe o bloco (já tem tudo no pedido)
    const oculta = createThread({ projectPath: proj, profileId: "p1", oculta: true }, home);
    await postMessage(oculta.id, "oi", home);
    expect((getLive(oculta.id)?.engine as StubEngine).lastStart?.contextPack ?? "").not.toContain("# Design system do projeto");
  });
});
