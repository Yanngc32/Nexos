import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function isNodeScript(bin: string): boolean {
  const base = bin.split(/[\\/]/).pop() ?? bin;
  return /\.(mjs|cjs|js|ts)$/i.test(base);
}

export function spawnBin(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (isNodeScript(bin)) {
    return spawn(process.execPath, [bin, ...args], { ...opts, shell: false });
  }
  return spawn(bin, args, {
    ...opts,
    shell: opts.shell ?? (process.platform === "win32"),
  });
}
