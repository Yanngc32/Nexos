import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* já morreu */
  }
}

export function reapRunPids(home: string): void {
  const dir = join(home, "run");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".pid")) continue;
    const path = join(dir, name);
    const pid = Number(readFileSync(path, "utf8").trim());
    killTree(pid);
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
