import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { estadoAtual, fecharTudo, ligadoEm, melhorHost, religar, resetEscutaForTest } from "../src/escuta.ts";

afterEach(resetEscutaForTest);

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

const ligar = (host = "") => religar(app.fetch, 0, host);

async function alcanca(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    return (await fetch(`http://${host}:${port}/health`)).ok;
  } catch {
    return false;
  }
}

describe("religar", () => {
  it("sobe o loopback sem ninguém pedir", async () => {
    const e = await ligar();
    expect(e.hosts).toContain("127.0.0.1");
    expect(e.port).toBeGreaterThan(0);
    expect(await alcanca(e.port)).toBe(true);
  });

  it("é idempotente: chamar de novo não fecha nem reabre nada", async () => {
    // é isto que deixa o relógio de 20s ser seguro. Se cada passagem
    // reabrisse o socket, toda conexão SSE do celular morreria a cada 20s.
    const primeiro = await ligar();
    const antes = ligadoEm("127.0.0.1");
    for (let i = 0; i < 3; i++) {
      const e = await ligar();
      expect(e.hosts).toEqual(primeiro.hosts);
      expect(e.port).toBe(primeiro.port);
    }
    expect(ligadoEm("127.0.0.1"), "o servidor tem que ser o MESMO objeto").toBe(antes);
    expect(await alcanca(primeiro.port)).toBe(true);
  });

  it("mantém a porta ao acrescentar endereço — porta diferente seria URL que não atende", async () => {
    const primeiro = await ligar();
    const depois = await ligar("203.0.113.7");
    expect(depois.port).toBe(primeiro.port);
  });

  it("endereço que não existe entra em falhas e não derruba o resto", async () => {
    const e = await ligar("203.0.113.7");
    expect(e.hosts).toContain("127.0.0.1");
    expect(e.falhas.map((f) => f.host)).toContain("203.0.113.7");
    expect(await alcanca(e.port)).toBe(true);
  });

  it("endereço que sumiu do config é DESLIGADO na passagem seguinte", async () => {
    // sem isto, tirar o endereço da tela deixaria o socket aberto até reiniciar
    const com = await ligar("127.0.0.2");
    expect(com.hosts).toContain("127.0.0.2");
    expect(await alcanca(com.port, "127.0.0.2")).toBe(true);
    const sem = await ligar();
    expect(sem.hosts).not.toContain("127.0.0.2");
    expect(await alcanca(sem.port, "127.0.0.2"), "socket velho continuou aberto").toBe(false);
    expect(await alcanca(sem.port), "e o loopback não pode ter caído junto").toBe(true);
  });

  it("a falha de uma passagem não fica pendurada na seguinte", async () => {
    expect((await ligar("203.0.113.7")).falhas).toHaveLength(1);
    expect((await ligar()).falhas, "falha velha virou notícia velha").toHaveLength(0);
  });

  it("escutar em tudo não tenta o loopback junto — daria EADDRINUSE", async () => {
    const e = await ligar("0.0.0.0");
    expect(e.hosts).toEqual(["0.0.0.0"]);
    expect(e.falhas).toEqual([]);
    // e continua alcançável pelo loopback, porque 0.0.0.0 o inclui
    expect(await alcanca(e.port)).toBe(true);
  });
});

describe("melhorHost", () => {
  it("prefere o túnel, porque é o único por onde o celular chega", () => {
    expect(melhorHost({ hosts: ["127.0.0.1", "100.101.102.103"], falhas: [], port: 1 })).toBe("100.101.102.103");
  });

  it("prefere IPv4 mesmo quando o IPv6 veio primeiro na escuta", () => {
    // Windows lista o IPv6 do Tailscale antes; QR com ele falha no telefone
    expect(
      melhorHost({
        hosts: ["127.0.0.1", "fd7a:115c:a1e0::1", "100.101.102.103"],
        falhas: [],
        port: 1,
      }),
    ).toBe("100.101.102.103");
  });

  it("sem túnel, devolve o que há", () => {
    expect(melhorHost({ hosts: ["127.0.0.1"], falhas: [], port: 1 })).toBe("127.0.0.1");
  });

  it("sem nada ligado, não devolve vazio pra tela montar URL torta", () => {
    expect(melhorHost({ hosts: [], falhas: [], port: 0 })).toBe("127.0.0.1");
  });
});

describe("fecharTudo", () => {
  it("solta a porta de verdade — socket pendurado impediria a subida seguinte", async () => {
    const e = await ligar();
    expect(await alcanca(e.port)).toBe(true);
    fecharTudo();
    expect(estadoAtual()).toEqual({ hosts: [], falhas: [], port: 0 });
    expect(await alcanca(e.port)).toBe(false);
  });
});
