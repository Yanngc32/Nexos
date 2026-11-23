import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalMemoriaPath, memoriaPath } from "../src/memoria.ts";
import { lerMemoria, lerSegredo, proporMemoria, statusMemorias } from "../src/memorias/index.ts";
import {
  cortarPorSecoes,
  lerRespostaDoModelo,
  migrarMemoriaLegada,
  MODELO_MIGRACAO_PADRAO,
  slugMemoria,
  TETO_MIGRACAO_MS,
  type RodarModelo,
} from "../src/memorias/migracao.ts";
import { tempHome } from "./helpers.ts";

const LEGADO = [
  "# Memória do projeto",
  "",
  "Projeto de exemplo, daemon em TypeScript.",
  "",
  "## Comandos",
  "- usar `rtk` antes de qualquer CLI",
  "<!-- commit: abc123 -->",
  "",
  "## Deploy",
  "Deploy sai pelo `build-installer.bat`, nunca direto.",
  "",
  "## Seção vazia",
  "",
].join("\n");

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

/** Home + um projeto conhecido com MEMORIA.md legado. */
function cenario(texto = LEGADO, nome = "Meu Projeto"): { home: string; projeto: string; legado: string; listarProjetos: () => { nome: string; projectPath: string }[] } {
  const home = tempHome();
  const projeto = join(tempHome(), nome);
  mkdirSync(projeto, { recursive: true });
  const legado = memoriaPath(projeto, home);
  writeFileSync(legado, texto, "utf8");
  return { home, projeto, legado, listarProjetos: () => [{ nome, projectPath: projeto }] };
}

const ativas = (home: string) => statusMemorias(home).ativas;

describe("migrarMemoriaLegada — corte por seções (sem modelo)", () => {
  it("um fato por ##, preâmbulo vira memoria-legada, seção vazia some, carimbo de commit sai, original vira .migrado", async () => {
    const { home, legado, listarProjetos } = cenario();
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.erros).toEqual([]);
    expect(r.migrados).toEqual([
      { origem: legado, criadas: ["meu-projeto/memoria-legada.md", "meu-projeto/comandos.md", "meu-projeto/deploy.md"] },
    ]);
    const comandos = lerMemoria(home, "meu-projeto/comandos.md")!;
    expect(comandos.titulo).toBe("Comandos");
    expect(comandos.origem).toBe("migracao");
    expect(comandos.tipo).toBe("conhecimento");
    expect(comandos.corpo).toContain("usar `rtk` antes de qualquer CLI");
    expect(comandos.corpo).not.toContain("commit: abc123");
    expect(lerMemoria(home, "meu-projeto/memoria-legada.md")!.titulo).toBe("Memória do projeto");
    expect(existsSync(legado)).toBe(false);
    expect(readFileSync(legado + ".migrado", "utf8")).toBe(LEGADO);
  });

  it("arquivo sem ## vira um fato só, memoria-legada.md", async () => {
    const { home, listarProjetos } = cenario("Só um parágrafo solto, sem título nenhum.\nSegunda linha.");
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados[0]!.criadas).toEqual(["meu-projeto/memoria-legada.md"]);
    const m = lerMemoria(home, "meu-projeto/memoria-legada.md")!;
    expect(m.gancho).toBe("Só um parágrafo solto, sem título nenhum.");
    expect(m.corpo).toContain("Segunda linha.");
  });

  it("chat geral vai para geral/", async () => {
    const home = tempHome();
    mkdirSync(join(home, "memoria-global"), { recursive: true });
    writeFileSync(globalMemoriaPath(home), "## Preferências\nResponder em pt-BR.\n", "utf8");
    const r = await migrarMemoriaLegada(home, { listarProjetos: () => [] });
    expect(r.migrados).toEqual([{ origem: globalMemoriaPath(home), criadas: ["geral/preferencias.md"] }]);
    expect(lerMemoria(home, "geral/preferencias.md")!.corpo).toContain("Responder em pt-BR.");
    expect(existsSync(globalMemoriaPath(home) + ".migrado")).toBe(true);
  });

  it("arquivo vazio (ou só carimbos) é pulado e fica onde está", async () => {
    const { home, legado, listarProjetos } = cenario("<!-- commit: x -->\n\n");
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados).toEqual([]);
    expect(r.pulados).toEqual([`${legado}: vazio`]);
    expect(existsSync(legado)).toBe(true);
  });
});

describe("migrarMemoriaLegada — idempotência e colisão", () => {
  it("rodar de novo não duplica nada: o .migrado marca como feito", async () => {
    const { home, legado, listarProjetos } = cenario();
    await migrarMemoriaLegada(home, { listarProjetos });
    const antes = ativas(home);
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados).toEqual([]);
    expect(r.erros).toEqual([]);
    expect(r.pulados).toEqual([`${legado}: já migrado`]);
    expect(ativas(home)).toBe(antes);
  });

  it("MEMORIA.md e .migrado juntos: não mexe em nada e avisa", async () => {
    const { home, legado, listarProjetos } = cenario();
    writeFileSync(legado + ".migrado", "versão antiga", "utf8");
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados).toEqual([]);
    expect(r.pulados[0]).toMatch(/já existe MEMORIA\.md\.migrado ao lado/);
    expect(ativas(home)).toBe(0);
    expect(readFileSync(legado, "utf8")).toBe(LEGADO);
    expect(readFileSync(legado + ".migrado", "utf8")).toBe("versão antiga");
  });

  it("caminho ocupado por outra memória: grava com -2, sem pisar na existente", async () => {
    const { home, listarProjetos } = cenario();
    const outra = proporMemoria(home, { op: "create", relPath: "meu-projeto/comandos.md", titulo: "Outra", gancho: "outra coisa", corpo: "não é a mesma", origem: "usuario" });
    expect(outra.ok).toBe(true);
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados[0]!.criadas).toContain("meu-projeto/comandos-2.md");
    expect(lerMemoria(home, "meu-projeto/comandos.md")!.corpo).toBe("não é a mesma");
    expect(lerMemoria(home, "meu-projeto/comandos-2.md")!.corpo).toContain("rtk");
  });

  it("rodada anterior que parou no meio: memória idêntica já gravada é reaproveitada, não vira -2", async () => {
    const { home, listarProjetos } = cenario();
    const [, comandos] = cortarPorSecoes(LEGADO, "meu-projeto");
    proporMemoria(home, { op: "create", relPath: "meu-projeto/comandos.md", titulo: comandos!.titulo, gancho: comandos!.gancho, corpo: comandos!.corpo, origem: "migracao" });
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados[0]!.criadas).toEqual(["meu-projeto/memoria-legada.md", "meu-projeto/comandos.md", "meu-projeto/deploy.md"]);
    expect(lerMemoria(home, "meu-projeto/comandos-2.md")).toBeUndefined();
  });

  it("mesmo arquivo achado por dois caminhos (projeto conhecido + varredura da pasta) migra uma vez", async () => {
    const { home, listarProjetos } = cenario();
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.migrados).toHaveLength(1);
    expect(r.pulados).toEqual([]);
  });
});

describe("migrarMemoriaLegada — segredos", () => {
  it("token no corpo vai pro cofre e o .md fica com o marcador", async () => {
    const token = "ghp_" + "A1b2C3d4".repeat(5);
    const { home, listarProjetos } = cenario(`## Acesso\nO token do GitHub é ${token} e serve pro CI.\n`);
    const r = await migrarMemoriaLegada(home, { listarProjetos });
    expect(r.erros).toEqual([]);
    const m = lerMemoria(home, "meu-projeto/acesso.md")!;
    expect(m.corpo).not.toContain(token);
    expect(m.corpo).toContain("{{secret:meu-projeto.acesso.1}}");
    expect(lerSegredo(home, "meu-projeto.acesso.1")).toBe(token);
    const noDisco = readFileSync(join(home, "memorias", "meu-projeto", "acesso.md"), "utf8");
    expect(noDisco).not.toContain(token);
  });
});

describe("migrarMemoriaLegada — modelo separa os fatos", () => {
  const RESPOSTA = [
    "=== FATO",
    "tipo: instrucao",
    "arquivo: usar-rtk",
    "titulo: Usar RTK na CLI",
    "gancho: antes de rodar qualquer comando de terminal",
    "corpo:",
    "Sempre usar `rtk` antes de qualquer CLI.",
    "Projeto de exemplo, daemon em TypeScript.",
    "=== FIM",
    "",
    "=== FATO",
    "tipo: infra",
    "arquivo: deploy.md",
    "titulo: Deploy",
    "gancho: quando for publicar uma versão",
    "corpo:",
    "Deploy sai pelo `build-installer.bat`, nunca direto.",
    "=== FIM",
  ].join("\n");

  it("usa os fatos do modelo, com modelo padrão haiku e teto de 90 s", async () => {
    const { home, listarProjetos } = cenario();
    const rodar = vi.fn<RodarModelo>(async () => RESPOSTA);
    const r = await migrarMemoriaLegada(home, { listarProjetos, rodar });
    expect(rodar).toHaveBeenCalledTimes(1);
    const [prompt, ctx] = rodar.mock.calls[0]!;
    expect(ctx).toEqual({ home, modelo: MODELO_MIGRACAO_PADRAO, tetoMs: TETO_MIGRACAO_MS });
    expect(MODELO_MIGRACAO_PADRAO).toBe("haiku");
    expect(prompt).toContain("Deploy sai pelo");
    expect(prompt).not.toContain("commit: abc123");
    expect(r.migrados[0]!.criadas).toEqual(["meu-projeto/usar-rtk.md", "meu-projeto/deploy.md"]);
    const rtk = lerMemoria(home, "meu-projeto/usar-rtk.md")!;
    expect(rtk.tipo).toBe("instrucao");
    expect(rtk.gancho).toBe("antes de rodar qualquer comando de terminal");
    expect(lerMemoria(home, "meu-projeto/deploy.md")!.tipo).toBe("infra");
  });

  it("repassa o modelo escolhido", async () => {
    const { home, listarProjetos } = cenario();
    const rodar = vi.fn<RodarModelo>(async () => RESPOSTA);
    await migrarMemoriaLegada(home, { listarProjetos, rodar, modelo: "sonnet" });
    expect(rodar.mock.calls[0]![1].modelo).toBe("sonnet");
  });

  it.each([
    ["modelo lança", async () => { throw new Error("sem cota"); }],
    ["texto solto", async () => "Aqui estão os fatos:\n" + RESPOSTA],
    ["tipo fora da lista", async () => RESPOSTA.replace("tipo: infra", "tipo: segredo")],
    ["bloco sem FIM", async () => RESPOSTA.replace(/=== FIM$/, "")],
    ["resumo que perde quase tudo", async () => "=== FATO\ntipo: conhecimento\narquivo: x\ntitulo: X\ngancho: g\ncorpo:\nok\n=== FIM"],
  ] as [string, RodarModelo][])("%s: cai no corte por seções", async (_nome, rodar) => {
    const { home, listarProjetos } = cenario();
    const r = await migrarMemoriaLegada(home, { listarProjetos, rodar });
    expect(r.erros).toEqual([]);
    expect(r.migrados[0]!.criadas).toEqual(["meu-projeto/memoria-legada.md", "meu-projeto/comandos.md", "meu-projeto/deploy.md"]);
  });
});

describe("migrarMemoriaLegada — nunca lança", () => {
  it("lista de projetos que explode vira erro, e o chat geral ainda migra", async () => {
    const home = tempHome();
    mkdirSync(join(home, "memoria-global"), { recursive: true });
    writeFileSync(globalMemoriaPath(home), "## Fato\nalgo durável\n", "utf8");
    const r = await migrarMemoriaLegada(home, {
      listarProjetos: () => {
        throw new Error("threads ilegíveis");
      },
    });
    expect(r.erros).toEqual(["lista de projetos: threads ilegíveis"]);
    expect(r.migrados).toHaveLength(1);
  });

  it("home sem nada: resultado vazio", async () => {
    const r = await migrarMemoriaLegada(tempHome(), {});
    expect(r).toEqual({ migrados: [], pulados: [], erros: [] });
  });

  it("deps undefined não quebra", async () => {
    await expect(migrarMemoriaLegada(tempHome(), undefined as never)).resolves.toEqual({ migrados: [], pulados: [], erros: [] });
  });
});

describe("helpers", () => {
  it("slugMemoria: sem acento, kebab-case, nome reservado do Windows ganha sufixo", () => {
    expect(slugMemoria("Decisões de Arquitetura!")).toBe("decisoes-de-arquitetura");
    expect(slugMemoria("CON")).toBe("con-fato");
    expect(slugMemoria("***")).toBe("fato");
    expect(slugMemoria("a".repeat(100)).length).toBe(60);
  });

  it("lerRespostaDoModelo aceita cerca de código em volta, recusa campo vazio", () => {
    const bloco = "=== FATO\ntipo: decisao\narquivo: x\ntitulo: X\ngancho: g\ncorpo:\ntexto bem comprido do fato\n=== FIM";
    expect(lerRespostaDoModelo("```\n" + bloco + "\n```", "texto bem comprido do fato")).toHaveLength(1);
    expect(lerRespostaDoModelo(bloco.replace("gancho: g", "gancho:"), "texto")).toBeUndefined();
    expect(lerRespostaDoModelo("", "texto")).toBeUndefined();
  });
});
