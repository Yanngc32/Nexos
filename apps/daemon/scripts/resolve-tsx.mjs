import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function daemonRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveTsxCli(root = daemonRoot()) {
  const cli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) {
    throw new Error(`tsx not found: ${cli}`);
  }
  return cli;
}

export function nexoEntry(root = daemonRoot()) {
  return join(root, "src", "index.ts");
}

export function resolveNodeBin() {
  const exe = process.execPath || "node";
  if (process.versions?.electron || /electron/i.test(exe)) {
    return findNodeOnPath();
  }
  return exe;
}

function findNodeOnPath() {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(cmd, ["node"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.find((l) => !/WindowsApps/i.test(l)) || lines[0] || "node";
  } catch {
    return "node";
  }
}

/**
 * Como rodar o motor: com o fonte presente (desenvolvimento), `tsx src/index.ts` — mudança no
 * código vale sem compilar; sem ele (instalador), o bundle `dist/nexos.mjs` direto, sem tsx.
 */
export function motorArgs(root = daemonRoot()) {
  const fonte = nexoEntry(root);
  const bundle = join(root, "dist", "nexos.mjs");
  if (existsSync(fonte)) return [resolveTsxCli(root), fonte];
  if (existsSync(bundle)) return [bundle];
  throw new Error(`motor não encontrado: nem ${fonte} nem ${bundle}`);
}

export function spawnNexoProcess(args, opts = {}) {
  const root = opts.daemonRoot ?? daemonRoot();
  const { daemonRoot: _ignored, nodeBin, ...spawnOpts } = opts;
  const bin = nodeBin ?? resolveNodeBin();
  return spawn(bin, [...motorArgs(root), ...args], {
    cwd: root,
    env: process.env,
    ...spawnOpts,
  });
}
