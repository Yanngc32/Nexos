import { describe, expect, it } from "vitest";
import type { PackConfig, ThreadEvent } from "@nexo/shared";
import { DEFAULT_CONFIG } from "@nexo/shared";
import { historicoParaResumir, montarCompactacao, pedidoDeResumo } from "../src/compactar.ts";
import { aResumir, cobertosPor, escopo, pack, precisaCompactar, tokensDoHistorico } from "../src/packer.ts";

const CFG: PackConfig = { ...DEFAULT_CONFIG.pack, keepLastMessages: 2 };
const T = "t-1";

let n = 0;
const ts = () => `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`;

const meta = (): ThreadEvent => ({
  ts: ts(),
  type: "thread_meta",
  threadId: T,
  projectPath: "/p",
  profileId: "casa",
});
const user = (text: string): ThreadEvent => ({ ts: ts(), type: "user", threadId: T, text });
const bot = (text: string): ThreadEvent => ({ ts: ts(), type: "assistant", threadId: T, text });
const resumo = (text: string, cobertos: number): ThreadEvent => ({
  ts: ts(),
  type: "compacted",
  threadId: T,
  text,
  cobertos,
  tokensAntes: 100,
  tokensDepois: 10,
});

/** Conversa com `pares` idas e voltas, cada mensagem gorda o suficiente pra contar. */
function conversa(pares: number): ThreadEvent[] {
  const ev: ThreadEvent[] = [meta()];
  for (let i = 0; i < pares; i++) {
    ev.push(user(`pergunta ${i} ${"x".repeat(200)}`));
    ev.push(bot(`resposta ${i} ${"y".repeat(200)}`));
  }
  return ev;
}

describe("escopo", () => {
  it("sem corte nenhum, é tudo", () => {
    const ev = conversa(2);
    expect(escopo(ev).eventos).toHaveLength(ev.length);
    expect(escopo(ev).resumo).toBe("");
  });

  it("o resumo substitui os eventos que ele cobre", () => {
    const ev = [...conversa(3), resumo("o que houve antes", 5)];
    const e = escopo(ev);
    expect(e.resumo).toBe("o que houve antes");
    // 7 eventos de conversa + 1 compacted; cobertos=5 corta os 5 primeiros e o
    // próprio compacted sai (ele não é mensagem)
    expect(e.eventos).toHaveLength(2);
  });

  it("o que chegou DEPOIS do resumo fica verbatim", () => {
    // é o caso real: mensagem nova entra enquanto o resumo está sendo feito
    const ev = [...conversa(3), resumo("antes", 5), user("chegou depois")];
    const e = escopo(ev);
    expect(e.eventos.some((x) => x.type === "user" && x.text === "chegou depois")).toBe(true);
  });

  it("`/clear` depois de um resumo joga o resumo fora também", () => {
    // clear é a pessoa dizendo "esqueça"; um resumo sobrevivente contrariaria isso
    const ev = [...conversa(3), resumo("antes", 5), { ts: ts(), type: "cleared", threadId: T } as ThreadEvent, user("oi")];
    const e = escopo(ev);
    expect(e.resumo).toBe("");
    expect(e.eventos.map((x) => x.type)).toEqual(["user"]);
  });

  it("resumo depois de um `/clear` vale, e não ressuscita o que foi limpo", () => {
    const ev: ThreadEvent[] = [meta(), user("velho"), { ts: ts(), type: "cleared", threadId: T }];
    ev.push(user("a"), bot("b"), user("c"), bot("d"), user("e"), bot("f"));
    ev.push(resumo("resumo do pos-clear", ev.length - 2));
    const e = escopo(ev);
    expect(e.resumo).toBe("resumo do pos-clear");
    expect(e.eventos.some((x) => x.type === "user" && x.text === "velho")).toBe(false);
  });

  it("dois resumos: o mais novo manda", () => {
    const ev = [...conversa(4), resumo("primeiro", 4)];
    ev.push(user("x"), bot("y"));
    ev.push(resumo("segundo", ev.length - 1));
    expect(escopo(ev).resumo).toBe("segundo");
  });
});

describe("pack com resumo", () => {
  it("põe o resumo no topo, rotulado", () => {
    const ev = [...conversa(3), resumo("decidimos usar base32", 5)];
    const t = pack(ev, CFG, 100_000).text;
    expect(t).toMatch(/^Resumo do que veio antes nesta conversa: decidimos usar base32/);
    expect(t, "e o que sobrou vem depois").toContain("resposta 2");
  });

  it("o resumo encolhe o pack de verdade", () => {
    const ev = conversa(20);
    const antes = pack(ev, CFG, 1_000_000).text.length;
    const depois = pack([...ev, resumo("tudo em três linhas", 30)], CFG, 1_000_000).text.length;
    expect(depois).toBeLessThan(antes / 2);
  });

  it("se o resumo ainda não couber, o corte entra — e o resumo sobrevive a ele", () => {
    /*
     * É a rede de segurança: o corte era o comportamento único antes, e continua
     * como último recurso. O resumo tem que ir na frente dele, senão compactar
     * não teria servido pra nada no caso em que mais importa.
     */
    const ev = [...conversa(40), resumo("o essencial da conversa", 60)];
    const r = pack(ev, CFG, 200);
    expect(r.trimmed).toBeTruthy();
    expect(r.text).toContain("o essencial da conversa");
  });
});

describe("precisaCompactar", () => {
  it("não abaixo do limiar", () => {
    expect(precisaCompactar(conversa(2), CFG, 100_000)).toBe(false);
  });

  it("sim quando o histórico encosta no teto", () => {
    const ev = conversa(20);
    expect(precisaCompactar(ev, CFG, Math.floor(tokensDoHistorico(ev) / 0.8) - 1)).toBe(true);
  });

  it("não compacta em 100% do teto, e sim antes", () => {
    // compactar leva um turno; esperar o teto faria o turno seguinte já ser
    // cortado em silêncio enquanto o resumo é feito
    const ev = conversa(20);
    const tokens = tokensDoHistorico(ev);
    // com teto tal que o histórico está em 85%, já deve querer compactar
    expect(precisaCompactar(ev, CFG, Math.ceil(tokens / 0.85))).toBe(true);
    // e em 70%, ainda não
    expect(precisaCompactar(ev, CFG, Math.ceil(tokens / 0.7))).toBe(false);
  });

  it("não compacta se tudo é recente: custaria um turno pra economizar nada", () => {
    const cfg = { ...CFG, keepLastMessages: 100 };
    expect(precisaCompactar(conversa(20), cfg, 1)).toBe(false);
  });

  it("usa o contextTokens REAL quando ele é maior que a estimativa — a estimativa (chars/4 só de user/assistant/resumo de ferramenta) ignora system prompt e definição de ferramenta MCP, e fica muito abaixo do que o motor realmente usa", () => {
    const ev = conversa(20);
    const estimativa = tokensDoHistorico(ev);
    // teto tal que a ESTIMATIVA fica bem abaixo do limiar (não dispararia sozinha)
    const tokenCap = Math.ceil(estimativa / 0.3);
    expect(precisaCompactar(ev, CFG, tokenCap)).toBe(false);
    // mas o real (visto no evento `usage`) já passou de 80% desse mesmo teto
    const real = Math.ceil(tokenCap * 0.85);
    expect(precisaCompactar(ev, CFG, tokenCap, real)).toBe(true);
  });

  it("sem contextTokens real (thread sem usage ainda, valor 0), continua só na estimativa — comportamento de antes preservado", () => {
    const ev = conversa(20);
    const tokenCap = Math.floor(tokensDoHistorico(ev) / 0.8) - 1;
    expect(precisaCompactar(ev, CFG, tokenCap, 0)).toBe(true);
  });
});

describe("aResumir e cobertosPor", () => {
  it("as últimas mensagens ficam FORA do resumo — recência é o que mais importa", () => {
    const ev = conversa(5);
    const alvo = aResumir(ev, CFG, 1_000_000);
    const ultimas = alvo.filter((e) => e.type === "assistant" && e.text.includes("resposta 4"));
    expect(ultimas, "a última resposta não pode ter sido resumida").toHaveLength(0);
    expect(alvo.some((e) => e.type === "user" && e.text.includes("pergunta 0"))).toBe(true);
  });

  it("`cobertos` é índice no ARQUIVO, não no escopo", () => {
    // é o que faz o índice sobreviver a `/clear` e a resumo anterior
    const ev: ThreadEvent[] = [meta(), user("velho"), { ts: ts(), type: "cleared", threadId: T }];
    ev.push(...conversa(4).slice(1));
    const c = cobertosPor(ev, CFG, 1_000_000);
    expect(c).toBeGreaterThan(3);
    expect(c).toBeLessThan(ev.length);
  });

  it("nada a resumir dá zero", () => {
    expect(cobertosPor(conversa(1), CFG, 1_000_000)).toBe(0);
  });
});

describe("historicoParaResumir", () => {
  it("manda quem falou o quê, e não o JSON cru", () => {
    const t = historicoParaResumir(conversa(5), CFG, 1_000_000);
    expect(t).toMatch(/^Usuário: pergunta 0/);
    expect(t).toContain("Assistente: resposta 0");
    expect(t, "as recentes não vão: elas ficam verbatim").not.toContain("resposta 4");
  });

  it("inclui o que ferramenta fez, que é metade do que aconteceu", () => {
    const ev = conversa(5);
    ev.splice(3, 0, { ts: ts(), type: "tool", threadId: T, name: "Edit", summary: "a.ts" });
    expect(historicoParaResumir(ev, CFG, 1_000_000)).toContain("[ferramenta Edit: a.ts]");
  });
});

describe("pedidoDeResumo", () => {
  it("pede o MOTIVO das decisões, que é o que não dá pra redescobrir", () => {
    const p = pedidoDeResumo("conversa");
    expect(p).toMatch(/MOTIVO/);
    expect(p, "e o que falhou, pra ninguém repetir").toMatch(/falhou/);
    expect(p, "é pra outro agente ler, não uma pessoa").toMatch(/OUTRO agente/);
    expect(p).toContain("conversa");
  });

  it("proíbe inventar", () => {
    expect(pedidoDeResumo("x")).toMatch(/Não invente/);
  });
});

describe("montarCompactacao", () => {
  const bom = "Decidimos base32 porque o espaço vai de 10^6 pra 10^9 pelo mesmo trabalho de digitar.";

  it("monta o evento com a contagem de antes e depois", () => {
    const ev = conversa(20);
    const r = montarCompactacao(ev, CFG, 1_000_000, T, bom, ts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.evento.cobertos).toBe(cobertosPor(ev, CFG, 1_000_000));
    expect(r.evento.tokensDepois).toBeLessThan(r.evento.tokensAntes);
  });

  it("resumo vazio ou curto é descartado: pior que corte", () => {
    for (const ruim of ["", "   ", "ok", "resumo curto"]) {
      const r = montarCompactacao(conversa(20), CFG, 1_000_000, T, ruim, ts());
      expect(r.ok, JSON.stringify(ruim)).toBe(false);
    }
  });

  it("resumo que não encolhe nada é descartado", () => {
    /*
     * Acontece com conversa de muitas mensagens curtas: o resumo tem tamanho
     * próprio e pode ficar maior que o que substitui. Gravar seria pagar um
     * turno pra piorar.
     */
    const ev = conversa(3);
    const gigante = "z".repeat(20_000);
    const r = montarCompactacao(ev, CFG, 1_000_000, T, gigante, ts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/não encolheu/);
  });

  it("nada a resumir é recusado, não gravado vazio", () => {
    const r = montarCompactacao(conversa(1), CFG, 1_000_000, T, bom, ts());
    expect(r.ok).toBe(false);
  });

  it("o evento gravado é o que o packer entende — ida e volta", () => {
    const ev = conversa(20);
    const r = montarCompactacao(ev, CFG, 1_000_000, T, bom, ts());
    if (!r.ok) throw new Error("devia ter montado");
    const depois = pack([...ev, r.evento], CFG, 1_000_000).text;
    expect(depois).toContain(bom);
    expect(depois, "o que foi resumido não pode continuar verbatim").not.toContain("pergunta 0");
  });
});

describe("o resumo não pode receber mais do que caiba num turno", () => {
  /*
   * O histórico no disco NÃO tem teto: uma conversa de meses tem megabytes de
   * JSONL. Mandar isso num turno estoura a janela e o turno falha inteiro — e
   * falha justamente na conversa mais longa, que é a que mais precisava.
   */
  it("corta a entrada no teto, pelos mais ANTIGOS", () => {
    const ev = conversa(200);
    const pequeno = aResumir(ev, CFG, 500);
    const grande = aResumir(ev, CFG, 1_000_000);
    expect(pequeno.length).toBeLessThan(grande.length);
    expect(pequeno[0], "começa pelo mais antigo").toBe(grande[0]);
  });

  it("respeita o teto de verdade, com folga de um evento", () => {
    const ev = conversa(200);
    const teto = 2000;
    const t = historicoParaResumir(ev, CFG, teto);
    // 4 chars por token é a mesma estimativa do packer; um evento de folga
    // porque o corte é feito ANTES de estourar, não depois
    expect(Math.ceil(t.length / 4)).toBeLessThan(teto * 1.5);
  });

  it("nunca devolve vazio por teto apertado: um evento sempre entra", () => {
    // vazio faria a compactação desistir pra sempre numa conversa que precisa
    const ev = conversa(200);
    expect(aResumir(ev, CFG, 1).length).toBeGreaterThan(0);
  });

  it("`cobertos` acompanha o pedaço, não o histórico todo", () => {
    const ev = conversa(200);
    expect(cobertosPor(ev, CFG, 500)).toBeLessThan(cobertosPor(ev, CFG, 1_000_000));
  });

  it("compacta em pedaços: cada passagem come o mais antigo que couber", () => {
    let ev = conversa(200);
    const antes = tokensDoHistorico(ev);
    for (let i = 0; i < 3; i++) {
      const r = montarCompactacao(ev, CFG, 3000, T, `resumo da passagem ${i} ${"z".repeat(200)}`, ts());
      if (!r.ok) throw new Error(`passagem ${i}: ${r.motivo}`);
      ev = [...ev, r.evento];
    }
    expect(tokensDoHistorico(ev), "cada passagem tem que encolher mais").toBeLessThan(antes);
  });
});

describe("consolidação", () => {
  it("o resumo anterior entra na entrada da próxima — senão degrada a cada passagem", () => {
    /*
     * Sem isto, a segunda compactação resumiria só o pedaço novo e o resumo
     * antigo iria sendo re-resumido de segunda mão, perdendo precisão a cada
     * vez. Com isto o resultado é sempre UM resumo do todo.
     */
    const ev = [...conversa(60), resumo("a decisão original foi base32", 40)];
    const t = historicoParaResumir(ev, CFG, 100_000);
    expect(t).toContain("a decisão original foi base32");
    expect(t).toMatch(/^Resumo do que veio antes/);
  });

  it("sem resumo anterior, a entrada não ganha cabeçalho de graça", () => {
    expect(historicoParaResumir(conversa(10), CFG, 100_000)).toMatch(/^Usuário:/);
  });
});
