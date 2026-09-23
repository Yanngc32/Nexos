import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ponte com o helper nativo `Nexos.WindowsControl.exe` (.NET, `native/*.cs`) —
 * fala JSON-lines por stdio: um pedido `{id,method,params}\n`, uma resposta
 * `{id,result?,error?}\n`. Só o Win32/UI Automation de verdade sabe listar
 * janela, ler árvore de acessibilidade e mandar SendInput; o daemon (Node
 * puro, sem Electron) não tem acesso a nenhum dos dois — por isso o processo
 * separado, em vez de reimplementar isso em JS.
 */

const HELPER_NAME = "Nexos.WindowsControl.exe";
const TIMEOUT_MS = 45_000;

interface NativeResponse<T> {
  id: string;
  result?: T;
  error?: { message?: string };
}

interface Pendente {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function aqui(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Fonte C# do helper (`src/windows-control/native`), a partir da raiz do daemon — e não do
 * arquivo atual: empacotado, o motor roda do bundle `dist/nexos.mjs`, e "ao lado de mim" viraria
 * `dist/native`. A raiz é a primeira pasta acima com `package.json`.
 */
export function nativeDir(): string {
  let dir = aqui();
  for (let i = 0; i < 6 && !existsSync(join(dir, "package.json")); i++) dir = dirname(dir);
  return join(dir, "src", "windows-control", "native");
}

export function helperExePath(): string {
  return join(nativeDir(), "bin", "Release", "net7.0-windows", HELPER_NAME);
}

export function helperCompilado(): boolean {
  return existsSync(helperExePath());
}

let compilando: Promise<void> | null = null;

/**
 * Compila o helper na primeira vez que o recurso é usado — igual
 * `installBuildTools()` em `apk-build.ts` instala o SDK do Android sob
 * demanda: quem nunca liga "Permitir controle do Windows" nunca paga o custo
 * do build (~3s nesta máquina), e ninguém precisa mexer em `run.bat` pra um
 * recurso opcional de risco alto.
 */
export async function garantirHelperCompilado(): Promise<void> {
  if (helperCompilado()) return;
  if (!compilando) {
    compilando = (async () => {
      try {
        await execFileAsync("dotnet", ["build", "-c", "Release"], { cwd: nativeDir(), timeout: 5 * 60_000 });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error(
          `Não foi possível compilar o helper do controle do Windows (dotnet build falhou). ` +
            `Confirme que o .NET SDK está instalado (\`dotnet --version\`). Detalhe: ${(err.stderr || err.message || "").slice(0, 500)}`,
        );
      }
      if (!helperCompilado()) throw new Error("dotnet build terminou mas o executável não apareceu — build inconsistente.");
    })().finally(() => {
      compilando = null;
    });
  }
  return compilando;
}

export class WindowsControlClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private pending = new Map<string, Pendente>();
  private stderrTail = "";

  constructor(private readonly executablePath: () => string) {}

  async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();
    const child = this.ensureStarted();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Controle do Windows excedeu o tempo limite em ${method}.`));
        this.stop("O helper parou após exceder o tempo limite.");
      }, TIMEOUT_MS);
      timer.unref?.();

      let removeAbort: (() => void) | undefined;
      if (signal) {
        const onAbort = (): void => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(abortError());
          this.stop("A ação do Windows foi interrompida.");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, {
        resolve: (value) => {
          removeAbort?.();
          resolve(value as T);
        },
        reject: (err) => {
          removeAbort?.();
          reject(err);
        },
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.finish(id, error);
      });
    });
  }

  stop(reason = "Controle do Windows desativado."): void {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    if (child && !child.killed) child.kill();
    const error = new Error(reason);
    for (const id of [...this.pending.keys()]) this.finish(id, error);
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const executable = this.executablePath();
    this.stderrTail = "";
    const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.rejectAll(error);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.pending.size === 0) return;
      const detail = this.stderrTail.trim();
      this.rejectAll(new Error(`Helper do Windows encerrou (código ${code ?? "desconhecido"})${detail ? `: ${detail}` : "."}`));
    });
    return child;
  }

  private handleLine(line: string): void {
    let response: NativeResponse<unknown>;
    try {
      response = JSON.parse(line) as NativeResponse<unknown>;
    } catch {
      return;
    }
    if (!response.id || !this.pending.has(response.id)) return;
    if (response.error) {
      this.finish(response.id, new Error(response.error.message || "Falha no controle do Windows."));
      return;
    }
    this.finish(response.id, undefined, response.result);
  }

  private finish(id: string, error?: Error, result?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.finish(id, error);
  }
}

function abortError(): Error {
  const error = new Error("A ação do Windows foi interrompida.");
  error.name = "AbortError";
  return error;
}

export const windowsControlClient = new WindowsControlClient(helperExePath);
