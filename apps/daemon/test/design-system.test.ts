import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import {
  ativarDs,
  criarDs,
  estadoDs,
  lintCard,
  removerDs,
  salvarCard,
  salvarTokens,
  tokensParaCss,
} from "../src/design-system.ts";
import { assinarDs, pastasObservadas } from "../src/ds-watch.ts";
import { projectDir, projectDirSemCriar } from "../src/projeto-dir.ts";

function projeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-proj-"));
}

describe("tokensParaCss", () => {
  it("achata grupos em variáveis e resolve referência {a.b}", () => {
    const { css, vars } = tokensParaCss({
      color: { $type: "color", bg: { $value: "#161616" }, fundo: { $value: "{color.bg}" } },
      space: { "4": { $value: { value: 16, unit: "px" } } },
    });
    expect(vars.map((v) => [v.nome, v.valor])).toEqual([
      ["--color-bg", "#161616"],
      ["--color-fundo", "var(--color-bg)"],
      ["--space-4", "16px"],
    ]);
    expect(css).toContain(":root {");
    expect(css).toContain("--color-fundo: var(--color-bg);");
  });

  it("fontFamily vira lista com aspas só onde precisa; cubicBezier vira função", () => {
    const { vars } = tokensParaCss({
      f: { $type: "fontFamily", $value: ["IBM Plex Sans", "system-ui"] },
      e: { $type: "cubicBezier", $value: [0.3, 0.7, 0.4, 1] },
    });
    expect(vars[0]!.valor).toBe('"IBM Plex Sans", system-ui');
    expect(vars[1]!.valor).toBe("cubic-bezier(0.3, 0.7, 0.4, 1)");
  });

  it("composto (typography) vira uma variável por campo", () => {
    const { vars } = tokensParaCss({ titulo: { $type: "typography", $value: { fontSize: "32px", fontWeight: 700 } } });
    expect(vars.map((v) => v.nome)).toEqual(["--titulo-fontSize", "--titulo-fontWeight"]);
  });

  it("$extensions nexos.temas gera bloco por tema", () => {
    const { css } = tokensParaCss({ bg: { $value: "#000", $extensions: { "nexos.temas": { claro: "#fff" } } } });
    expect(css).toContain(':root[data-tema="claro"] {\n  --bg: #fff;');
  });
});

describe("lintCard", () => {
  const vars = new Set(["--color-bg", "--space-2"]);

  it("card limpo não tem aviso", () => {
    expect(lintCard('<style>.a{background:var(--color-bg);padding:var(--space-2)}</style><div class="a">oi</div>', vars)).toEqual([]);
  });

  it("acusa cor literal em <style>, style= e atributo SVG — mas não id/âncora com #", () => {
    const html = `<style>#abc .x{color:#fff}</style><p style="background: rgb(0 0 0)">x</p>
      <svg><rect fill="#c81e2c"/></svg><a href="#fab">link</a>`;
    const regras = lintCard(html, vars).map((i) => i.regra);
    expect(regras).toEqual(["cor-literal", "cor-literal", "cor-literal"]);
  });

  it("acusa script, handler inline e javascript:, mas aceita o JSON de controles", () => {
    const html = `<script type="application/json" data-ds-controles>[{"var":"--x"}]</script>
      <script>alert(1)</script><button onclick="x()">b</button><a href="javascript:x()">a</a>`;
    expect(lintCard(html, vars).map((i) => i.regra)).toEqual(["script", "script", "script"]);
  });

  it("recurso externo só passa se for Google Fonts; link <a> não conta", () => {
    const html = `<img src="https://evil.test/x.png"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">
      <a href="https://site.test">site</a><style>.a{background:url(http://x.test/a.png)}</style><img src="../assets/logo.svg">`;
    const itens = lintCard(html, vars);
    expect(itens.map((i) => i.regra)).toEqual(["externo", "externo"]);
  });

  it("token inexistente, a não ser que o card declare a variável localmente", () => {
    const html = `<style>.a{--local: 4px; margin: var(--local); color: var(--nao-existe)}</style>`;
    expect(lintCard(html, vars)).toEqual([
      expect.objectContaining({ regra: "token-inexistente", trecho: "--nao-existe" }),
    ]);
  });
});

describe("criar / ler / salvar", () => {
  it("cria o esqueleto na pasta do projeto do Nexos (não no repo) e já deixa ativo", () => {
    const home = tempHome();
    const p = projeto();
    const est = criarDs(p, home, { nome: "Nova Grumari" });
    expect(est.ativo).toBe("nova-grumari");
    const pasta = est.ds!.pastaAbs;
    expect(pasta).toBe(join(projectDirSemCriar(p, home), "design-system", "nova-grumari"));
    expect(existsSync(join(pasta, "tokens.json"))).toBe(true);
    expect(existsSync(join(pasta, "DESIGN.md"))).toBe(true);
    // nada no repositório do projeto
    expect(readdirSync(p)).toEqual([]);
    expect(est.ds!.projetoAbs).toBe(resolve(p));
    expect(est.ds!.nome).toBe("Nova Grumari");
    expect(est.ds!.cards.map((c) => c.id)).toEqual(["core-botoes", "dados-campos"]);
    // o esqueleto tem que passar no próprio lint
    expect(est.ds!.cards.flatMap((c) => c.lint)).toEqual([]);
    expect(est.ds!.tokensLint).toEqual([]);
    expect(est.ds!.css).toContain("--color-primary: #c81e2c;");
  });

  it("pasta que já tem tokens.json (sincronizada sem o ponteiro) é adotada sem sobrescrever", () => {
    const home = tempHome();
    const p = projeto();
    const pasta = join(projectDir(p, home), "design-system", "painel");
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, "tokens.json"), JSON.stringify({ cor: { $value: "#123456" } }));
    const est = criarDs(p, home, { nome: "Painel" });
    expect(JSON.parse(readFileSync(join(pasta, "tokens.json"), "utf8"))).toEqual({ cor: { $value: "#123456" } });
    expect(est.ds!.vars.map((v) => v.nome)).toEqual(["--cor"]);
  });

  it("ponteiro editado à mão com id inválido é ignorado (id vira nome de pasta)", () => {
    const home = tempHome();
    const p = projeto();
    writeFileSync(join(projectDir(p, home), "design-system.json"), JSON.stringify({ sistemas: [{ id: "../fora", nome: "x" }], ativo: "../fora" }));
    expect(estadoDs(p, home)).toEqual({ sistemas: [], ativo: null, oficial: null, ds: null });
  });

  it("card em disco que o meta.json não conhece aparece em 'outros'", () => {
    const home = tempHome();
    const p = projeto();
    const ds0 = criarDs(p, home, {}).ds!;
    writeFileSync(join(ds0.pastaAbs, "cards", "extra.html"), "<p>x</p>");
    const ds = estadoDs(p, home).ds!;
    expect(ds.cards.at(-1)).toMatchObject({ id: "extra", secao: "outros", titulo: "extra" });
    expect(ds.secoes.some((s) => s.id === "outros")).toBe(true);
  });

  it("salvar tokens com base desatualizada dá 409; com base certa grava", () => {
    const home = tempHome();
    const p = projeto();
    const ds = criarDs(p, home, {}).ds!;
    expect(() => salvarTokens(p, home, { a: { $value: "1px" } }, "hash-velho")).toThrow(expect.objectContaining({ status: 409 }));
    const novo = salvarTokens(p, home, { a: { $value: "1px" } }, ds.tokensHash);
    expect(novo.vars.map((v) => v.nome)).toEqual(["--a"]);
  });

  it("salvar card grava html + meta e devolve o lint", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, {});
    const ds = salvarCard(p, home, "core-pills", { html: '<p style="color:#fff">x</p>', titulo: "Pills", secao: "core" });
    const card = ds.cards.find((c) => c.id === "core-pills")!;
    expect(card).toMatchObject({ titulo: "Pills", secao: "core" });
    expect(card.lint.map((i) => i.regra)).toEqual(["cor-literal"]);
    expect(() => salvarCard(p, home, "../fora", { html: "x" })).toThrow(/id de card/);
  });

  it("vários DS: nome repetido ganha sufixo; ativar e remover (arquivos ficam no disco)", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Painel" });
    criarDs(p, home, { nome: "Portal do cliente" });
    const est = criarDs(p, home, { nome: "Painel" });
    expect(est.sistemas.map((s) => s.id)).toEqual(["painel", "portal-do-cliente", "painel-2"]);
    expect(est.ativo).toBe("painel-2");
    expect(ativarDs(p, home, "painel").ds!.nome).toBe("Painel");
    const depois = removerDs(p, home, "painel");
    expect(depois.ativo).toBe("portal-do-cliente");
    expect(existsSync(join(projectDirSemCriar(p, home), "design-system", "painel", "tokens.json"))).toBe(true);
  });

  it("sem DS: estado vazio, salvar dá 404", () => {
    const home = tempHome();
    const p = projeto();
    expect(estadoDs(p, home)).toEqual({ sistemas: [], ativo: null, oficial: null, ds: null });
    expect(() => salvarTokens(p, home, {})).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("assinarDs", () => {
  it("avisa mudança de arquivo e fecha o watcher com o último assinante", async () => {
    const pasta = projeto();
    const eventos: string[] = [];
    const sair = assinarDs(pasta, (ev) => eventos.push(ev.arquivo));
    expect(pastasObservadas()).toContain(pasta);
    writeFileSync(join(pasta, "tokens.json"), "{}");
    await new Promise((r) => setTimeout(r, 600));
    expect(eventos).toContain("tokens.json");
    sair();
    expect(pastasObservadas()).not.toContain(pasta);
  });
});
