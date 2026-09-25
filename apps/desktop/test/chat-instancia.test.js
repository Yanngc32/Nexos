// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { CAMPOS_DO_CHAT, IDS_DO_CHAT, criarAreaDeChats, criarEstadoDoChat, elementoDoChat, ligarEstadoDoChat, ouvirConversa } from "../chat-instancia.js";

/** Stream falso controlado pelo teste: `emitir` manda evento, `fechar` termina limpo, `cair` dá erro. */
function streamFalso() {
  const abertos = [];
  const conectar = (threadId, signal, aoEvento) =>
    new Promise((resolve, reject) => {
      const s = { threadId, aoEvento, fechar: resolve, cair: () => reject(new Error("caiu")) };
      signal.addEventListener("abort", () => {
        const e = new Error("abortado");
        e.name = "AbortError";
        reject(e);
      });
      abertos.push(s);
    });
  const doThread = (id) => abertos.filter((s) => s.threadId === id).at(-1);
  return { conectar, abertos, doThread };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mini "renderer": o que o onLive do app faz — lê `state` global e escreve no log do chat atual. */
function montarApp() {
  const a = criarEstadoDoChat({ threadId: "A", el: { log: [] } });
  const b = criarEstadoDoChat({ threadId: "B", el: { log: [] } });
  const area = criarAreaDeChats(a);
  area.adicionar(b);
  const state = ligarEstadoDoChat({ projectPath: "/p" }, area);
  const aoEvento = (ev) => {
    state.events = [...state.events, ev];
    area.atual().el.log.push(`${state.threadId}:${ev.text}`);
    if (ev.type === "done") state.talking = false;
  };
  return { a, b, area, state, aoEvento };
}

describe("estado do chat por instância", () => {
  it("state.<campo do chat> lê e escreve no chat em foco; o resto do state é do app", () => {
    const { a, b, area, state } = montarApp();
    expect(state.threadId).toBe("A");
    state.events = [{ type: "user" }];
    expect(a.events).toHaveLength(1);
    area.focar(b);
    expect(state.threadId).toBe("B");
    expect(state.events).toEqual([]);
    state.pendingImages.push({ name: "x" });
    expect(b.pendingImages).toHaveLength(1);
    expect(a.pendingImages).toHaveLength(0);
    expect(state.projectPath).toBe("/p");
  });

  it("valor que já estava no state vai pro chat atual ao ligar", () => {
    const area = criarAreaDeChats();
    const state = ligarEstadoDoChat({ threadId: "salva", profileId: "p1" }, area);
    expect(area.foco.threadId).toBe("salva");
    expect(state.profileId).toBe("p1");
  });

  it("cobre o inventário do plano", () => {
    for (const c of ["threadId", "events", "limiteDoChat", "ultimaAvaliacaoRoteamento", "toolNamePorId", "subchatsPendentes", "logShotUrls", "abortSse", "sseOn", "talking", "think", "pendingQuota", "meter", "agentId", "pendingImages", "slash", "queuePaused", "metaAtual"]) {
      expect(CAMPOS_DO_CHAT).toContain(c);
    }
    expect(CAMPOS_DO_CHAT).not.toContain("el");
  });

  it("comChat troca o atual só no trecho, aninha e restaura mesmo com erro", () => {
    const { a, b, area, state } = montarApp();
    expect(area.comChat(b, () => state.threadId)).toBe("B");
    expect(state.threadId).toBe("A");
    area.comChat(b, () => {
      area.comChat(a, () => expect(state.threadId).toBe("A"));
      expect(state.threadId).toBe("B");
    });
    expect(() => area.comChat(b, () => { throw new Error("x"); })).toThrow("x");
    expect(state.threadId).toBe("A");
    expect(area.ehFoco(a)).toBe(true);
    expect(area.comChat(b, () => area.ehFoco())).toBe(false);
  });

  it("remover: último chat não sai; tirar o em foco passa o foco pro vizinho", () => {
    const { a, b, area } = montarApp();
    area.focar(b);
    expect(area.remover(b)).toBe(true);
    expect(area.foco).toBe(a);
    expect(area.remover(a)).toBe(false);
    expect(area.chats).toEqual([a]);
  });

  it("adicionar na posição, ordenar e focadoEm", () => {
    const { a, b, area } = montarApp();
    const d = criarEstadoDoChat({ threadId: "D" });
    area.adicionar(d, 1);
    expect(area.threadsAbertas()).toEqual(["A", "D", "B"]);
    expect(area.ordenar([b, a, d])).toBe(true);
    expect(area.threadsAbertas()).toEqual(["B", "A", "D"]);
    expect(area.ordenar([b, a])).toBe(false);
    area.focar(d, 42);
    expect(d.focadoEm).toBe(42);
  });

  it("campos de tela ficam só na instância: state.projectPath segue do app", () => {
    for (const c of ["projeto", "minimizado", "peso", "focadoEm", "terminouNaoVisto", "erroDoTurno", "projectPath"]) expect(CAMPOS_DO_CHAT).not.toContain(c);
    const { a, state } = montarApp();
    a.projeto = "/outro";
    expect(state.projectPath).toBe("/p");
  });

  it("doThread e threadsAbertas", () => {
    const { b, area } = montarApp();
    expect(area.doThread("B")).toBe(b);
    expect(area.doThread("C")).toBe(null);
    expect(area.doThread("")).toBe(null);
    expect(area.threadsAbertas()).toEqual(["A", "B"]);
  });
});

describe("ouvirConversa: dois chats não trocam eventos", () => {
  it("eventos intercalados de A e B caem cada um no seu log, com o foco em A o tempo todo", async () => {
    const { a, b, area, aoEvento } = montarApp();
    const sse = streamFalso();
    const deps = { conectar: sse.conectar, aoEvento, aoReligar: async () => {} };
    ouvirConversa(a, area, deps);
    ouvirConversa(b, area, deps);
    await tick();
    sse.doThread("A").aoEvento({ type: "text", text: "a1" });
    sse.doThread("B").aoEvento({ type: "text", text: "b1" });
    sse.doThread("A").aoEvento({ type: "text", text: "a2" });
    sse.doThread("B").aoEvento({ type: "text", text: "b2" });
    expect(a.el.log).toEqual(["A:a1", "A:a2"]);
    expect(b.el.log).toEqual(["B:b1", "B:b2"]);
    expect(a.events.map((e) => e.text)).toEqual(["a1", "a2"]);
    expect(b.events.map((e) => e.text)).toEqual(["b1", "b2"]);
    expect(area.foco).toBe(a);
  });

  it("chat que trocou de conversa ignora o stream velho (evento atrasado não vaza)", async () => {
    const { a, area, aoEvento } = montarApp();
    const sse = streamFalso();
    ouvirConversa(a, area, { conectar: sse.conectar, aoEvento, aoReligar: async () => {} });
    await tick();
    const velho = sse.doThread("A");
    a.threadId = "C";
    velho.aoEvento({ type: "text", text: "atrasado" });
    expect(a.el.log).toEqual([]);
  });

  it("abrir de novo aborta o anterior e só o novo escreve", async () => {
    const { a, area, aoEvento } = montarApp();
    const sse = streamFalso();
    const deps = { conectar: sse.conectar, aoEvento, aoReligar: async () => {} };
    ouvirConversa(a, area, deps);
    await tick();
    const primeiro = sse.abertos[0];
    ouvirConversa(a, area, deps);
    await tick();
    primeiro.aoEvento({ type: "text", text: "velho" });
    sse.abertos[1].aoEvento({ type: "text", text: "novo" });
    expect(a.el.log).toEqual(["A:novo"]);
    expect(a.sseOn).toBe(true);
  });

  it("queda religa só o chat que caiu, relendo antes; o outro segue de pé", async () => {
    const { a, b, area, aoEvento } = montarApp();
    const sse = streamFalso();
    const relidos = [];
    const agendados = [];
    const deps = {
      conectar: sse.conectar,
      aoEvento,
      aoReligar: async (chat) => relidos.push(chat.threadId),
      agendar: (fn) => agendados.push(fn),
    };
    ouvirConversa(a, area, deps);
    ouvirConversa(b, area, deps);
    await tick();
    sse.doThread("B").cair();
    await tick();
    expect(b.sseOn).toBe(false);
    expect(a.sseOn).toBe(true);
    await agendados.shift()();
    expect(relidos).toEqual(["B"]);
    expect(sse.abertos.filter((s) => s.threadId === "B")).toHaveLength(2);
    expect(b.sseOn).toBe(true);
    sse.doThread("B").aoEvento({ type: "text", text: "de volta" });
    expect(b.el.log).toEqual(["B:de volta"]);
    expect(a.el.log).toEqual([]);
  });

  it("motor desligado segura o religar", async () => {
    const { a, area, aoEvento } = montarApp();
    const sse = streamFalso();
    const agendados = [];
    ouvirConversa(a, area, { conectar: sse.conectar, aoEvento, podeReligar: () => false, agendar: (fn) => agendados.push(fn) });
    await tick();
    sse.abertos[0].fechar();
    await tick();
    await agendados.shift()();
    expect(sse.abertos).toHaveLength(1);
    expect(a.sseOn).toBe(false);
  });

  it("sem conversa não abre stream", () => {
    const area = criarAreaDeChats();
    expect(ouvirConversa(area.foco, area, { conectar: () => { throw new Error("não"); }, aoEvento: () => {} })).toBe(null);
  });
});

describe("elementoDoChat: id de chat cai na raiz do chat atual", () => {
  const montar = () => {
    document.body.innerHTML = `<div id="banner"></div><section id="c1"><ol id="log"></ol><form id="composer"><textarea id="input"></textarea></form></section><section id="c2"><ol id="log"></ol><form id="composer"><textarea id="input"></textarea></form></section>`;
    const a = criarEstadoDoChat({ el: { root: document.getElementById("c1") } });
    const b = criarEstadoDoChat({ el: { root: document.getElementById("c2") } });
    const area = criarAreaDeChats(a);
    area.adicionar(b);
    const $ = (id) => elementoDoChat(document, area.atual(), id);
    return { a, b, area, $ };
  };

  it("log e composer são os do chat atual; id do app vem do documento", () => {
    const { b, area, $ } = montar();
    expect($("log").parentElement.id).toBe("c1");
    expect(area.comChat(b, () => $("log").parentElement.id)).toBe("c2");
    expect(area.comChat(b, () => $("input").closest("section").id)).toBe("c2");
    area.focar(b);
    expect($("input").closest("section").id).toBe("c2");
    expect($("banner")).toBe(document.getElementById("banner"));
  });

  it("sem raiz (ou id fora da raiz) cai no documento", () => {
    const { $ } = montar();
    expect(elementoDoChat(document, criarEstadoDoChat(), "log").parentElement.id).toBe("c1");
    expect(elementoDoChat(document, null, "input").closest("section").id).toBe("c1");
    expect($("nao-existe")).toBe(null);
  });

  it("todo id de chat existe no index.html dentro do #pane-chat", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    // o `URL` global aqui é o do happy-dom: resolve o caminho pelo do node
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
    // trecho do #pane-chat até o próximo bloco do corpo (a paleta)
    const pane = html.slice(html.indexOf('id="pane-chat"'), html.indexOf('id="palette"'));
    for (const id of IDS_DO_CHAT) expect(pane.includes(`id="${id}"`), id).toBe(true);
  });
});
