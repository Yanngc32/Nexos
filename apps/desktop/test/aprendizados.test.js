// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abaInicial,
  contagens,
  cortar,
  createAprendizados,
  eyebrowDoCartao,
  filtrarPorAba,
  fmtConfianca,
  fraseDoGatilho,
  pendentesDe,
  resumoDasEvidencias,
  textoDoRodape,
  textoDoStatus,
  tituloDaProposta,
} from "../aprendizados.js";

// o markup de verdade da seção, direto do index.html: teste e app não divergem
const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const INICIO = INDEX.indexOf('<section class="ag-sec" id="aprend-sec"');
const SECAO = INDEX.slice(INICIO, INDEX.indexOf("</section>", INICIO) + 10);

const ev = (tipo, extra = {}) => ({ threadId: "t1", titulo: "Refatorar painel", data: "2026-10-05T12:00:00.000Z", tipo, trecho: "não, usa var(--accent)", efeito: "confirma", ...extra });
const inst = (id, status, extra = {}) => ({
  id,
  gatilho: "mexer em CSS do desktop",
  acao: "Usar os tokens do design system.",
  area: "css",
  evidencia: [ev("inject")],
  confianca: 0.5,
  escopo: "projeto",
  status,
  editadoPelaPessoa: false,
  rejeicoes: 0,
  criadoEm: "2026-10-01T00:00:00.000Z",
  atualizadoEm: `2026-10-0${id.length}T00:00:00.000Z`,
  noContexto: true,
  ...extra,
});

describe("helpers de aprendizados", () => {
  it("gatilho vira frase: 'Quando' só quando falta conector", () => {
    expect(fraseDoGatilho("mexer em CSS")).toBe("Quando mexer em CSS");
    expect(fraseDoGatilho("ao terminar.")).toBe("Ao terminar");
    expect(fraseDoGatilho("Quando for commitar")).toBe("Quando for commitar");
  });

  it("confiança com vírgula e duas casas", () => {
    expect(fmtConfianca(0.3)).toBe("0,30");
    expect(fmtConfianca(0.85)).toBe("0,85");
  });

  it("eyebrow mostra o sinal mais forte e o escopo", () => {
    expect(eyebrowDoCartao({ escopo: "projeto", evidencia: [ev("mensagem_seguinte"), ev("inject")] })).toBe("Correção no meio do turno · projeto");
    expect(eyebrowDoCartao({ escopo: "projeto", evidencia: [ev("inject"), ev("mock_reprovado")] })).toBe("Mock reprovado · projeto");
  });

  it("conversas distintas e data do último", () => {
    const r = resumoDasEvidencias([ev("inject", { threadId: "a" }), ev("parar", { threadId: "a" }), ev("inject", { threadId: "b", data: "2026-10-06T12:00:00.000Z" })]);
    expect(r.conversas).toBe(2);
    expect(r.ultimo).toMatch(/^\d{2}\/10$/);
  });

  it("trecho longo é cortado em ~140 caracteres", () => {
    expect(cortar("a".repeat(300)).length).toBe(140);
    expect(cortar("  ok   assim ")).toBe("ok assim");
  });

  it("abas: aprovado e incorporado juntos; mais confiável primeiro; abre em revisar só com pendente", () => {
    const lista = [inst("a", "candidato", { confianca: 0.3 }), inst("bb", "aprovado", { confianca: 0.7 }), inst("ccc", "incorporado", { confianca: 0.9, skill: "s" }), inst("dddd", "rejeitado"), inst("ee", "aprovado", { confianca: 0.5 })];
    expect(contagens(lista)).toEqual({ revisar: 1, aprovados: 3, rejeitados: 1 });
    expect(filtrarPorAba(lista, "aprovados").map((i) => i.id)).toEqual(["ccc", "bb", "ee"]);
    expect(abaInicial(lista)).toBe("revisar");
    expect(abaInicial(lista.slice(1))).toBe("aprovados");
  });

  it("status do cabeçalho e contador: desligado zera", () => {
    const dados = { ligado: true, instintos: [inst("a", "candidato"), inst("bb", "candidato")] };
    expect(textoDoStatus(dados)).toBe("2 pra revisar");
    expect(pendentesDe(dados)).toBe(2);
    expect(textoDoStatus({ ligado: true, instintos: [] })).toBe("nada pendente");
    expect(textoDoStatus({ ...dados, ligado: false })).toBe("desligado");
    expect(pendentesDe({ ...dados, ligado: false })).toBe(0);
  });

  it("rodapé e título da proposta", () => {
    expect(textoDoRodape({ itens: 4, maxItens: 6, chars: 980, maxChars: 1500 })).toBe("No contexto agora: 4 de 6 · 980 de 1500 caracteres");
    expect(tituloDaProposta({ area: "commits", gatilhos: ["a", "b", "c"], atualizar: false })).toBe("Juntar 3 aprendizados sobre commits numa skill");
    expect(tituloDaProposta({ area: "commits", skill: "aprendizados-x-commits", gatilhos: ["a"], atualizar: true })).toBe("Atualizar a skill /aprendizados-x-commits");
  });
});

describe("seção Aprendizados", () => {
  let req;
  let pendentes;
  let abrirConversa;
  let tela;

  const montar = (dados) => {
    document.body.innerHTML = SECAO;
    req = vi.fn(async (caminho, opts) => {
      if (caminho.startsWith("/v1/aprendizados?")) return typeof dados === "function" ? dados() : dados;
      if (opts?.method) return { ...(dados.instintos?.[0] ?? {}), status: "aprovado", atualizadoEm: "2026-10-08T00:00:00.000Z" };
      return {};
    });
    pendentes = vi.fn();
    abrirConversa = vi.fn();
    tela = createAprendizados({
      req,
      el: (id) => document.getElementById(id),
      getProjectPath: () => "/p",
      aoPendentes: pendentes,
      aoAbrirConversa: abrirConversa,
      aoAbrirSkills: vi.fn(),
    });
  };

  const resumo = (instintos, extra = {}) => ({
    ligado: true,
    instintos,
    propostas: [],
    contexto: { itens: 1, maxItens: 6, chars: 80, maxChars: 1500 },
    analisando: 0,
    ...extra,
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("vazio: título e texto do spec, sem abas", async () => {
    montar(resumo([]));
    await tela.carregar();
    expect(document.getElementById("aprend-lista").textContent).toContain("Nada aprendido ainda");
    expect(document.getElementById("aprend-abas").classList.contains("hidden")).toBe(true);
    expect(document.getElementById("aprend-contador").classList.contains("hidden")).toBe(true);
    expect(pendentes).toHaveBeenCalledWith("/p", 0);
  });

  it("pendente: cartão com gatilho, ação, confiança e evidência; contador e status acendem", async () => {
    montar(resumo([inst("a", "candidato", { confianca: 0.3 })]));
    await tela.carregar();
    const lista = document.getElementById("aprend-lista");
    expect(lista.textContent).toContain("Quando mexer em CSS do desktop");
    expect(lista.textContent).toContain("Usar os tokens do design system.");
    expect(lista.textContent).toContain("Confiança 0,30");
    expect(lista.textContent).toContain("visto em 1 conversa");
    expect([...lista.querySelectorAll("button")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Aprovar", "Editar", "Rejeitar", "De onde veio (1)"]));
    expect(document.getElementById("aprend-status").textContent).toBe("1 pra revisar");
    expect(document.getElementById("aprend-contador").getAttribute("aria-label")).toBe("1 aprendizado pra revisar");
    expect(pendentes).toHaveBeenCalledWith("/p", 1);
  });

  it("trecho da fala entra como texto, nunca como HTML", async () => {
    montar(resumo([inst("a", "candidato", { evidencia: [ev("inject", { trecho: "<img src=x onerror=alert(1)>" })] })]));
    await tela.carregar();
    document.querySelector(".aprend-disc").click();
    expect(document.querySelector("#aprend-lista img")).toBeNull();
    expect(document.querySelector(".aprend-ev q").textContent).toBe("<img src=x onerror=alert(1)>");
    document.querySelector(".aprend-ev-btn").click();
    expect(abrirConversa).toHaveBeenCalledWith("t1");
  });

  it("aprovado fora do teto mostra a pílula; incorporado mostra a skill e não tem ações", async () => {
    montar(resumo([inst("aa", "aprovado", { noContexto: false }), inst("bbb", "incorporado", { skill: "aprendizados-nexos-css" })]));
    await tela.carregar();
    const lista = document.getElementById("aprend-lista");
    expect(lista.textContent).toContain("fora do contexto (teto)");
    expect(lista.textContent).toContain("na skill /aprendizados-nexos-css");
    const incorporado = [...lista.querySelectorAll("article")].find((a) => a.textContent.includes("na skill"));
    expect(incorporado.querySelector(".aprend-acoes")).toBeNull();
  });

  it("aprovar manda a ação com o expected e tira o cartão da aba", async () => {
    vi.useFakeTimers();
    try {
      montar(resumo([inst("a", "candidato")]));
      await tela.carregar();
      [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Aprovar").click();
      await vi.advanceTimersByTimeAsync(300);
      const chamada = req.mock.calls.find(([c]) => c.includes("/acao"));
      expect(chamada[0]).toContain("/v1/aprendizados/a/acao?projectPath=%2Fp");
      expect(JSON.parse(chamada[1].body)).toEqual({ acao: "aprovar", expected: "2026-10-01T00:00:00.000Z" });
      expect(document.getElementById("aprend-toast").textContent).toContain("Aprovado — entra nas próximas conversas.");
      expect(document.querySelector("#aprend-lista article[data-id='a']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("editar: dois campos com contador; salvar e aprovar manda o texto e Esc cancela", async () => {
    montar(resumo([inst("a", "candidato")]));
    await tela.carregar();
    [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Editar").click();
    const campos = document.querySelectorAll("#aprend-lista .aprend-campo");
    expect(campos).toHaveLength(2);
    expect(campos[0].textContent).toContain("Quando…");
    expect(campos[0].querySelector(".aprend-cont").textContent).toBe("23/120");
    campos[0].querySelector("input").value = "rodar os testes";
    [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Salvar e aprovar").click();
    await Promise.resolve();
    const put = req.mock.calls.find(([, o]) => o?.method === "PUT");
    expect(JSON.parse(put[1].body)).toMatchObject({ gatilho: "rodar os testes", aprovar: true });

    montar(resumo([inst("a", "candidato")]));
    await tela.carregar();
    [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Editar").click();
    document.querySelector("#aprend-lista article").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("#aprend-lista .aprend-campo")).toBeNull();
  });

  it("repintar com a edição aberta não joga fora o que a pessoa digitou", async () => {
    montar(resumo([inst("a", "candidato")]));
    await tela.carregar();
    [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Editar").click();
    document.querySelector("#aprend-lista input").value = "texto no meio da digitação";
    await tela.carregar({ silencioso: true });
    expect(document.querySelector("#aprend-lista input").value).toBe("texto no meio da digitação");
  });

  it("409 recarrega e avisa que mudou em outro aparelho", async () => {
    montar(resumo([inst("a", "candidato")]));
    await tela.carregar();
    req.mockImplementation(async (c) => {
      if (c.includes("/acao")) throw Object.assign(new Error("mudou em outro aparelho"), { status: 409, data: {} });
      return resumo([inst("a", "candidato")]);
    });
    [...document.querySelectorAll("#aprend-lista button")].find((b) => b.textContent === "Aprovar").click();
    await vi.waitFor(() => expect(document.getElementById("aprend-toast").textContent).toContain("Mudou em outro aparelho — recarreguei."));
  });

  it("proposta de skill: Criar skill chama o motor; Agora não esconde", async () => {
    const proposta = { area: "commits", skill: "aprendizados-nexos-commits", atualizar: false, ids: ["a", "bb", "ccc"], gatilhos: ["for commitar", "o commit for de release", "o commit tocar mais de um app"] };
    montar(resumo([inst("a", "aprovado"), inst("bb", "aprovado"), inst("ccc", "aprovado")], { propostas: [proposta] }));
    await tela.carregar();
    const lista = document.getElementById("aprend-lista");
    expect(lista.textContent).toContain("Juntar 3 aprendizados sobre commits numa skill");
    expect(lista.textContent).toContain("Quando for commitar");
    [...lista.querySelectorAll("button")].find((b) => b.textContent === "Agora não").click();
    await vi.waitFor(() => expect(req.mock.calls.some(([c]) => c.includes("/propostas/commits/adiar"))).toBe(true));
    await vi.waitFor(() => expect(document.querySelector(".aprend-prop")).toBeNull());
  });

  it("erro ao criar a skill aparece no cartão da proposta, com tentar de novo", async () => {
    const proposta = { area: "commits", skill: "s", atualizar: false, ids: [], gatilhos: ["a", "b", "c"] };
    montar(resumo([inst("a", "aprovado")], { propostas: [proposta] }));
    await tela.carregar();
    req.mockImplementation(async (c) => {
      if (c.includes("/skill")) throw new Error("sem pasta de skills");
      return resumo([inst("a", "aprovado")], { propostas: [proposta] });
    });
    [...document.querySelectorAll(".aprend-prop button")].find((b) => b.textContent === "Criar skill").click();
    await vi.waitFor(() => expect(document.querySelector(".aprend-prop .ag-err")?.textContent).toBe("sem pasta de skills"));
    expect([...document.querySelectorAll(".aprend-prop button")].map((b) => b.textContent)).toContain("Tentar de novo");
  });

  it("erro ao ler: mensagem com o motivo e Tentar de novo", async () => {
    montar(() => {
      throw new Error("arquivo travado no Drive");
    });
    await tela.carregar();
    expect(document.getElementById("aprend-erro").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("aprend-erro-msg").textContent).toBe("Não deu pra ler os aprendizados: arquivo travado no Drive.");
  });

  it("chave desligada: manda o PUT, status vira desligado e o contador some", async () => {
    montar(resumo([inst("a", "candidato")]));
    await tela.carregar();
    const chave = document.getElementById("aprend-ligado");
    chave.checked = false;
    chave.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(document.getElementById("aprend-status").textContent).toBe("desligado"));
    const put = req.mock.calls.find(([c]) => c.includes("/config"));
    expect(JSON.parse(put[1].body)).toEqual({ ligado: false });
    expect(document.getElementById("aprend-contador").classList.contains("hidden")).toBe(true);
    expect(pendentes).toHaveBeenLastCalledWith("/p", 0);
  });

  it("analisando: o cabeçalho diz quantas conversas", async () => {
    montar(resumo([inst("a", "aprovado")], { analisando: 2 }));
    await tela.carregar();
    expect(document.getElementById("aprend-status").textContent).toContain("analisando 2 conversas…");
  });
});
