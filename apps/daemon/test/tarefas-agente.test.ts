import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import {
  canalTarefas,
  colunaDoStatus,
  getQuadro,
  getTarefa,
  listarTarefas,
  salvarTarefa,
  statusEfetivo,
  tarefasBus,
  type EventoQuadro,
  type Quadro,
} from "../src/tarefas.ts";
import {
  MARCA_FIM_DE_TURNO,
  aoUsarFerramentaDeTarefa,
  aplicarPO,
  criarTarefaDoPO,
  fecharTurno,
  idDoCard,
  itensDoTodoWrite,
  lerTarefasDoAgente,
  resetTarefasAgenteForTest,
  retomarTurno,
  sincronizarNoFimDoTurno,
  sincronizarTarefasDoAgente,
  type ItemDoAgente,
} from "../src/tarefas-agente.ts";

const P = "/projetos/um";
const T = "th-conversa-1";

afterEach(() => resetTarefasAgenteForTest());

function colunas(home: string): { pendente: string; andamento: string; feito: string } {
  const [a, b, c] = [...getQuadro(P, home).colunas].sort((x, y) => x.ordem - y.ordem);
  return { pendente: a.id, andamento: b.id, feito: c.id };
}

function desligarQuadro(home: string): void {
  saveConfig(home, { modulos: { ...loadConfig(home).modulos, quadroTarefas: false } });
}

function arquivoDoCard(home: string, id: string): string {
  const achar = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const r = achar(p);
        if (r) return r;
      } else if (e.name === `${id}.md`) return p;
    }
    return undefined;
  };
  // a pasta do projeto depende do layout (ver `pastaTarefasSemCriar`): procura no home inteiro
  const p = achar(home);
  if (!p) throw new Error(`sem arquivo pro card ${id}`);
  return readFileSync(p, "utf8");
}

const item = (id: string, titulo: string, status: ItemDoAgente["status"]): ItemDoAgente => ({ id, titulo, status });

describe("modelo: camadas fonte/po", () => {
  it("fonte e po persistem no .md e voltam na leitura; criadoPor aceita agente", () => {
    const home = tempHome();
    const r = sincronizarTarefasDoAgente(P, home, T, "sess-1", [item("1", "Ler o código", "pending")]);
    const id = idDoCard(T, "1");
    expect(r.criados).toEqual([id]);
    const t = getTarefa(P, home, id)!;
    expect(t.criadoPor).toBe("agente");
    expect(t.threadId).toBe(T);
    expect(t.fonte).toMatchObject({ conversa: T, sessaoId: "sess-1", id: "1", status: "pending", titulo: "Ler o código" });
    const md = arquivoDoCard(home, id);
    expect(md).toContain('"fonte"');
    expect(md).toContain('"sess-1"');

    aplicarPO(P, home, id, { resumo: "contexto pro dono" }, "explicar");
    const md2 = arquivoDoCard(home, id);
    expect(md2).toContain('"po"');
    expect(getTarefa(P, home, id)!.po).toMatchObject({ resumo: "contexto pro dono", motivo: "explicar" });
  });

  it("card criado pela pessoa não tem camada nenhuma", () => {
    const home = tempHome();
    const t = salvarTarefa({ projectPath: P, titulo: "manual", colunaId: colunas(home).pendente }, home);
    expect(t.fonte).toBeUndefined();
    expect(t.po).toBeUndefined();
    expect(t.criadoPor).toBeUndefined();
  });
});

describe("statusEfetivo / colunaDoStatus", () => {
  const quadroCom = (n: number): Quadro =>
    ({ colunas: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, nome: `C${i}`, ordem: (n - i) * 10 })) }) as unknown as Quadro;

  it("3+ colunas: pending=menor ordem, in_progress=a segunda, completed=maior", () => {
    const q = quadroCom(4); // ordem invertida de propósito: c3 é a menor
    expect(colunaDoStatus(q, "pending")).toBe("c3");
    expect(colunaDoStatus(q, "in_progress")).toBe("c2");
    expect(colunaDoStatus(q, "completed")).toBe("c0");
  });

  it("2 colunas: in_progress cai na primeira; 1 coluna: tudo nela; 0: undefined", () => {
    const q2 = quadroCom(2);
    expect(colunaDoStatus(q2, "pending")).toBe("c1");
    expect(colunaDoStatus(q2, "in_progress")).toBe("c1");
    expect(colunaDoStatus(q2, "completed")).toBe("c0");
    const q1 = quadroCom(1);
    expect(["pending", "in_progress", "completed"].map((s) => colunaDoStatus(q1, s as "pending"))).toEqual(["c0", "c0", "c0"]);
    expect(colunaDoStatus(quadroCom(0), "pending")).toBeUndefined();
  });

  it("po ganha da fonte, fonte ganha da coluna, sem camada lê a coluna", () => {
    const q = quadroCom(3);
    const fonte = { conversa: T, id: "1", status: "in_progress" as const, titulo: "x", em: "" };
    expect(statusEfetivo({ colunaId: "c2", fonte, po: { status: "completed", em: "" } }, q)).toBe("completed");
    expect(statusEfetivo({ colunaId: "c2", fonte }, q)).toBe("in_progress");
    expect(statusEfetivo({ colunaId: "c2" }, q)).toBe("pending");
    expect(statusEfetivo({ colunaId: "c1" }, q)).toBe("in_progress");
    expect(statusEfetivo({ colunaId: "c0" }, q)).toBe("completed");
    expect(statusEfetivo({ colunaId: "c0" })).toBe("pending");
  });
});

describe("lista do motor", () => {
  it("lerTarefasDoAgente: pasta ausente = null; arquivo ruim pulado; ordem numérica", () => {
    const home = tempHome();
    const configDir = join(home, "cfg");
    expect(lerTarefasDoAgente(configDir, "sess-1")).toBeNull();
    expect(lerTarefasDoAgente(configDir, "../fora")).toBeNull();
    const dir = join(configDir, "tasks", "sess-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "10.json"), JSON.stringify({ id: "10", subject: "Dez", status: "completed" }));
    writeFileSync(join(dir, "2.json"), JSON.stringify({ id: "2", subject: "  Dois\n  linhas ", status: "in_progress" }));
    writeFileSync(join(dir, "3.json"), "{ pela metade");
    writeFileSync(join(dir, "4.json"), JSON.stringify({ id: "4", subject: "Status ruim", status: "doing" }));
    expect(lerTarefasDoAgente(configDir, "sess-1")).toEqual([item("2", "Dois linhas", "in_progress"), item("10", "Dez", "completed")]);
  });

  it("itensDoTodoWrite: ids todo-N; entrada sem lista = null", () => {
    expect(itensDoTodoWrite({ todos: [{ content: "A", status: "pending" }, { content: "", status: "pending" }, { content: "C", status: "completed" }] })).toEqual([
      item("todo-1", "A", "pending"),
      item("todo-3", "C", "completed"),
    ]);
    expect(itensDoTodoWrite({})).toBeNull();
    expect(itensDoTodoWrite(null)).toBeNull();
  });
});

describe("sync da lista do agente", () => {
  it("cria na coluna do status, atualiza, move e apaga o que sumiu; idempotente", () => {
    const home = tempHome();
    const c = colunas(home);
    const id1 = idDoCard(T, "1");
    const id2 = idDoCard(T, "2");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending"), item("2", "Dois", "in_progress")]);
    expect(getTarefa(P, home, id1)!.colunaId).toBe(c.pendente);
    expect(getTarefa(P, home, id2)!.colunaId).toBe(c.andamento);

    const mesmo = sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending"), item("2", "Dois", "in_progress")]);
    expect(mesmo).toEqual({ criados: [], atualizados: [], apagados: [] });

    const r = sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um revisto", "completed")]);
    expect(r).toEqual({ criados: [], atualizados: [id1], apagados: [id2] });
    const t1 = getTarefa(P, home, id1)!;
    expect(t1.colunaId).toBe(c.feito);
    expect(t1.titulo).toBe("Um revisto");
    expect(getTarefa(P, home, id2)).toBeUndefined();
  });

  it("id estável por (conversa, item): outra conversa não colide nem apaga", () => {
    const home = tempHome();
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    sincronizarTarefasDoAgente(P, home, "th-outra", "s2", [item("1", "Um da outra", "pending")]);
    sincronizarTarefasDoAgente(P, home, "th-outra", "s2", []);
    expect(getTarefa(P, home, idDoCard(T, "1"))).toBeDefined();
    expect(getTarefa(P, home, idDoCard("th-outra", "1"))).toBeUndefined();
    expect(idDoCard(T, "1")).not.toBe(idDoCard("th-outra", "1"));
  });

  it("agente muda o status → status do PO cai; título e resumo do PO ficam", () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    aplicarPO(P, home, id, { titulo: "Título do PO", resumo: "resumo", status: "completed", acaoVoce: "aprovar" }, "já entregue");
    expect(getTarefa(P, home, id)!.colunaId).toBe(c.feito);

    // mesma lista: nada muda, o PO segue mandando
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    expect(getTarefa(P, home, id)!.po?.status).toBe("completed");

    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    const t = getTarefa(P, home, id)!;
    expect(t.po).toMatchObject({ titulo: "Título do PO", resumo: "resumo" });
    expect(t.po?.status).toBeUndefined();
    expect(t.po?.acaoVoce).toBeUndefined();
    expect(t.titulo).toBe("Título do PO");
    expect(t.colunaId).toBe(c.pendente);
  });

  it("card do PO nunca é apagado pelo sync; card da pessoa também não", () => {
    const home = tempHome();
    const doPO = criarTarefaDoPO(P, home, { titulo: "Do PO", status: "pending", motivo: "faltava", threadId: T });
    const daPessoa = salvarTarefa({ projectPath: P, titulo: "Da pessoa", colunaId: colunas(home).pendente, threadId: T }, home);
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    const r = sincronizarTarefasDoAgente(P, home, T, "s", []);
    expect(r.apagados).toEqual([idDoCard(T, "1")]);
    expect(getTarefa(P, home, doPO.id)).toBeDefined();
    expect(getTarefa(P, home, daPessoa.id)).toBeDefined();
  });

  it("coluna arrastada pela pessoa fica enquanto o status do agente não muda", () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    salvarTarefa({ id, projectPath: P, titulo: "Um", colunaId: c.andamento }, home);
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um com título novo", "pending")]);
    expect(getTarefa(P, home, id)!.colunaId).toBe(c.andamento);
  });

  it("evento de ferramenta: TodoWrite agendado vira card; fim do turno lê o arquivo de tarefas", async () => {
    const home = tempHome();
    const configDir = join(home, "cfg");
    aoUsarFerramentaDeTarefa(home, { threadId: T, projectPath: P }, "TodoWrite", { todos: [{ content: "Via todo", status: "pending" }] });
    aoUsarFerramentaDeTarefa(home, { threadId: T, projectPath: P }, "Bash", {});
    expect(getTarefa(P, home, idDoCard(T, "todo-1"))).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(getTarefa(P, home, idDoCard(T, "todo-1"))?.titulo).toBe("Via todo");

    const dir = join(configDir, "tasks", "sess-9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.json"), JSON.stringify({ id: "1", subject: "Via TaskCreate", status: "in_progress" }));
    sincronizarNoFimDoTurno(home, { threadId: T, projectPath: P, configDir, sessionId: "sess-9" });
    const daConversa = listarTarefas(P, home).filter((t) => t.threadId === T);
    expect(daConversa.map((t) => t.titulo)).toEqual(["Via TaskCreate"]);
  });

  it("quadro desligado ou sem projeto: nada é gravado", () => {
    const home = tempHome();
    sincronizarNoFimDoTurno(home, { threadId: T });
    aoUsarFerramentaDeTarefa(home, { threadId: T }, "TodoWrite", { todos: [{ content: "x", status: "pending" }] });
    sincronizarNoFimDoTurno(home, { threadId: T });
    desligarQuadro(home);
    aoUsarFerramentaDeTarefa(home, { threadId: T, projectPath: P }, "TodoWrite", { todos: [{ content: "x", status: "pending" }] });
    sincronizarNoFimDoTurno(home, { threadId: T, projectPath: P });
    expect(listarTarefas(P, home)).toEqual([]);
  });
});

describe("API do PO", () => {
  it("aplicarPO: motivo obrigatório; comentário autor PO; evento via po; null limpa", () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    expect(() => aplicarPO(P, home, id, { status: "completed" }, "")).toThrow(/motivo/);
    expect(() => aplicarPO(P, home, id, { status: "completed" }, "   ")).toThrow(/motivo/);
    expect(() => aplicarPO(P, home, "tk-nao-existe", {}, "x")).toThrow(/não existe/);
    expect(() => aplicarPO(P, home, id, { status: "doing" as "pending" }, "x")).toThrow(/status/);

    const eventos: EventoQuadro[] = [];
    const ouvir = (e: EventoQuadro) => eventos.push(e);
    tarefasBus.on(canalTarefas(P), ouvir);
    try {
      const t = aplicarPO(P, home, id, { status: "in_progress", acaoVoce: "olhar" }, "começou de fato");
      expect(t.colunaId).toBe(c.andamento);
      expect(t.po).toMatchObject({ status: "in_progress", acaoVoce: "olhar", motivo: "começou de fato" });
      expect(t.comentarios.at(-1)).toMatchObject({ autor: "PO", texto: "começou de fato" });
    } finally {
      tarefasBus.off(canalTarefas(P), ouvir);
    }
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.every((e) => e.via === "po")).toBe(true);
    expect(eventos.some((e) => e.tipo === "moveu")).toBe(true);

    const limpo = aplicarPO(P, home, id, { status: null, acaoVoce: null }, "volta pro agente");
    expect(limpo.po?.status).toBeUndefined();
    expect(limpo.po?.acaoVoce).toBeUndefined();
    expect(limpo.colunaId).toBe(c.pendente);
  });

  it("criarTarefaDoPO: criadoPor po, coluna do status, comentário com o motivo", () => {
    const home = tempHome();
    const c = colunas(home);
    expect(() => criarTarefaDoPO(P, home, { titulo: "x", status: "pending", motivo: "", threadId: T })).toThrow(/motivo/);
    expect(() => criarTarefaDoPO(P, home, { titulo: " ", status: "pending", motivo: "m", threadId: T })).toThrow(/título/);
    const t = criarTarefaDoPO(P, home, {
      titulo: "Decidir o banco",
      resumo: "Postgres ou SQLite",
      status: "in_progress",
      motivo: "a conversa travou nisso",
      acaoVoce: "escolher",
      tipoResposta: "botao",
      threadId: T,
    });
    expect(t.criadoPor).toBe("po");
    expect(t.colunaId).toBe(c.andamento);
    expect(t.threadId).toBe(T);
    expect(t.po).toMatchObject({ titulo: "Decidir o banco", resumo: "Postgres ou SQLite", status: "in_progress", tipoResposta: "botao" });
    expect(t.comentarios[0]).toMatchObject({ autor: "PO", texto: "a conversa travou nisso" });
  });

  it("quadro desligado: aplicarPO e criarTarefaDoPO recusam", () => {
    const home = tempHome();
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "pending")]);
    desligarQuadro(home);
    expect(() => aplicarPO(P, home, idDoCard(T, "1"), { status: "completed" }, "m")).toThrow(/desligado/);
    expect(() => criarTarefaDoPO(P, home, { titulo: "x", status: "pending", motivo: "m", threadId: T })).toThrow(/desligado/);
  });
});

describe("passos de turno", () => {
  it("fecharTurno devolve o 'em andamento' pra 'a fazer'; retomarTurno volta com o PO de antes", async () => {
    const home = tempHome();
    const c = colunas(home);
    const ag = idDoCard(T, "1");
    const parado = idDoCard(T, "2");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress"), item("2", "Dois", "pending")]);
    const doPO = criarTarefaDoPO(P, home, { titulo: "Do PO", status: "in_progress", motivo: "m", acaoVoce: "ver", threadId: T });
    const daPessoa = salvarTarefa({ projectPath: P, titulo: "Da pessoa", colunaId: c.andamento, threadId: T }, home);

    const rebaixados = await fecharTurno(T, P, home);
    expect(rebaixados.sort()).toEqual([ag, doPO.id].sort());
    expect(getTarefa(P, home, ag)!.colunaId).toBe(c.pendente);
    expect(getTarefa(P, home, ag)!.po).toMatchObject({ status: "pending", motivo: MARCA_FIM_DE_TURNO });
    expect(getTarefa(P, home, doPO.id)!.po?.acaoVoce).toBeUndefined();
    expect(getTarefa(P, home, parado)!.po).toBeUndefined();
    expect(getTarefa(P, home, daPessoa.id)!.colunaId).toBe(c.andamento);

    const retomados = await retomarTurno(T, P, home);
    expect(retomados.sort()).toEqual([ag, doPO.id].sort());
    const a = getTarefa(P, home, ag)!;
    expect(a.colunaId).toBe(c.andamento);
    expect(a.po).toBeUndefined();
    const p = getTarefa(P, home, doPO.id)!;
    expect(p.colunaId).toBe(c.andamento);
    expect(p.po).toMatchObject({ titulo: "Do PO", status: "in_progress", acaoVoce: "ver", motivo: "m" });
    expect(await retomarTurno(T, P, home)).toEqual([]);
  });

  it("retomar sem memória (daemon reiniciou) ainda volta pra 'em andamento'", async () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    await fecharTurno(T, P, home);
    resetTarefasAgenteForTest();
    expect(await retomarTurno(T, P, home)).toEqual([id]);
    expect(getTarefa(P, home, id)!.colunaId).toBe(c.andamento);
    expect(getTarefa(P, home, id)!.po).toBeUndefined();
  });

  it("agente mexeu no item depois do fim do turno: a marca cai no sync e retomar não toca", async () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    await fecharTurno(T, P, home);
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "completed")]);
    expect(getTarefa(P, home, id)!.po).toBeUndefined();
    expect(await retomarTurno(T, P, home)).toEqual([]);
    expect(getTarefa(P, home, id)!.colunaId).toBe(c.feito);
  });

  it("fecharTurno espera o PO até o teto e não rejeita se ele falhar", async () => {
    const home = tempHome();
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    const nunca = new Promise<void>(() => {});
    const inicio = Date.now();
    expect(await fecharTurno(T, P, home, { aguardar: nunca, tetoMs: 50 })).toEqual([idDoCard(T, "1")]);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(40);

    sincronizarTarefasDoAgente(P, home, T + "-b", "s", [item("1", "Um", "in_progress")]);
    expect(await fecharTurno(T + "-b", P, home, { aguardar: Promise.reject(new Error("PO caiu")) })).toEqual([idDoCard(T + "-b", "1")]);
  });

  it("retomar espera o fechar da mesma conversa (fila por conversa)", async () => {
    const home = tempHome();
    const c = colunas(home);
    const id = idDoCard(T, "1");
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    let liberar!: () => void;
    const po = new Promise<void>((r) => (liberar = r));
    const fechar = fecharTurno(T, P, home, { aguardar: po });
    const retomar = retomarTurno(T, P, home);
    liberar();
    expect(await fechar).toEqual([id]);
    expect(await retomar).toEqual([id]);
    expect(getTarefa(P, home, id)!.colunaId).toBe(c.andamento);
  });

  it("sem projeto ou quadro desligado: os dois passos não fazem nada", async () => {
    const home = tempHome();
    sincronizarTarefasDoAgente(P, home, T, "s", [item("1", "Um", "in_progress")]);
    expect(await fecharTurno(T, undefined, home)).toEqual([]);
    expect(await retomarTurno(T, undefined, home)).toEqual([]);
    desligarQuadro(home);
    expect(await fecharTurno(T, P, home)).toEqual([]);
    expect(getTarefa(P, home, idDoCard(T, "1"))!.po).toBeUndefined();
  });
});
