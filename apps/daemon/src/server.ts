import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { DEFAULT_CONFIG } from "@nexo/shared";
import { loadConfig } from "./config.ts";
import { registrarEscuta } from "./escuta.ts";
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
      /** Onde ele REALMENTE escuta. */
      host: string;
      /** Só presente quando o endereço pedido não deu e ele caiu pro loopback. */
      hostPedido?: string;
    };

/**
 * Erros que significam "este endereço não existe nesta máquina", e não "não
 * consigo escutar".
 *
 * O caso que importa é mundano: você aponta o endereço de escuta pro IP do
 * túnel, o túnel cai (ou o IP muda, coisa que DHCP faz sozinho), e na próxima
 * subida o daemon não acha o endereço. Sem tratamento ele morre — e o daemon é
 * o que roda seus agentes. Recusar-se a subir por causa de uma preferência de
 * acesso pelo celular é priorizar errado.
 */
const ENDERECO_SUMIU = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

const ehLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1";

/** Uma tentativa de escutar. Resolve com o server pronto, ou rejeita com o erro do SO. */
function escutar(
  fetchHandler: Parameters<typeof serve>[0]["fetch"],
  hostname: string,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: fetchHandler, hostname, port }, (info) => {
      if (settled) return;
      settled = true;
      resolve({ server: server as Server, port: Number(info.port) });
    }) as Server;
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      server.close();
      reject(err);
    });
  });
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
  /*
   * `NEXO_HOST` ganha do config: quem sobe o daemon num terminal com uma
   * interface específica em mente não deveria ter que editar arquivo. Padrão
   * segue sendo loopback — publicar na rede é sempre uma escolha explícita.
   */
  const hostname = process.env.NEXO_HOST?.trim() || cfg.host;

  if (await probeHealth(port)) {
    return { alreadyUp: true, port };
  }

  ensureHome(home);
  reapRunPids(home);

  const token = randomBytes(24).toString("hex");
  const app = createApp(home, token);

  let host = hostname;
  let hostPedido: string | undefined;
  let ligado: { server: Server; port: number };
  try {
    ligado = await escutar(app.fetch, host, port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") return { alreadyUp: true, port };
    if (!ehLoopback(host) && e.code && ENDERECO_SUMIU.has(e.code)) {
      /*
       * Cai pro loopback, e só pra ele: é a direção RESTRITIVA. Nunca expõe
       * mais do que você pediu — no pior caso o celular não alcança e a tela
       * diz por quê, em vez de o Nexo não abrir.
       */
      hostPedido = host;
      host = DEFAULT_CONFIG.host;
      ligado = await escutar(app.fetch, host, port);
    } else {
      throw err;
    }
  }

  // token e pid só depois de escutar de verdade: escrever antes deixaria um
  // token no disco que servidor nenhum aceita
  writeFileSync(tokenPath(home), token, { encoding: "utf8", mode: 0o600 });
  writeFileSync(pidPath(home), String(process.pid), "utf8");
  registrarEscuta({ host, hostPedido });
  return { alreadyUp: false, port: ligado.port, token, server: ligado.server, host, hostPedido };
}
