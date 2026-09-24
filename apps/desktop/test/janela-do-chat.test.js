import { describe, expect, it } from "vitest";
import { inicioDaJanela, mensagensAntesDe } from "../janela-do-chat.js";

/** n turnos, cada um: 1 mensagem sua + `ferramentas` pares tool/tool_result + resposta. */
function conversa(n, ferramentas) {
  const ev = [{ type: "thread_meta" }];
  for (let t = 0; t < n; t++) {
    ev.push({ type: "user", text: `m${t}` });
    for (let f = 0; f < ferramentas; f++) ev.push({ type: "tool", id: `${t}-${f}` }, { type: "tool_result", id: `${t}-${f}` });
    ev.push({ type: "assistant", text: "ok" });
  }
  return ev;
}

describe("inicioDaJanela", () => {
  it("conversa curta desenha tudo", () => {
    expect(inicioDaJanela(conversa(3, 2), 300)).toBe(0);
  });

  it("corta numa mensagem sua e fica dentro do limite", () => {
    const ev = conversa(50, 4); // 10 eventos por turno
    const i = inicioDaJanela(ev, 95);
    expect(ev[i].type).toBe("user");
    expect(ev.length - i).toBe(90);
  });

  it("último turno entra inteiro mesmo passando do limite", () => {
    const ev = conversa(3, 100);
    const i = inicioDaJanela(ev, 50);
    expect(ev[i].text).toBe("m2");
  });

  it("sem mensagem sua não corta", () => {
    const ev = Array.from({ length: 500 }, (_, k) => ({ type: "tool", id: String(k) }));
    expect(inicioDaJanela(ev, 100)).toBe(0);
  });
});

describe("mensagensAntesDe", () => {
  it("conta só mensagens suas (não as automáticas) antes do corte", () => {
    const ev = [{ type: "user" }, { type: "user", automatico: true }, { type: "tool" }, { type: "user" }];
    expect(mensagensAntesDe(ev, 3)).toBe(1);
  });
});
