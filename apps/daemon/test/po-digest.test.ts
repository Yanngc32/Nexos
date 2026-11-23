import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadEvent } from "@nexos/shared";
import { describe, expect, it } from "vitest";
import { ARQUIVO_DECISOES_PO, registrarDecisaoPO } from "../src/po/decisoes.ts";
import { MAX_CARDS_PO, montarPromptPO, type CardDoDigest } from "../src/po/digest.ts";
import type { LotePO } from "../src/po/fila.ts";
import { evidenciaDoGit, PO_GIT_SECTION, type RodarGit } from "../src/po/git.ts";
import { cardsDoDigest, loteDaAbertura, loteDoFechamento } from "../src/po/index.ts";
import {
  PO_ETAPA_SECTION,
  PO_FOREIGN_MARK,
  PO_HOLD_RULE,
  PO_NEXT_SECTION,
  PO_PREVIOUS_REPLY_SECTION,
  PO_REPLY_SECTION,
  PO_RESUMED_MARK,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN,
  PO_USER_SECTION,
} from "../src/po/texto.ts";
import type { Tarefa } from "../src/tarefas.ts";
import { tempHome } from "./helpers.ts";

const lote = (extra: Partial<LotePO> = {}): LotePO => ({
  textos: ["Corrige o login com a chave sk-SEGREDO"],
  chamadas: [],
  mensagens: [],
  turnos: 1,
  ...extra,
});
const cards = (n: number): CardDoDigest[] =>
  Array.from({ length: n }, (_, i) => ({ id: `tk-${i}`, status: "pending" as const, titulo: `Card ${i}` }));

describe("montarPromptPO", () => {
  it("abertura: regras da abertura, pedido inteiro, quadro e resposta anterior; nada do fechamento", () => {
    const longo = "x".repeat(5000);
    const m = montarPromptPO({
      fase: "abertura",
      lote: lote({ textos: [longo], respostaAnterior: "combinamos o plano", proximo: "não aparece", resposta: "nem esta" }),
      cards: [{ id: "tk-a", status: "in_progress", titulo: "Login" }],
      etapas: [{ etapaId: "e1", titulo: "Etapa", placar: "feita" }],
      git: "",
    });
    expect(m.prompt.startsWith(PO_SYSTEM_PROMPT_OPEN)).toBe(true);
    expect(m.prompt).toContain(`${PO_USER_SECTION}\n${longo}`);
    expect(m.prompt).toContain("QUADRO ATUAL:\ntk-a [em andamento] Login");
    expect(m.prompt).toContain(`${PO_PREVIOUS_REPLY_SECTION}\ncombinamos o plano`);
    expect(m.prompt).not.toContain("AÇÕES DESTE TURNO");
    expect(m.prompt).not.toContain(PO_ETAPA_SECTION);
    expect(m.prompt).not.toContain(PO_NEXT_SECTION);
    expect(m.prompt).not.toContain(PO_HOLD_RULE);
    expect(m.temProximo).toBe(false);
    expect(m.etapas.size).toBe(0);
  });

  it(`quadro até ${MAX_CARDS_PO} cards, card de outra conversa marcado; ids = os listados + devolvidos + etapas`, () => {
    const lista = [{ id: "tk-fora", status: "pending" as const, titulo: "Do outro chat", outraConversa: true }, ...cards(40)];
    const m = montarPromptPO({
      fase: "fechamento",
      lote: lote(),
      cards: lista,
      devolvidos: [{ id: "tk-39", retomado: true }],
      etapas: [{ etapaId: "e1", titulo: "Migrar", placar: "feita", cartao: { id: "tk-plano", status: "in_progress" } }],
    });
    expect(m.prompt).toContain(`tk-fora [a fazer] ${PO_FOREIGN_MARK} Do outro chat`);
    expect(m.prompt).toContain("tk-28 [a fazer] Card 28");
    expect(m.prompt).not.toContain("tk-29 [a fazer]");
    expect(m.ids.has("tk-28")).toBe(true);
    expect(m.ids.has("tk-30")).toBe(false);
    // Devolvido fora dos 30 ainda pode ser julgado; o cartão da etapa também.
    expect(m.ids.has("tk-39")).toBe(true);
    expect(m.ids.has("tk-plano")).toBe(true);
    expect(m.prompt).toContain(`${PO_RETURNED_SECTION}\n- tk-39 ${PO_RESUMED_MARK}`);
    expect(m.etapas.get("e1")).toBe("tk-plano");
    expect(m.prompt).toContain(PO_ETAPA_SECTION);
    expect(m.prompt).toContain("- [e1] Migrar — placar: feita — cartão tk-plano: em andamento");
  });

  it("fechamento: ações (até 60), mensagens do meio, resposta, git e próximo + regra de segurar", () => {
    const chamadas = Array.from({ length: 80 }, (_, i) => ({ ferramenta: "Bash", detalhe: `cmd-${i}` }));
    const m = montarPromptPO({
      fase: "fechamento",
      lote: lote({ chamadas, mensagens: ["vou rodar os testes"], resposta: "Feito, testes verdes.", proximo: "agora   publica" }),
      cards: [],
      git: `\n\n${PO_GIT_SECTION}\nstatus`,
    });
    expect(m.prompt.startsWith(PO_SYSTEM_PROMPT_CLOSE)).toBe(true);
    expect(m.prompt).toContain("QUADRO ATUAL:\n(vazio)");
    const acoes = m.prompt.split("AÇÕES DESTE TURNO:\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(acoes).toHaveLength(60);
    expect(acoes[0]).toBe("- Bash: cmd-20");
    expect(m.prompt).toContain("- vou rodar os testes");
    expect(m.prompt).toContain(`${PO_REPLY_SECTION}\nFeito, testes verdes.`);
    expect(m.prompt).toContain(PO_GIT_SECTION);
    expect(m.prompt).toContain(`${PO_NEXT_SECTION}\nagora publica\n\n${PO_HOLD_RULE}`);
    expect(m.temProximo).toBe(true);
  });

  it("limpar tira segredo do texto livre e nunca toca no id", () => {
    const limpar = (s: string) => s.replace(/sk-[A-Z]+/g, "[segredo]").replace(/tk-/g, "QUEBRADO-");
    const m = montarPromptPO({
      fase: "fechamento",
      lote: lote({ resposta: "usei sk-OUTRO", chamadas: [{ ferramenta: "Bash", detalhe: "export K=sk-ABC" }] }),
      cards: [{ id: "tk-a", status: "pending", titulo: "Chave sk-TITULO" }],
      limpar,
    });
    expect(m.prompt).not.toMatch(/sk-[A-Z]/);
    expect(m.prompt).toContain("tk-a [a fazer] Chave [segredo]");
    expect(m.ids.has("tk-a")).toBe(true);
  });
});

describe("cardsDoDigest", () => {
  const t = (id: string, threadId: string, status: "pending" | "in_progress" | "completed", updatedAt: string) =>
    ({ id, threadId, titulo: id, updatedAt, po: { status } }) as unknown as Tarefa;

  it("abertos daqui, depois 'a fazer' de fora (marcados), depois concluídos daqui; mais novo primeiro", () => {
    const r = cardsDoDigest(
      [
        t("feito-velho", "th", "completed", "2026-01-01"),
        t("aberto-velho", "th", "pending", "2026-01-02"),
        t("fora-andando", "outro", "in_progress", "2026-01-09"),
        t("fora-afazer", "outro", "pending", "2026-01-03"),
        t("aberto-novo", "th", "in_progress", "2026-01-05"),
        t("feito-novo", "th", "completed", "2026-01-06"),
        t("fora-feito", "outro", "completed", "2026-01-07"),
      ],
      "th",
      undefined as never,
    );
    expect(r.map((c) => c.id)).toEqual(["aberto-novo", "aberto-velho", "fora-afazer", "feito-novo", "feito-velho"]);
    expect(r.find((c) => c.id === "fora-afazer")?.outraConversa).toBe(true);
    expect(r.find((c) => c.id === "aberto-novo")?.outraConversa).toBeUndefined();
  });

  it(`corta em ${MAX_CARDS_PO}`, () => {
    const muitos = Array.from({ length: 45 }, (_, i) => t(`c${i}`, "th", "pending", `2026-01-${String(i).padStart(2, "0")}`));
    expect(cardsDoDigest(muitos, "th", undefined as never)).toHaveLength(MAX_CARDS_PO);
  });
});

describe("lote a partir da conversa", () => {
  const ev = (e: Record<string, unknown>) => ({ ts: "2026-11-19T00:00:00Z", threadId: "th", ...e }) as unknown as ThreadEvent;
  const eventos = [
    ev({ type: "user", text: "primeiro pedido" }),
    ev({ type: "assistant", text: "resposta do primeiro" }),
    ev({ type: "user", text: "segundo pedido" }),
    ev({ type: "assistant", text: "vou olhar" }),
    ev({ type: "tool", name: "Read", summary: "src/a.ts" }),
    ev({ type: "assistant", text: "   " }),
    ev({ type: "tool", name: "Edit", summary: "src/a.ts" }),
    ev({ type: "assistant", text: "pronto" }),
  ];

  it("fechamento: último pedido, ferramentas, falas do meio e a última fala como resposta", () => {
    expect(loteDoFechamento(eventos, "  próxima  ")).toEqual({
      textos: ["segundo pedido"],
      chamadas: [
        { ferramenta: "Read", detalhe: "src/a.ts" },
        { ferramenta: "Edit", detalhe: "src/a.ts" },
      ],
      mensagens: ["vou olhar"],
      resposta: "pronto",
      proximo: "próxima",
      turnos: 1,
    });
  });

  it("abertura: pedido novo + a resposta final do turno anterior", () => {
    expect(loteDaAbertura(eventos.slice(0, 3))).toEqual({
      textos: ["segundo pedido"],
      chamadas: [],
      mensagens: [],
      respostaAnterior: "resposta do primeiro",
      turnos: 1,
    });
    expect(loteDaAbertura(eventos.slice(0, 1)).respostaAnterior).toBeUndefined();
  });
});

describe("evidenciaDoGit", () => {
  it("fora de repositório não manda bloco; erro também não", async () => {
    expect(await evidenciaDoGit("/x", undefined, async () => null)).toBe("");
    expect(await evidenciaDoGit("/x", undefined, async () => "false")).toBe("");
    expect(
      await evidenciaDoGit("/x", undefined, async () => {
        throw new Error("sem git");
      }),
    ).toBe("");
  });

  it("dentro: status, diff (cai pro índice sem HEAD) e commits desde o card", async () => {
    const vistos: string[][] = [];
    const rodar: RodarGit = async (_cwd, args) => {
      vistos.push(args);
      if (args[0] === "rev-parse") return "true\n";
      if (args[0] === "status") return " M src/a.ts";
      if (args[0] === "diff" && args[1] === "HEAD") return null;
      if (args[0] === "diff") return " src/a.ts | 2 +-";
      if (args[0] === "log") return "abc123 conserta login";
      return "";
    };
    const g = await evidenciaDoGit("/repo", "2026-11-19T10:00:00Z", rodar);
    expect(g.startsWith(`\n\n${PO_GIT_SECTION}`)).toBe(true);
    expect(g).toContain(" M src/a.ts");
    expect(g).toContain(" src/a.ts | 2 +-");
    expect(g).toContain("abc123 conserta login");
    expect(vistos.some((a) => a[0] === "log" && a[1] === "--since=2026-11-19T10:00:00Z")).toBe(true);
    // Sem "desde", não roda o log.
    vistos.length = 0;
    await evidenciaDoGit("/repo", undefined, rodar);
    expect(vistos.some((a) => a[0] === "log")).toBe(false);
  });
});

describe("registrarDecisaoPO", () => {
  it("uma linha JSON por rodada; passou do teto, o atual vira .1", () => {
    const home = tempHome();
    const d = { conversationId: "th", phase: "fechamento" as const, outcome: "ok", route: "perfil/sonnet", durationMs: 5, cards: ["tk-a"] };
    registrarDecisaoPO(home, d);
    const arquivo = join(home, ARQUIVO_DECISOES_PO);
    const linha = JSON.parse(readFileSync(arquivo, "utf8").trim());
    expect(linha).toMatchObject(d);
    expect(typeof linha.at).toBe("string");

    writeFileSync(arquivo, "x".repeat(200));
    registrarDecisaoPO(home, { ...d, outcome: "sem-mudanca" }, 100);
    expect(readFileSync(`${arquivo}.1`, "utf8")).toBe("x".repeat(200));
    expect(JSON.parse(readFileSync(arquivo, "utf8").trim()).outcome).toBe("sem-mudanca");
    expect(existsSync(`${arquivo}.2`)).toBe(false);
  });
});
