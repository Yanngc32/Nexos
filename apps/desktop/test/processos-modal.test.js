// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createProcessosModal } from "../processos-modal.js";

const HTML = `
  <div id="processos-modal" class="hidden">
    <p id="proc-err" class="hidden"></p><p id="proc-empty" class="hidden"></p><ul id="proc-list"></ul>
  </div>
`;

const AGORA = 1_000_000_000;

function montar({ processos = [], confirmar = async () => true, falha } = {}) {
  document.body.innerHTML = HTML;
  const chamadas = [];
  const erros = [];
  const modal = createProcessosModal({
    el: (id) => document.getElementById(id),
    req: async (rota, opts) => {
      chamadas.push({ rota, body: opts?.body ? JSON.parse(opts.body) : undefined });
      if (falha && rota === falha.rota) throw new Error(falha.msg);
      return opts ? { ok: true } : { processos };
    },
    aoErro: (m) => erros.push(m),
    confirmar,
    intervaloMs: 60_000,
    agora: () => AGORA,
  });
  return { modal, chamadas, erros, $: (id) => document.getElementById(id) };
}

const servico = {
  chave: "servico:10",
  tipo: "servico",
  pid: 10,
  nome: "Frontend (Vite)",
  comando: "npm run dev",
  desde: AGORA - 125_000,
  projectPath: "C:\\proj\\Prisma",
  servicoId: "web",
  porta: 5173,
};
const orfao = { chave: "orfao:engine-t1.pid:20", tipo: "orfao", pid: 20, nome: "cmd.exe", comando: "claude --print", motivo: "motor de conversa que ficou de pé" };

afterEach(() => vi.useRealTimers());

describe("processos-modal", () => {
  it("abre, lista serviço com projeto/porta/tempo e órfão com motivo", async () => {
    const { modal, $ } = montar({ processos: [servico, orfao] });
    modal.abrir();
    await vi.waitFor(() => expect($("proc-list").children).toHaveLength(2));
    expect($("processos-modal").classList.contains("hidden")).toBe(false);
    const [s, o] = $("proc-list").children;
    expect(s.querySelector(".proc-meta").textContent).toBe("Prisma · :5173 · PID 10 · 2min");
    expect(s.querySelector(".proc-matar").textContent).toBe("Parar");
    expect(o.querySelector(".proc-nome").textContent).toBe("cmd.exe · órfão");
    expect(o.querySelector(".proc-motivo").textContent).toMatch(/motor/);
    modal.fechar();
  });

  it("vazio diz que não há nada", async () => {
    const { modal, $ } = montar();
    await modal.carregar();
    expect($("proc-empty").classList.contains("hidden")).toBe(false);
  });

  it("matar órfão pede confirmação e manda a chave, não o PID", async () => {
    const perguntas = [];
    const { modal, chamadas, $ } = montar({ processos: [orfao], confirmar: async (m) => (perguntas.push(m), true) });
    await modal.carregar();
    $("proc-list").querySelector(".proc-matar").click();
    await vi.waitFor(() => expect(chamadas.some((c) => c.rota === "/v1/processos/matar")).toBe(true));
    expect(perguntas).toEqual(["Matar cmd.exe (PID 20)?"]);
    expect(chamadas.find((c) => c.rota === "/v1/processos/matar").body).toEqual({ chave: orfao.chave });
  });

  it("recusar a confirmação não mata; serviço para sem perguntar", async () => {
    const { modal, chamadas, $ } = montar({ processos: [orfao, servico], confirmar: async () => false });
    await modal.carregar();
    const [o, s] = $("proc-list").querySelectorAll(".proc-matar");
    o.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(chamadas.some((c) => c.rota === "/v1/processos/matar")).toBe(false);
    s.click();
    await vi.waitFor(() => expect(chamadas.find((c) => c.rota === "/v1/processos/matar")?.body).toEqual({ chave: servico.chave }));
  });

  it("falha ao listar aparece no modal; falha ao matar vira erro", async () => {
    const lista = montar({ falha: { rota: "/v1/processos", msg: "motor fora" } });
    await lista.modal.carregar();
    expect(lista.$("proc-err").textContent).toBe("motor fora");

    const matar = montar({ processos: [servico], falha: { rota: "/v1/processos/matar", msg: "não está mais na lista" } });
    await matar.modal.carregar();
    matar.$("proc-list").querySelector(".proc-matar").click();
    await vi.waitFor(() => expect(matar.erros).toEqual(["não está mais na lista"]));
  });

  it("aberto atualiza sozinho; fechado para de perguntar", async () => {
    vi.useFakeTimers();
    const { modal, chamadas } = montar({ processos: [servico] });
    modal.abrir();
    const listas = () => chamadas.filter((c) => c.rota === "/v1/processos").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listas()).toBe(2);
    modal.fechar();
    expect(modal.aberto()).toBe(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(listas()).toBe(2);
  });
});
