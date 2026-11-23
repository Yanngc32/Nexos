import { afterEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";
import { lerMemoria, listarMemorias, proporMemoria } from "../src/memorias/nucleo.ts";
import { aplicarOperacoes, criarMemorista } from "../src/memorias/memorista.ts";
import {
  COOLDOWN_MEMORISTA_MS,
  MAX_OPERACOES,
  PROMPT_MEMORISTA,
  anexarFato,
  interpretarVeredito,
  juntarFalas,
  montarPromptMemorista,
} from "../src/memorias/memorista-prompt.ts";
import type { EventoMemoriaSalva, RodarModelo } from "../src/memorias/motor.ts";

function criar(home: string, relPath: string, corpo = "Corpo de " + relPath) {
  const r = proporMemoria(home, { op: "create", relPath, titulo: "Título " + relPath, gancho: "quando " + relPath, tipo: "infra", corpo, origem: "agente" });
  if (!r.ok) throw new Error(r.motivo);
  return r.memoria;
}

/** Modelo falso: guarda os prompts e responde o que a fila mandar. */
function modeloFalso(respostas: (string | Error)[]) {
  const prompts: { prompt: string; ctx: Parameters<RodarModelo>[1] }[] = [];
  const rodar: RodarModelo = async (prompt, ctx) => {
    prompts.push({ prompt, ctx });
    const r = respostas.shift() ?? "OK";
    if (r instanceof Error) throw r;
    return r;
  };
  return { rodar, prompts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("prompt do memorista", () => {
  it("traz os tipos, o teste de corte, a regra 'na dúvida, OK', o índice e o COMPLEMENTA", () => {
    const p = montarPromptMemorista({
      memorias: [{ relPath: "deploy-vercel.md", titulo: "Deploy na Vercel", gancho: "ao publicar o site" }],
      usadas: [{ relPath: "infra/servidor.md", titulo: "Servidor", gancho: "ao acessar a máquina" }],
      falasUsuario: ["sempre rode o lint antes"],
      resposta: "Feito.",
    });
    for (const t of ["instrucao", "preferencia", "conhecimento", "decisao", "infra", "correcao"]) expect(p).toContain(t);
    expect(p).toContain("daqui a um mês");
    expect(p).toContain("muda o que o agente faz");
    expect(p).toContain("Na dúvida, responda OK.");
    expect(p).toContain("COMPLEMENTA | <caminho.md> | <o fato novo>");
    expect(p).toMatch(/Mesmo assunto[^\n]*COMPLEMENTA/);
    expect(p).toContain("MEMÓRIAS JÁ SALVAS:\n- deploy-vercel.md — Deploy na Vercel: ao publicar o site");
    expect(p).toContain("- infra/servidor.md — Servidor: ao acessar a máquina");
    expect(p).toContain("sempre rode o lint antes");
    expect(p).toContain("Feito.");
    expect(PROMPT_MEMORISTA).toContain(`No máximo ${MAX_OPERACOES} operações`);
  });

  it("índice com mais de 40 memórias avisa quantas ficaram de fora", () => {
    const memorias = Array.from({ length: 45 }, (_, i) => ({ relPath: `m-${i}.md`, titulo: `T${i}`, gancho: "g" }));
    const p = montarPromptMemorista({ memorias, usadas: [], falasUsuario: ["x"], resposta: "" });
    expect(p).toContain("(+5 omitidas)");
    expect(p).not.toContain("m-44.md");
  });

  it("falas numeradas; acima do teto sai a mais antiga", () => {
    expect(juntarFalas(["a", "b"])).toBe("(1) a\n(2) b");
    expect(juntarFalas(["só uma"])).toBe("só uma");
    const j = juntarFalas(["velha ".repeat(10), "nova"], 30);
    expect(j).toBe("nova");
  });
});

describe("interpretarVeredito", () => {
  const conhecidos = ["deploy-vercel.md", "infra/servidor.md"];

  it("OK e lixo viram nenhuma operação", () => {
    expect(interpretarVeredito("OK", conhecidos)).toEqual([]);
    expect(interpretarVeredito("Acho que nada aqui.\nOK.", conhecidos)).toEqual([]);
    expect(interpretarVeredito("", conhecidos)).toEqual([]);
  });

  it("aceita CRIA (e NOVA) válido, com tipo acentuado e marcação de lista", () => {
    const ops = interpretarVeredito(
      [
        "- CRIA | Instrução | lint-antes.md | Lint antes do commit | ao commitar | Sempre rodar npm run lint antes de commitar.",
        "`NOVA | infraestrutura | infra/nas.md | NAS de casa | ao falar do backup | O backup vai para o NAS em 192.168.0.10.`",
      ].join("\n"),
      conhecidos,
    );
    expect(ops).toEqual([
      { op: "create", relPath: "lint-antes.md", tipo: "instrucao", titulo: "Lint antes do commit", gancho: "ao commitar", fato: "Sempre rodar npm run lint antes de commitar." },
      { op: "create", relPath: "infra/nas.md", tipo: "infra", titulo: "NAS de casa", gancho: "ao falar do backup", fato: "O backup vai para o NAS em 192.168.0.10." },
    ]);
  });

  it("derruba tipo inválido, caminho inválido e CRIA em caminho que já existe", () => {
    const ops = interpretarVeredito(
      [
        "CRIA | opiniao | a.md | T | g | fato",
        "CRIA | infra | ../fora.md | T | g | fato",
        "CRIA | infra | sem-extensao | T | g | fato",
        "CRIA | infra | Deploy-Vercel.md | T | g | fato",
        "CRIA | infra | b.md |  | g | fato",
        "CRIA | infra | c.md | T | g | fato válido",
      ].join("\n"),
      conhecidos,
    );
    expect(ops.map((o) => o.relPath)).toEqual(["c.md"]);
  });

  it("COMPLEMENTA só em caminho conhecido (caminho inventado cai) e mapeia para o canônico", () => {
    const ops = interpretarVeredito(
      ["COMPLEMENTA | inventado.md | fato", "COMPLEMENTA | INFRA/servidor.md | porta 2222", "COMPLEMENTA | infra/servidor.md | de novo"].join("\n"),
      conhecidos,
    );
    expect(ops).toEqual([{ op: "update", relPath: "infra/servidor.md", fato: "porta 2222" }]);
  });

  it("nunca passa de 3 operações", () => {
    const linhas = Array.from({ length: 6 }, (_, i) => `CRIA | decisao | d-${i}.md | T${i} | g | fato ${i}`);
    const ops = interpretarVeredito(linhas.join("\n"), []);
    expect(ops).toHaveLength(MAX_OPERACOES);
    expect(ops.map((o) => o.relPath)).toEqual(["d-0.md", "d-1.md", "d-2.md"]);
  });

  it("anexarFato acrescenta no fim e ignora fato repetido", () => {
    expect(anexarFato("Linha 1\n", "Linha 2")).toBe("Linha 1\nLinha 2\n");
    expect(anexarFato("A porta é 2222.\n", "a porta  é 2222.")).toBeNull();
  });
});

describe("criarMemorista", () => {
  it("fim de turno grava a memória via proporMemoria com origem 'memorista' e avisa", async () => {
    const home = tempHome();
    const { rodar, prompts } = modeloFalso(["CRIA | preferencia | respostas-curtas.md | Respostas curtas | ao responder | O usuário quer respostas curtas."]);
    const eventos: EventoMemoriaSalva[] = [];
    const m = criarMemorista({ home, rodar, modelo: () => "haiku", ligado: () => true, agora: () => 1_000_000, aoSalvar: (e) => eventos.push(e) });
    m.observarUsuario("t1", "responda sempre curto, por favor");
    await m.fimDeTurno("t1", { threadProfileId: "p1", resumoDoTurno: "Ok, vou ser breve.", memoriasUsadas: [] });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.ctx).toMatchObject({ home, modelo: "haiku", tetoMs: 60_000, threadProfileId: "p1" });
    expect(prompts[0]!.prompt).toContain("responda sempre curto, por favor");
    const mem = lerMemoria(home, "respostas-curtas.md");
    expect(mem).toMatchObject({ tipo: "preferencia", titulo: "Respostas curtas", gancho: "ao responder", origem: "memorista", status: "ativa" });
    expect(mem!.corpo).toContain("O usuário quer respostas curtas.");
    expect(eventos).toEqual([{ relPath: "respostas-curtas.md", titulo: "Respostas curtas", op: "create", origem: "memorista", threadId: "t1" }]);
  });

  it("desligado ou turno sem fala do usuário: não chama o modelo", async () => {
    const home = tempHome();
    const { rodar, prompts } = modeloFalso([]);
    let ligado = false;
    const m = criarMemorista({ home, rodar, modelo: () => "x", ligado: () => ligado, agora: () => 0 });
    m.observarUsuario("t1", "algo");
    await m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] });
    ligado = true;
    await m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] }); // a fala já foi consumida
    m.observarUsuario("t2", "   ");
    await m.fimDeTurno("t2", { resumoDoTurno: "r", memoriasUsadas: [] });
    expect(prompts).toHaveLength(0);
  });

  it("cooldown de 60 s por conversa: turno dentro da janela entra junto na próxima análise", async () => {
    vi.useFakeTimers();
    const home = tempHome();
    const { rodar, prompts } = modeloFalso(["OK", "OK"]);
    let t = 0;
    const m = criarMemorista({ home, rodar, modelo: () => "x", ligado: () => true, agora: () => t });

    m.observarUsuario("t1", "primeira");
    await m.fimDeTurno("t1", { resumoDoTurno: "r1", memoriasUsadas: [] });
    expect(prompts).toHaveLength(1);

    t = 10_000;
    m.observarUsuario("t1", "segunda");
    await m.fimDeTurno("t1", { resumoDoTurno: "r2", memoriasUsadas: [] });
    // outra conversa não sofre o cooldown da primeira
    m.observarUsuario("t2", "de outra conversa");
    await m.fimDeTurno("t2", { resumoDoTurno: "r", memoriasUsadas: [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.prompt).toContain("de outra conversa");

    t = 30_000;
    m.observarUsuario("t1", "terceira");
    await m.fimDeTurno("t1", { resumoDoTurno: "r3", memoriasUsadas: [] });
    expect(prompts).toHaveLength(2);

    // fim da janela: os dois adiados vão numa análise só, sem esperar nova fala
    t = COOLDOWN_MEMORISTA_MS;
    await vi.advanceTimersByTimeAsync(COOLDOWN_MEMORISTA_MS - 10_000);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]!.prompt).toContain("(1) segunda\n(2) terceira");
    expect(prompts[2]!.prompt).not.toContain("primeira");
  });

  it("falha do modelo devolve o lote para a fila e ele vai na análise seguinte", async () => {
    const home = tempHome();
    const { rodar, prompts } = modeloFalso([new Error("sem conta"), "OK"]);
    let t = 0;
    const m = criarMemorista({ home, rodar, modelo: () => "x", ligado: () => true, agora: () => t });
    m.observarUsuario("t1", "fala perdida?");
    await expect(m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] })).resolves.toBeUndefined();

    t = COOLDOWN_MEMORISTA_MS + 1;
    m.observarUsuario("t1", "fala nova");
    await m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.prompt).toContain("(1) fala perdida?\n(2) fala nova");
  });

  it("COMPLEMENTA acrescenta à memória existente (revisão fresca) e ignora fato repetido", async () => {
    const home = tempHome();
    criar(home, "infra/servidor.md", "O servidor fica em casa.");
    const { rodar, prompts } = modeloFalso(["COMPLEMENTA | infra/servidor.md | O SSH é na porta 2222.", "COMPLEMENTA | infra/servidor.md | O SSH é na porta 2222."]);
    let t = 0;
    const eventos: EventoMemoriaSalva[] = [];
    const m = criarMemorista({ home, rodar, modelo: () => "x", ligado: () => true, agora: () => t, aoSalvar: (e) => eventos.push(e) });

    m.observarUsuario("t1", "o ssh é na 2222");
    await m.fimDeTurno("t1", { resumoDoTurno: "anotado", memoriasUsadas: ["infra/servidor.md"] });
    expect(prompts[0]!.prompt).toContain("- infra/servidor.md — Título infra/servidor.md: quando infra/servidor.md");
    const depois = lerMemoria(home, "infra/servidor.md")!;
    expect(depois.corpo).toContain("O servidor fica em casa.");
    expect(depois.corpo).toContain("O SSH é na porta 2222.");
    expect(depois.revisao).toBe(2);
    expect(depois.origem).toBe("memorista");
    expect(eventos.map((e) => e.op)).toEqual(["update"]);

    t = COOLDOWN_MEMORISTA_MS + 1;
    m.observarUsuario("t1", "de novo");
    await m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] });
    expect(lerMemoria(home, "infra/servidor.md")!.revisao).toBe(2);
    expect(eventos).toHaveLength(1);
  });

  it("CRIA em caminho que já existe, tipo inválido e caminho inventado não gravam nada", async () => {
    const home = tempHome();
    criar(home, "ja-existe.md");
    const { rodar } = modeloFalso([
      ["CRIA | infra | ja-existe.md | T | g | sobrescreve?", "CRIA | palpite | novo.md | T | g | f", "COMPLEMENTA | nao-existe.md | f"].join("\n"),
    ]);
    const m = criarMemorista({ home, rodar, modelo: () => "x", ligado: () => true, agora: () => 0 });
    m.observarUsuario("t1", "fala");
    await m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] });
    expect(listarMemorias(home, { incluirAposentadas: true }).map((x) => x.relPath)).toEqual(["ja-existe.md"]);
    expect(lerMemoria(home, "ja-existe.md")!.revisao).toBe(1);
  });

  it("fimDeTurno nunca lança, nem com aoSalvar quebrado", async () => {
    const home = tempHome();
    const { rodar } = modeloFalso(["CRIA | decisao | usar-pnpm.md | Usar pnpm | ao instalar | Usamos pnpm porque o monorepo exige."]);
    const m = criarMemorista({
      home,
      rodar,
      modelo: () => "x",
      ligado: () => true,
      agora: () => 0,
      aoSalvar: () => {
        throw new Error("quebrou");
      },
    });
    m.observarUsuario("t1", "use pnpm");
    await expect(m.fimDeTurno("t1", { resumoDoTurno: "r", memoriasUsadas: [] })).resolves.toBeUndefined();
    expect(lerMemoria(home, "usar-pnpm.md")?.origem).toBe("memorista");
  });

  it("aplicarOperacoes conta só o que gravou", () => {
    const home = tempHome();
    criar(home, "a.md");
    const n = aplicarOperacoes(
      home,
      [
        { op: "create", relPath: "a.md", tipo: "infra", titulo: "T", gancho: "g", fato: "f" },
        { op: "create", relPath: "b.md", tipo: "infra", titulo: "T", gancho: "g", fato: "f" },
        { op: "update", relPath: "a.md", fato: "novo fato" },
      ],
      "curador",
    );
    expect(n).toBe(2);
    expect(lerMemoria(home, "b.md")!.origem).toBe("curador");
  });
});
