import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Varre o processo descendente de `pid` direto no WMI (PowerShell), em vez de confiar no
 * `/t` do próprio `taskkill`. `npm run <script>` empilha várias camadas de processo no
 * Windows (cmd.exe → npm.cmd → node da CLI do npm → shim .cmd do binário do pacote → node de
 * verdade — e ferramentas como o Vite ainda spawnam o esbuild, um binário nativo à parte),
 * e o `taskkill /t` erra o rastro do PPID com uma frequência real nessa cadeia — o comando
 * "acerta" o processo raiz e um descendente sobrevive escutando a porta. Consultar o WMI a
 * cada nível (BFS) é mais devagar, mas não depende de o `taskkill` ter acertado a foto certa
 * da árvore no instante em que rodou.
 */
function descendentesWin(pid: number): number[] {
  const script = [
    `$alvo = @(${pid})`,
    "$achados = @()",
    "while ($alvo.Count -gt 0) {",
    "  $filhos = @(Get-CimInstance Win32_Process | Where-Object { $alvo -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId)",
    "  $achados += $filhos",
    "  $alvo = $filhos",
    "}",
    "$achados",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === "win32") {
    const todos = [pid, ...descendentesWin(pid)];
    for (const p of todos) spawnSync("taskkill", ["/pid", String(p), "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* já morreu */
  }
}

/**
 * Mata quem estiver ESCUTANDO nesta porta, sem depender da árvore de PID do processo que a
 * gente spawnou. No Windows, `npm run <script>` empilha várias camadas de processo
 * (cmd.exe → npm.cmd → node da CLI do npm → shim .cmd do binário do pacote → node de
 * verdade) — se qualquer processo intermediário já não existir mais quando o Windows monta
 * o retrato de árvore, `taskkill /t` perde o rastro do PPID e o processo que de fato escuta
 * a porta sobrevive, mesmo o comando "acertando" o pai. Ir direto na porta é o único jeito
 * de garantir que quem responde ali pare de responder.
 */
export type KillByPortResult = { tentou: boolean; pids: number[]; erro?: string };

export function killByPort(port: number): KillByPortResult {
  if (process.platform !== "win32") return { tentou: false, pids: [] };
  if (!Number.isInteger(port) || port <= 0) return { tentou: false, pids: [] };
  const r = spawnSync("netstat", ["-ano"], { windowsHide: true, encoding: "utf8" });
  if (r.error) return { tentou: true, pids: [], erro: `netstat não rodou: ${r.error.message}` };
  if (r.status !== 0 || !r.stdout) return { tentou: true, pids: [], erro: `netstat saiu com status ${r.status}` };
  const pids = new Set<number>();
  for (const linha of r.stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(linha)) continue;
    const campos = linha.trim().split(/\s+/);
    // "TCP  <local>  <remoto>  LISTENING  <pid>" — a porta é o que vem depois do último ":" do local
    const local = campos[1] ?? "";
    const portaLocal = Number(local.slice(local.lastIndexOf(":") + 1));
    if (portaLocal !== port) continue;
    const pid = Number(campos[campos.length - 1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  for (const pid of pids) spawnSync("taskkill", ["/pid", String(pid), "/f"], { windowsHide: true, stdio: "ignore" });
  return { tentou: true, pids: [...pids] };
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
