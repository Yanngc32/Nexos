import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { addProfile } from "../src/profiles.ts";
import {
  aplicarControles,
  apagarCard,
  controlesDoCard,
  criarDs,
  estadoDs,
  lintCard,
  listarVersoes,
  promoverVariante,
  restaurarVersao,
  salvarCard,
} from "../src/design-system.ts";
import { canalGeracao, geracaoAtual, geracaoBus, iniciarFeedback, iniciarNovoCard, resetGeracaoForTest, type Geracao, type Motor } from "../src/ds-gerar.ts";

const CONTROLES = `<script type="application/json" data-ds-controles>[
  {"var":"--btn-pad-x","rotulo":"Padding","tipo":"range","min":8,"max":32,"passo":2,"unidade":"px","padrao":16},
  {"var":"--btn-raio","rotulo":"Raio","tipo":"token","grupo":"radius"},
  {"var":"invalido","tipo":"range","min":1,"max":2}
]</script>`;
const CARD = `${CONTROLES}<style>.b{padding:0 var(--btn-pad-x, 16px);border-radius:var(--btn-raio, var(--radius-md))}</style><button class="b">Salvar</button>`;

describe("controles do card", () => {
  it("lê só os controles bem formados", () => {
    expect(controlesDoCard(CARD).map((c) => [c.var, c.tipo])).toEqual([
      ["--btn-pad-x", "range"],
      ["--btn-raio", "token"],
    ]);
  });

  it("variável de controle não é 'token inexistente'", () => {
    expect(lintCard(CARD, new Set(["--radius-md"]))).toEqual([]);
  });

  it("aplicar grava o bloco de valores, valida limites e token do grupo, e substitui o anterior", () => {
    const vars = [
      { nome: "--radius-md", caminho: "radius.md", valor: "8px", bruto: "8px" },
      { nome: "--color-bg", caminho: "color.bg", valor: "#000", bruto: "#000" },
    ];
    const um = aplicarControles(CARD, { "--btn-pad-x": 20, "--btn-raio": "--radius-md" }, vars);
    expect(um).toContain("--btn-pad-x: 20px;");
    expect(um).toContain("--btn-raio: var(--radius-md);");
    const dois = aplicarControles(um, { "--btn-pad-x": 24 }, vars);
    expect(dois.match(/data-ds-controles-valores/g)).toHaveLength(1);
    expect(dois).toContain("--btn-pad-x: 24px;");
    expect(() => aplicarControles(CARD, { "--btn-pad-x": 99 }, vars)).toThrow(/fora de 8–32/);
    expect(() => aplicarControles(CARD, { "--btn-raio": "--color-bg" }, vars)).toThrow(/não existe no grupo radius/);
  });
});

describe("versões e variantes", () => {
  let home: string;
  let proj: string;
  beforeEach(() => {
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), "nexo-f4-"));
    criarDs(proj, home, { nome: "Teste" });
  });

  it("lista versões (mais nova primeiro) e restaura, guardando a atual antes", async () => {
    salvarCard(proj, home, "core-botoes", { html: "<p>v2</p>" }, { versionar: true });
    await new Promise((r) => setTimeout(r, 5));
    salvarCard(proj, home, "core-botoes", { html: "<p>v3</p>" }, { versionar: true });
    const versoes = listarVersoes(proj, home, "core-botoes");
    expect(versoes).toHaveLength(2);
    expect(versoes[0]!.em).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ds = restaurarVersao(proj, home, "core-botoes", versoes[0]!.nome); // v2
    expect(ds.cards.find((c) => c.id === "core-botoes")!.html).toBe("<p>v2</p>");
    expect(listarVersoes(proj, home, "core-botoes")).toHaveLength(3); // v3 foi guardada
    expect(() => restaurarVersao(proj, home, "core-botoes", "../x.html")).toThrow(/versão inválida/);
  });

  it("variante vira o original e some; apagar card é recuperável pelas versões", () => {
    salvarCard(proj, home, "core-botoes-var-1", { html: "<p>variante</p>", titulo: "Botões (variante)", secao: "core" });
    const ds = promoverVariante(proj, home, "core-botoes-var-1");
    expect(ds.cards.map((c) => c.id)).not.toContain("core-botoes-var-1");
    expect(ds.cards.find((c) => c.id === "core-botoes")!.html).toBe("<p>variante</p>");
    const depois = apagarCard(proj, home, "dados-campos");
    expect(depois.cards.map((c) => c.id)).not.toContain("dados-campos");
    expect(listarVersoes(proj, home, "dados-campos").length).toBeGreaterThan(0);
    expect(() => promoverVariante(proj, home, "core-botoes")).toThrow(/não é uma variante/);
  });
});

describe("feedback por card", () => {
  let home: string;
  let proj: string;
  let perfil: string;
  beforeEach(() => {
    resetGeracaoForTest();
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), "nexo-fb-"));
    perfil = addProfile({ id: "p1", engine: "stub" }, home).id;
    criarDs(proj, home, { nome: "Teste" });
  });

  function motorQueResponde(fn: (pedido: string) => string) {
    const pedidos: string[] = [];
    const motor: Motor = {
      criarConversa: () => "t-fb",
      turno: async (_id, pedido, aoTexto) => {
        pedidos.push(pedido);
        const r = fn(pedido);
        aoTexto(r);
        return { ok: true, textoFinal: r };
      },
      abortar: async () => {},
    };
    return { motor, pedidos };
  }

  function fim(): Promise<Geracao> {
    return new Promise((resolve) => {
      const canal = canalGeracao(proj);
      const g = geracaoAtual(proj);
      if (g && g.status !== "rodando") return resolve(g);
      const ouvir = (ev: { type: string; geracao: Geracao }) => {
        if (ev.type === "geracao" && ev.geracao.status !== "rodando") {
          geracaoBus.off(canal, ouvir);
          resolve(ev.geracao);
        }
      };
      geracaoBus.on(canal, ouvir);
    });
  }

  it("reescreve só o card, com o pedido e os elementos apontados", async () => {
    const { motor, pedidos } = motorQueResponde(
      () => `<ds-card id="core-botoes" titulo="Botões"><button style="padding:var(--space-4)">Maior</button></ds-card>`,
    );
    iniciarFeedback(proj, home, "core-botoes", { profileId: perfil, texto: "botão maior", elementos: [{ seletor: "button.primario", html: "<button class=\"primario\">", texto: "Salvar" }] }, motor);
    const g = await fim();
    expect(g.status).toBe("concluida");
    expect(pedidos[0]).toContain("botão maior");
    expect(pedidos[0]).toContain("button.primario");
    expect(pedidos[0]).toContain("## Card atual");
    const ds = estadoDs(proj, home).ds!;
    expect(ds.cards.find((c) => c.id === "core-botoes")!.html).toContain("Maior");
    expect(listarVersoes(proj, home, "core-botoes").length).toBeGreaterThan(0);
  });

  it("como variante: cria <id>-var-1 ao lado do original e mantém o original", async () => {
    const antes = estadoDs(proj, home).ds!.cards.find((c) => c.id === "core-botoes")!.html;
    const { motor, pedidos } = motorQueResponde(
      (p) => `<ds-card id="${/id="(core-botoes-var-\d+)"/.exec(p)![1]}"><p style="color:var(--color-text)">outra</p></ds-card>`,
    );
    iniciarFeedback(proj, home, "core-botoes", { profileId: perfil, texto: "tenta outra abordagem", variante: true }, motor);
    const g = await fim();
    expect(g.status).toBe("concluida");
    expect(pedidos[0]).toContain("VARIANTE");
    const ds = estadoDs(proj, home).ds!;
    const ids = ds.cards.map((c) => c.id);
    expect(ids.indexOf("core-botoes-var-1")).toBe(ids.indexOf("core-botoes") + 1);
    expect(ds.cards.find((c) => c.id === "core-botoes")!.html).toBe(antes);
    expect(ds.cards.find((c) => c.id === "core-botoes-var-1")!.titulo).toBe("Botões (variante)");
  });

  it("card novo pela IA: reserva o lugar no meta (tipo/largura/seção), pede com o kit e grava o card", async () => {
    const { motor, pedidos } = motorQueResponde(
      (p) => `<ds-card id="${/- id: (\S+)/.exec(p)![1]}"><div class="k-bloco"><p class="k-rotulo">Padrão</p><span style="color:var(--color-text)">Badge</span></div></ds-card>`,
    );
    iniciarNovoCard(proj, home, { profileId: perfil, texto: "badges de status", titulo: "Badges", secao: "core", tipo: "componente", largura: "1/3" }, motor);
    // esqueleto: a entrada já está no meta antes do card chegar
    expect(geracaoAtual(proj)!.plano.map((c) => c.id)).toEqual(["badges"]);
    const g = await fim();
    expect(g.status).toBe("concluida");
    expect(pedidos[0]).toContain("Card de COMPONENTE");
    expect(pedidos[0]).toContain(".k-demo");
    const card = estadoDs(proj, home).ds!.cards.find((c) => c.id === "badges")!;
    expect(card).toMatchObject({ tipo: "componente", largura: "1/3", secao: "core" });
    expect(card.html).toContain("Badge");
    const { motor: m2 } = motorQueResponde(() => "");
    expect(() => iniciarNovoCard(proj, home, { profileId: perfil, texto: "" }, m2)).toThrow(/descreva/);
  });

  it("sem texto ou card inexistente dá erro", () => {
    const { motor } = motorQueResponde(() => "");
    expect(() => iniciarFeedback(proj, home, "core-botoes", { profileId: perfil, texto: "" }, motor)).toThrow(/escreva/);
    expect(() => iniciarFeedback(proj, home, "nao-existe", { profileId: perfil, texto: "x" }, motor)).toThrow(/não existe/);
  });
});
