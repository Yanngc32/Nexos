// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agruparPorPasta,
  blocosDoMarkdown,
  createAvisoDeMemoria,
  createMemorias,
  desenharCorpo,
  filtrarMemorias,
  fmtRelativo,
  rotuloDoTipo,
  TEXTO_VAZIO,
  textoDoAviso,
  textoDoContador,
  textoDoErro,
  textoSemResultado,
  tituloDaPasta,
} from "../memorias.js";

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

/** Recorta do index.html real a seção Memórias e o contêiner do aviso — o teste quebra se o markup sumir. */
function montarMarkup() {
  const ini = HTML.indexOf('<section class="ag-sec mem-sec"');
  expect(ini).toBeGreaterThan(-1);
  const fim = HTML.indexOf("</section>", ini) + "</section>".length;
  const avisoIni = HTML.indexOf('<div class="mem-aviso-ancora">');
  expect(avisoIni).toBeGreaterThan(-1);
  const avisoFim = HTML.indexOf("</div></div>", avisoIni) + "</div></div>".length;
  document.body.innerHTML = HTML.slice(ini, fim) + HTML.slice(avisoIni, avisoFim);
}

const $ = (id) => document.getElementById(id);
const AGORA = new Date(2026, 10, 23, 15, 0, 0).getTime();

const ITENS = [
  { relPath: "deploy.md", pasta: "", titulo: "Deploy usa a porta 8080", gancho: "Servidor de homologação", tipo: "infra", revisao: 2, origem: "agente", atualizadaEm: new Date(2026, 10, 23, 14, 30).toISOString() },
  { relPath: "estilo/commits.md", pasta: "estilo", titulo: "Commits em português", gancho: "Conventional Commits", tipo: "preferencia", revisao: 1, origem: "pessoa", atualizadaEm: new Date(2026, 10, 20).toISOString() },
  { relPath: "estilo/testes.md", pasta: "estilo", titulo: "Rodar vitest antes do push", gancho: "", tipo: "instrucao", revisao: 1, origem: "pessoa", atualizadaEm: new Date(2026, 10, 22).toISOString() },
  { relPath: "arquitetura/banco.md", pasta: "arquitetura", titulo: "Banco é SQLite", gancho: "Decisão de não usar Postgres", tipo: "decisao", revisao: 3, origem: "agente", atualizadaEm: new Date(2026, 9, 1).toISOString() },
];
const SECOES = { estilo: "Estilo de trabalho" };

describe("helpers puros", () => {
  it("rótulo pt-BR do tipo, com fallback", () => {
    expect(rotuloDoTipo("decisao")).toBe("Decisão");
    expect(rotuloDoTipo("correcao")).toBe("Correção");
    expect(rotuloDoTipo("outro")).toBe("Outro");
    expect(rotuloDoTipo("")).toBe("Memória");
  });

  it("título da pasta: secoes > Geral na raiz > a / b", () => {
    expect(tituloDaPasta("estilo", SECOES)).toBe("Estilo de trabalho");
    expect(tituloDaPasta("", {})).toBe("Geral");
    expect(tituloDaPasta("a/b", {})).toBe("a / b");
  });

  it("agrupa por pasta: raiz primeiro, pastas em ordem, mais recente primeiro", () => {
    const g = agruparPorPasta(ITENS, SECOES);
    expect(g.map((x) => x.titulo)).toEqual(["Geral", "arquitetura", "Estilo de trabalho"]);
    expect(g[2].itens.map((i) => i.relPath)).toEqual(["estilo/testes.md", "estilo/commits.md"]);
  });

  it("busca local exige todos os termos e ignora acento", () => {
    expect(filtrarMemorias(ITENS, "decisao").map((i) => i.relPath)).toEqual(["arquitetura/banco.md"]);
    expect(filtrarMemorias(ITENS, "PORTUGUÊS commits").map((i) => i.relPath)).toEqual(["estilo/commits.md"]);
    expect(filtrarMemorias(ITENS, "trabalho", SECOES)).toHaveLength(2);
    expect(filtrarMemorias(ITENS, "porta xyz")).toHaveLength(0);
    expect(filtrarMemorias(ITENS, "  ")).toHaveLength(4);
  });

  it("data relativa", () => {
    const h = (d) => new Date(d).toISOString();
    expect(fmtRelativo(h(AGORA - 20_000), AGORA)).toBe("agora há pouco");
    expect(fmtRelativo(h(AGORA - 5 * 60_000), AGORA)).toBe("há 5 min");
    expect(fmtRelativo(h(AGORA - 3 * 3_600_000), AGORA)).toBe("há 3 h");
    expect(fmtRelativo(h(new Date(2026, 10, 22, 10)), AGORA)).toBe("ontem");
    expect(fmtRelativo(h(new Date(2026, 10, 19, 10)), AGORA)).toBe("há 4 dias");
    expect(fmtRelativo(h(new Date(2026, 9, 1, 10)), AGORA)).toBe("01/10");
    expect(fmtRelativo(h(new Date(2024, 9, 1, 10)), AGORA)).toBe("01/10/2024");
    expect(fmtRelativo("lixo", AGORA)).toBe("");
  });

  it("markdown simples: frontmatter fora, títulos, listas, código, citação", () => {
    const b = blocosDoMarkdown("---\ntipo: infra\n---\n# Título\n\nTexto **forte**.\n\n- um\n- dois\n\n1. a\n2. b\n\n```\nnpm test\n```\n\n> citado");
    expect(b.map((x) => x.tipo)).toEqual(["titulo", "paragrafo", "lista", "lista", "codigo", "citacao"]);
    expect(b[2]).toMatchObject({ ordenada: false, itens: ["um", "dois"] });
    expect(b[3]).toMatchObject({ ordenada: true, itens: ["a", "b"] });
    expect(b[4].texto).toContain("npm test");
  });

  it("segredo vira chip 'senha guardada' e o nome não vaza no texto", () => {
    const box = document.createElement("div");
    box.append(desenharCorpo("A senha do banco é {{secret:db_prod}} e o token `{{secret:tok}}`.\n\n```\nPGPASS={{secret:db_prod}}\n```"));
    const chips = box.querySelectorAll(".mem-segredo");
    expect(chips).toHaveLength(3);
    for (const c of chips) expect(c.textContent).toBe("senha guardada");
    expect(box.textContent).not.toContain("{{secret");
    expect(box.textContent).not.toContain("db_prod");
    expect(chips[0].title).toContain("db_prod");
    expect(chips[0].querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("corpo nunca vira HTML", () => {
    const box = document.createElement("div");
    box.append(desenharCorpo('<img src=x onerror="alert(1)"> **<b>oi</b>**'));
    expect(box.querySelector("img")).toBeNull();
    expect(box.querySelector("b")).toBeNull();
    expect(box.textContent).toContain("<img");
  });

  it("texto do aviso por operação, com fallback pro nome do arquivo", () => {
    expect(textoDoAviso({ op: "create", titulo: "Porta 8080" })).toBe("Memória salva: Porta 8080");
    expect(textoDoAviso({ op: "update", titulo: "Porta 8080" })).toBe("Memória atualizada: Porta 8080");
    expect(textoDoAviso({ op: "retire", titulo: "Porta 8080" })).toBe("Memória aposentada: Porta 8080");
    expect(textoDoAviso({ op: "create", relPath: "infra/deploy.md" })).toBe("Memória salva: deploy");
    expect(textoDoAviso({ op: "create" })).toBe("");
  });

  it("contador e textos de vazio", () => {
    expect(textoDoContador(1, false)).toBe("1 memória");
    expect(textoDoContador(3, false)).toBe("3 memórias");
    expect(textoDoContador(1, true)).toBe("1 encontrada");
    expect(TEXTO_VAZIO.texto).toContain("lembra disso");
    expect(textoSemResultado(" porta ").titulo).toBe("Nada encontrado para “porta”");
  });

  it("erros claros, sem ponto duplo", () => {
    expect(textoDoErro({ status: 404 }, "lista")).toBe("Este motor ainda não mostra as memórias. Atualize o Nexos e tente de novo.");
    expect(textoDoErro({ status: 404 }, "arquivo")).toMatch(/^Essa memória não existe mais\./);
    expect(textoDoErro(new Error("O motor não respondeu."), "lista")).toBe("Não deu pra carregar as memórias. O motor não respondeu.");
    expect(textoDoErro(new Error(""), "arquivo")).toBe("Não deu pra abrir essa memória. Tente de novo.");
  });
});

describe("seção Memórias (DOM)", () => {
  beforeEach(montarMarkup);
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const reqCom = (lista, arquivo) =>
    vi.fn(async (url) => {
      if (url.startsWith("/v1/memorias/arquivo")) {
        if (arquivo instanceof Error) throw arquivo;
        return arquivo;
      }
      if (lista instanceof Error) throw lista;
      return lista;
    });

  it("carrega e desenha grupos com título, gancho, tipo e data", async () => {
    const req = reqCom({ dir: "/m", itens: ITENS, secoes: SECOES });
    const m = createMemorias({ req, el: $, agora: () => AGORA });
    await m.carregar();
    expect(req).toHaveBeenCalledWith("/v1/memorias");
    const grupos = [...document.querySelectorAll(".mem-grupo")];
    expect(grupos.map((g) => g.querySelector(".mem-grupo-t").textContent)).toEqual(["Geral", "arquitetura", "Estilo de trabalho"]);
    const primeiro = document.querySelector('.mem-item[data-rel="deploy.md"]');
    expect(primeiro.querySelector(".mem-item-t").textContent).toBe("Deploy usa a porta 8080");
    expect(primeiro.querySelector(".mem-item-g").textContent).toBe("Servidor de homologação");
    expect(primeiro.querySelector(".mem-tipo").textContent).toBe("Infra");
    expect(primeiro.querySelector(".mem-quando").textContent).toBe("há 30 min");
    expect($("mem-contador").textContent).toBe("4 memórias");
    expect($("mem-erro").classList.contains("hidden")).toBe(true);
  });

  it("vazio fala de “lembra disso”", async () => {
    const m = createMemorias({ req: reqCom({ dir: "/m", itens: [], secoes: {} }), el: $ });
    await m.carregar();
    const v = document.querySelector(".mem-vazio");
    expect(v.querySelector("h3").textContent).toBe("Nenhuma memória ainda");
    expect(v.textContent).toContain("lembra disso");
  });

  it("busca filtra na hora e pergunta ao motor depois", async () => {
    vi.useFakeTimers();
    try {
      const req = reqCom({ dir: "/m", itens: ITENS, secoes: SECOES });
      const m = createMemorias({ req, el: $, agora: () => AGORA, esperaBuscaMs: 100 });
      await m.carregar();
      const busca = $("mem-busca");
      busca.value = "sqlite";
      busca.dispatchEvent(new Event("input"));
      expect([...document.querySelectorAll(".mem-item")].map((b) => b.dataset.rel)).toEqual(["arquitetura/banco.md"]);
      expect($("mem-contador").textContent).toBe("1 encontrada");
      await vi.advanceTimersByTimeAsync(150);
      expect(req).toHaveBeenLastCalledWith("/v1/memorias?consulta=sqlite");
    } finally {
      vi.useRealTimers();
    }
  });

  it("busca sem resultado mostra o termo e o botão de limpar", async () => {
    const m = createMemorias({ req: reqCom({ dir: "/m", itens: ITENS, secoes: {} }), el: $, esperaBuscaMs: 10_000 });
    await m.carregar();
    const busca = $("mem-busca");
    busca.value = "kubernetes";
    busca.dispatchEvent(new Event("input"));
    const v = document.querySelector(".mem-vazio");
    expect(v.querySelector("h3").textContent).toBe("Nada encontrado para “kubernetes”");
    const limpar = v.querySelector("button");
    expect(limpar.textContent).toBe("Limpar busca");
  });

  it("erro do motor aparece em texto claro e 'Tentar de novo' recarrega", async () => {
    const e = Object.assign(new Error("Não deu pra falar com o motor."), { status: 500 });
    const req = reqCom(e);
    const m = createMemorias({ req, el: $ });
    await m.carregar();
    expect($("mem-erro").classList.contains("hidden")).toBe(false);
    expect($("mem-erro-msg").textContent).toBe("Não deu pra carregar as memórias. Não deu pra falar com o motor.");
    expect($("mem-contador").textContent).toBe("não carregou");
    $("btn-mem-tentar").click();
    expect(req).toHaveBeenCalledTimes(2);
  });

  it("clicar abre o leitor com o corpo e o chip do segredo; fechar volta", async () => {
    const arquivo = { ...ITENS[0], corpo: "# Acesso\n\nUsuário `deploy`, senha {{secret:deploy_pw}}." };
    const req = reqCom({ dir: "/m", itens: ITENS, secoes: {} }, arquivo);
    const m = createMemorias({ req, el: $, agora: () => AGORA });
    await m.carregar();
    const item = document.querySelector('.mem-item[data-rel="deploy.md"]');
    item.click();
    await vi.waitFor(() => expect($("mem-leitor-h").textContent).toBe("Deploy usa a porta 8080"));
    expect(req).toHaveBeenCalledWith("/v1/memorias/arquivo?path=deploy.md");
    expect($("mem-leitor").classList.contains("hidden")).toBe(false);
    expect($("mem-corpo").dataset.aberto).toBe("1");
    expect(item.getAttribute("aria-current")).toBe("true");
    const corpo = $("mem-leitor-corpo");
    expect(corpo.querySelector(".mem-md-h").textContent).toBe("Acesso");
    expect(corpo.querySelector(".mem-segredo").textContent).toBe("senha guardada");
    expect(corpo.textContent).not.toContain("deploy_pw");
    expect($("mem-leitor-caminho").textContent).toBe("deploy.md");
    $("btn-mem-fechar").click();
    expect($("mem-leitor").classList.contains("hidden")).toBe(true);
    expect($("mem-corpo").dataset.aberto).toBe("0");
    expect(document.activeElement).toBe(document.querySelector('.mem-item[data-rel="deploy.md"]'));
  });

  it("memória que sumiu mostra o 404 claro", async () => {
    const req = reqCom({ dir: "/m", itens: ITENS, secoes: {} }, Object.assign(new Error("Not found"), { status: 404 }));
    const m = createMemorias({ req, el: $ });
    await m.carregar();
    await m.abrir("deploy.md");
    expect($("mem-leitor-erro").classList.contains("hidden")).toBe(false);
    expect($("mem-leitor-erro").textContent).toMatch(/^Essa memória não existe mais\./);
  });

  it("setas andam pela lista e ArrowUp no primeiro volta pra busca", async () => {
    const m = createMemorias({ req: reqCom({ dir: "/m", itens: ITENS, secoes: SECOES }), el: $ });
    await m.carregar();
    const itens = [...document.querySelectorAll(".mem-item")];
    $("mem-busca").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(itens[0]);
    itens[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(itens[1]);
    itens[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(itens.at(-1));
    itens.at(-1).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(itens[0]);
    itens[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe($("mem-busca"));
  });
});

describe("aviso de memória no chat", () => {
  beforeEach(() => {
    montarMarkup();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("a região é aria-live e mostra o texto clicável", () => {
    const zona = $("mem-aviso");
    expect(zona.getAttribute("aria-live")).toBe("polite");
    expect(zona.getAttribute("role")).toBe("status");
    let t = 0;
    const aoAbrir = vi.fn();
    const aviso = createAvisoDeMemoria({ el: $, aoAbrir, duracaoMs: 1000, agora: () => t });
    const ev = { type: "memoria.salva", relPath: "deploy.md", titulo: "Deploy usa a porta 8080", op: "create" };
    expect(aviso.mostrar(ev)).toBe(true);
    const b = zona.querySelector("button.mem-aviso");
    expect(b.querySelector(".mem-aviso-txt").textContent).toBe("Memória salva: Deploy usa a porta 8080");
    expect(b.querySelector(".mem-aviso-lk").textContent).toBe("Ver");
    b.click();
    expect(aoAbrir).toHaveBeenCalledWith(ev);
    expect(zona.children).toHaveLength(0);
  });

  it("some sozinho, segura no hover e não repete o mesmo evento em seguida", () => {
    let t = 0;
    const aviso = createAvisoDeMemoria({ el: $, duracaoMs: 1000, agora: () => t });
    const ev = { relPath: "a.md", titulo: "A", op: "update" };
    aviso.mostrar(ev);
    expect(aviso.mostrar(ev)).toBe(false);
    const b = $("mem-aviso").querySelector("button");
    b.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(5000);
    expect($("mem-aviso").children).toHaveLength(1);
    b.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(1100);
    expect($("mem-aviso").children).toHaveLength(0);
    t = 5000;
    expect(aviso.mostrar(ev)).toBe(true);
    expect(aviso.mostrar({ relPath: "b.md", op: "create" })).toBe(true);
    expect($("mem-aviso").textContent).toContain("Memória salva: b");
  });
});
