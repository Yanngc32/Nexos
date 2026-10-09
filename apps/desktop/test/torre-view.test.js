// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTorreView } from "../torre-view.js";
import { aplicarRetrato, feedVazio } from "../torre/feed.js";

const PANE = readFileSync(join(process.cwd(), "index.html"), "utf8").match(/<section class="pane" id="pane-torre"[\s\S]*?<\/section>/)[0];
const T0 = 4_000_000;
const ag = (id, p, extra = {}) => ({ threadId: id, projectPath: p, busy: false, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], preview: `Conversa ${id}`, updatedAt: new Date(T0).toISOString(), ...extra });

/** Dados falsos: o feed é preenchido pelo teste; `retomar` só marca como ligado. */
function dadosFalsos(agentes) {
  const feed = feedVazio();
  let ligado = false;
  const d = {
    feed,
    chamadas: [],
    get ligado() {
      return ligado;
    },
    async retomar() {
      d.chamadas.push("retomar");
      ligado = true;
      aplicarRetrato(feed, agentes, T0);
      return true;
    },
    pausar: vi.fn(() => {
      d.chamadas.push("pausar");
      ligado = false;
    }),
    observar: vi.fn(),
    ouvir: vi.fn(),
    aoEventoAgente: vi.fn(),
  };
  return d;
}

let raf;
function montar({ agentes, reduzido = true, motorOk = true, projetos = ["C:/p/nexos", "C:/p/outro"], atual = "C:/p/nexos" } = {}) {
  document.body.innerHTML = `<div id="work-stage">${PANE.replace('class="pane"', 'class="pane is-on"')}</div>`;
  raf = { cbs: [], id: 0 };
  const win = {
    matchMedia: () => ({ matches: reduzido }),
    requestAnimationFrame: (f) => {
      raf.cbs.push(f);
      return ++raf.id;
    },
    cancelAnimationFrame: () => {},
  };
  const dados = dadosFalsos(agentes);
  const eventos = [];
  let agora = T0;
  const view = createTorreView({
    el: (id) => document.getElementById(id),
    dados,
    getProjetos: () => projetos,
    getProjetoAtual: () => atual,
    motorOk: () => motorOk,
    aoAbrirConversa: (x) => eventos.push(["conversa", x]),
    aoAbrirPlano: (p) => eventos.push(["plano", p]),
    aoAbrirMemoria: (p) => eventos.push(["memoria", p]),
    aoAbrirTarefas: (p) => eventos.push(["tarefas", p]),
    aoAbrirCanvas: (p) => eventos.push(["canvas", p]),
    aoAbrirContas: () => eventos.push(["contas"]),
    aoLigarMotor: () => eventos.push(["ligar"]),
    doc: document,
    win,
    relogio: () => agora,
  });
  view.ligar();
  return { view, dados, eventos, win, avancar: (ms) => (agora += ms), tique: (ts = 1_000_000) => raf.cbs.splice(0).forEach((f) => f(ts)) };
}

const espera = () => new Promise((r) => setTimeout(r, 0));
const torres = () => [...document.querySelectorAll(".vg-torre")];
const AGENTES = [ag("a", "C:/p/nexos", { busy: true }), ag("b", "C:/p/nexos", { aguardando: true, pergunta: { texto: "Qual?" } }), ag("c", "C:/p/outro", { busy: true })];

describe("aba Torre: visão geral", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("abre na visão geral com 2 projetos ativos: um botão por torre com rótulo acessível e resumo na barra", async () => {
    const { view } = montar({ agentes: AGENTES });
    view.visivel(true);
    await espera();
    await espera();
    expect(view.nivel).toBe("geral");
    expect(torres().map((b) => b.getAttribute("aria-label"))).toEqual(["nexos: 1 trabalhando, 1 esperando você", "outro: 1 trabalhando"]);
    expect(document.getElementById("tr-resumo").textContent).toContain("1 esperando você");
    expect(document.getElementById("tr-nome").textContent).toBe("Torres");
    expect(document.getElementById("btn-tr-voltar").classList.contains("hidden")).toBe(true);
  });

  it("clique na torre faz zoom (troca direta com movimento reduzido); Esc e o botão voltam; o ? abre a conversa certa", async () => {
    const { view, eventos } = montar({ agentes: AGENTES });
    view.visivel(true);
    await espera();
    await espera();
    // o "?" pula o zoom e abre a conversa que espera
    document.querySelector(".vg-q").click();
    expect(eventos).toEqual([["conversa", { threadId: "b", projectPath: "C:/p/nexos" }]]);
    expect(view.nivel).toBe("geral");
    torres()[0].click();
    await espera();
    await espera();
    expect(view.nivel).toBe("c:/p/nexos");
    expect(document.getElementById("btn-tr-voltar").classList.contains("hidden")).toBe(false);
    expect(document.querySelector(".tr-torre")).toBeTruthy();
    // Esc volta pra visão geral
    document.getElementById("pane-torre").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await espera();
    await espera();
    expect(view.nivel).toBe("geral");
    torres()[1].click();
    await espera();
    await espera();
    expect(view.nivel).toBe("c:/p/outro");
    document.getElementById("btn-tr-voltar").click();
    await espera();
    await espera();
    expect(view.nivel).toBe("geral");
  });

  it("projetos sem atividade: torres apagadas e 'Tudo quieto no reino.'", async () => {
    const { view } = montar({ agentes: [], projetos: ["C:/p/a", "C:/p/b"], atual: "" });
    view.visivel(true);
    await espera();
    await espera();
    expect(view.nivel).toBe("geral");
    expect(document.querySelector(".tr-msg-vazio").textContent).toBe("Tudo quieto no reino.");
    expect(torres().every((t) => t.classList.contains("apagada"))).toBe(true);
  });

  it("motor desligado: silhuetas, mensagem e botão Ligar", async () => {
    const { view, eventos } = montar({ agentes: [], motorOk: false });
    view.visivel(true);
    await espera();
    await espera();
    expect(document.querySelector(".tr-msg-fora p").textContent).toBe("Motor desligado");
    document.querySelector(".tr-ligar").click();
    expect(eventos).toEqual([["ligar"]]);
    expect(torres().every((t) => t.disabled)).toBe(true);
  });
});

describe("aba Torre: torre de um projeto", () => {
  it("botões de verdade pra cada mago, plaquinhas, andares clicáveis e mural", async () => {
    const { view, eventos } = montar({ agentes: AGENTES });
    view.visivel(true);
    await espera();
    await espera();
    await view.abrirEm("c:/p/nexos");
    await espera();
    expect(view.nivel).toBe("c:/p/nexos");
    expect(document.getElementById("tr-nome").textContent).toBe("nexos");
    const magos = [...document.querySelectorAll(".tr-mago")];
    expect(magos.map((b) => b.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["Conversa Conversa a — trabalhando", "Conversa Conversa b — esperando sua resposta"]));
    expect(document.querySelectorAll(".tr-placa")).toHaveLength(2);
    magos.find((b) => b.getAttribute("aria-label").includes("Conversa b")).click();
    expect(eventos.at(-1)).toEqual(["conversa", { threadId: "b", projectPath: "C:/p/nexos" }]);
    // andares de apoio e mural levam pra tela certa
    for (const [rotulo, esperado] of [
      ["Abrir Configurações › Contas", ["contas"]],
      ["Abrir o Planejamento", ["plano", "C:/p/nexos"]],
      ["Abrir a Memória do Projeto", ["memoria", "C:/p/nexos"]],
      ["Abrir o Canvas", ["canvas", "C:/p/nexos"]],
    ]) {
      document.querySelector(`.tr-area[aria-label="${rotulo}"]`).click();
      expect(eventos.at(-1)).toEqual(esperado);
    }
    document.querySelector(".tr-mural").click();
    expect(eventos.at(-1)).toEqual(["tarefas", "C:/p/nexos"]);
    // a torre inteira tem um resumo em texto pro leitor de tela
    expect(document.getElementById("tr-resumo-sr").textContent).toContain("Torre nexos.");
  });

  it("torre sem conversa mostra mensagem de vazio e mantém o botão de voltar", async () => {
    const { view } = montar({ agentes: [] , atual: "C:/p/nexos"});
    view.visivel(true);
    await espera();
    await espera();
    expect(view.nivel).toBe("c:/p/nexos");
    expect(document.querySelector(".tr-msg-vazio p").textContent).toBe("Nenhum mago trabalhando neste projeto.");
    expect(document.getElementById("btn-tr-voltar").classList.contains("hidden")).toBe(false);
  });
});

describe("aba Torre: aba oculta não deixa nada rodando", () => {
  it("ocultar pausa os dados e o loop; voltar recomeça do retrato de agora", async () => {
    const { view, dados, tique } = montar({ agentes: AGENTES });
    view.visivel(true);
    await espera();
    await espera();
    expect(view.rodando).toBe(true);
    expect(raf.cbs.length).toBeGreaterThan(0);
    view.visivel(false);
    expect(dados.pausar).toHaveBeenCalled();
    expect(view.rodando).toBe(false);
    // o quadro que já estava agendado não reagenda
    tique();
    expect(raf.cbs).toHaveLength(0);
    view.visivel(true);
    await espera();
    await espera();
    expect(dados.chamadas.filter((c) => c === "retomar")).toHaveLength(2);
    expect(view.rodando).toBe(true);
  });

  it("evento de agente só vai pros dados (o renderer já tem o stream)", () => {
    const { view, dados } = montar({ agentes: AGENTES });
    view.aoEventoAgente({ type: "tool", threadId: "a", name: "Read" });
    expect(dados.aoEventoAgente).toHaveBeenCalledWith({ type: "tool", threadId: "a", name: "Read" });
  });
});
