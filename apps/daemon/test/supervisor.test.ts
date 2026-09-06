import { describe, expect, it } from "vitest";
import { lerDecisao, pedidoDeVolta, pedidoInicial, type Disponivel } from "../src/supervisor.ts";

const TIME: Disponivel[] = [
  { id: "revisor", nome: "Revisor", papel: "critica" },
  { id: "escritor", nome: "Escritor" },
];

function ok(texto: string) {
  const r = lerDecisao(texto, TIME);
  if (!r.ok) throw new Error(`esperava decisão, veio: ${r.erro}`);
  return r.d;
}

function erro(texto: string): string {
  const r = lerDecisao(texto, TIME);
  if (r.ok) throw new Error(`esperava recusa, veio: ${JSON.stringify(r.d)}`);
  return r.erro;
}

describe("lerDecisao", () => {
  it("lê a ordem de chamar um membro", () => {
    expect(ok('{"acao":"chamar","membro":"revisor","pedido":"olha o diff"}')).toEqual({
      acao: "chamar",
      membro: "revisor",
      pedido: "olha o diff",
    });
  });

  it("lê o encerramento", () => {
    expect(ok('{"acao":"encerrar","resumo":"tudo certo"}')).toEqual({
      acao: "encerrar",
      resumo: "tudo certo",
    });
  });

  it("aceita cerca de código e texto em volta", () => {
    const bruto = 'Claro!\n```json\n{"acao":"encerrar","resumo":"pronto"}\n```\nEspero ter ajudado.';
    expect(ok(bruto)).toEqual({ acao: "encerrar", resumo: "pronto" });
  });

  it("pega o ÚLTIMO objeto: o modelo às vezes mostra o exemplo antes da resposta", () => {
    const bruto =
      'O formato é {"acao":"chamar","membro":"escritor","pedido":"x"}. ' +
      'Minha decisão: {"acao":"encerrar","resumo":"nada a fazer"}';
    expect(ok(bruto)).toEqual({ acao: "encerrar", resumo: "nada a fazer" });
  });

  it("chave e aspas dentro do pedido não quebram a leitura", () => {
    const d = ok('{"acao":"chamar","membro":"escritor","pedido":"troca {a} por \\"b\\" no arquivo"}');
    expect(d).toEqual({ acao: "chamar", membro: "escritor", pedido: 'troca {a} por "b" no arquivo' });
  });

  it("recusa membro que não está no time, dizendo quem está", () => {
    const e = erro('{"acao":"chamar","membro":"fantasma","pedido":"x"}');
    expect(e).toContain("fantasma");
    expect(e).toContain("revisor, escritor");
  });

  it("recusa pedido vazio: chamar alguém sem dizer o quê não é ordem", () => {
    expect(erro('{"acao":"chamar","membro":"revisor","pedido":"  "}')).toMatch(/pedido/);
  });

  it("recusa ação desconhecida", () => {
    expect(erro('{"acao":"pensar"}')).toMatch(/chamar.*encerrar/);
  });

  it("recusa texto sem JSON e JSON quebrado", () => {
    expect(erro("vou chamar o revisor")).toMatch(/objeto JSON/);
    expect(erro('{"acao":"encerrar",}')).toMatch(/não é válido/);
  });

  it("encerrar sem resumo não vira recusa: a decisão de parar já foi tomada", () => {
    expect(ok('{"acao":"encerrar"}')).toEqual({
      acao: "encerrar",
      resumo: "o supervisor encerrou sem resumo",
    });
  });
});

describe("pedidos", () => {
  it("o inicial traz objetivo, lista e quantas chamadas restam", () => {
    const p = pedidoInicial("auditar o login", undefined, TIME, 5);
    expect(p).toContain("auditar o login");
    expect(p).toContain("- revisor — Revisor: critica");
    expect(p).toContain("- escritor — Escritor");
    expect(p).toContain("Restam 5 chamadas");
  });

  it("o papel do supervisor substitui o texto padrão", () => {
    expect(pedidoInicial("x", "só delega, nunca escreve", TIME, 3)).toContain("só delega, nunca escreve");
  });

  it("o de volta não repete o objetivo: é a mesma conversa e sairia pago duas vezes", () => {
    const p = pedidoDeVolta("revisor", "achei três bugs", "/runs/r1/passo-2.md", 4, 4000);
    expect(p).toContain("# Resultado de revisor");
    expect(p).toContain("achei três bugs");
    expect(p).not.toContain("# Objetivo do time");
  });

  it("saída longa é cortada com o caminho do arquivo inteiro", () => {
    const p = pedidoDeVolta("revisor", "x".repeat(50), "/runs/r1/passo-2.md", 4, 10);
    expect(p).toContain("[cortado");
    expect(p).toContain("/runs/r1/passo-2.md");
    expect(p).not.toContain("x".repeat(11));
  });
});
