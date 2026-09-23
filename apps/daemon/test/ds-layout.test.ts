import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { criarCardDeTipo, criarDs, estadoDs, lintCard, listarBases, mudarCard, mudarSecao } from "../src/design-system.ts";
import { cardsDeFundamentos, KIT_MD } from "../src/ds-kit.ts";
import { blocoDoDsParaPack } from "../src/ds-sync.ts";

let home: string;
let proj: string;
beforeEach(() => {
  home = tempHome();
  proj = mkdtempSync(join(tmpdir(), "nexo-layout-"));
  criarDs(proj, home, { nome: "Teste" });
});

const ds = () => estadoDs(proj, home).ds!;
const meta = () => JSON.parse(readFileSync(join(ds().pastaAbs, "meta.json"), "utf8"));

describe("fundamentos vindos do daemon", () => {
  it("um card por grupo, com var(), escapando texto, e na ordem/largura/oculto do meta", () => {
    const vars = [
      { nome: "--color-bg", caminho: "color.bg", tipo: "color", valor: "#000", bruto: "#000" },
      { nome: "--space-2", caminho: "space.2", valor: "8px", bruto: "8px" },
      { nome: "--x", caminho: "<b>", valor: "1", bruto: 1 },
    ];
    const cards = cardsDeFundamentos(vars, [{ id: "fund-espaco", largura: "1/3" }, { id: "fund-cores", oculto: true }]);
    expect(cards.map((c) => c.id)).toEqual(["fund-espaco", "fund-cores", "fund-outros"]);
    expect(cards[0]).toMatchObject({ largura: "1/3", tokens: ["--space-2"] });
    expect(cards[1]).toMatchObject({ oculto: true });
    expect(cards[1]!.html).toContain('class="k-amostra" style="background:var(--color-bg)"');
    expect(cards[2]!.html).toContain("&lt;b&gt;");
  });

  it("o DS lido traz os fundamentos e o CSS do kit", () => {
    expect(ds().fundamentos.map((f) => f.id)).toContain("fund-cores");
    expect(ds().kitCss).toContain(".k-grade");
  });
});

describe("card de tipo (modelo, sem IA)", () => {
  it("cria arquivo + meta com tipo/largura/seção nova, só com os tokens marcados, e passa no lint", () => {
    const { ds: novo, id } = criarCardDeTipo(proj, home, {
      tipo: "cores",
      titulo: "Cores da marca",
      secao: "Marca",
      largura: "1/3",
      tokens: ["--color-primary", "--color-secondary"],
    });
    expect(id).toBe("cores-da-marca");
    const card = novo.cards.find((c) => c.id === id)!;
    expect(card).toMatchObject({ tipo: "cores", largura: "1/3", secao: "marca" });
    expect(card.html).toContain("var(--color-primary)");
    expect(card.html).not.toContain("var(--color-bg)");
    expect(card.lint).toEqual([]);
    expect(novo.secoes.find((s) => s.id === "marca")?.titulo).toBe("Marca");
    // mesmo título de novo: id livre
    expect(criarCardDeTipo(proj, home, { tipo: "cores", titulo: "Cores da marca" }).id).toBe("cores-da-marca-2");
    expect(() => criarCardDeTipo(proj, home, { tipo: "componente" })).toThrow(/modelo pronto/);
    expect(() => criarCardDeTipo(proj, home, { tipo: "cores", tokens: [] })).toThrow(/ao menos um/);
  });

  it("o HTML do kit não dispara o lint (cor só por var)", () => {
    const vars = new Set(ds().vars.map((v) => v.nome));
    for (const f of ds().fundamentos) expect(lintCard(f.html, vars)).toEqual([]);
  });
});

describe("layout", () => {
  it("largura, título, seção e mover dentro da seção; card fora do meta ganha entrada", () => {
    mudarCard(proj, home, "core-botoes", { largura: "1", titulo: "Botões v2" });
    expect(ds().cards.find((c) => c.id === "core-botoes")).toMatchObject({ largura: "1", titulo: "Botões v2" });
    criarCardDeTipo(proj, home, { tipo: "forma", titulo: "Raios", secao: "core" });
    // core: [core-botoes, raios] → mover raios pra trás
    mudarCard(proj, home, "raios", { mover: -1 });
    expect(ds().cards.filter((c) => c.secao === "core").map((c) => c.id)).toEqual(["raios", "core-botoes"]);
    expect(() => mudarCard(proj, home, "nao-existe", { largura: "1" })).toThrow(/não existe/);
    expect(() => mudarCard(proj, home, "core-botoes", { largura: "3/4" })).not.toThrow(); // inválido é ignorado
    expect(ds().cards.find((c) => c.id === "core-botoes")?.largura).toBe("1");
  });

  it("fundamentos: ocultar, largura e mover gravam em meta.fundamentos", () => {
    mudarCard(proj, home, "fund-cores", { oculto: true, largura: "2/3" });
    mudarCard(proj, home, "fund-tipografia", { mover: -1 });
    expect(ds().fundamentos.slice(0, 2).map((f) => [f.id, f.oculto ?? false, f.largura ?? ""])).toEqual([
      ["fund-tipografia", false, ""],
      ["fund-cores", true, "2/3"],
    ]);
    mudarCard(proj, home, "fund-cores", { oculto: false });
    expect(ds().fundamentos.find((f) => f.id === "fund-cores")?.oculto).toBeUndefined();
  });

  it("alinhamento da seção, inclusive fundamentos (que não precisa estar em secoes)", () => {
    mudarSecao(proj, home, "fundamentos", { alinhamento: "alvenaria" });
    mudarSecao(proj, home, "core", { alinhamento: "esticar", titulo: "Básico" });
    expect(meta().secoes.find((s: { id: string }) => s.id === "fundamentos")).toMatchObject({ alinhamento: "alvenaria" });
    expect(ds().secoes.find((s) => s.id === "core")).toMatchObject({ alinhamento: "esticar", titulo: "Básico" });
    mudarSecao(proj, home, "core", { alinhamento: "torto" });
    expect(ds().secoes.find((s) => s.id === "core")?.alinhamento).toBe("esticar");
  });
});

describe("agente do chat", () => {
  it("o pack aponta pro KIT.md e ele é escrito na pasta do DS", () => {
    expect(blocoDoDsParaPack(proj, home)).toContain("KIT.md");
    const kit = join(ds().pastaAbs, "KIT.md");
    expect(existsSync(kit)).toBe(true);
    expect(readFileSync(kit, "utf8")).toBe(KIT_MD);
    expect(KIT_MD).toContain('"alvenaria"');
  });
});

describe("base do design system novo", () => {
  it("do zero vem vazio; padrão vem com o esqueleto; copiar traz os arquivos de outro projeto sem .versoes", () => {
    const outro = mkdtempSync(join(tmpdir(), "nexo-base-"));
    const zero = criarDs(outro, home, { nome: "Limpo", base: "zero" }).ds!;
    expect(zero.vars).toEqual([]);
    expect(zero.cards).toEqual([]);
    expect(zero.fundamentos).toEqual([]);
    expect(zero.designMd.trim()).toBe("# Limpo");

    // a lista mostra zero, padrão e os DS existentes (os dois projetos deste teste)
    const bases = listarBases(outro, home);
    expect(bases.slice(0, 2).map((b) => b.id)).toEqual(["zero", "padrao"]);
    const doProj = bases.find((b) => b.nome === "Teste")!;
    expect(doProj.id).toMatch(/^copia:.+\/teste$/);
    expect(bases.find((b) => b.nome === "Limpo")?.projeto).toBe("este projeto");

    // .versoes do original não vai junto
    mudarCard(proj, home, "core-botoes", { largura: "1" });
    criarCardDeTipo(proj, home, { tipo: "cores", titulo: "Marca" });
    const copia = criarDs(outro, home, { nome: "Cópia", base: doProj.id }).ds!;
    expect(copia.cards.map((c) => c.id)).toEqual(ds().cards.map((c) => c.id));
    expect(copia.cards.find((c) => c.id === "core-botoes")?.largura).toBe("1");
    expect(existsSync(join(copia.pastaAbs, ".versoes"))).toBe(false);

    expect(() => criarDs(outro, home, { nome: "X", base: "copia:../../etc/x" })).toThrow(/base inválida/);
    expect(() => criarDs(outro, home, { nome: "X", base: "copia:nao-existe/ds" })).toThrow(/não existe/);
    expect(() => criarDs(outro, home, { nome: "X", base: "outra" })).toThrow(/base inválida/);
  });
});
