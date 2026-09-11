import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import {
  adicionarChecklistItem,
  adicionarComentario,
  alternarChecklistItem,
  apagarChecklistItem,
  apagarColuna,
  apagarEtiqueta,
  apagarMarco,
  apagarTarefa,
  ferramentasDeTarefas,
  getQuadro,
  getTarefa,
  listarTarefas,
  salvarColuna,
  salvarEtiqueta,
  salvarMarco,
  salvarTarefa,
  tarefasRoot,
} from "../src/tarefas.ts";
import { tarefasPath } from "../src/home.ts";

const P1 = "/projetos/um";
const P2 = "/projetos/dois";

describe("getQuadro", () => {
  it("nasce com 3 colunas padrão na primeira leitura, sem passo de 'criar quadro'", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    expect(q.colunas.map((c) => c.nome)).toEqual(["A fazer", "Fazendo", "Feito"]);
    expect(q.marcos).toEqual([]);
    expect(q.etiquetas).toEqual([]);
  });

  it("é idempotente — ler duas vezes devolve o MESMO quadro, não recria colunas", () => {
    const home = tempHome();
    const primeiro = getQuadro(P1, home);
    const segundo = getQuadro(P1, home);
    expect(segundo.colunas.map((c) => c.id)).toEqual(primeiro.colunas.map((c) => c.id));
  });

  it("projetos diferentes têm quadros independentes", () => {
    const home = tempHome();
    salvarColuna(P1, { nome: "Backlog" }, home);
    const q1 = getQuadro(P1, home);
    const q2 = getQuadro(P2, home);
    expect(q1.colunas.some((c) => c.nome === "Backlog")).toBe(true);
    expect(q2.colunas.some((c) => c.nome === "Backlog")).toBe(false);
  });

  it("grava num arquivo .md legível, com bloco json no topo", () => {
    const home = tempHome();
    getQuadro(P1, home);
    const dir = tarefasRoot(home);
    const arquivos = readdirSync(dir);
    expect(arquivos.length).toBe(1); // uma pasta por hash de projeto
    const pastaProjeto = join(dir, arquivos[0]);
    const conteudo = readFileSync(join(pastaProjeto, "quadro.md"), "utf8");
    expect(conteudo).toMatch(/^```json\n/);
    expect(conteudo).toContain("# Quadro de tarefas");
    expect(conteudo).toContain("A fazer");
  });
});

describe("salvarColuna / apagarColuna", () => {
  it("cria uma coluna nova no fim", () => {
    const home = tempHome();
    const c = salvarColuna(P1, { nome: "Bloqueado" }, home);
    const q = getQuadro(P1, home);
    expect(q.colunas.at(-1)).toEqual(c);
  });

  it("renomeia com id", () => {
    const home = tempHome();
    const c = salvarColuna(P1, { nome: "Backlog" }, home);
    const editada = salvarColuna(P1, { id: c.id, nome: "Backlog 2" }, home);
    expect(editada.nome).toBe("Backlog 2");
  });

  it("recusa nome vazio", () => {
    const home = tempHome();
    expect(() => salvarColuna(P1, { nome: "" }, home)).toThrow(/obrigatório/);
  });

  it("recusa passar de COLUNAS_MAX", () => {
    const home = tempHome();
    for (let i = 0; i < 9; i++) salvarColuna(P1, { nome: `c${i}` }, home); // 3 padrão + 9 = 12
    expect(() => salvarColuna(P1, { nome: "excedente" }, home)).toThrow(/limite/);
  });

  it("apaga coluna vazia", () => {
    const home = tempHome();
    const c = salvarColuna(P1, { nome: "Backlog" }, home);
    apagarColuna(P1, c.id, home);
    expect(getQuadro(P1, home).colunas.some((x) => x.id === c.id)).toBe(false);
  });

  it("recusa apagar coluna com tarefa dentro — sem cascata silenciosa", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    const colunaId = q.colunas[0]!.id;
    salvarTarefa({ projectPath: P1, titulo: "fazer algo", colunaId }, home);
    expect(() => apagarColuna(P1, colunaId, home)).toThrow(/1 tarefa/);
    // e a tarefa continua lá, intacta
    expect(getQuadro(P1, home).colunas.some((c) => c.id === colunaId)).toBe(true);
  });
});

describe("salvarMarco / apagarMarco", () => {
  it("cria com nome e prazo opcional", () => {
    const home = tempHome();
    const m = salvarMarco(P1, { nome: "v1.0", prazo: "2026-12-01" }, home);
    expect(m.nome).toBe("v1.0");
    expect(m.prazo).toBe("2026-12-01");
  });

  it("recusa prazo em formato errado", () => {
    const home = tempHome();
    expect(() => salvarMarco(P1, { nome: "v1.0", prazo: "01/12/2026" }, home)).toThrow(/AAAA-MM-DD/);
  });

  it("edita e consegue LIMPAR o prazo mandando null", () => {
    const home = tempHome();
    const m = salvarMarco(P1, { nome: "v1.0", prazo: "2026-12-01" }, home);
    const editado = salvarMarco(P1, { id: m.id, prazo: null }, home);
    expect(editado.prazo).toBeUndefined();
  });

  it("recusa apagar marco em uso", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    const m = salvarMarco(P1, { nome: "v1.0" }, home);
    salvarTarefa({ projectPath: P1, titulo: "t", colunaId: q.colunas[0]!.id, marcoId: m.id }, home);
    expect(() => apagarMarco(P1, m.id, home)).toThrow(/1 tarefa/);
  });
});

describe("salvarEtiqueta / apagarEtiqueta", () => {
  it("cria com nome e cor", () => {
    const home = tempHome();
    const e = salvarEtiqueta(P1, { nome: "Urgente", cor: "#ff0000" }, home);
    expect(e.nome).toBe("Urgente");
    expect(e.cor).toBe("#ff0000");
  });

  it("recusa cor fora do formato #rrggbb", () => {
    const home = tempHome();
    expect(() => salvarEtiqueta(P1, { nome: "x", cor: "vermelho" }, home)).toThrow(/cor inválida/);
  });

  it("recusa apagar etiqueta em uso por alguma tarefa", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    const e = salvarEtiqueta(P1, { nome: "x", cor: "#ff0000" }, home);
    salvarTarefa({ projectPath: P1, titulo: "t", colunaId: q.colunas[0]!.id, etiquetaIds: [e.id] }, home);
    expect(() => apagarEtiqueta(P1, e.id, home)).toThrow(/1 tarefa/);
  });

  it("apaga etiqueta sem uso nenhum", () => {
    const home = tempHome();
    const e = salvarEtiqueta(P1, { nome: "x", cor: "#ff0000" }, home);
    apagarEtiqueta(P1, e.id, home);
    expect(getQuadro(P1, home).etiquetas).toHaveLength(0);
  });
});

describe("salvarTarefa", () => {
  it("cria com o mínimo (título + colunaId), entra no fim da coluna", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    const colunaId = q.colunas[0]!.id;
    const a = salvarTarefa({ projectPath: P1, titulo: "primeira", colunaId }, home);
    const b = salvarTarefa({ projectPath: P1, titulo: "segunda", colunaId }, home);
    expect(a.ordem).toBe(0);
    expect(b.ordem).toBe(1);
    expect(a.checklist).toEqual([]);
    expect(a.comentarios).toEqual([]);
    expect(a.etiquetaIds).toEqual([]);
  });

  it("recusa sem projectPath", () => {
    const home = tempHome();
    expect(() => salvarTarefa({ titulo: "x", colunaId: "c1" }, home)).toThrow(/projectPath/);
  });

  it("recusa sem título", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    expect(() => salvarTarefa({ projectPath: P1, colunaId }, home)).toThrow(/título/);
  });

  it("recusa colunaId que não existe NESTE projeto", () => {
    const home = tempHome();
    expect(() => salvarTarefa({ projectPath: P1, titulo: "x", colunaId: "coluna-fantasma" }, home)).toThrow(
      /coluna não existe/,
    );
  });

  it("recusa colunaId de OUTRO projeto — quadros não vazam entre si", () => {
    const home = tempHome();
    const colunaDoP2 = getQuadro(P2, home).colunas[0]!.id;
    expect(() => salvarTarefa({ projectPath: P1, titulo: "x", colunaId: colunaDoP2 }, home)).toThrow(
      /coluna não existe/,
    );
  });

  it("recusa marcoId que não existe", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    expect(() => salvarTarefa({ projectPath: P1, titulo: "x", colunaId, marcoId: "marco-fantasma" }, home)).toThrow(
      /marco não existe/,
    );
  });

  it("recusa etiquetaId que não existe", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    expect(() =>
      salvarTarefa({ projectPath: P1, titulo: "x", colunaId, etiquetaIds: ["fantasma"] }, home),
    ).toThrow(/etiqueta não existe/);
  });

  it("recusa prioridade fora da lista", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    expect(() => salvarTarefa({ projectPath: P1, titulo: "x", colunaId, prioridade: "gigante" }, home)).toThrow(
      /prioridade inválida/,
    );
  });

  it("aceita prioridade e responsável válidos", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId, prioridade: "alta", responsavel: "Yann" }, home);
    expect(t.prioridade).toBe("alta");
    expect(t.responsavel).toBe("Yann");
  });

  it("upsert: atualizar com id mantém campo que não foi mandado", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "original", descricao: "desc original", colunaId }, home);
    const editada = salvarTarefa({ projectPath: P1, id: t.id, titulo: "editado" }, home);
    expect(editada.titulo).toBe("editado");
    expect(editada.descricao).toBe("desc original");
  });

  it("mover pra outra coluna via colunaId: some da coluna antiga, aparece na nova, entra no fim dela", () => {
    const home = tempHome();
    const q = getQuadro(P1, home);
    const [c1, c2] = q.colunas;
    salvarTarefa({ projectPath: P1, titulo: "já tinha", colunaId: c2!.id }, home);
    const t = salvarTarefa({ projectPath: P1, titulo: "mover", colunaId: c1!.id }, home);
    const movida = salvarTarefa({ projectPath: P1, id: t.id, colunaId: c2!.id }, home);
    expect(movida.colunaId).toBe(c2!.id);
    expect(movida.ordem).toBe(1); // depois da que já estava lá
  });

  it("drag-and-drop manda ordem explícita — respeita em vez de sempre ir pro fim", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId, ordem: 5 }, home);
    expect(t.ordem).toBe(5);
  });

  it("editar tarefa criada pela pessoa via ferramenta MCP não vira 'criada por agente' retroativamente", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "da pessoa", colunaId }, home); // sem criadoPor
    const editada = salvarTarefa({ projectPath: P1, id: t.id, titulo: "editada por agente" }, home, "agente");
    expect(editada.criadoPor).toBeUndefined();
  });

  it("tarefa nova via ferramenta MCP fica marcada 'agente'", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "da IA", colunaId }, home, "agente");
    expect(t.criadoPor).toBe("agente");
  });

  it("grava a tarefa num .md próprio, com bloco json e renderização legível", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "revisar PR", descricao: "olhar os testes", colunaId }, home);
    const dir = tarefasRoot(home);
    const pastaProjeto = join(dir, readdirSync(dir)[0]);
    const conteudo = readFileSync(join(pastaProjeto, "itens", `${t.id}.md`), "utf8");
    expect(conteudo).toMatch(/^```json\n/);
    expect(conteudo).toContain("# revisar PR");
    expect(conteudo).toContain("olhar os testes");
  });
});

describe("listarTarefas", () => {
  it("filtra por projectKey — capitalização diferente do MESMO path não vaza tarefa entre 'projetos'", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    expect(listarTarefas(P1.toUpperCase(), home)).toHaveLength(1);
    expect(listarTarefas(P2, home)).toHaveLength(0);
  });
});

describe("apagarTarefa", () => {
  it("apaga, e some de listarTarefas", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    apagarTarefa(P1, home, t.id);
    expect(getTarefa(P1, home, t.id)).toBeUndefined();
    expect(listarTarefas(P1, home)).toHaveLength(0);
  });

  it("404 se não existe", () => {
    const home = tempHome();
    expect(() => apagarTarefa(P1, home, "nao-existe")).toThrow(/não existe/);
  });
});

describe("checklist", () => {
  it("adiciona item, começa não-feito", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    const item = adicionarChecklistItem(P1, home, t.id, "escrever teste");
    expect(item.feito).toBe(false);
    expect(getTarefa(P1, home, t.id)?.checklist).toHaveLength(1);
  });

  it("alterna feito/não-feito", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    const item = adicionarChecklistItem(P1, home, t.id, "item");
    alternarChecklistItem(P1, home, t.id, item.id, true);
    expect(getTarefa(P1, home, t.id)?.checklist[0]!.feito).toBe(true);
  });

  it("apaga item do checklist", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    const item = adicionarChecklistItem(P1, home, t.id, "item");
    apagarChecklistItem(P1, home, t.id, item.id);
    expect(getTarefa(P1, home, t.id)?.checklist).toHaveLength(0);
  });

  it("item fantasma é 404", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    expect(() => alternarChecklistItem(P1, home, t.id, "fantasma", true)).toThrow(/não existe/);
  });
});

describe("comentarios", () => {
  it("adiciona comentário, fica no fim da lista, sem editar/apagar (só isso existe)", () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const t = salvarTarefa({ projectPath: P1, titulo: "x", colunaId }, home);
    adicionarComentario(P1, home, t.id, "primeiro", "Yann");
    const c2 = adicionarComentario(P1, home, t.id, "segundo");
    const tarefa = getTarefa(P1, home, t.id)!;
    expect(tarefa.comentarios).toHaveLength(2);
    expect(tarefa.comentarios[0]!.autor).toBe("Yann");
    expect(tarefa.comentarios[1]!.id).toBe(c2.id);
  });

  it("tarefa fantasma é 404", () => {
    const home = tempHome();
    expect(() => adicionarComentario(P1, home, "fantasma", "x")).toThrow(/não existe/);
  });
});

describe("migração do tarefas.json legado", () => {
  it("projeto com quadro/tarefas no formato antigo migra sozinho na primeira leitura", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    const legado = {
      quadros: [{ projectPath: P1, colunas: [{ id: "cl-1", nome: "Fazendo", ordem: 0 }], marcos: [] }],
      tarefas: [
        {
          id: "tk-1",
          projectPath: P1,
          titulo: "tarefa antiga",
          colunaId: "cl-1",
          ordem: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(tarefasPath(home), JSON.stringify(legado, null, 2), "utf8");

    const quadro = getQuadro(P1, home);
    expect(quadro.colunas.map((c) => c.nome)).toEqual(["Fazendo"]);
    const tarefas = listarTarefas(P1, home);
    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]!.titulo).toBe("tarefa antiga");
    expect(tarefas[0]!.checklist).toEqual([]);
  });

  it("legado corrompido não derruba — projeto nasce com quadro padrão", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(tarefasPath(home), "{ isso não é json", "utf8");
    const quadro = getQuadro(P1, home);
    expect(quadro.colunas.map((c) => c.nome)).toEqual(["A fazer", "Fazendo", "Feito"]);
  });

  it("legado sem entrada pra este projeto não muda nada", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      tarefasPath(home),
      JSON.stringify({ quadros: [{ projectPath: P2, colunas: [], marcos: [] }], tarefas: [] }),
      "utf8",
    );
    const quadro = getQuadro(P1, home);
    expect(quadro.colunas.map((c) => c.nome)).toEqual(["A fazer", "Fazendo", "Feito"]);
  });
});

describe("ferramentasDeTarefas (MCP)", () => {
  it("não tem ferramenta de apagar — mesma assimetria de autoria.ts (agente/time/hook)", () => {
    const home = tempHome();
    const nomes = ferramentasDeTarefas(P1, home)().map((f) => f.name);
    expect(nomes).toEqual(["nexo_tarefa_listar", "nexo_tarefa_salvar"]);
  });

  it("nexo_tarefa_listar sem tarefa nenhuma ainda assim mostra as colunas (pro modelo saber que colunaId usar)", async () => {
    const home = tempHome();
    const [listar] = ferramentasDeTarefas(P1, home)();
    const r = await listar!.executar({});
    expect(r.ok).toBe(true);
    expect(r.texto).toContain("A fazer");
  });

  it("nexo_tarefa_salvar cria uma tarefa de verdade, marcada 'agente'", async () => {
    const home = tempHome();
    const colunaId = getQuadro(P1, home).colunas[0]!.id;
    const [, salvar] = ferramentasDeTarefas(P1, home)();
    const r = await salvar!.executar({ titulo: "criada pelo modelo", colunaId });
    expect(r.ok).toBe(true);
    const tarefas = listarTarefas(P1, home);
    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]!.criadoPor).toBe("agente");
  });

  it("nexo_tarefa_salvar com colunaId inválido devolve erro pro modelo corrigir, não derruba o processo", async () => {
    const home = tempHome();
    const [, salvar] = ferramentasDeTarefas(P1, home)();
    const r = await salvar!.executar({ titulo: "x", colunaId: "fantasma" });
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/coluna não existe/);
  });
});

describe("tarefasRoot", () => {
  it("respeita tarefasDir de config — pasta portável entre máquinas", async () => {
    const home = tempHome();
    const pastaCompartilhada = join(tempHome(), "compartilhada");
    const { saveConfig } = await import("../src/config.ts");
    saveConfig(home, { tarefasDir: pastaCompartilhada });
    getQuadro(P1, home);
    expect(existsSync(pastaCompartilhada)).toBe(true);
  });
});
