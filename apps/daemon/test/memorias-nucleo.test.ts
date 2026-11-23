import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import {
  corpoParaPrompt,
  escritaDiretaNegada,
  indiceMemorias,
  lerMemoria,
  lerSegredo,
  listarMemorias,
  memoriasDir,
  proporMemoria,
  rankearMemorias,
  reconciliarMemorias,
  selecionarLexicamente,
  statusMemorias,
  validarCaminhoMemoria,
  versaoCatalogo,
  type Memoria,
} from "../src/memorias/index.ts";

const AVISO = "<!-- Índice gerado pelo Nexos a partir das memórias. Edite as memórias, não este arquivo. -->";

function criar(home: string, relPath: string, extra: Partial<{ titulo: string; gancho: string; tipo: string; corpo: string }> = {}) {
  const r = proporMemoria(home, {
    op: "create",
    relPath,
    titulo: extra.titulo ?? "Título " + relPath,
    gancho: extra.gancho ?? "quando usar " + relPath,
    tipo: extra.tipo,
    corpo: extra.corpo ?? "Corpo de " + relPath,
    origem: "agente",
  });
  if (!r.ok) throw new Error(r.motivo);
  return r.memoria;
}

const lerIndice = (home: string) => readFileSync(join(memoriasDir(home), "MEMORY.md"), "utf8");

describe("memorias: caminho", () => {
  it("memoriasDir fica em <home>/memorias", () => {
    const home = tempHome();
    expect(memoriasDir(home)).toBe(join(home, "memorias"));
  });

  it("aceita kebab-case .md na raiz e num nível de pasta", () => {
    expect(validarCaminhoMemoria("preferencias-de-codigo.md")).toBeUndefined();
    expect(validarCaminhoMemoria("infra/servidor-casa.md")).toBeUndefined();
  });

  it.each([
    ["", "vazio"],
    ["MEMORY.md", "índice"],
    ["memory.md", "índice em minúsculas"],
    ["../fora.md", ".."],
    ["infra/../fora.md", ".. no meio"],
    ["/abs/nota.md", "absoluto"],
    ["C:/abs/nota.md", "letra de unidade"],
    [".oculta.md", "oculto"],
    [".hidden/nota.md", "pasta oculta"],
    [".retired/nota.md", "aposentadas"],
    ["con.md", "reservado"],
    ["infra/nul.md", "reservado na pasta"],
    ["com1.md", "reservado com número"],
    ["a/b/c.md", "dois níveis"],
    ["Nota.md", "maiúscula"],
    ["nota_x.md", "underscore"],
    ["nota.txt", "extensão"],
  ])("recusa %s (%s)", (rel) => {
    expect(validarCaminhoMemoria(rel)).toEqual(expect.any(String));
  });

  it("escritaDiretaNegada recusa a pasta e o que está dentro, libera fora", () => {
    const home = tempHome();
    const dir = memoriasDir(home);
    expect(escritaDiretaNegada(home, join(dir, "nota.md"))).toEqual(expect.any(String));
    expect(escritaDiretaNegada(home, join(dir, "infra", "x.md"))).toEqual(expect.any(String));
    expect(escritaDiretaNegada(home, join(dir, "MEMORY.md"))).toEqual(expect.any(String));
    expect(escritaDiretaNegada(home, dir)).toEqual(expect.any(String));
    expect(escritaDiretaNegada(home, join(home, "outra", "nota.md"))).toBeUndefined();
    expect(escritaDiretaNegada(home, join(home, "memorias-x", "nota.md"))).toBeUndefined();
  });
});

describe("memorias: proporMemoria", () => {
  it("create grava o arquivo no formato, revisão 1 e regenera o MEMORY.md", () => {
    const home = tempHome();
    const r = proporMemoria(home, {
      op: "create",
      relPath: "infra/servidor-casa.md",
      titulo: "Servidor de casa",
      gancho: "acesso ao servidor da casa",
      tipo: "infra",
      corpo: "O servidor responde em 192.168.0.10.",
      origem: "agente",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.memoria).toMatchObject({
      relPath: "infra/servidor-casa.md",
      pasta: "infra",
      titulo: "Servidor de casa",
      gancho: "acesso ao servidor da casa",
      tipo: "infra",
      revisao: 1,
      status: "ativa",
      origem: "agente",
    });
    expect(r.segredosGuardados).toEqual([]);
    const arq = readFileSync(join(memoriasDir(home), "infra", "servidor-casa.md"), "utf8");
    expect(arq.startsWith("---\nname: servidor-casa\ndescription: acesso ao servidor da casa\nmetadata:\n  type: infra\n---\n# Servidor de casa\n")).toBe(true);
    expect(arq).toContain("O servidor responde em 192.168.0.10.");
    const indice = lerIndice(home);
    expect(indice.split("\n")[0]).toBe(AVISO);
    expect(indice).toContain("## infra\n\n- [Servidor de casa](infra/servidor-casa.md) — acesso ao servidor da casa");
  });

  it("tipo padrão é conhecimento; tipo inválido é recusado", () => {
    const home = tempHome();
    expect(criar(home, "nota.md").tipo).toBe("conhecimento");
    const r = proporMemoria(home, { op: "create", relPath: "outra.md", gancho: "g", corpo: "c", tipo: "inventado", origem: "agente" });
    expect(r.ok).toBe(false);
  });

  it("create lê titulo/gancho/tipo do frontmatter do corpo", () => {
    const home = tempHome();
    const r = proporMemoria(home, {
      op: "create",
      relPath: "estilo.md",
      corpo: "---\nname: estilo\ndescription: estilo de código preferido\nmetadata:\n  type: preferencia\n---\n# Estilo de código\nAspas duplas e ponto e vírgula.",
      origem: "usuario",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.memoria.titulo).toBe("Estilo de código");
    expect(r.memoria.gancho).toBe("estilo de código preferido");
    expect(r.memoria.tipo).toBe("preferencia");
    expect(r.memoria.corpo).toBe("Aspas duplas e ponto e vírgula.");
    expect(r.memoria.corpo).not.toContain("---");
  });

  it("create sem gancho ou sem corpo é recusado", () => {
    const home = tempHome();
    expect(proporMemoria(home, { op: "create", relPath: "a.md", corpo: "c", origem: "agente" }).ok).toBe(false);
    expect(proporMemoria(home, { op: "create", relPath: "a.md", gancho: "g", corpo: "  ", origem: "agente" }).ok).toBe(false);
  });

  it("create em caminho existente (ativo ou aposentado) é recusado", () => {
    const home = tempHome();
    const m = criar(home, "nota.md");
    const dup = proporMemoria(home, { op: "create", relPath: "nota.md", gancho: "g", corpo: "c", origem: "agente" });
    expect(dup.ok).toBe(false);
    const ret = proporMemoria(home, { op: "retire", relPath: "nota.md", revisaoEsperada: m.revisao, origem: "agente" });
    expect(ret.ok).toBe(true);
    const deNovo = proporMemoria(home, { op: "create", relPath: "nota.md", gancho: "g", corpo: "c", origem: "agente" });
    expect(deNovo.ok).toBe(false);
  });

  it.each(["MEMORY.md", "../fora.md", "/abs.md", ".oculta.md", ".retired/x.md", "con.md"])("proposta em %s é recusada sem escrever", (rel) => {
    const home = tempHome();
    const r = proporMemoria(home, { op: "create", relPath: rel, gancho: "g", corpo: "c", origem: "agente" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(home, "fora.md"))).toBe(false);
  });

  it("origem inválida é recusada", () => {
    const home = tempHome();
    const r = proporMemoria(home, { op: "create", relPath: "a.md", gancho: "g", corpo: "c", origem: "hacker" as never });
    expect(r.ok).toBe(false);
  });

  it("update com revisão certa sobe a revisão e mantém o que não veio", () => {
    const home = tempHome();
    const m = criar(home, "nota.md", { titulo: "Nota", gancho: "gancho original", tipo: "decisao" });
    const r = proporMemoria(home, { op: "update", relPath: "nota.md", corpo: "Corpo novo.", revisaoEsperada: 1, origem: "curador" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.memoria).toMatchObject({ revisao: 2, titulo: "Nota", gancho: "gancho original", tipo: "decisao", corpo: "Corpo novo.", origem: "curador" });
    expect(r.memoria.criadaEm).toBe(m.criadaEm);
    expect(lerIndice(home)).toContain("- [Nota](nota.md) — gancho original");
  });

  it("update com revisão errada devolve {ok:false, revisaoAtual} e não escreve", () => {
    const home = tempHome();
    criar(home, "nota.md", { corpo: "original" });
    const r = proporMemoria(home, { op: "update", relPath: "nota.md", corpo: "x", revisaoEsperada: 7, origem: "agente" });
    expect(r).toMatchObject({ ok: false, revisaoAtual: 1 });
    expect(lerMemoria(home, "nota.md")?.corpo).toBe("original");
  });

  it("update e retire exigem revisaoEsperada", () => {
    const home = tempHome();
    criar(home, "nota.md");
    expect(proporMemoria(home, { op: "update", relPath: "nota.md", corpo: "x", origem: "agente" })).toMatchObject({ ok: false, revisaoAtual: 1 });
    expect(proporMemoria(home, { op: "retire", relPath: "nota.md", origem: "agente" })).toMatchObject({ ok: false, revisaoAtual: 1 });
  });

  it("update em memória inexistente é recusado", () => {
    const home = tempHome();
    expect(proporMemoria(home, { op: "update", relPath: "nada.md", corpo: "x", revisaoEsperada: 1, origem: "agente" }).ok).toBe(false);
  });

  it("retire move para .retired/<relPath> e tira do índice", () => {
    const home = tempHome();
    criar(home, "infra/vps.md", { titulo: "VPS" });
    criar(home, "fica.md", { titulo: "Fica" });
    const r = proporMemoria(home, { op: "retire", relPath: "infra/vps.md", revisaoEsperada: 1, origem: "agente" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.memoria).toMatchObject({ status: "aposentada", revisao: 2 });
    const dir = memoriasDir(home);
    expect(existsSync(join(dir, "infra", "vps.md"))).toBe(false);
    expect(existsSync(join(dir, ".retired", "infra", "vps.md"))).toBe(true);
    const indice = lerIndice(home);
    expect(indice).not.toContain("infra/vps.md");
    expect(indice).not.toContain("## infra");
    expect(indice).toContain("- [Fica](fica.md)");
    expect(listarMemorias(home).map((m) => m.relPath)).toEqual(["fica.md"]);
    expect(listarMemorias(home, { incluirAposentadas: true }).map((m) => m.relPath)).toEqual(["fica.md", "infra/vps.md"]);
    expect(lerMemoria(home, "infra/vps.md")?.corpo).toContain("Corpo de infra/vps.md");
  });

  it("MEMORY.md: raiz primeiro, depois uma seção por pasta, tudo por relPath", () => {
    const home = tempHome();
    criar(home, "zeta.md", { titulo: "Zeta", gancho: "gz" });
    criar(home, "infra/b.md", { titulo: "B", gancho: "gb" });
    criar(home, "alfa.md", { titulo: "Alfa", gancho: "ga" });
    criar(home, "codigo/a.md", { titulo: "A", gancho: "gca" });
    criar(home, "infra/a.md", { titulo: "IA", gancho: "gia" });
    expect(lerIndice(home)).toBe(
      [
        AVISO,
        "",
        "- [Alfa](alfa.md) — ga",
        "- [Zeta](zeta.md) — gz",
        "",
        "## codigo",
        "",
        "- [A](codigo/a.md) — gca",
        "",
        "## infra",
        "",
        "- [IA](infra/a.md) — gia",
        "- [B](infra/b.md) — gb",
        "",
      ].join("\n"),
    );
    expect(indiceMemorias(home)).toBe(lerIndice(home));
  });

  it("título de seção escrito à mão no MEMORY.md é preservado", () => {
    const home = tempHome();
    criar(home, "infra/a.md", { titulo: "A", gancho: "ga" });
    const arq = join(memoriasDir(home), "MEMORY.md");
    writeFileSync(arq, readFileSync(arq, "utf8").replace("## infra", "## Infra do servidor"));
    criar(home, "infra/b.md", { titulo: "B", gancho: "gb" });
    const indice = lerIndice(home);
    expect(indice).toContain("## Infra do servidor\n\n- [A](infra/a.md) — ga\n- [B](infra/b.md) — gb");
    expect(indice).not.toContain("## infra");
    const diario = JSON.parse(readFileSync(join(memoriasDir(home), ".memorias.json"), "utf8"));
    expect(diario.secoes).toEqual({ infra: "Infra do servidor" });
  });

  it("MEMORY.md apagado ou mexido é regenerado na próxima escrita", () => {
    const home = tempHome();
    criar(home, "a.md", { titulo: "A", gancho: "ga" });
    rmSync(join(memoriasDir(home), "MEMORY.md"));
    criar(home, "b.md", { titulo: "B", gancho: "gb" });
    expect(lerIndice(home)).toContain("- [A](a.md) — ga\n- [B](b.md) — gb");
  });

  it("versaoCatalogo muda quando o índice muda", () => {
    const home = tempHome();
    criar(home, "a.md");
    const v1 = versaoCatalogo(home);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(versaoCatalogo(home)).toBe(v1);
    criar(home, "b.md");
    expect(versaoCatalogo(home)).not.toBe(v1);
  });

  it("statusMemorias conta ativas, aposentadas e segredos", () => {
    const home = tempHome();
    criar(home, "a.md");
    criar(home, "b.md");
    proporMemoria(home, { op: "retire", relPath: "b.md", revisaoEsperada: 1, origem: "agente" });
    proporMemoria(home, { op: "create", relPath: "c.md", gancho: "g", corpo: "chave {{secret:x}}", segredos: [{ nome: "api.c", valor: "valor-secreto-123" }], origem: "agente" });
    expect(statusMemorias(home)).toEqual({ dir: memoriasDir(home), total: 3, ativas: 2, aposentadas: 1, segredos: 1 });
  });
});

describe("memorias: reconciliação", () => {
  it("importa .md novo criado por fora (revisão 1, origem externo)", () => {
    const home = tempHome();
    const dir = memoriasDir(home);
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra", "nova.md"), "---\nname: nova\ndescription: gancho externo\nmetadata:\n  type: infra\n---\n# Nova externa\nCorpo externo.\n");
    writeFileSync(join(dir, "Invalido.md"), "ignorada");
    writeFileSync(join(dir, "MEMORY.md"), "qualquer coisa");
    const r = reconciliarMemorias(home);
    expect(r).toEqual({ importadas: ["infra/nova.md"], adotadas: [], aposentadas: [] });
    const m = lerMemoria(home, "infra/nova.md");
    expect(m).toMatchObject({ titulo: "Nova externa", gancho: "gancho externo", tipo: "infra", corpo: "Corpo externo.", revisao: 1, origem: "externo", status: "ativa" });
    expect(lerIndice(home)).toContain("- [Nova externa](infra/nova.md) — gancho externo");
    expect(reconciliarMemorias(home)).toEqual({ importadas: [], adotadas: [], aposentadas: [] });
  });

  it("adota a edição externa: revisão+1, origem externo, campos relidos", () => {
    const home = tempHome();
    criar(home, "nota.md", { titulo: "Antes", gancho: "g antes" });
    const arq = join(memoriasDir(home), "nota.md");
    writeFileSync(arq, readFileSync(arq, "utf8").replace("# Antes", "# Depois").replace("description: g antes", "description: g depois"));
    expect(reconciliarMemorias(home)).toEqual({ importadas: [], adotadas: ["nota.md"], aposentadas: [] });
    const m = lerMemoria(home, "nota.md");
    expect(m).toMatchObject({ titulo: "Depois", gancho: "g depois", revisao: 2, origem: "externo" });
    expect(lerIndice(home)).toContain("- [Depois](nota.md) — g depois");
  });

  it("edição externa não vira conflito: a proposta usa a revisão adotada", () => {
    const home = tempHome();
    criar(home, "nota.md");
    const arq = join(memoriasDir(home), "nota.md");
    writeFileSync(arq, readFileSync(arq, "utf8") + "\nlinha a mais\n");
    const velha = proporMemoria(home, { op: "update", relPath: "nota.md", corpo: "x", revisaoEsperada: 1, origem: "agente" });
    expect(velha).toMatchObject({ ok: false, revisaoAtual: 2 });
    const nova = proporMemoria(home, { op: "update", relPath: "nota.md", corpo: "x", revisaoEsperada: 2, origem: "agente" });
    expect(nova.ok).toBe(true);
  });

  it("memória cujo arquivo sumiu vira aposentada", () => {
    const home = tempHome();
    criar(home, "some.md", { titulo: "Some" });
    rmSync(join(memoriasDir(home), "some.md"));
    expect(reconciliarMemorias(home)).toEqual({ importadas: [], adotadas: [], aposentadas: ["some.md"] });
    expect(lerMemoria(home, "some.md")).toMatchObject({ status: "aposentada", revisao: 2 });
    expect(lerIndice(home)).not.toContain("some.md");
  });

  it("arquivo que volta depois de sumir é adotado de novo", () => {
    const home = tempHome();
    criar(home, "volta.md");
    const arq = join(memoriasDir(home), "volta.md");
    const texto = readFileSync(arq, "utf8");
    rmSync(arq);
    reconciliarMemorias(home);
    writeFileSync(arq, texto);
    expect(reconciliarMemorias(home).adotadas).toEqual(["volta.md"]);
    expect(lerMemoria(home, "volta.md")).toMatchObject({ status: "ativa", revisao: 3 });
  });

  it("diário corrompido não derruba: reimporta do disco", () => {
    const home = tempHome();
    criar(home, "a.md");
    writeFileSync(join(memoriasDir(home), ".memorias.json"), "{ quebrado");
    expect(reconciliarMemorias(home).importadas).toEqual(["a.md"]);
    expect(listarMemorias(home)).toHaveLength(1);
  });
});

describe("memorias: segredos na proposta", () => {
  it("segredo explícito vai ao cofre e vira {{secret:nome}}", () => {
    const home = tempHome();
    const r = proporMemoria(home, {
      op: "create",
      relPath: "infra/banco.md",
      gancho: "acesso ao banco",
      corpo: "A senha do banco é hunter2-muito-longa.",
      segredos: [{ nome: "banco.senha", valor: "hunter2-muito-longa" }],
      origem: "agente",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segredosGuardados).toEqual(["banco.senha"]);
    expect(r.memoria.corpo).toBe("A senha do banco é {{secret:banco.senha}}.");
    const arq = readFileSync(join(memoriasDir(home), "infra", "banco.md"), "utf8");
    expect(arq).not.toContain("hunter2-muito-longa");
    expect(lerSegredo(home, "banco.senha")).toBe("hunter2-muito-longa");
  });

  it("sem segredos explícitos, valor com cara de token é redigido", () => {
    const home = tempHome();
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    const r = proporMemoria(home, { op: "create", relPath: "github.md", gancho: "token do github", corpo: `Use o token ${token} no CI.`, origem: "agente" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segredosGuardados).toEqual(["github.1"]);
    expect(r.memoria.corpo).toBe("Use o token {{secret:github.1}} no CI.");
    expect(readFileSync(join(memoriasDir(home), "github.md"), "utf8")).not.toContain(token);
    expect(lerSegredo(home, "github.1")).toBe(token);
    expect(lerIndice(home)).not.toContain(token);
  });

  it("nome derivado não pisa em segredo já guardado", () => {
    const home = tempHome();
    const t1 = "sk-" + "a".repeat(30);
    const t2 = "sk-" + "b".repeat(30);
    const r1 = proporMemoria(home, { op: "create", relPath: "chaves.md", gancho: "g", corpo: `chave ${t1}`, origem: "agente" });
    expect(r1.ok && r1.segredosGuardados).toEqual(["chaves.1"]);
    const r2 = proporMemoria(home, { op: "update", relPath: "chaves.md", corpo: `chave {{secret:chaves.1}} e ${t2}`, revisaoEsperada: 1, origem: "agente" });
    expect(r2.ok && r2.segredosGuardados).toEqual(["chaves.2"]);
    expect(lerSegredo(home, "chaves.1")).toBe(t1);
    expect(lerSegredo(home, "chaves.2")).toBe(t2);
  });

  it("segredo explícito com nome inválido ou sem valor é recusado sem escrever", () => {
    const home = tempHome();
    const r1 = proporMemoria(home, { op: "create", relPath: "a.md", gancho: "g", corpo: "x", segredos: [{ nome: "../ruim", valor: "v" }], origem: "agente" });
    const r2 = proporMemoria(home, { op: "create", relPath: "a.md", gancho: "g", corpo: "x", segredos: [{ nome: "bom", valor: "" }], origem: "agente" });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(existsSync(join(memoriasDir(home), "a.md"))).toBe(false);
  });

  it("cofre inválido aborta a proposta e o texto puro não vai ao disco", () => {
    const home = tempHome();
    mkdirSync(join(home, "cofre"), { recursive: true });
    writeFileSync(join(home, "cofre", "segredos.json"), "lixo");
    const token = "ghp_" + "Z".repeat(30);
    const r = proporMemoria(home, { op: "create", relPath: "a.md", gancho: "g", corpo: `token ${token}`, origem: "agente" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(memoriasDir(home), "a.md"))).toBe(false);
  });

  it("corpoParaPrompt preserva placeholders e mascara o que escapou", () => {
    const base: Memoria = {
      relPath: "a.md", pasta: "", titulo: "A", gancho: "g", tipo: "conhecimento",
      corpo: "senha {{secret:a.1}} e token ghp_" + "Q".repeat(30) + " fim",
      revisao: 1, status: "ativa", origem: "externo", criadaEm: "", atualizadaEm: "",
    };
    const saida = corpoParaPrompt(base);
    expect(saida).toContain("{{secret:a.1}}");
    expect(saida).not.toContain("ghp_");
    expect(saida).toContain(" fim");
  });
});

describe("memorias: busca lexical", () => {
  const mem = (relPath: string, titulo: string, gancho: string, corpo: string): Memoria => ({
    relPath, pasta: relPath.includes("/") ? relPath.split("/")[0]! : "", titulo, gancho, tipo: "conhecimento", corpo,
    revisao: 1, status: "ativa", origem: "agente", criadaEm: "", atualizadaEm: "",
  });
  const lista = [
    mem("infra/servidor.md", "Servidor de casa", "acesso ssh", "porta 22"),
    mem("codigo/estilo.md", "Estilo", "aspas duplas", "fala sobre servidor de passagem"),
    mem("receitas.md", "Bolo", "receita de bolo", "farinha"),
  ];

  it("rankearMemorias ordena por pontuação e descarta quem não pontua", () => {
    expect(rankearMemorias(lista, "servidor").map((m) => m.relPath)).toEqual(["infra/servidor.md", "codigo/estilo.md"]);
    expect(rankearMemorias(lista, "de para")).toEqual([]);
  });

  it("selecionarLexicamente exige pontuação mínima e respeita o limite", () => {
    expect(selecionarLexicamente(lista, "servidor").map((m) => m.relPath)).toEqual(["infra/servidor.md"]);
    expect(selecionarLexicamente(lista, "servidor bolo", 1)).toHaveLength(1);
  });

  it("listarMemorias com consulta e limite", () => {
    const home = tempHome();
    criar(home, "infra/servidor.md", { titulo: "Servidor", gancho: "acesso ssh" });
    criar(home, "bolo.md", { titulo: "Bolo", gancho: "receita" });
    expect(listarMemorias(home, { consulta: "servidor" }).map((m) => m.relPath)).toEqual(["infra/servidor.md"]);
    expect(listarMemorias(home, { limite: 1 })).toHaveLength(1);
  });
});
