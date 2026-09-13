import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

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
const TIMEOUT_STATUS_MS = 10_000;
const TIMEOUT_CERT_MS = 30_000;

function tailscaleBin(): string {
  return process.env.NEXO_TAILSCALE_BIN ?? "tailscale";
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
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const nome = status.Self?.DNSName?.replace(/\.$/, "");
    return nome ? nome.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type CertPar = { certPem: string; keyPem: string };

/**
 * Pede (ou renova — `tailscale cert` decide sozinho se está perto de vencer) o
 * certificado pro hostname, e devolve o par pronto pra `https.createServer`.
 *
 * Grava em `~/.nexo/tls/`, sempre `0600` — mesmo padrão do `daemon.token`, e pela
 * mesma razão: é material sensível (a chave privada) morando ao lado do resto.
 */
export async function pedirCertTailscale(hostname: string, home: string): Promise<CertPar | null> {
  if (!hostname) return null;
  const dir = tlsDir(home);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const arqCert = certPath(home);
  const arqKey = keyPath(home);
  try {
    await execFileAsync(tailscaleBin(), ["cert", "--cert-file", arqCert, "--key-file", arqKey, hostname], {
      timeout: TIMEOUT_CERT_MS,
    });
  } catch {
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
  } catch {
    return null;
  }
}
