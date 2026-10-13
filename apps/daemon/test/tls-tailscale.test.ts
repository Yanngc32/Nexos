import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { certGuardado, certPath, hostnameTailscale, keyPath, pedirCertTailscale, statusTailscale, tlsDir } = await import("../src/tls-tailscale.ts");
const CERT = readFileSync(join(import.meta.dirname, "fixtures/fake-tls-cert.pem"), "utf8");
const KEY = readFileSync(join(import.meta.dirname, "fixtures/fake-tls-key.pem"), "utf8");

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

describe("statusTailscale", () => {
  it("Running: nome sem ponto final e os IPs deste node", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(null, { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "Maquina.tail1.ts.net.", TailscaleIPs: ["100.64.8.119", "fd7a:115c:a1e0::1"] } }) }),
    );
    expect(await statusTailscale()).toEqual({ hostname: "maquina.tail1.ts.net", ips: ["100.64.8.119", "fd7a:115c:a1e0::1"] });
  });

  it("NoState/Starting (logo depois de bloquear a tela ou acordar): null, mesmo com JSON válido", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(null, { stdout: JSON.stringify({ BackendState: "NoState", Self: { DNSName: "", TailscaleIPs: null } }) }),
    );
    expect(await statusTailscale()).toBeNull();
  });
});

describe("certificado guardado", () => {
  function gravar(home: string) {
    mkdirSync(tlsDir(home), { recursive: true });
    writeFileSync(certPath(home), CERT);
    writeFileSync(keyPath(home), KEY);
  }

  it("serve se é do mesmo nome e vale por mais de um dia; outro nome ou vencendo, não", () => {
    const home = tempHome();
    expect(certGuardado(home, "nexo-teste.invalid")).toBeNull();
    gravar(home);
    expect(certGuardado(home, "nexo-teste.invalid")).toMatchObject({ certPem: CERT, keyPem: KEY, venceEm: "2036-09-10" });
    expect(certGuardado(home, "outra.tail1.ts.net")).toBeNull();
    expect(certGuardado(home, "nexo-teste.invalid", Date.parse("2036-09-09T12:00:00Z"))).toBeNull();
  });

  it("tailscale cert falhou (rede/firewall): devolve o par guardado em vez de derrubar o HTTPS", async () => {
    const home = tempHome();
    gravar(home);
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("dial tcp: forbidden"), undefined));
    const par = await pedirCertTailscale("nexo-teste.invalid", home);
    expect(par).toEqual({ certPem: CERT, keyPem: KEY });
  });
});
