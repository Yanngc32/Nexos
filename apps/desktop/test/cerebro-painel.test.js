// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCerebroView } from "../cerebro-view.js";

const PANE = readFileSync(join(process.cwd(), "index.html"), "utf8").match(/<section class="pane" id="pane-cerebro"[\s\S]*?<\/section>/)[0];
const PROJ = "C:/p/nexos";
const AGORA = Date.parse("2026-10-13T12:00:00Z");

const cap = (id, extra = {}) => {
  const [tipo, nome] = id.split(":");
  return { id, tipo, nome, descricao: `desc ${nome}`, gatilhos: [], comoUsar: `use ${nome}`, origem: "auto", ligada: true, usos7d: 0, usos30d: 0, disparos30d: 0, usosAposDisparo30d: 0, porDia: Array(14).fill(0), disparosPorDia: Array(14).fill(0), ...extra };
};
const itensBase = () => [
  cap("ferramenta:nexo_perguntar", { usos7d: 3, usos30d: 20, disparos30d: 4, usosAposDisparo30d: 4, gatilhos: ["decisão", "escolher", "qual opção", "o que prefere"], ultimoUso: "2026-10-13T11:48:00Z", porDia: [...Array(13).fill(0), 3] }),
  cap("skill:make-interfaces-feel-better", { usos30d: 2, gatilhos: ["ui", "tela"], ultimoUso: "2026-10-12T10:00:00Z" }),
  cap("agente:explorador", { gatilhos: ["onde fica"], disparos30d: 7 }),
  cap("doc:DOC_TEC.md", { gatilhos: ["arquitetura"] }),
  cap("skill:nexo-times", { ligada: false }),
];

function dadosFalsos() {
  let ouvinte = () => {};
  const d = {
    itens: itensBase(),
    ouvir: (nome, f) => nome === "evento" && (ouvinte = f),
    catalogo: vi.fn(async () => ({ itens: d.itens.map((c) => ({ ...c, gatilhos: [...c.gatilhos] })), kpis: null })),
    salvar: vi.fn(async (id, body) => ({ id, ...body, ...(body.descricao !== undefined || body.gatilhos !== undefined ? { origem: "pessoa" } : {}) })),
    removerAjuste: vi.fn(async () => ({ ok: true })),
    sugestoes: vi.fn(async () => [
      { tipo: "ignorado", nivel: "atencao", id: "agente:explorador", titulo: "agente:explorador", texto: "7 disparos, 0 usos." },
      { tipo: "gatilho", nivel: "info", id: "skill:make-interfaces-feel-better", titulo: "skill:make-interfaces-feel-better", texto: "vale virar gatilho", gatilhos: ["layout", "css"] },
      { tipo: "sem-gatilho", nivel: "atencao", titulo: "5 ferramentas sem gatilho e sem uso", texto: "x", ids: ["skill:nexo-times", "doc:DOC_TEC.md"] },
    ]),
    disparos: vi.fn(async () => [
      { ts: "2026-10-13T11:59:00Z", threadId: "t1", chave: "agente:explorador", tipo: "chat", titulo: "Cérebro centralizado" },
      { ts: "2026-10-13T11:00:00Z", threadId: "t2", chave: "skill:make-interfaces-feel-better", tipo: "chat", titulo: "Release", usou: true },
      { ts: "2026-10-13T08:00:00Z", threadId: "t3", chave: "agente:explorador", tipo: "chat", titulo: "Torre" },
    ]),
    testar: vi.fn(async (texto) => ({
      candidatos: texto.includes("mock")
        ? [
            { id: "agente:explorador", gatilho: "onde fica", comoUsar: "Agent explorador", peso: 19, bateram: ["onde fica"], entra: true },
            { id: "skill:make-interfaces-feel-better", gatilho: "tela", comoUsar: "Skill x", peso: 14, bateram: ["tela"], entra: true },
          ]
        : [],
      linha: texto.includes("mock") ? "[Cérebro] onde fica → Agent explorador; tela → Skill x" : "",
    })),
    detalhe: vi.fn(async (id) => ({ id, porConversa: { chat: 5, run: 1, time: 0, oculta: 0 }, porDia: Array(14).fill(1), disparosPorDia: Array(14).fill(0), ultimos: [{ ts: "2026-10-13T11:00:00Z", threadId: "t9", titulo: "Ajustes do login", tipo: "chat" }], gatilhosSugeridos: [{ termo: "pergunta", vezes: 4 }] })),
    conteudo: vi.fn(async () => ({ texto: "# DOC\n\nconteúdo do doc", caminho: "C:/p/nexos/DOC_TEC.md" })),
    salvarMcp: vi.fn(async () => ({})),
    descobrirMcp: vi.fn(async () => ({ ferramentas: [{ name: "a" }, { name: "b" }] })),
    acompanhar: vi.fn(),
    pausar: vi.fn(),
    emitir: (ev) => ouvinte(ev),
  };
  return d;
}

const noite = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
let timers;
function montar() {
  document.body.innerHTML = `<div id="work-stage">${PANE.replace('class="pane"', 'class="pane is-on"')}</div>`;
  timers = [];
  const dados = dadosFalsos();
  const abertas = [];
  const guardado = new Map([["nexos.cerebro.modo", "painel"]]);
  const view = createCerebroView({
    el: (id) => document.getElementById(id),
    dados,
    getProjetoAtual: () => PROJ,
    getProjetos: () => [PROJ],
    aoAbrirConversa: (x) => abertas.push(x),
    win: { matchMedia: () => ({ matches: true }) },
    agendar: (f, ms) => (timers.push({ f, ms }), timers.length),
    cancelar: () => {},
    relogio: () => AGORA,
    armazenamento: { getItem: (k) => guardado.get(k) ?? null, setItem: (k, v) => guardado.set(k, v) },
  });
  view.ligar();
  return { view, dados, abertas, guardado };
}
const linhas = () => [...document.querySelectorAll("tr.cb-lin")].map((tr) => tr.dataset.id);
const tecla = (alvo, key, extra = {}) => alvo.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
const rodarTimers = () => {
  const t = timers.splice(0);
  for (const x of t) x.f();
};

describe("aba Cérebro — modo Painel", () => {
  beforeEach(() => {
    globalThis.CSS ??= { escape: (s) => s.replace(/([^\w-])/g, "\\$1") };
  });

  it("abre no Painel: KPIs, teste, filtros, tabela ordenada por usos, sugestões e linha do tempo", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    expect(document.getElementById("cb-modo-painel").dataset.on).toBe("1");
    const kps = Object.fromEntries([...document.querySelectorAll(".cb-kp")].map((k) => [k.dataset.kp, k.querySelector(".cb-kp-num").textContent]));
    expect(kps).toEqual({ total: "5", usadas: "1de 5", gatilhos: "11→ 4 usos", nunca: "3" });
    expect(document.querySelector('[data-kp="nunca"] .cb-kp-rod').textContent).toBe("1 sem gatilho · 2 com gatilho");
    expect(linhas()[0]).toBe("ferramenta:nexo_perguntar");
    const l0 = document.querySelector("tr.cb-lin");
    expect(l0.querySelectorAll(".cb-gat > span:not(.cb-mais)")).toHaveLength(3);
    expect(l0.querySelector(".cb-mais").textContent).toBe("+1");
    expect(l0.querySelector(".cb-col-ult").textContent).toBe("há 12 min");
    expect(l0.querySelector(".cb-col-disp").textContent).toContain("4 → 4");
    expect(document.querySelector(".cb-tb th.ordenado").getAttribute("aria-sort")).toBe("descending");
    // sugestão de gatilho aparece como chip tracejado na linha da skill
    expect(document.querySelector('tr.cb-lin[data-id="skill:make-interfaces-feel-better"] .cb-sug-chip').textContent).toBe('+ "layout"');
    expect(document.querySelectorAll(".cb-sug-i")).toHaveLength(3);
    // linha do tempo: 24 h, 3 disparos, faixa com 24 colunas e o mais novo "esperando"
    expect(document.querySelectorAll(".cb-faixa i")).toHaveLength(24);
    expect(document.querySelectorAll(".cb-lt-lista li")).toHaveLength(3);
    expect(document.querySelector(".cb-lt-lista .cb-res").textContent).toBe("esperando");
    expect(dados.sugestoes).toHaveBeenCalledWith(PROJ);
  });

  it("KPI e chips filtram; busca filtra em tempo real; cabeçalho ordena", async () => {
    const { view } = montar();
    view.visivel(true);
    await noite();
    document.querySelector('[data-kp="nunca"]').click();
    // empate em 0 usos: ordem pelo nome
    expect(linhas()).toEqual(["doc:DOC_TEC.md", "agente:explorador", "skill:nexo-times"]);
    expect(document.querySelector('[data-kp="nunca"]').getAttribute("aria-pressed")).toBe("true");
    document.querySelector('[data-kp="nunca"]').click();
    expect(linhas()).toHaveLength(5);
    const skill = [...document.querySelectorAll('[data-grupo="tipos"] .cb-chip-f')].find((b) => b.textContent.startsWith("skill"));
    skill.click();
    expect(linhas()).toEqual(["skill:make-interfaces-feel-better", "skill:nexo-times"]);
    skill.click();
    const busca = document.querySelector(".cb-busca input");
    busca.value = "arquitetura";
    busca.dispatchEvent(new Event("input"));
    expect(linhas()).toEqual(["doc:DOC_TEC.md"]);
    busca.value = "";
    busca.dispatchEvent(new Event("input"));
    document.querySelector('.cb-th[data-col="nome"]').click();
    expect(linhas()[0]).toBe("doc:DOC_TEC.md");
    expect(document.querySelector(".cb-tb th.ordenado").getAttribute("aria-sort")).toBe("ascending");
  });

  it("testar gatilhos: espera parar de digitar, marca os termos e mostra a linha exata", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    const inp = document.getElementById("cb-teste-inp");
    inp.value = "faz um mock da tela e onde fica o form";
    inp.dispatchEvent(new Event("input"));
    expect(dados.testar).not.toHaveBeenCalled();
    rodarTimers();
    await noite();
    expect(dados.testar).toHaveBeenCalledWith("faz um mock da tela e onde fica o form", PROJ);
    expect([...document.querySelectorAll(".cb-teste-eco mark")].map((m) => m.textContent)).toEqual(["tela", "onde fica"]);
    expect(document.querySelector(".cb-previa").textContent).toBe("[Cérebro] onde fica → Agent explorador; tela → Skill x");
    expect(document.querySelectorAll(".cb-bate-l")).toHaveLength(2);
    // clicar num candidato abre a linha dele
    document.querySelector(".cb-bate-l").click();
    expect(view.painel.estado.aberto).toBe("agente:explorador");
  });

  it("linha abre pra editar: detalhe, sugeridos, salvar grava e fecha; Esc fecha; ↑↓ navega", async () => {
    const { view, dados, abertas } = montar();
    view.visivel(true);
    await noite();
    document.querySelector('tr.cb-lin[data-id="ferramenta:nexo_perguntar"]').click();
    await noite();
    const exp = document.querySelector("tr.cb-exp");
    expect(exp).not.toBeNull();
    expect(document.querySelector('tr.cb-lin[data-id="ferramenta:nexo_perguntar"]').getAttribute("aria-expanded")).toBe("true");
    expect(dados.detalhe).toHaveBeenCalledWith("ferramenta:nexo_perguntar", PROJ);
    expect(exp.querySelector(".cb-exp-d2").textContent).toContain("Usos × disparos");
    expect(exp.querySelector(".cb-exp-d2").textContent).toContain("passo de time / run1");
    expect(exp.querySelector(".cb-exp-d3").textContent).toContain("Ajustes do login");
    exp.querySelector(".cb-exp-d3 .cb-lk").click();
    expect(abertas).toEqual([{ threadId: "t9", projectPath: PROJ }]);
    // sugerido vira chip clicável
    const sug = exp.querySelector(".cb-chips .cb-sug-chip");
    expect(sug.textContent).toContain('"pergunta"');
    sug.click();
    const inp = exp.querySelector(".cb-chip-inp");
    inp.value = "Prefere";
    tecla(inp, "Enter");
    expect([...exp.querySelectorAll(".cb-chip")].map((c) => c.textContent)).toEqual(["decisão", "escolher", "qual opção", "o que prefere", "pergunta", "prefere"]);
    const ta = exp.querySelector("textarea");
    ta.value = "Pergunta com botões";
    ta.dispatchEvent(new Event("input"));
    document.getElementById("btn-cb-salvar-linha").click();
    await noite();
    expect(dados.salvar).toHaveBeenCalledWith(
      "ferramenta:nexo_perguntar",
      { descricao: "Pergunta com botões", gatilhos: ["decisão", "escolher", "qual opção", "o que prefere", "pergunta", "prefere"], comoUsar: "use nexo_perguntar" },
      PROJ,
    );
    expect(document.querySelector("tr.cb-exp")).toBeNull();
    expect(document.getElementById("cb-toast").textContent).toContain("salvo");
    expect(document.querySelector('tr.cb-lin[data-id="ferramenta:nexo_perguntar"] .cb-pessoa')).not.toBeNull();

    // teclado: foco na 1ª linha, ↓ vai pra 2ª, Enter abre, Esc fecha
    const tr0 = document.querySelector("tr.cb-lin");
    tr0.focus();
    tecla(tr0, "ArrowDown");
    expect(document.activeElement.dataset.id).toBe(linhas()[1]);
    tecla(document.activeElement, "Enter");
    expect(view.painel.estado.aberto).toBe(linhas()[1]);
    tecla(document.querySelector(".cb-exp-grid"), "Escape");
    expect(document.querySelector("tr.cb-exp")).toBeNull();
  });

  it("switch liga/desliga na hora com desfazer; sugestão adiciona gatilho; desligar todas", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    const sw = document.querySelector('tr.cb-lin[data-id="doc:DOC_TEC.md"] .cb-sw');
    sw.checked = false;
    sw.dispatchEvent(new Event("change"));
    await noite();
    expect(dados.salvar).toHaveBeenCalledWith("doc:DOC_TEC.md", { ligada: false }, PROJ);
    const toast = document.getElementById("cb-toast");
    expect(toast.textContent).toContain("DOC_TEC.md desligada neste projeto");
    toast.querySelector(".cb-toast-lk").click();
    await noite();
    expect(dados.salvar).toHaveBeenLastCalledWith("doc:DOC_TEC.md", { ligada: true }, PROJ);

    const add = [...document.querySelectorAll(".cb-sug-i button")].find((b) => b.textContent.startsWith("Adicionar"));
    add.click();
    await noite();
    expect(dados.salvar).toHaveBeenLastCalledWith("skill:make-interfaces-feel-better", { gatilhos: ["ui", "tela", "layout", "css"] }, PROJ);
    expect(document.querySelectorAll(".cb-sug-i")).toHaveLength(2);

    const revisar = [...document.querySelectorAll(".cb-sug-i button")].find((b) => b.textContent === "Revisar lista");
    revisar.click();
    expect(linhas().sort()).toEqual(["doc:DOC_TEC.md", "skill:nexo-times"]);
    expect(document.querySelector('[data-grupo="ids"] .cb-chip-f').textContent).toContain("sem gatilho e sem uso: 2");
    const desligar = [...document.querySelectorAll(".cb-sug-i button")].find((b) => b.textContent === "Desligar todas");
    desligar.click();
    await noite();
    expect(dados.salvar).toHaveBeenCalledWith("doc:DOC_TEC.md", { ligada: false }, PROJ);
    expect(dados.salvar).not.toHaveBeenCalledWith("skill:nexo-times", { ligada: false }, PROJ);
  });

  it("evento ao vivo: linha acende 'disparou agora', KPI soma, disparo entra no topo da linha do tempo", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    expect(document.querySelector('[data-kp="gatilhos"] .cb-kp-num').textContent).toBe("11→ 4 usos");
    dados.emitir({ tipo: "disparo", chave: "agente:explorador", threadId: "t5", ts: "2026-10-13T11:59:50Z", projectPath: PROJ });
    const tr = document.querySelector('tr.cb-lin[data-id="agente:explorador"]');
    expect(tr.classList.contains("nova")).toBe(true);
    expect(tr.querySelector(".cb-agora").textContent).toContain("disparou agora");
    expect(document.querySelector('[data-kp="gatilhos"] .cb-kp-num').textContent).toBe("12→ 4 usos");
    const topo = document.querySelector(".cb-lt-lista li");
    expect(topo.classList.contains("nova")).toBe(true);
    expect(topo.textContent).toContain("agente:explorador");
    // uso logo depois marca o disparo como "usou"
    dados.emitir({ tipo: "uso", chave: "agente:explorador", threadId: "t5", ts: "2026-10-13T11:59:55Z", projectPath: PROJ, usou: true });
    expect(document.querySelector(".cb-lt-lista li .cb-res").textContent).toBe("usou");
    expect(document.querySelector('tr.cb-lin[data-id="agente:explorador"] .cb-uso-c .cb-num').textContent).toBe("1 / 1");
  });

  it("folha 'Adicionar capacidade': doc pede caminho, mostra a prévia do pack e grava como capacidade nova", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    document.getElementById("btn-cb-adicionar").click();
    const folha = document.querySelector(".cb-folha");
    expect(folha.getAttribute("aria-modal")).toBe("true");
    const [caminho, nome, descricao] = folha.querySelectorAll(".cb-folha-campos input[type=text]");
    caminho.value = "docs/RUNBOOK.md";
    caminho.dispatchEvent(new Event("input"));
    descricao.value = "Como subir em produção.";
    descricao.dispatchEvent(new Event("input"));
    expect(nome.value).toBe("");
    const g = folha.querySelector(".cb-chip-inp");
    g.value = "deploy";
    tecla(g, "Enter");
    g.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    expect(folha.querySelector(".cb-previa").textContent).toBe("no pack: deploy → Read docs/RUNBOOK.md");
    [...folha.querySelectorAll(".cb-folha-rod button")].find((b) => b.textContent === "Salvar").click();
    await noite();
    expect(dados.salvar).toHaveBeenCalledWith(
      "doc:runbook",
      { tipo: "doc", nome: "RUNBOOK.md", descricao: "Como subir em produção.", gatilhos: ["deploy"], caminho: "C:/p/nexos/docs/RUNBOOK.md", comoUsar: "Read docs/RUNBOOK.md" },
      PROJ,
    );
    expect(document.querySelector(".cb-folha")).toBeNull();
    expect(dados.catalogo).toHaveBeenCalledTimes(2);

    // MCP externo: grava e descobre as ferramentas
    document.getElementById("btn-cb-adicionar").click();
    const f2 = document.querySelector(".cb-folha");
    [...f2.querySelectorAll(".cb-tipo-b")].find((b) => b.dataset.tipo === "mcp-externo").click();
    const [nomeMcp, comando] = f2.querySelectorAll(".cb-folha-campos input[type=text]");
    nomeMcp.value = "github";
    nomeMcp.dispatchEvent(new Event("input"));
    comando.value = "npx -y @mcp/github";
    comando.dispatchEvent(new Event("input"));
    [...f2.querySelectorAll(".cb-folha-rod button")].find((b) => b.textContent === "Salvar").click();
    await noite();
    expect(dados.salvarMcp).toHaveBeenCalledWith("github", { transporte: "stdio", comando: "npx", args: ["-y", "@mcp/github"], descricao: "" }, PROJ);
    expect(dados.descobrirMcp).toHaveBeenCalledWith("github", PROJ);
    expect(document.getElementById("cb-toast").textContent).toContain("github: 2 ferramenta(s) no catálogo");
  });

  it("atalhos: / busca, t testar, n nova, m troca pro mapa e guarda o modo; ver no mapa foca o nó", async () => {
    const { view, guardado } = montar();
    view.visivel(true);
    await noite();
    const pane = document.getElementById("pane-cerebro");
    tecla(pane, "/");
    expect(document.activeElement).toBe(document.querySelector(".cb-busca input"));
    document.activeElement.blur();
    tecla(pane, "t");
    expect(document.activeElement.id).toBe("cb-teste-inp");
    document.activeElement.blur();
    tecla(pane, "n");
    expect(document.querySelector(".cb-folha")).not.toBeNull();
    tecla(document.querySelector(".cb-folha"), "Escape");
    expect(document.querySelector(".cb-folha")).toBeNull();
    tecla(pane, "m");
    expect(document.getElementById("cb-modo-mapa").dataset.on).toBe("1");
    expect(guardado.get("nexos.cerebro.modo")).toBe("mapa");
    expect(document.querySelector("#cb-svg")).not.toBeNull();
    tecla(pane, "m");
    expect(document.querySelector(".cb-tb")).not.toBeNull();
    document.querySelector('tr.cb-lin[data-id="skill:nexo-times"] [aria-label="ver nexo-times no mapa"]').click();
    const no = document.querySelector('[data-no="skill:nexo-times"]');
    expect(no.classList.contains("cb-destaque")).toBe(true);
  });

  it("ver conteúdo abre a folha com o texto; escopo Global recarrega sem projeto", async () => {
    const { view, dados } = montar();
    view.visivel(true);
    await noite();
    document.querySelector('tr.cb-lin[data-id="doc:DOC_TEC.md"] [aria-label="ver conteúdo de DOC_TEC.md"]').click();
    await noite();
    expect(document.querySelector(".cb-pre").textContent).toContain("conteúdo do doc");
    expect(dados.conteudo).toHaveBeenCalledWith("doc:DOC_TEC.md", PROJ);
    const sel = document.getElementById("cb-escopo");
    sel.value = "";
    sel.dispatchEvent(new Event("change"));
    await noite();
    expect(dados.catalogo).toHaveBeenLastCalledWith("");
    expect(dados.acompanhar).toHaveBeenLastCalledWith("");
  });
});

