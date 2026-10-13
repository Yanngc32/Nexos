import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@nexos/shared";
import { esquecerCatalogo, type Capacidade } from "../src/cerebro-catalogo.ts";
import { esquecerDisparosForTest, medirBlocoDoCerebro, testarGatilhos } from "../src/cerebro-gatilhos.ts";
import { detalheDeUso, disparosComTitulo, gatilhosSugeridos, montarSugestoes, sugestoesDoCerebro } from "../src/cerebro-sugestoes.ts";
import { esquecerUsoDoCerebro, ligarContadorDoCerebro, palavrasDaMensagem, palavrasSemGatilho, registrarDisparo, varrerConversas } from "../src/cerebro-uso.ts";
import { globalSkillsDir } from "../src/home.ts";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, createThread, renomearThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  esquecerCatalogo();
  esquecerUsoDoCerebro();
  esquecerDisparosForTest();
});

function cap(id: string, extra: Partial<Capacidade> = {}): Capacidade {
  const [tipo, nome] = id.split(":") as [Capacidade["tipo"], string];
  return { id, tipo, nome, descricao: `d ${nome}`, gatilhos: [], comoUsar: `use ${nome}`, escopo: "global", origem: "auto", ligada: true, usos7d: 0, usos30d: 0, disparos30d: 0, usosAposDisparo30d: 0, ...extra };
}

describe("palavras e sugestões", () => {
  it("palavrasDaMensagem: minúsculas, 4+ letras, sem palavras vazias nem repetição", () => {
    expect(palavrasDaMensagem("Arruma o LAYOUT do login, o layout tá quebrado pra caramba e depois 2026")).toEqual(["arruma", "layout", "login", "quebrado", "caramba"]);
  });

  it("gatilhosSugeridos: só 3+ mensagens, nada que já é gatilho ou parte do nome", () => {
    const c = cap("skill:make-interfaces-feel-better", { gatilhos: ["Tela"] });
    expect(gatilhosSugeridos(c, { layout: 8, css: 5, tela: 9, make: 4, botao: 2 })).toEqual([
      { termo: "layout", vezes: 8 },
      { termo: "css", vezes: 5 },
    ]);
    expect(gatilhosSugeridos(c, undefined)).toEqual([]);
  });

  it("montarSugestoes: ignorado, sem gatilho, gatilho candidato e medida do bloco", () => {
    const itens = [
      cap("agente:explorador", { gatilhos: ["onde fica"], disparos30d: 7 }),
      cap("skill:caveman", { disparos30d: 9, usosAposDisparo30d: 3 }),
      ...Array.from({ length: 6 }, (_, i) => cap(`ferramenta:morta_${i}`)),
      cap("ferramenta:viva", { usos30d: 3, ultimoUso: "x" }),
      cap("skill:ui", { gatilhos: ["tela"] }),
    ];
    const s = montarSugestoes(itens, { "skill:ui": { layout: 4, css: 3 } }, { texto: "x", caracteres: 1380, max: 1500, dentro: [], fora: ["skill:a", "skill:b"] });
    expect(s.map((x) => x.tipo)).toEqual(["ignorado", "sem-gatilho", "gatilho", "bloco"]);
    expect(s[0]).toMatchObject({ id: "agente:explorador", nivel: "atencao" });
    expect(s[1]!.ids).toHaveLength(6);
    expect(s[2]).toMatchObject({ id: "skill:ui", gatilhos: ["layout", "css"] });
    expect(s[3]!.texto).toContain("2 capacidade(s)");
    expect(montarSugestoes([cap("ferramenta:a")], {}, null)).toEqual([]);
  });
});

describe("testar gatilhos e medir o bloco", () => {
  const itens = [
    cap("skill:ui", { gatilhos: ["tela", "ui"] }),
    cap("agente:explorador", { gatilhos: ["onde fica"] }),
    cap("ferramenta:nexo_mock_salvar", { gatilhos: ["mock"] }),
    cap("ferramenta:nexo_perguntar", { gatilhos: ["decisão"] }),
  ];
  it("devolve todos os candidatos com peso e termos; só 3 entram; linha = prefixo exato", () => {
    const r = testarGatilhos("faz um mock da tela e onde fica o form? preciso de uma decisão", itens, { tipo: "chat" });
    expect(r.candidatos).toHaveLength(4);
    expect(r.candidatos.filter((c) => c.entra)).toHaveLength(3);
    expect(r.candidatos.find((c) => !c.entra)!.id).toBe("ferramenta:nexo_mock_salvar");
    expect(r.candidatos.find((c) => c.id === "skill:ui")!.bateram).toEqual(["tela"]);
    expect(r.linha.startsWith("[Cérebro] ")).toBe(true);
    expect(r.linha).not.toContain("nexo_mock_salvar");
    expect(testarGatilhos("nada a ver", itens, { tipo: "chat" })).toEqual({ candidatos: [], linha: "" });
  });

  it("medirBlocoDoCerebro diz o que ficou dentro e fora do teto", () => {
    const muitos = Array.from({ length: 40 }, (_, i) => cap(`skill:s${i}`, { gatilhos: [`g${i}`, "x".repeat(50)] }));
    const m = medirBlocoDoCerebro(muitos, { tipo: "chat" });
    expect(m.caracteres).toBeLessThanOrEqual(m.max);
    expect(m.dentro.length).toBeGreaterThan(0);
    expect(m.fora.length).toBeGreaterThan(0);
    expect(m.dentro.length + m.fora.length).toBe(40);
  });
});

describe("com motor de verdade (contador + catálogo)", () => {
  it("uso sem gatilho anota as palavras da mensagem; detalhe e linha do tempo trazem título", async () => {
    const home = tempHome();
    addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
    const projeto = join(home, "proj");
    mkdirSync(projeto, { recursive: true });
    const skill = join(globalSkillsDir(home), "make-interfaces-feel-better");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: make-interfaces-feel-better\ndescription: Acabamento.\n---\n", "utf8");
    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    renomearThread(chat.id, "Ajustes do login", "manual", home);
    const desligar = ligarContadorDoCerebro();
    try {
      for (let i = 0; i < 3; i++) {
        appendEvent({ ts: new Date().toISOString(), type: "user", threadId: chat.id, text: `arruma o layout do cadastro ${i}` } as ThreadEvent, home);
        appendEvent({ ts: new Date().toISOString(), type: "tool", threadId: chat.id, name: "Skill", summary: "s", input: { skill: "make-interfaces-feel-better" } } as ThreadEvent, home);
        // 2ª chamada no mesmo turno não conta as palavras de novo
        appendEvent({ ts: new Date().toISOString(), type: "tool", threadId: chat.id, name: "Skill", summary: "s", input: { skill: "make-interfaces-feel-better" } } as ThreadEvent, home);
      }
      expect(palavrasSemGatilho(home)["skill:make-interfaces-feel-better"]).toMatchObject({ arruma: 3, layout: 3, cadastro: 3 });
      registrarDisparo(chat.id, { tipo: "skill", nome: "make-interfaces-feel-better" }, home);
      appendEvent({ ts: new Date().toISOString(), type: "tool", threadId: chat.id, name: "Skill", summary: "s", input: { skill: "make-interfaces-feel-better" } } as ThreadEvent, home);
    } finally {
      desligar();
    }
    await varrerConversas(home);

    const d = detalheDeUso("skill:make-interfaces-feel-better", projeto, home)!;
    expect(d.porConversa.chat).toBe(7);
    expect(d.porDia.at(-1)).toBe(7);
    expect(d.disparosPorDia.at(-1)).toBe(1);
    expect(d.ultimos[0]).toMatchObject({ threadId: chat.id, titulo: "Ajustes do login", tipo: "chat" });
    // "layout" já é gatilho curado da skill: não volta como sugestão
    expect(d.gatilhosSugeridos.map((g) => g.termo)).toEqual(["arruma", "cadastro"]);
    expect(detalheDeUso("skill:nada", projeto, home)).toBeNull();

    const linha = disparosComTitulo(home, { projectPath: projeto });
    expect(linha[0]).toMatchObject({ chave: "skill:make-interfaces-feel-better", usou: true, titulo: "Ajustes do login" });

    const sug = sugestoesDoCerebro(projeto, home);
    expect(sug.find((x) => x.tipo === "gatilho")).toMatchObject({ id: "skill:make-interfaces-feel-better" });
    expect(sug.find((x) => x.tipo === "bloco")).toBeDefined();
  });
});
