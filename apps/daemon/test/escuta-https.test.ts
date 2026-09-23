import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { tempHome } from "./helpers.ts";

const hostnameTailscaleMock = vi.hoisted(() => vi.fn());
const pedirCertTailscaleMock = vi.hoisted(() => vi.fn());
const HOST_TUNEL = vi.hoisted(() => "127.0.0.9");
vi.mock("../src/tls-tailscale.ts", () => ({
  hostnameTailscale: hostnameTailscaleMock,
  pedirCertTailscale: pedirCertTailscaleMock,
}));

/*
 * `100.x` (bloco CGNAT do Tailscale) não bind de verdade num sandbox sem essa
 * interface — só `127.0.0.0/8` é livremente bindável sem existir de verdade
 * (é o que já permite o teste de `escuta.test.ts` usar "127.0.0.2" como
 * "endereço extra"). Então o teste usa um endereço de loopback como o "túnel"
 * — e finge, só pra `classificar`, que ele É um túnel; `ondeEscutar` e o resto
 * de `enderecos.ts` continuam de verdade.
 */
vi.mock("../src/enderecos.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/enderecos.ts")>();
  return {
    ...real,
    classificar: (host: string, iface?: string) => (host === HOST_TUNEL ? "tunel" : real.classificar(host, iface)),
    // interfaces de verdade fora: numa máquina com Tailscale ligado o IP 100.x real virava o "túnel"
    // no lugar do HOST_TUNEL e três casos quebravam só nela. Aqui só existe o que o teste liga.
    enderecosDaMaquina: () => [],
  };
});

const { estadoAtual, religar, resetEscutaForTest, tentarHttps } = await importEscuta();

async function importEscuta() {
  return import("../src/escuta.ts");
}

const CERT = readFileSync(join(import.meta.dirname, "fixtures/fake-tls-cert.pem"), "utf8");
const KEY = readFileSync(join(import.meta.dirname, "fixtures/fake-tls-key.pem"), "utf8");

afterEach(() => {
  resetEscutaForTest();
  hostnameTailscaleMock.mockReset();
  pedirCertTailscaleMock.mockReset();
});

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

async function comTunel() {
  return religar(app.fetch, 0, HOST_TUNEL);
}

describe("tentarHttps", () => {
  it("sem hostname (tailscale ausente ou deslogado): não abre nada", async () => {
    await comTunel();
    hostnameTailscaleMock.mockResolvedValue(null);
    await tentarHttps(app.fetch, 0, tempHome());
    expect(estadoAtual().https).toBeNull();
    expect(pedirCertTailscaleMock).not.toHaveBeenCalled();
  });

  it("com hostname mas sem túnel de pé: não pede certificado à toa", async () => {
    await religar(app.fetch, 0); // só loopback
    hostnameTailscaleMock.mockResolvedValue("maquina.tail1234.ts.net");
    await tentarHttps(app.fetch, 0, tempHome());
    expect(estadoAtual().https).toBeNull();
    expect(pedirCertTailscaleMock).not.toHaveBeenCalled();
  });

  it("hostname + túnel, mas tailnet sem HTTPS habilitado (cert null): fecha e segue sem https", async () => {
    await comTunel();
    hostnameTailscaleMock.mockResolvedValue("maquina.tail1234.ts.net");
    pedirCertTailscaleMock.mockResolvedValue(null);
    await tentarHttps(app.fetch, 0, tempHome());
    expect(estadoAtual().https).toBeNull();
  });

  it("tudo certo: sobe um socket HTTPS de verdade, alcançável por HTTPS", async () => {
    const e = await comTunel();
    hostnameTailscaleMock.mockResolvedValue("maquina.tail1234.ts.net");
    pedirCertTailscaleMock.mockResolvedValue({ certPem: CERT, keyPem: KEY });
    await tentarHttps(app.fetch, e.port, tempHome());

    const info = estadoAtual().https;
    expect(info).toMatchObject({ host: HOST_TUNEL, hostname: "maquina.tail1234.ts.net" });
    expect(info?.port).toBeGreaterThan(0);

    // certificado autoassinado de teste: o handshake TLS é real, só não é
    // confiável por uma CA pública — por isso `rejectUnauthorized: false`
    const https = await import("node:https");
    const corpo: string = await new Promise((resolve, reject) => {
      https.get(
        { host: HOST_TUNEL, port: info?.port, path: "/health", rejectUnauthorized: false },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        },
      ).on("error", reject);
    });
    expect(JSON.parse(corpo)).toEqual({ ok: true });
  });

  it("chamar de novo com o mesmo hostname não religa o socket (não derruba conexão à toa)", async () => {
    const e = await comTunel();
    hostnameTailscaleMock.mockResolvedValue("maquina.tail1234.ts.net");
    pedirCertTailscaleMock.mockResolvedValue({ certPem: CERT, keyPem: KEY });
    await tentarHttps(app.fetch, e.port, tempHome());
    const primeiro = estadoAtual().https;

    pedirCertTailscaleMock.mockClear();
    await tentarHttps(app.fetch, e.port, tempHome());
    expect(pedirCertTailscaleMock).not.toHaveBeenCalled();
    expect(estadoAtual().https).toEqual(primeiro);
  });

  it("túnel some (ex.: Tailscale caiu): fecha o HTTPS também", async () => {
    const e = await comTunel();
    hostnameTailscaleMock.mockResolvedValue("maquina.tail1234.ts.net");
    pedirCertTailscaleMock.mockResolvedValue({ certPem: CERT, keyPem: KEY });
    await tentarHttps(app.fetch, e.port, tempHome());
    expect(estadoAtual().https).not.toBeNull();

    await religar(app.fetch, e.port); // sem host de túnel
    await tentarHttps(app.fetch, e.port, tempHome());
    expect(estadoAtual().https).toBeNull();
  });

  it("falha do binário no meio do caminho nunca lança — só fecha o que havia", async () => {
    await comTunel();
    hostnameTailscaleMock.mockRejectedValue(new Error("boom"));
    await expect(tentarHttps(app.fetch, 0, tempHome())).resolves.toBeUndefined();
    expect(estadoAtual().https).toBeNull();
  });
});
