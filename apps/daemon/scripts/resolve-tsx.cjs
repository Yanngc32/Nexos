const { execFileSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function daemonRoot() {
  return join(__dirname, "..");
}

function resolveTsxCli(root = daemonRoot()) {
  const cli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) {
    throw new Error(`tsx not found: ${cli}`);
  }
  return cli;
}

function nexoEntry(root = daemonRoot()) {
  return join(root, "src", "index.ts");
}

function resolveNodeBin() {
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

function spawnNexoProcess(args, opts = {}) {
  const root = opts.daemonRoot ?? daemonRoot();
  const { daemonRoot: _ignored, nodeBin, ...spawnOpts } = opts;
  const bin = nodeBin ?? resolveNodeBin();
  return spawn(bin, [resolveTsxCli(root), nexoEntry(root), ...args], {
    cwd: root,
    env: process.env,
    ...spawnOpts,
  });
}

module.exports = { daemonRoot, resolveTsxCli, nexoEntry, resolveNodeBin, spawnNexoProcess };
