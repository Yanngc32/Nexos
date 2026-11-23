import { describe, it, expect, vi } from "vitest";
import { tempHome } from "./helpers.ts";
import { listarMemorias, proporMemoria } from "../src/memorias/nucleo.ts";
import {
  escolherMemoriasDoTurno,
  interpretarSelecao,
  ledgerDaConversa,
  MAX_CHARS_LEXICO,
  montarPerguntaSelecao,
  primeiroObjetoJson,
  SISTEMA_SELECAO,
  zerarLedgerMemorias,
} from "../src/memorias/selecao.ts";
import type { RodarModelo } from "../src/memorias/motor.ts";

function criar(home: string, relPath: string, titulo: string, gancho: string, corpo: string) {
  const r = proporMemoria(home, { op: "create", relPath, titulo, gancho, corpo, origem: "agente" });
  if (!r.ok) throw new Error(`não criou ${relPath}: ${r.motivo}`);
  return r.memoria;
}

/** Acervo pequeno: deploy, testes e café (o café nunca combina com nada técnico). */
function acervo(): string {
  const home = tempHome();
  criar(home, "deploy.md", "Deploy do servidor", "quando for publicar ou fazer deploy", "Deploy sempre via script deploy.sh, nunca scp.");
  criar(home, "testes.md", "Rodar testes", "quando for rodar testes do daemon", "Use npx vitest run com o arquivo do teste.");
  criar(home, "pessoal/cafe.md", "Café favorito", "preferência pessoal de bebida", "Expresso duplo, sem açúcar.");
  return home;
}

let seq = 0;
const novaConversa = () => `t-sel-${Date.now()}-${seq++}`;

describe("interpretarSelecao / primeiroObjetoJson", () => {
  it("pega o primeiro objeto balanceado mesmo com texto e chaves dentro de string", () => {
    expect(primeiroObjetoJson('blá {"a":"x}y","b":{"c":1}} fim {"z":2}')).toBe('{"a":"x}y","b":{"c":1}}');
    expect(primeiroObjetoJson("sem objeto")).toBeUndefined();
    expect(primeiroObjetoJson('{"aberto": ')).toBeUndefined();
  });

  it("lista vazia é escolha válida; formato errado vira null", () => {
    expect(interpretarSelecao('{"memorias":[]}')).toEqual([]);
    expect(interpretarSelecao('Claro! {"memorias":[" a.md ", 3, "", "b/c.md"]}')).toEqual(["a.md", "b/c.md"]);
    expect(interpretarSelecao('{"outra":["a.md"]}')).toBeNull();
    expect(interpretarSelecao("não sei")).toBeNull();
    expect(interpretarSelecao('{"memorias": [quebrado}')).toBeNull();
  });

  it("pergunta leva mensagem, resumo e uma linha por candidata", () => {
    const candidatas = listarMemorias(acervo());
    const p = montarPerguntaSelecao("como faço deploy?", candidatas, "o agente falou de testes");
    expect(p).toContain("como faço deploy?");
    expect(p).toContain("o agente falou de testes");
    expect(p).toContain("- deploy.md: Deploy do servidor — quando for publicar ou fazer deploy");
    expect(p.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });
});

describe("escolherMemoriasDoTurno", () => {
  it("sem mensagem ou sem memória devolve vazio sem chamar o modelo", async () => {
    const rodar = vi.fn<RodarModelo>(async () => '{"memorias":[]}');
    expect(await escolherMemoriasDoTurno({ home: acervo(), mensagem: "   ", rodar, modelo: "haiku" })).toEqual({ bloco: "", usadas: [], via: "vazio" });
    expect(await escolherMemoriasDoTurno({ home: tempHome(), mensagem: "deploy", rodar, modelo: "haiku" })).toEqual({ bloco: "", usadas: [], via: "vazio" });
    expect(rodar).not.toHaveBeenCalled();
  });

  it("via modelo: manda o sistema + candidatas, descarta caminho inventado e repetido, prefixa cada memória", async () => {
    const home = acervo();
    const rodar = vi.fn<RodarModelo>(async () => '{"memorias":["deploy.md","inventada.md","deploy.md","testes.md"]}');
    const r = await escolherMemoriasDoTurno({ home, mensagem: "vou publicar", threadId: novaConversa(), rodar, modelo: "haiku", tetoMs: 2_000, threadProfileId: "p1" });
    expect(r.via).toBe("modelo");
    expect(r.usadas).toEqual(["deploy.md", "testes.md"]);
    expect(r.bloco).toContain("--- Memória relevante: deploy.md ---\nDeploy sempre via script deploy.sh");
    expect(r.bloco).toContain("--- Memória relevante: testes.md ---");
    expect(r.bloco).not.toContain("inventada.md");
    const [prompt, ctx] = rodar.mock.calls[0]!;
    expect(prompt.startsWith(SISTEMA_SELECAO)).toBe(true);
    expect(prompt).toContain("- pessoal/cafe.md: Café favorito");
    expect(ctx).toMatchObject({ home, modelo: "haiku", tetoMs: 2_000, threadProfileId: "p1" });
  });

  it('{"memorias":[]} do modelo é respeitado: nada entra e não cai no léxico', async () => {
    const r = await escolherMemoriasDoTurno({ home: acervo(), mensagem: "deploy deploy", rodar: async () => '{"memorias":[]}', modelo: "haiku" });
    expect(r).toEqual({ bloco: "", usadas: [], via: "modelo" });
  });

  it("erro, resposta ilegível e teto de tempo caem na busca léxica", async () => {
    const home = acervo();
    const msg = "preciso fazer deploy do servidor";
    const erro = await escolherMemoriasDoTurno({ home, mensagem: msg, rodar: async () => { throw new Error("sem conta"); }, modelo: "haiku" });
    expect(erro.via).toBe("lexico");
    expect(erro.usadas).toEqual(["deploy.md"]);

    const ilegivel = await escolherMemoriasDoTurno({ home, mensagem: msg, rodar: async () => "acho que deploy.md", modelo: "haiku" });
    expect(ilegivel.via).toBe("lexico");
    expect(ilegivel.usadas).toEqual(["deploy.md"]);

    const inicio = Date.now();
    const lento = await escolherMemoriasDoTurno({
      home,
      mensagem: msg,
      rodar: () => new Promise<string>((res) => setTimeout(() => res('{"memorias":["testes.md"]}'), 5_000).unref()),
      modelo: "haiku",
      tetoMs: 50,
    });
    expect(lento.via).toBe("lexico");
    expect(lento.usadas).toEqual(["deploy.md"]);
    expect(Date.now() - inicio).toBeLessThan(2_000);
  });

  it("sem rodar ou sem modelo vai direto ao léxico", async () => {
    const home = acervo();
    const r = await escolherMemoriasDoTurno({ home, mensagem: "rodar testes do daemon" });
    expect(r.via).toBe("lexico");
    expect(r.usadas).toEqual(["testes.md"]);
    const semModelo = await escolherMemoriasDoTurno({ home, mensagem: "rodar testes do daemon", rodar: async () => '{"memorias":[]}' });
    expect(semModelo.via).toBe("lexico");
  });

  it("ledger: a mesma versão não entra duas vezes na conversa; mudança de corpo ou zerar libera", async () => {
    const home = acervo();
    const threadId = novaConversa();
    const rodar: RodarModelo = async () => '{"memorias":["deploy.md"]}';
    const o = { home, mensagem: "deploy", threadId, rodar, modelo: "haiku" };
    expect((await escolherMemoriasDoTurno(o)).usadas).toEqual(["deploy.md"]);
    expect(Object.keys(ledgerDaConversa(threadId))).toEqual(["deploy.md"]);
    expect(await escolherMemoriasDoTurno(o)).toEqual({ bloco: "", usadas: [], via: "modelo" });
    // outra conversa tem ledger próprio
    expect((await escolherMemoriasDoTurno({ ...o, threadId: novaConversa() })).usadas).toEqual(["deploy.md"]);
    // corpo novo = hash novo: volta
    const up = proporMemoria(home, { op: "update", relPath: "deploy.md", corpo: "Deploy agora via CI.", revisaoEsperada: 1, origem: "agente" });
    expect(up.ok).toBe(true);
    const r = await escolherMemoriasDoTurno(o);
    expect(r.usadas).toEqual(["deploy.md"]);
    expect(r.bloco).toContain("Deploy agora via CI.");
    // compactação zera
    zerarLedgerMemorias(threadId);
    expect(ledgerDaConversa(threadId)).toEqual({});
    expect((await escolherMemoriasDoTurno(o)).usadas).toEqual(["deploy.md"]);
  });

  it("sem threadId não há ledger: repete a cada turno", async () => {
    const home = acervo();
    const o = { home, mensagem: "deploy", rodar: (async () => '{"memorias":["deploy.md"]}') as RodarModelo, modelo: "haiku" };
    expect((await escolherMemoriasDoTurno(o)).usadas).toEqual(["deploy.md"]);
    expect((await escolherMemoriasDoTurno(o)).usadas).toEqual(["deploy.md"]);
  });

  it("memória que não cabe no teto é pulada inteira, nunca cortada", async () => {
    const home = tempHome();
    criar(home, "deploy-gigante.md", "Deploy gigante", "deploy do servidor", `Deploy ${"x".repeat(MAX_CHARS_LEXICO + 100)}`);
    criar(home, "deploy-curto.md", "Deploy curto", "deploy do servidor", "Deploy via script.");
    const r = await escolherMemoriasDoTurno({ home, mensagem: "deploy do servidor", threadId: novaConversa() });
    expect(r.via).toBe("lexico");
    expect(r.usadas).toEqual(["deploy-curto.md"]);
    expect(r.bloco).not.toContain("xxxx");
  });

  it("segredo no corpo vai mascarado no excerto", async () => {
    const home = tempHome();
    const r0 = proporMemoria(home, {
      op: "create",
      relPath: "banco.md",
      titulo: "Banco de dados",
      gancho: "acesso ao banco de dados",
      corpo: "Senha do banco: {{secret:banco.senha}}",
      segredos: [{ nome: "banco.senha", valor: "hunter2-muito-longa" }],
      origem: "agente",
    });
    expect(r0.ok).toBe(true);
    const r = await escolherMemoriasDoTurno({ home, mensagem: "acesso ao banco de dados" });
    expect(r.usadas).toEqual(["banco.md"]);
    expect(r.bloco).toContain("{{secret:banco.senha}}");
    expect(r.bloco).not.toContain("hunter2");
  });
});
