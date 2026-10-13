// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCerebroView } from "../cerebro-view.js";

const PANE = readFileSync(join(process.cwd(), "index.html"), "utf8").match(/<section class="pane" id="pane-cerebro"[\s\S]*?<\/section>/)[0];
const PROJ = "C:/p/nexos";

const cap = (id, extra = {}) => {
  const [tipo, nome] = id.split(":");
  return { id, tipo, nome, descricao: `desc ${nome}`, gatilhos: [], comoUsar: `use ${nome}`, origem: "auto", ligada: true, usos7d: 0, usos30d: 0, disparos30d: 0, usosAposDisparo30d: 0, ...extra };
};
const ITENS = [
  cap("ferramenta:nexo_perguntar", { usos7d: 3, usos30d: 20, gatilhos: ["decisão"], ultimoUso: "2026-10-13T10:00:00Z" }),
  cap("skill:caveman", { usos30d: 2, ultimoUso: "2026-10-13T10:00:00Z" }),
  cap("agente:explorador", { gatilhos: ["onde fica"] }),
  cap("skill:nexo-times", { ligada: false }),
];

function dadosFalsos({ itens = ITENS, falha = false } = {}) {
  let ouvinte = () => {};
  const d = {
    chamadas: [],
    ouvir: vi.fn((nome, f) => {
      if (nome === "evento") ouvinte = f;
    }),
    catalogo: vi.fn(async (path) => {
      d.chamadas.push(`catalogo:${path}`);
      if (falha) throw new Error("motor fora");
      return { itens: itens.map((c) => ({ ...c, gatilhos: [...c.gatilhos] })), kpis: null };
    }),
    salvar: vi.fn(async (id, body) => ({ id, ...body, origem: "pessoa" })),
    sugestoes: vi.fn(async () => []),
    disparos: vi.fn(async () => []),
    testar: vi.fn(async () => ({ candidatos: [], linha: "" })),
    detalhe: vi.fn(async () => null),
    removerAjuste: vi.fn(async () => ({ ok: true })),
    conteudo: vi.fn(async () => ({ texto: "" })),
    acompanhar: vi.fn((path) => d.chamadas.push(`acompanhar:${path}`)),
    pausar: vi.fn(() => d.chamadas.push("pausar")),
    emitir: (ev) => ouvinte(ev),
  };
  return d;
}

const noite = () => new Promise((r) => setTimeout(r, 0));
let timers;
function montar(opts = {}) {
  document.body.innerHTML = `<div id="work-stage">${PANE.replace('class="pane"', 'class="pane is-on"')}</div>`;
  timers = [];
  const dados = dadosFalsos(opts);
  const view = createCerebroView({
    el: (id) => document.getElementById(id),
    dados,
    getProjetoAtual: () => opts.atual ?? PROJ,
    getProjetos: () => [PROJ, "C:/p/outro"],
    armazenamento: { getItem: (k) => (k === "nexos.cerebro.modo" ? (opts.modo ?? "mapa") : null), setItem: () => {} },
    win: { matchMedia: () => ({ matches: opts.reduzido ?? true }) },
    agendar: (f, ms) => (timers.push({ f, ms }), timers.length),
    cancelar: () => {},
    relogio: () => Date.parse("2026-10-13T10:30:00Z"),
  });
  view.ligar();
  return { view, dados };
}

describe("aba Cérebro (modo mapa)", () => {
  beforeEach(() => {
    globalThis.CSS ??= { escape: (s) => s.replace(/([^\w-])/g, "\\$1") };
  });

  it("ao ficar visível carrega o catálogo do projeto, liga o stream e desenha KPIs, legenda, mapa e rodapé", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    expect(dados.chamadas).toEqual([`catalogo:${PROJ}`, `acompanhar:${PROJ}`]);
    const escopo = document.getElementById("cb-escopo");
    expect(escopo.value).toBe(PROJ);
    expect([...escopo.options].map((o) => o.textContent)).toEqual(["nexos (aberto)", "outro", "Global (chat geral)"]);
    expect(document.getElementById("cb-modo-mapa").dataset.on).toBe("1");
    const kps = [...document.querySelectorAll(".cb-kp")].map((k) => k.querySelector(".cb-kp-num").textContent);
    expect(kps).toEqual(["4", "1", "0", "2"]);
    expect(document.querySelectorAll(".cb-leg-item")).toHaveLength(7);
    expect(document.querySelectorAll("[data-no]")).toHaveLength(4);
    expect(document.querySelectorAll("[data-hub]")).toHaveLength(7);
    const no = document.querySelector('[data-no="ferramenta:nexo_perguntar"]');
    expect(no.getAttribute("role")).toBe("button");
    expect(no.getAttribute("aria-label")).toContain("3 usos em 7 d");
    expect(no.querySelector(".cb-anel")).not.toBeNull();
    expect(document.querySelector('[data-no="skill:nexo-times"]').classList.contains("off")).toBe(true);
    expect(document.querySelector('[data-no="agente:explorador"] .cb-cap').classList.contains("nunca")).toBe(true);
    expect(document.querySelector(".cb-rodape").textContent).toContain("tracejado = nunca usada");

    // oculta: para o stream
    view.visivel(false);
    expect(dados.chamadas.at(-1)).toBe("pausar");
  });

  it("legenda esconde um tipo; clicar num nó abre o painel; Esc fecha; salvar manda o ajuste e mostra toast", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    const leg = document.querySelector('.cb-leg-item[data-tipo="skill"]');
    leg.click();
    expect(leg.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll("[data-no]")).toHaveLength(2);
    leg.click();
    expect(document.querySelectorAll("[data-no]")).toHaveLength(4);

    document.querySelector('[data-no="ferramenta:nexo_perguntar"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const painel = document.querySelector(".cb-painel");
    expect(painel).not.toBeNull();
    expect(painel.getAttribute("aria-labelledby")).toBe("cb-painel-tit");
    expect(document.getElementById("cb-painel-tit").textContent).toBe("nexo_perguntar");
    expect(painel.querySelector(".cb-info")).not.toBeNull();
    expect([...painel.querySelectorAll(".cb-chip")].map((c) => c.textContent)).toEqual(["decisão"]);

    // acrescenta um gatilho com Enter e edita a descrição
    const inp = painel.querySelector(".cb-chip-inp");
    inp.value = "Escolher ";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect([...painel.querySelectorAll(".cb-chip")].map((c) => c.textContent)).toEqual(["decisão", "escolher"]);
    const ta = painel.querySelector("textarea");
    ta.value = "Pergunta com botões";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(painel.querySelector(".cb-campo > label span:last-child").textContent).toBe("19/120");

    document.getElementById("btn-cb-salvar").click();
    await noite();
    expect(dados.salvar).toHaveBeenCalledWith("ferramenta:nexo_perguntar", { descricao: "Pergunta com botões", gatilhos: ["decisão", "escolher"], comoUsar: "use nexo_perguntar", ligada: true }, PROJ);
    expect(document.querySelector(".cb-painel")).toBeNull();
    expect(document.getElementById("cb-toast").textContent).toContain("salvo");
    expect(view.estado.itens[0].origem).toBe("pessoa");

    document.querySelector('[data-no="skill:caveman"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".cb-painel")).not.toBeNull();
    document.querySelector(".cb-painel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cb-painel")).toBeNull();
  });

  it("evento ao vivo soma no KPI e no aria-label; sem reduced-motion o nó pulsa e a aresta acende", async () => {
    const { view, dados } = montar({ reduzido: false });
    view.visivel(true);
    await noite();
    dados.emitir({ tipo: "disparo", chave: "agente:explorador", threadId: "t", ts: "2026-10-13T10:20:00Z" });
    const no = document.querySelector('[data-no="agente:explorador"]');
    expect(no.classList.contains("cb-pulsa")).toBe(true);
    expect(no.getAttribute("aria-label")).toContain("disparou 1");
    dados.emitir({ tipo: "uso", chave: "agente:explorador", threadId: "t", ts: "2026-10-13T10:21:00Z", usou: true });
    expect(document.querySelector('[data-aresta="agente:explorador"]').classList.contains("cb-viva")).toBe(true);
    const kps = [...document.querySelectorAll(".cb-kp")].map((k) => k.querySelector(".cb-kp-num").textContent);
    expect(kps).toEqual(["4", "2", "1", "1"]);
    expect(document.querySelector('[data-kp="gatilhos"] .cb-kp-rod').textContent).toBe("→ 1 usos (100%)");
  });

  it("estados: erro com 'tentar de novo', vazio sem itens", async () => {
    const a = montar({ falha: true });
    a.view.visivel(true);
    await noite();
    const alerta = document.querySelector(".cb-alerta.danger");
    expect(alerta.textContent).toContain("motor fora");
    alerta.querySelector("button").click();
    expect(a.dados.catalogo).toHaveBeenCalledTimes(2);

    const b = montar({ itens: [] });
    b.view.visivel(true);
    await noite();
    expect(document.querySelector(".cb-vazio").textContent).toContain("Abra uma conversa neste projeto");
  });
});
