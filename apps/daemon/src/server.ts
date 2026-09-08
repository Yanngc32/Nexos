import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@nexo/shared";
import { loadConfig } from "./config.ts";
import { fecharTudo, ligadoEm, manterEmDia, religar } from "./escuta.ts";
import { ensureHome, tokenPath } from "./home.ts";
import { createApp } from "./http.ts";
import { reapRunPids } from "./kill-tree.ts";

export function pidPath(home: string): string {
  return join(home, "run", "daemon.pid");
}

export type StartResult =
  | { alreadyUp: true; port: number }
  | {
      alreadyUp: false;
      port: number;
      token: string;
      server: Server;
      /** Onde ele REALMENTE escuta — loopback primeiro, depois os túneis. */
      hosts: string[];
      /** O que tentou e não deu. Túnel fora do ar cai aqui, e não é fatal. */
      falhas: { host: string; motivo: string }[];
    };

/**
 * Reaproveita o token da subida anterior, se houver um íntegro.
 *
 * Antes ele era sorteado a cada subida, e o efeito prático era desparear o
 * celular toda vez que a máquina reiniciava: você escaneava o QR de novo todo
 * dia. Sessão que morre sozinha não é segurança, é atrito — o arquivo já é
 * `0600`, e quem consegue lê-lo consegue ler o resto do `~/.nexo` também.
 *
 * A troca é explícita: `POST /v1/token/rotate` sorteia um novo e derruba todos
 * os celulares de uma vez. Revogar virou botão, em vez de acontecer por
 * acidente.
 *
 * A forma é conferida antes de reusar. Arquivo truncado ou editado à mão viraria
 * um token que ninguém consegue usar e que nada explica.
 */
function tokenDaCasa(home: string): string {
  const caminho = tokenPath(home);
  try {
    const guardado = readFileSync(caminho, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(guardado)) return guardado;
  } catch {
    /* primeira subida, ou arquivo ilegível */
  }
  const novo = randomBytes(24).toString("hex");
  writeFileSync(caminho, novo, { encoding: "utf8", mode: 0o600 });
  return novo;
}

export async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export function waitClosed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("close", () => resolve());
  });
}

export async function startDaemon(home: string, opts?: { port?: number }): Promise<StartResult> {
  const cfg = loadConfig(home);
  const port = opts?.port !== undefined ? opts.port : cfg.port;

  if (await probeHealth(port)) {
    return { alreadyUp: true, port };
  }

  ensureHome(home);
  reapRunPids(home);

  /*
   * `NEXO_HOST` ganha do config: quem sobe o daemon num terminal com uma
   * interface específica em mente não deveria ter que editar arquivo. Nos dois
   * casos é um ACRÉSCIMO à detecção automática, não uma substituição — o
   * loopback entra sempre, e os túneis que a máquina tem entram sozinhos.
   */
  const hostManual = () => process.env.NEXO_HOST?.trim() || loadConfig(home).host;

  const token = tokenDaCasa(home);
  const app = createApp(home, token);

  const estado = await religar(app.fetch, port, hostManual());

  /*
   * **O LOOPBACK É QUEM DECIDE se este processo é o daemon.**
   *
   * Não basta ter escutado em ALGUM endereço: com a porta já ocupada no
   * loopback por outro daemon, o endereço do túnel ainda estaria livre, e nós
   * subiríamos nele. O resultado seria dois daemons na mesma porta — o app do
   * desktop falando com um pelo loopback, o celular falando com o outro pelo
   * túnel, cada um com sua conversa e seu run. Cérebro partido.
   *
   * Então: loopback ocupado é `alreadyUp`, e o que já abrimos tem que fechar.
   * (Foi um endereço de túnel de verdade na máquina de teste que revelou isto;
   * sem ele o caso nunca aparece.)
   */
  const loopback = estado.hosts.includes(DEFAULT_CONFIG.host);
  if (!loopback) {
    fecharTudo();
    const falha = estado.falhas.find((f) => f.host === DEFAULT_CONFIG.host);
    if (falha?.motivo === "EADDRINUSE") return { alreadyUp: true, port };
    const motivo = estado.falhas.map((f) => `${f.host}: ${f.motivo}`).join(", ") || "motivo desconhecido";
    throw new Error(`não consegui escutar em ${DEFAULT_CONFIG.host}:${port} (${motivo})`);
  }

  writeFileSync(pidPath(home), String(process.pid), "utf8");
  // e daqui pra frente ele se mantém em dia sozinho: túnel que sobe depois
  // entra sem ninguém reiniciar nada
  manterEmDia(app.fetch, estado.port, hostManual);

  const principal = ligadoEm(estado.hosts[0] ?? "");
  if (!principal) throw new Error("escuta sem servidor: isto é bug");
  // `estado.port`, não `port`: com `--port 0` quem escolheu foi o SO
  return {
    alreadyUp: false,
    port: estado.port,
    token,
    server: principal,
    hosts: estado.hosts,
    falhas: estado.falhas,
  };
}
