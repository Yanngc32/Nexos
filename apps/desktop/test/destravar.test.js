import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const d = require("../destravar.cjs");
const { criarLog } = require("../log.cjs");

const WIN = process.platform === "win32";
const vivos = [];
const servidores = [];

afterEach(async () => {
  for (const c of vivos.splice(0)) c.kill();
  await Promise.all(servidores.splice(0).map((s) => new Promise((r) => s.close(() => r()))));
});

function home() {
  const h = mkdtempSync(join(tmpdir(), "nexos-destravar-"));
  mkdirSync(join(h, "run"), { recursive: true });
  return h;
}

function linhas(h) {
  try {
    return readFileSync(join(h, "daemon.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function logDe(h) {
  return criarLog({ home: () => h, env: { NEXOS_LOG: "debug" } });
}

/** Motor falso com a MESMA linha de comando do empacotado: `<raiz>/dist/nexos.mjs up`. */
function motorFalso(h) {
  const raiz = join(h, "daemon", "dist");
  mkdirSync(raiz, { recursive: true });
  const script = join(raiz, "nexos.mjs");
  writeFileSync(
    script,
    [
      'import { createServer } from "node:net";',
      "const s = createServer(() => {});",
      's.listen(0, "127.0.0.1", () => console.log(s.address().port));',
    ].join("\n"),
  );
  const c = spawn(process.execPath, [script, "up"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  vivos.push(c);
  return new Promise((resolve) => c.stdout.once("data", (b) => resolve({ child: c, port: Number(String(b).trim()) })));
}

describe("confirmarPid", () => {
  const gravado = 1_000_000;
  const ok = (comando, criado = gravado - 500) => d.confirmarPid(1, gravado, { comando, criado });

  it("empacotado: dist/nexos.mjs up", () => {
    expect(ok("C:\\Nexos\\Nexos.exe C:\\Nexos\\resources\\daemon\\dist\\nexos.mjs up")).toEqual({ ok: true });
  });

  it("dev pelo app: filho do tsx com src/index.ts up", () => {
    const cmd =
      "C:\\x\\electron.exe --require C:\\x\\tsx\\dist\\preflight.cjs --import file:///C:/x/tsx/dist/loader.mjs C:\\r\\apps\\daemon\\src\\index.ts up";
    expect(ok(cmd)).toEqual({ ok: true });
  });

  it("dev pelo terminal: scripts/nexo.mjs up", () => {
    expect(ok("node /r/apps/daemon/scripts/nexo.mjs up")).toEqual({ ok: true });
  });

  it("recusa: outro programa, comando sem up, PID reusado, processo inexistente", () => {
    expect(ok("C:\\Windows\\notepad.exe").motivo).toBe("não é o motor do Nexos");
    expect(ok("node /r/apps/daemon/scripts/nexo.mjs hook fire git.post-commit").motivo).toMatch(/sem .up./);
    expect(ok("node C:\\r\\daemon\\dist\\nexos.mjs up", gravado + 60_000).motivo).toMatch(/PID reusado/);
    expect(d.confirmarPid(1, gravado, null).motivo).toBe("processo não existe");
  });

  it.skipIf(!WIN)("processo de verdade: o nosso passa, um qualquer não, um morto não existe", async () => {
    const h = home();
    const { child } = await motorFalso(h);
    const info = d.infoProcesso(child.pid);
    expect(info.comando).toContain("nexos.mjs");
    expect(d.confirmarPid(child.pid, Date.now(), info)).toEqual({ ok: true });
    // reusado: o .pid foi gravado bem antes de o processo nascer
    expect(d.confirmarPid(child.pid, Date.now() - 3_600_000, info).motivo).toMatch(/PID reusado/);

    const outro = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    vivos.push(outro);
    await new Promise((r) => setTimeout(r, 300));
    expect(d.confirmarPid(outro.pid, Date.now(), d.infoProcesso(outro.pid)).ok).toBe(false);

    const morto = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((r) => morto.once("exit", r));
    expect(d.infoProcesso(morto.pid)).toBeNull();
  }, 20_000);
});

describe("saudeDoMotor: os três estados", () => {
  it("ok, fechado e sem_resposta", async () => {
    const http = createHttp((_q, r) => r.end("{}"));
    servidores.push(http);
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    expect(await d.saudeDoMotor(http.address().port)).toBe("ok");

    const conexoes = [];
    const mudo = createServer((s) => conexoes.push(s));
    servidores.push(mudo);
    await new Promise((r) => mudo.listen(0, "127.0.0.1", r));
    expect(await d.saudeDoMotor(mudo.address().port, { timeoutMs: 300 })).toBe("sem_resposta");

    const livre = mudo.address().port;
    for (const s of conexoes) s.destroy();
    await new Promise((r) => servidores.pop().close(r));
    expect(await d.saudeDoMotor(livre, { timeoutMs: 300 })).toBe("fechado");
  });
});

describe("criarVigia", () => {
  it("dispara uma vez aos 15 s seguidos de sem_resposta e rearma depois que volta", () => {
    let t = 0;
    const h = home();
    const v = d.criarVigia({ log: logDe(h), agora: () => t });
    expect(v.registrar("ok")).toBe("nada");
    t = 1000;
    expect(v.registrar("sem_resposta")).toBe("nada");
    t = 15_999;
    expect(v.registrar("sem_resposta")).toBe("nada");
    t = 16_000;
    expect(v.registrar("sem_resposta")).toBe("destravar");
    t = 30_000;
    expect(v.registrar("sem_resposta")).toBe("nada");
    t = 31_000;
    v.registrar("ok");
    t = 32_000;
    v.registrar("sem_resposta");
    t = 47_000;
    expect(v.registrar("sem_resposta")).toBe("destravar");
    const log = linhas(h).join("\n");
    expect(log).toContain("INFO  [saude] motor: ok → sem_resposta");
    expect(log).toContain("AVISO [saude] motor não respondeu ao /health");
    expect(log).toContain("AVISO [app] motor sem resposta há 15 s");
  });
});

describe("agentesVivos", () => {
  it("conta run/*.pid vivos, menos o daemon.pid", () => {
    const h = home();
    writeFileSync(join(h, "run", "daemon.pid"), "11");
    writeFileSync(join(h, "run", "engine-a.pid"), "22");
    writeFileSync(join(h, "run", "engine-b.pid"), "33");
    const vivo = (pid) => pid !== 33;
    expect(d.agentesVivos(h, vivo)).toEqual([{ arquivo: "engine-a.pid", pid: 22 }]);
  });
});

describe("destravar", () => {
  it("PID recusado: não mata e loga o motivo", async () => {
    const h = home();
    writeFileSync(join(h, "run", "daemon.pid"), "4242");
    let matou = false;
    const r = await d.destravar({
      home: h,
      port: 1,
      log: logDe(h),
      deps: { info: () => ({ comando: "C:\\Windows\\notepad.exe", criado: 0 }), matar: () => (matou = true) },
    });
    expect(r).toMatchObject({ ok: false, pid: 4242, recusado: true, motivo: "não é o motor do Nexos" });
    expect(matou).toBe(false);
    expect(linhas(h).join("\n")).toMatch(/AVISO \[app\] PID 4242 recusado: não é o motor do Nexos/);
  });

  it("forcar mata mesmo sem confirmação (pedido da pessoa)", async () => {
    const h = home();
    writeFileSync(join(h, "run", "daemon.pid"), "4242");
    let matou = 0;
    const r = await d.destravar({
      home: h,
      port: 1,
      log: logDe(h),
      forcar: true,
      deps: { info: () => null, matar: (p) => (matou = p), portaLivre: async () => true },
    });
    expect(r.ok).toBe(true);
    expect(matou).toBe(4242);
  });

  it("porta que não libera estoura o teto e loga erro", async () => {
    const h = home();
    writeFileSync(join(h, "run", "daemon.pid"), "4242");
    let t = 0;
    const r = await d.destravar({
      home: h,
      port: 7,
      log: logDe(h),
      deps: {
        info: () => ({ comando: "x/dist/nexos.mjs up", criado: 0 }),
        matar: () => {},
        portaLivre: async () => false,
        agora: () => t,
        esperar: async () => {
          t += 1000;
        },
        tetoPortaMs: 3000,
      },
    });
    expect(r).toMatchObject({ ok: false, motivo: "porta não liberou" });
    expect(linhas(h).join("\n")).toMatch(/ERRO {2}\[app\] porta 7 não liberou em 3000 ms/);
  });

  it.skipIf(!WIN)("motor de verdade: confirma, mata e a porta libera", async () => {
    const h = home();
    const { child, port } = await motorFalso(h);
    writeFileSync(join(h, "run", "daemon.pid"), String(child.pid));
    const saiu = new Promise((r) => child.once("exit", r));
    const r = await d.destravar({ home: h, port, log: logDe(h) });
    await saiu;
    expect(r.ok).toBe(true);
    const log = linhas(h).join("\n");
    expect(log).toContain(`INFO  [app] PID ${child.pid} confirmado como o motor`);
    expect(log).toContain(`INFO  [app] kill enviado pro PID ${child.pid}`);
    expect(log).toMatch(new RegExp(`INFO {2}\\[app\\] porta ${port} liberada em \\d+ ms`));
  }, 20_000);
});
