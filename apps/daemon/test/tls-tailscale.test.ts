import { existsSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { certPath, hostnameTailscale, keyPath, pedirCertTailscale } = await import("../src/tls-tailscale.ts");

beforeEach(() => {
  execFileMock.mockReset();
});

describe("hostnameTailscale", () => {
  it("lê o DNSName de `tailscale status --json`, sem o ponto final", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(null, { stdout: JSON.stringify({ Self: { DNSName: "maquina.tail1234.ts.net." } }) }),
    );
    expect(await hostnameTailscale()).toBe("maquina.tail1234.ts.net");
  });

  it("binário ausente: null, nunca lança", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("ENOENT"), undefined));
    await expect(hostnameTailscale()).resolves.toBeNull();
  });

  it("JSON sem Self (daemon do tailscale não logado): null", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "{}" }));
    expect(await hostnameTailscale()).toBeNull();
  });

  it("saída que não é JSON: null, nunca lança", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "não é json" }));
    await expect(hostnameTailscale()).resolves.toBeNull();
  });
});

describe("pedirCertTailscale", () => {
  it("sucesso: grava cert e key em ~/.nexos/tls, key sempre 0600, e devolve os dois", async () => {
    const home = tempHome();
    execFileMock.mockImplementation((_bin, args, _opts, cb) => {
      const certFile = args[args.indexOf("--cert-file") + 1];
      const keyFile = args[args.indexOf("--key-file") + 1];
      writeFileSync(certFile, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
      writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n");
      cb(null, { stdout: "" });
    });
    const par = await pedirCertTailscale("maquina.tail1234.ts.net", home);
    expect(par?.certPem).toMatch(/BEGIN CERTIFICATE/);
    expect(par?.keyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(existsSync(certPath(home))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(keyPath(home)).mode & 0o777).toBe(0o600);
    }
  });

  it("binário ausente ou tailnet sem HTTPS: null, nunca lança", async () => {
    const home = tempHome();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("HTTPS not enabled"), undefined));
    await expect(pedirCertTailscale("maquina.tail1234.ts.net", home)).resolves.toBeNull();
  });

  it("hostname vazio: null sem nem chamar o binário", async () => {
    const home = tempHome();
    await expect(pedirCertTailscale("", home)).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("comando diz sucesso mas não escreveu os arquivos: null, não finge que deu certo", async () => {
    const home = tempHome();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "" }));
    await expect(pedirCertTailscale("maquina.tail1234.ts.net", home)).resolves.toBeNull();
    expect(existsSync(certPath(home))).toBe(false);
  });
});
