import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@nexos/shared";
import { loadConfig } from "./config.ts";
import { fecharTudo, ligadoEm, manterEmDia, manterHttpsEmDia, religar } from "./escuta.ts";
import { ensureHome, tokenPath } from "./home.ts";
import { createApp } from "./http.ts";
import { reapRunPids } from "./kill-tree.ts";
import { log, registrarSegredo } from "./log.ts";

export function pidPath(home: string): string {
  return join(home, "run", "daemon.pid");
}

/** Código de saída do `nexos up` quando a porta tem um motor travado (o app lê isto). */
export const CODIGO_TRAVADO = 3;

export type StartResult =
  | { alreadyUp: true; port: number; travado?: false }
  /**
   * Porta ocupada por um motor que aceita a conexão e não responde. Quem mata é o app (que
   * confere se o PID é mesmo nosso), nunca o `up` — ver `startDaemon`.
   */
  | { alreadyUp: true; port: number; travado: true; pid: number | null }
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
 * `0600`, e quem consegue lê-lo consegue ler o resto do `~/.nexos` também.
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

/**
 * - `ok`: o motor respondeu.
 * - `fechado`: ninguém escuta (ECONNREFUSED e afins) — ou quem escuta respondeu, mas não é um
 *   motor saudável (404 de outro programa): segue a subida e o bind decide (EADDRINUSE → já ligado).
 * - `sem_resposta`: estourou o prazo. Motor que aceita a conexão com o event loop parado.
 */
export type Saude = "ok" | "fechado" | "sem_resposta";

export const HEALTH_TIMEOUT_MS = 3000;

export async function probeHealth(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Saude> {
  const inicio = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.ok ? "ok" : "fechado";
  } catch (e) {
    const nome = (e as Error).name;
    if (nome !== "TimeoutError" && nome !== "AbortError") return "fechado";
    log.debug("saude", "checagem sem resposta", { checagem: "probeHealth", ms: Date.now() - inicio, erro: (e as Error).name });
    return "sem_resposta";
  }
}

function pidDoMotor(home: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(home), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

  const saude = await probeHealth(port);
  if (saude === "ok") {
    return { alreadyUp: true, port };
  }
  /*
   * **Travado não é desligado.** Porta ocupada por um motor que não responde: `reapRunPids` aqui
   * mataria os agentes em voo sem perguntar (e, antes de ele pular o `daemon.pid`, o próprio
   * motor — até um saudável que ficou 3 s lento). E nem adiantaria: o kill é assíncrono, o bind
   * logo abaixo caía em EADDRINUSE e virava "já ligado". Quem destrava é o app, que confere se o
   * PID é mesmo nosso antes de matar.
   */
  if (saude === "sem_resposta") {
    const pid = pidDoMotor(home);
    log.aviso("motor", `porta ${port} ocupada, PID ${pid ?? "?"} não responde — motor travado, não subo outro`, {
      pid,
      porta: port,
      codigoSaida: CODIGO_TRAVADO,
    });
    return { alreadyUp: true, port, travado: true, pid };
  }

  ensureHome(home);
  reapRunPids(home);

  /*
   * `NEXOS_HOST` ganha do config: quem sobe o daemon num terminal com uma
   * interface específica em mente não deveria ter que editar arquivo. Nos dois
   * casos é um ACRÉSCIMO à detecção automática, não uma substituição — o
   * loopback entra sempre, e os túneis que a máquina tem entram sozinhos.
   */
  const hostManual = () => process.env.NEXOS_HOST?.trim() || loadConfig(home).host;

  const token = tokenDaCasa(home);
  registrarSegredo(token);
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
  // HTTPS é melhor-esforço e roda no fundo — nunca atrasa a subida do daemon,
  // que segue em HTTP com ou sem ele (ver escuta.ts)
  manterHttpsEmDia(app.fetch, estado.port, home);

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
