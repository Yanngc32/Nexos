import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./log.ts";

/**
 * HTTPS pro daemon via `tailscale cert` — ver
 * `docs/superpowers/specs/2026-09-13-https-tailscale-cert-design.md` pro design completo.
 *
 * Duas chamadas ao binário `tailscale`, as DUAS best-effort e NUNCA lançam: sem o
 * binário, sem HTTPS habilitado no tailnet, ou qualquer erro no meio do caminho, o
 * chamador recebe `null` e o daemon segue só em HTTP — exatamente como já fazia antes
 * deste módulo existir. `enderecos.ts` deliberadamente NÃO chama a CLI (só inspeciona
 * `os.networkInterfaces()` — ver o comentário lá); este módulo é o único lugar do
 * daemon que reintroduz essa dependência, e só porque emitir certificado exige o nome
 * MagicDNS, que não tem como derivar de um endereço IP.
 */

const execFileAsync = promisify(execFile);

/*
 * Por que o HTTPS não subiu. Continua best-effort (cai pro HTTP), mas antes eram só catches mudos:
 * a pessoa ligava o Tailscale, esperava HTTPS no celular e não tinha pista nenhuma. Loga só quando
 * o motivo MUDA (a tentativa repete no relógio). Sem o binário é o caso comum de quem não usa
 * Tailscale: fica em debug.
 */
let ultimoMotivo = "";

export function motivoHttps(motivo: string, dados?: Record<string, unknown>, nivel: "debug" | "aviso" = "aviso"): void {
  if (motivo === ultimoMotivo) return;
  ultimoMotivo = motivo;
  log[nivel]("https", `HTTPS pelo Tailscale não subiu: ${motivo}`, dados);
}

/** HTTPS de pé: a próxima falha volta a aparecer no log. */
export function httpsSubiu(hostname: string, port: number): void {
  if (ultimoMotivo !== "ok") log.info("https", `HTTPS pelo Tailscale de pé em ${hostname}:${port}`);
  ultimoMotivo = "ok";
}

/** Só pra teste. */
export function resetMotivoHttpsForTest(): void {
  ultimoMotivo = "";
}

function erroDoComando(e: unknown): Record<string, unknown> {
  const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  return { erro: err.message, codigo: err.code ?? "", stderr: String(err.stderr ?? "").trim().slice(0, 300) };
}
const TIMEOUT_STATUS_MS = 10_000;
const TIMEOUT_CERT_MS = 30_000;

function tailscaleBin(): string {
  return process.env.NEXOS_TAILSCALE_BIN ?? "tailscale";
}

export function tlsDir(home: string): string {
  return join(home, "tls");
}

export function certPath(home: string): string {
  return join(tlsDir(home), "cert.pem");
}

export function keyPath(home: string): string {
  return join(tlsDir(home), "key.pem");
}

/**
 * O nome MagicDNS deste node (`algo.tailnet.ts.net`), ou `null` se a máquina não está
 * num tailnet, o binário não existe, ou a saída não é o JSON esperado.
 *
 * `DNSName` vem com ponto final (`"maquina.tailXXXX.ts.net."`) — removido aqui, porque
 * nem `tailscale cert` nem a URL do QR o aceitam.
 */
export async function hostnameTailscale(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(tailscaleBin(), ["status", "--json"], { timeout: TIMEOUT_STATUS_MS });
    let status: { Self?: { DNSName?: string } };
    try {
      status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    } catch (e) {
      motivoHttps("saída do \"tailscale status\" não é JSON", { erro: (e as Error).message, saida: stdout.slice(0, 300) });
      return null;
    }
    const nome = status.Self?.DNSName?.replace(/\.$/, "");
    if (!nome) motivoHttps("máquina sem nome MagicDNS (fora do tailnet ou MagicDNS desligado)", undefined, "debug");
    return nome ? nome.toLowerCase() : null;
  } catch (e) {
    const dados = erroDoComando(e);
    if (dados.codigo === "ENOENT") motivoHttps(`binário ${tailscaleBin()} não encontrado`, dados, "debug");
    // Tailscale instalado mas parado/deslogado também sai com código ≠ 0: é o caso que a pessoa quer saber
    else motivoHttps('"tailscale status" falhou', dados);
    return null;
  }
}

export type CertPar = { certPem: string; keyPem: string };

/**
 * Pede (ou renova — `tailscale cert` decide sozinho se está perto de vencer) o
 * certificado pro hostname, e devolve o par pronto pra `https.createServer`.
 *
 * Grava em `~/.nexos/tls/`, sempre `0600` — mesmo padrão do `daemon.token`, e pela
 * mesma razão: é material sensível (a chave privada) morando ao lado do resto.
 */
export async function pedirCertTailscale(hostname: string, home: string): Promise<CertPar | null> {
  if (!hostname) return null;
  const dir = tlsDir(home);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    motivoHttps(`não consegui criar ${dir}`, { erro: (e as Error).message });
    return null;
  }
  const arqCert = certPath(home);
  const arqKey = keyPath(home);
  try {
    await execFileAsync(tailscaleBin(), ["cert", "--cert-file", arqCert, "--key-file", arqKey, hostname], {
      timeout: TIMEOUT_CERT_MS,
    });
  } catch (e) {
    // o caso típico: HTTPS certificates desligado no admin do tailnet
    motivoHttps(`"tailscale cert ${hostname}" recusou (HTTPS ligado no admin do tailnet?)`, erroDoComando(e));
    return null;
  }
  try {
    // `tailscale cert` não promete o modo do arquivo — `writeFileSync({ mode })` só
    // valeria na CRIAÇÃO, e o arquivo já existe (foi o comando acima que o criou), então
    // o ajuste tem que ser um `chmod` explícito, não uma reescrita com `mode`.
    if (process.platform !== "win32") chmodSync(arqKey, 0o600);
    const certPem = readFileSync(arqCert, "utf8");
    const keyPem = readFileSync(arqKey, "utf8");
    return { certPem, keyPem };
  } catch (e) {
    motivoHttps(`não consegui ler o certificado em ${dir}`, { erro: (e as Error).message });
    return null;
  }
}
