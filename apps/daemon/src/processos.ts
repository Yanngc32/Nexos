import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./kill-tree.ts";
import { servicosRodando, stopService } from "./services.ts";
import { busyThreads } from "./session.ts";

/**
 * Processos que o Nexos pôs de pé e que NÃO são agente trabalhando — de qualquer projeto:
 * - `servico`: serviço do `nexos.json` rodando agora.
 * - `orfao`: processo vivo de um `.pid` em `<home>/run` que ninguém mais controla — motor que
 *   ficou pendurado depois do turno, serviço de uma subida anterior do daemon.
 *
 * Motor de conversa com turno em voo fica de fora: é agente trabalhando, e o lugar de parar é
 * a própria conversa.
 */
export type Processo = {
  /** Identidade estável pra ação de matar: o daemon só mata o que está NESTA lista. */
  chave: string;
  tipo: "servico" | "orfao";
  pid: number;
  nome: string;
  comando: string;
  /** Epoch ms. */
  desde?: number;
  projectPath?: string;
  servicoId?: string;
  porta?: number;
  /** Por que é órfão, em português. */
  motivo?: string;
};

type InfoSo = { nome: string; comando: string; criado?: number };

/**
 * Nome, linha de comando e hora de criação, numa chamada só ao WMI. Fora do Windows não há
 * como confirmar dono do PID aqui — devolve vazio e órfão não entra na lista.
 */
function infoDosProcessos(pids: number[]): Map<number, InfoSo> {
  const out = new Map<number, InfoSo>();
  if (process.platform !== "win32" || !pids.length) return out;
  const filtro = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = [
    `Get-CimInstance Win32_Process -Filter '${filtro}' |`,
    "Select-Object ProcessId,Name,CommandLine,@{n='Criado';e={[int64]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds}} |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return out;
  try {
    const bruto = JSON.parse(r.stdout) as unknown;
    const lista = (Array.isArray(bruto) ? bruto : [bruto]) as { ProcessId: number; Name?: string; CommandLine?: string; Criado?: number }[];
    for (const p of lista) out.set(p.ProcessId, { nome: p.Name ?? "", comando: p.CommandLine ?? "", ...(p.Criado ? { criado: p.Criado } : {}) });
  } catch {
    /* saída estranha do PowerShell: fica sem info */
  }
  return out;
}

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe, só não é nosso pra sinalizar
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Folga entre o processo nascer e o `.pid` dele ser gravado. */
const FOLGA_PID_MS = 10_000;

type ArquivoPid = { arquivo: string; pid: number; gravado: number };

function arquivosPid(home: string): ArquivoPid[] {
  const dir = join(home, "run");
  if (!existsSync(dir)) return [];
  const out: ArquivoPid[] = [];
  for (const arquivo of readdirSync(dir)) {
    // `daemon.pid` é o próprio Nexos rodando (com o app, o processo do Electron) — nunca órfão
    if (!arquivo.endsWith(".pid") || arquivo === "daemon.pid") continue;
    try {
      const caminho = join(dir, arquivo);
      const pid = Number(readFileSync(caminho, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) out.push({ arquivo, pid, gravado: statSync(caminho).mtimeMs });
    } catch {
      /* arquivo sumiu no meio */
    }
  }
  return out;
}

function motivoDoOrfao(arquivo: string): string {
  if (arquivo.startsWith("engine-")) return "motor de conversa que ficou de pé depois do turno";
  if (arquivo.startsWith("svc-")) return "serviço de uma subida anterior do Nexos";
  return "processo antigo do Nexos";
}

export function listarProcessos(home: string): Processo[] {
  const servicos = servicosRodando();
  const emVoo = new Set(busyThreads());
  const deServico = new Set(servicos.map((s) => s.pid));
  const candidatos = arquivosPid(home).filter((a) => {
    if (deServico.has(a.pid) || !vivo(a.pid)) return false;
    const thread = /^engine-(.+)\.pid$/.exec(a.arquivo)?.[1];
    return !(thread && emVoo.has(thread));
  });
  const info = infoDosProcessos([...new Set([...servicos.map((s) => s.pid), ...candidatos.map((c) => c.pid)])]);

  const out: Processo[] = servicos.map((s) => ({
    chave: `servico:${s.pid}`,
    tipo: "servico",
    pid: s.pid,
    nome: s.name,
    comando: s.cmd,
    desde: Date.parse(s.startedAt),
    projectPath: s.projectPath,
    servicoId: s.id,
    ...(s.porta ? { porta: s.porta } : {}),
  }));
  for (const c of candidatos) {
    const so = info.get(c.pid);
    // PID reusado: o processo vivo com esse número nasceu DEPOIS do .pid — não é nosso.
    if (!so?.criado || so.criado > c.gravado + FOLGA_PID_MS) continue;
    out.push({
      chave: `orfao:${c.arquivo}:${c.pid}`,
      tipo: "orfao",
      pid: c.pid,
      nome: so.nome,
      comando: so.comando,
      desde: so.criado,
      motivo: motivoDoOrfao(c.arquivo),
    });
  }
  return out;
}

/** Mata um processo DA LISTA (nunca PID solto vindo de fora). `false` = não está mais nela. */
export function matarProcesso(home: string, chave: string): boolean {
  const alvo = listarProcessos(home).find((p) => p.chave === chave);
  if (!alvo) return false;
  if (alvo.tipo === "servico" && alvo.projectPath && alvo.servicoId) {
    stopService(alvo.projectPath, alvo.servicoId, home);
    return true;
  }
  killTree(alvo.pid);
  const arquivo = /^orfao:(.+):\d+$/.exec(chave)?.[1];
  if (arquivo) {
    try {
      unlinkSync(join(home, "run", arquivo));
    } catch {
      /* já foi */
    }
  }
  return true;
}
