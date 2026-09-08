import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { probeHealth, startDaemon, waitClosed } from "../src/server.ts";
import { tokenPath } from "../src/home.ts";
import { estadoAtual, fecharTudo, resetEscutaForTest } from "../src/escuta.ts";
import { saveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

const live: Server[] = [];

afterEach(resetEscutaForTest);

afterEach(async () => {
  await Promise.all(
    live.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

function listenDummy(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe("startDaemon", () => {
  it("EADDRINUSE = already up e NÃO troca o token guardado", async () => {
    // o que importa mudou: o token agora sobrevive às subidas, então a
    // invariante não é "não escreveu arquivo", é "não mexeu no que já valia"
    const home = tempHome();
    const dummy = await listenDummy((_q, r) => {
      r.statusCode = 404;
      r.end();
    });
    live.push(dummy.server);
    saveConfig(home, { port: dummy.port });
    writeFileSync(tokenPath(home), "a".repeat(48), "utf8");
    const result = await startDaemon(home, { port: dummy.port });
    expect(result.alreadyUp).toBe(true);
    expect(readFileSync(tokenPath(home), "utf8")).toBe("a".repeat(48));
  });

  it("loopback ocupado é already up — nunca meio daemon num endereço secundário", async () => {
    /*
     * O caso: outro daemon já tem a porta no loopback, mas um endereço
     * secundário (túnel, ou aqui `127.0.0.2`) está livre. Subir nele daria dois
     * daemons na mesma porta, um atendendo o desktop e outro o celular.
     *
     * Em máquina sem endereço secundário disponível isto passa trivialmente; em
     * máquina com um, é o teste que pega o bug. Foi assim que ele apareceu.
     */
    const home = tempHome();
    const dummy = await listenDummy((_q, r) => {
      r.statusCode = 404;
      r.end();
    });
    live.push(dummy.server);
    saveConfig(home, { port: dummy.port, host: "127.0.0.2" });
    const result = await startDaemon(home, { port: dummy.port });
    expect(result.alreadyUp).toBe(true);
    expect(estadoAtual().hosts, "sobrou socket aberto de um daemon que não é daemon").toEqual([]);
  });

  it("o token sobrevive a derrubar e subir o daemon — é o que evita reparear", async () => {
    const home = tempHome();
    const primeiro = await startDaemon(home, { port: 0 });
    expect(primeiro.alreadyUp).toBe(false);
    if (primeiro.alreadyUp) return;
    const t1 = primeiro.token;
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
    fecharTudo();

    const segundo = await startDaemon(home, { port: 0 });
    if (segundo.alreadyUp) return;
    live.push(segundo.server);
    expect(segundo.token, "subida nova com token novo desparearia o celular").toBe(t1);
  });

  it("token corrompido no disco é trocado em vez de servido", async () => {
    // arquivo truncado ou editado à mão viraria um token que ninguém usa e que
    // nada explica
    for (const lixo of ["", "  ", "curto", "Z".repeat(48), "a".repeat(47)]) {
      const home = tempHome();
      writeFileSync(tokenPath(home), lixo, "utf8");
      const r = await startDaemon(home, { port: 0 });
      if (r.alreadyUp) continue;
      live.push(r.server);
      expect(r.token, JSON.stringify(lixo)).toMatch(/^[0-9a-f]{48}$/);
      expect(r.token).not.toBe(lixo);
      fecharTudo();
    }
  });

  it("escuta no loopback sem ninguém pedir nada", async () => {
    const home = tempHome();
    const r = await startDaemon(home, { port: 0 });
    expect(r.alreadyUp).toBe(false);
    if (r.alreadyUp) return;
    live.push(r.server);
    expect(r.hosts[0]).toBe("127.0.0.1");
    expect(await probeHealth(r.port)).toBe(true);
  });

  it("endereço manual que não existe é falha REGISTRADA, não daemon morto", async () => {
    // 203.0.113.x é reservado pra documentação: não existe em interface nenhuma
    const home = tempHome();
    saveConfig(home, { host: "203.0.113.7" });
    const r = await startDaemon(home, { port: 0 });
    expect(r.alreadyUp).toBe(false);
    if (r.alreadyUp) return;
    live.push(r.server);
    expect(r.hosts, "o loopback tem que ter subido de qualquer forma").toContain("127.0.0.1");
    expect(r.falhas.map((f) => f.host)).toContain("203.0.113.7");
    expect(await probeHealth(r.port)).toBe(true);
  });

  it("nunca escuta em endereço mais aberto do que foi pedido", async () => {
    // se a detecção ou o fallback trouxessem 0.0.0.0, o Nexo apareceria na rede
    // inteira sem ninguém pedir
    const home = tempHome();
    saveConfig(home, { host: "203.0.113.7" });
    const r = await startDaemon(home, { port: 0 });
    if (r.alreadyUp) return;
    live.push(r.server);
    expect(r.hosts).not.toContain("0.0.0.0");
    expect(r.hosts).not.toContain("::");
  });

  it("não resolve waitClosed até server.close", async () => {
    const home = tempHome();
    const started = await startDaemon(home, { port: 0 });
    expect(started.alreadyUp).toBe(false);
    if (started.alreadyUp) return;
    live.push(started.server);
    let closed = false;
    const pending = waitClosed(started.server).then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(closed).toBe(false);
    started.server.close();
    await pending;
    expect(closed).toBe(true);
    live.length = 0;
  });
});
