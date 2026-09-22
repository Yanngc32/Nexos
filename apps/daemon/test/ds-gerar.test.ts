import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { addProfile } from "../src/profiles.ts";
import { criarDs, estadoDs } from "../src/design-system.ts";
import { coletarDoCodigo, resumoDaColeta } from "../src/ds-coleta.ts";
import { criarLeitor, lerBlocos, semCerca, type Bloco } from "../src/ds-stream.ts";
import {
  cancelarGeracao,
  estimar,
  geracaoAtual,
  geracaoBus,
  canalGeracao,
  iniciarGeracao,
  resetGeracaoForTest,
  type Geracao,
  type Motor,
} from "../src/ds-gerar.ts";

describe("ds-stream", () => {
  it("lê blocos cortados em qualquer ponto, inclusive no meio das tags", () => {
    const texto = `bla <ds-tokens>{"a":1}</ds-tokens> meio <ds-card id="x" titulo="Botões" secao="core"><p>oi</p></ds-card> fim`;
    for (let corte = 1; corte < texto.length; corte++) {
      const fechados: Bloco[] = [];
      const pedacos: string[] = [];
      const l = criarLeitor({ fechou: (b) => fechados.push(b), pedaco: (_b, t) => pedacos.push(t) });
      l.alimentar(texto.slice(0, corte));
      l.alimentar(texto.slice(corte));
      expect(fechados.map((b) => [b.tipo, b.conteudo])).toEqual([
        ["tokens", '{"a":1}'],
        ["card", "<p>oi</p>"],
      ]);
      expect(fechados[1]!.attrs).toEqual({ id: "x", titulo: "Botões", secao: "core" });
    }
  });

  it("caractere por caractere também", () => {
    const fechados: Bloco[] = [];
    const l = criarLeitor({ fechou: (b) => fechados.push(b) });
    for (const ch of `<ds-design-md># Regras\n- a</ds-design-md>`) l.alimentar(ch);
    expect(fechados[0]!.conteudo).toBe("# Regras\n- a");
  });

  it("bloco sem fechamento é descartado", () => {
    expect(lerBlocos(`<ds-card id="a"><p>metade`)).toEqual([]);
  });

  it("semCerca tira ```json … ```", () => {
    expect(semCerca('\n```json\n{"a":1}\n```\n')).toBe('{"a":1}');
    expect(semCerca("<p>x</p>")).toBe("<p>x</p>");
  });
});

describe("coletarDoCodigo", () => {
  it("acha variáveis, cores, fontes e logo; pula node_modules e a pasta ignorada", () => {
    const p = mkdtempSync(join(tmpdir(), "nexo-col-"));
    mkdirSync(join(p, "src"));
    mkdirSync(join(p, "public"));
    mkdirSync(join(p, "node_modules", "x"), { recursive: true });
    mkdirSync(join(p, "ds"));
    writeFileSync(join(p, "src", "app.css"), ":root{--brand:#C81E2C;}\n.a{color:#c81e2c;font-family:'Archivo',sans-serif} .b{color:#fff}");
    writeFileSync(join(p, "node_modules", "x", "y.css"), ".z{color:#123456}");
    writeFileSync(join(p, "ds", "z.css"), ".z{color:#abcdef}");
    writeFileSync(join(p, "public", "logo.svg"), "<svg/>");
    const c = coletarDoCodigo(p, [join(p, "ds")]);
    expect(c.variaveis).toEqual([["--brand", "#C81E2C"]]);
    expect(c.cores[0]).toEqual(["#c81e2c", 2]);
    expect(c.cores.map(([h]) => h)).not.toContain("#123456");
    expect(c.cores.map(([h]) => h)).not.toContain("#abcdef");
    expect(c.fontes[0]![0]).toBe("'Archivo',sans-serif");
    expect(c.logos).toEqual(["public/logo.svg"]);
    expect(resumoDaColeta(c)).toContain("#c81e2c · 2");
  });
});

/** Motor falso: responde cada turno com o que o roteiro mandar, pela ordem de chegada por conversa. */
function motorFalso(roteiro: (titulo: string, n: number, pedido: string) => string) {
  const titulos = new Map<string, string>();
  const turnos = new Map<string, number>();
  const pedidos: { titulo: string; pedido: string; imagens: number }[] = [];
  let seq = 0;
  const motor: Motor = {
    criarConversa: (_p, _perfil, titulo) => {
      const id = `t${++seq}`;
      titulos.set(id, titulo);
      return id;
    },
    turno: async (id, pedido, aoTexto, imagens = []) => {
      const n = (turnos.get(id) ?? 0) + 1;
      turnos.set(id, n);
      const titulo = titulos.get(id)!;
      pedidos.push({ titulo, pedido, imagens: imagens.length });
      const resposta = roteiro(titulo, n, pedido);
      // em dois pedaços, como um motor de verdade
      aoTexto(resposta.slice(0, Math.floor(resposta.length / 2)));
      aoTexto(resposta.slice(Math.floor(resposta.length / 2)));
      return { ok: true, textoFinal: resposta };
    },
    abortar: async () => {},
  };
  return { motor, pedidos };
}

function esperarFim(projectPath: string): Promise<Geracao> {
  return new Promise((resolve) => {
    const canal = canalGeracao(projectPath);
    const g = geracaoAtual(projectPath);
    if (g && g.status !== "rodando") return resolve(g);
    const ouvir = (ev: { type: string; geracao: Geracao }) => {
      // o canal também leva o HTML ao vivo dos cards (`ds_stream`)
      if (ev.type === "geracao" && ev.geracao.status !== "rodando") {
        geracaoBus.off(canal, ouvir);
        resolve(ev.geracao);
      }
    };
    geracaoBus.on(canal, ouvir);
  });
}

const TOKENS_OK = JSON.stringify({
  color: { $type: "color", bg: { $value: "#101010" }, text: { $value: "#fafafa" }, primary: { $value: "#2255ee" } },
  font: { family: { body: { $type: "fontFamily", $value: ["Inter", "sans-serif"] } } },
  space: { "2": { $value: "8px" } },
});

describe("iniciarGeracao", () => {
  let home: string;
  let proj: string;
  let perfil: string;
  beforeEach(() => {
    resetGeracaoForTest();
    home = tempHome();
    proj = mkdtempSync(join(tmpdir(), "nexo-gen-"));
    perfil = addProfile({ id: "p1", engine: "stub" }, home).id;
    criarDs(proj, home, { nome: "Teste" });
  });

  it("estimativa conta Diretor + uma conversa por seção", () => {
    expect(estimar({ secoes: ["core", "dados"] })).toEqual({ conversas: 3, cards: 10 });
    expect(estimar({ secoes: ["core"], gerarTokens: false })).toEqual({ conversas: 1, cards: 6 });
  });

  it("Diretor grava tokens + DESIGN.md; seção grava cards; card com cor literal volta pra correção", async () => {
    const { motor, pedidos } = motorFalso((titulo, n) => {
      if (titulo.includes("Diretor")) return `<ds-tokens>\n\`\`\`json\n${TOKENS_OK}\n\`\`\`\n</ds-tokens><ds-design-md># Regras\nUse o primário só em ação principal, nunca em fundo.</ds-design-md>`;
      if (n === 1) {
        return `<ds-card id="dados-tabela" titulo="Tabela"><p style="color: var(--color-text)">ok</p></ds-card>
<ds-card id="dados-campos" titulo="Campos"><p style="color:#fff">cor solta</p></ds-card>
<ds-card id="fora-do-plano"><p>x</p></ds-card>`;
      }
      return `<ds-card id="dados-campos" titulo="Campos"><p style="color:var(--color-text)">corrigido</p></ds-card>
<ds-card id="dados-selects"><p>s</p></ds-card><ds-card id="dados-alertas"><p>a</p></ds-card>`;
    });
    iniciarGeracao(proj, home, { profileId: perfil, secoes: ["dados"], usarCodigo: false }, motor);
    const g = await esperarFim(proj);
    expect(g.status).toBe("concluida");
    expect(g.etapas.map((e) => [e.id, e.status])).toEqual([
      ["diretor", "ok"],
      ["dados", "ok"],
    ]);
    const ds = estadoDs(proj, home).ds!;
    expect(ds.vars.map((v) => v.nome)).toContain("--color-primary");
    expect(ds.designMd).toContain("primário só em ação principal");
    const ids = ds.cards.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["dados-tabela", "dados-campos", "dados-selects", "dados-alertas"]));
    expect(ids).not.toContain("fora-do-plano");
    // ordem do plano, não a de chegada (dados-campos chegou por último, na correção)
    expect(ids.filter((id) => id.startsWith("dados-"))).toEqual(["dados-tabela", "dados-campos", "dados-selects", "dados-alertas"]);
    expect(ds.cards.find((c) => c.id === "dados-campos")!.html).toContain("corrigido");
    // (o core-botoes do esqueleto usa tokens que o JSON mínimo deste teste não tem — não conta)
    expect(ds.cards.filter((c) => c.id.startsWith("dados-")).flatMap((c) => c.lint)).toEqual([]);
    // o pedido de correção cita o problema e o card
    const correcao = pedidos.find((p) => p.titulo.includes("Dados") && p.pedido.includes("não passaram"))!.pedido;
    expect(correcao).toContain("dados-campos");
    expect(correcao).toContain("cor fora de token");
    // o card sobrescrito do esqueleto ficou guardado em .versoes
    expect(readdirSync(join(estadoDs(proj, home).ds!.pastaAbs, ".versoes", "dados-campos")).length).toBeGreaterThan(0);
  });

  it("HTML do card vai pro Canvas enquanto é escrito (abriu → pedaços), e o card inteiro é igual ao gravado", async () => {
    const card = `<ds-card id="dados-tabela" titulo="Tabela"><div style="color:var(--color-text)"><p>linha um</p><p>linha dois</p></div></ds-card>`;
    const { motor } = motorFalso((titulo) =>
      titulo.includes("Diretor")
        ? `<ds-tokens>${TOKENS_OK}</ds-tokens><ds-design-md># Regras\\nUse o primário só em ação principal, nunca em fundo.</ds-design-md>`
        : card,
    );
    // motor que manda token a token, como o text_delta do claude
    const turnoOriginal = motor.turno;
    motor.turno = async (id, pedido, aoTexto, imagens) => {
      let resposta = "";
      const r = await turnoOriginal(id, pedido, (t) => (resposta += t), imagens);
      for (let i = 0; i < resposta.length; i += 7) aoTexto(resposta.slice(i, i + 7));
      return r;
    };
    const vistos: { fase: string; card: string; html?: string }[] = [];
    const canal = canalGeracao(proj);
    const ouvir = (ev: { type: string; fase: string; card: string; html?: string }) => {
      if (ev.type === "ds_stream") vistos.push(ev);
    };
    geracaoBus.on(canal, ouvir);
    try {
      iniciarGeracao(proj, home, { profileId: perfil, secoes: ["dados"], usarCodigo: false }, motor);
      await esperarFim(proj);
    } finally {
      geracaoBus.off(canal, ouvir);
    }
    const doCard = vistos.filter((v) => v.card === "dados-tabela");
    expect(doCard[0]).toMatchObject({ fase: "abriu" });
    const html = doCard.filter((v) => v.fase === "pedaco").map((v) => v.html).join("");
    expect(doCard.filter((v) => v.fase === "pedaco").length).toBeGreaterThan(0);
    expect(html).toBe('<div style="color:var(--color-text)"><p>linha um</p><p>linha dois</p></div>');
  });

  it("tokens sem os obrigatórios: pede correção e para depois das tentativas", async () => {
    const { motor, pedidos } = motorFalso(() => `<ds-tokens>{"cor":{"$value":"#000"}}</ds-tokens><ds-design-md># Regras longas o bastante pra valer como regra de uso.</ds-design-md>`);
    iniciarGeracao(proj, home, { profileId: perfil, secoes: ["core"], usarCodigo: false }, motor);
    const g = await esperarFim(proj);
    expect(g.status).toBe("erro");
    expect(g.erro).toMatch(/falta o token --color-bg/);
    expect(pedidos.filter((p) => p.titulo.includes("Diretor"))).toHaveLength(3);
    // tokens do esqueleto continuam lá
    expect(JSON.parse(readFileSync(join(estadoDs(proj, home).ds!.pastaAbs, "tokens.json"), "utf8")).color.primary).toBeTruthy();
  });

  it("referência do Browser: dados no pedido do Diretor e print só no primeiro turno de cada conversa", async () => {
    const { motor, pedidos } = motorFalso((titulo, n) => {
      if (titulo.includes("Diretor")) return `<ds-tokens>${TOKENS_OK}</ds-tokens><ds-design-md># Regras\nUse o primário só em ação principal, nunca em fundo.</ds-design-md>`;
      // 1º turno com cor solta força uma correção, pra ver que ela vai sem imagem
      if (n === 1) return `<ds-card id="core-logo"><p style="color:#fff">x</p></ds-card>`;
      return ["core-logo", "core-botoes", "core-pills", "core-avatares", "core-barras", "core-icones"]
        .map((id) => `<ds-card id="${id}"><p style="color:var(--color-text)">ok</p></ds-card>`)
        .join("");
    });
    const referencia = {
      url: "https://marca.test/",
      titulo: "Marca",
      dados: { cores: { fundo: [["#030712", 9]], texto: [["#ffffff", 5]], borda: [] }, fontes: [["Inter", 10]], variaveis: [["--brand", "#fb64b6"]] },
      screenshot: { mime: "image/jpeg", data: "AQID" },
    };
    iniciarGeracao(proj, home, { profileId: perfil, secoes: ["core"], usarCodigo: false, url: "https://marca.test/", referencia }, motor);
    const g = await esperarFim(proj);
    expect(g.status).toBe("concluida");
    const diretor = pedidos.find((p) => p.titulo.includes("Diretor"))!;
    expect(diretor.pedido).toContain("Página de referência");
    expect(diretor.pedido).toContain("#030712 · 9");
    expect(diretor.pedido).toContain("--brand: #fb64b6");
    expect(diretor.imagens).toBe(1);
    const core = pedidos.filter((p) => p.titulo.includes("Core"));
    expect(core.map((p) => p.imagens)).toEqual([1, 0]);
    expect(core[0]!.pedido).toContain("print da página de referência");
  });

  it("referência inválida é ignorada, não derruba a geração", () => {
    const { motor } = motorFalso(() => "");
    motor.turno = () => new Promise(() => {});
    const g = iniciarGeracao(proj, home, { profileId: perfil, usarCodigo: false, referencia: { dados: "x", screenshot: { mime: "text/html", data: "x" } } }, motor);
    expect(g.status).toBe("rodando");
  });

  it("só uma geração por projeto; sem conta dá erro", () => {
    const { motor } = motorFalso(() => "");
    expect(() => iniciarGeracao(proj, home, { profileId: "nao-existe" }, motor)).toThrow(/conta/);
    motor.turno = () => new Promise(() => {}); // nunca termina
    iniciarGeracao(proj, home, { profileId: perfil, usarCodigo: false }, motor);
    expect(() => iniciarGeracao(proj, home, { profileId: perfil }, motor)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("cancelar aborta a conversa rodando e fecha como cancelada", async () => {
    const abortadas: string[] = [];
    let soltar: () => void = () => {};
    const motor: Motor = {
      criarConversa: () => "t-cancel",
      turno: () => new Promise((r) => (soltar = () => r({ ok: false, motivo: "abortado", textoFinal: "" }))),
      abortar: async (id) => {
        abortadas.push(id);
        soltar();
      },
    };
    iniciarGeracao(proj, home, { profileId: perfil, secoes: ["core"], usarCodigo: false }, motor);
    await new Promise((r) => setTimeout(r, 20));
    await cancelarGeracao(proj, motor);
    const g = await esperarFim(proj);
    expect(abortadas).toEqual(["t-cancel"]);
    expect(g.status).toBe("cancelada");
    expect(g.etapas.every((e) => e.status === "cancelado" || e.status === "erro")).toBe(true);
  });
});
