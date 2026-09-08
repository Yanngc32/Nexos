import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { DEFAULT_CONFIG } from "@nexo/shared";
import { enderecosDaMaquina, escolherHostDoCelular, ondeEscutar } from "./enderecos.ts";

/**
 * Em quais endereços o daemon está escutando — e mantê-los em dia sem reiniciar.
 *
 * Antes havia um endereço só, escolhido no config, e mudá-lo exigia derrubar e
 * subir o motor. Isso era artefato da implementação, não necessidade: nada
 * impede um processo de ter vários sockets ligados na mesma porta em endereços
 * diferentes. Agora o loopback (por onde o app do desktop fala) fica sempre de
 * pé, e os endereços de túnel entram e saem por cima, enquanto o daemon roda.
 *
 * `religar` é IDEMPOTENTE, e é o que faz o resto ser simples: ela olha o que
 * deveria estar ligado, liga o que falta, desliga o que sobrou, e não mexe no
 * que já está certo. Chamar de novo sem nada ter mudado não faz nada. Por isso
 * dá pra chamá-la de um relógio sem medo — túnel que sobe cinco minutos depois
 * de o Nexo abrir é o caso comum, não a exceção.
 *
 * O loopback é o único obrigatório. Túnel fora do ar é situação normal (ele
 * volta), então falhar em ligá-lo é registrado e segue a vida — o daemon nunca
 * deixa de subir por causa de uma preferência de acesso pelo celular.
 */

export type Ligado = { host: string; server: Server };

export type Falha = { host: string; motivo: string };

export type Estado = {
  /** Onde está escutando de verdade, agora. */
  hosts: string[];
  /** O que tentou e não deu, com o motivo — é isto que a tela mostra. */
  falhas: Falha[];
  /** A porta EFETIVA. Com `--port 0` quem escolhe é o SO, e só ele sabe qual. */
  port: number;
};

type Fetch = Parameters<typeof serve>[0]["fetch"];

let ligados: Ligado[] = [];
let falhas: Falha[] = [];
let porta = 0;

function abrir(fetchHandler: Fetch, hostname: string, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    let pronto = false;
    const server = serve({ fetch: fetchHandler, hostname, port }, (info) => {
      if (pronto) return;
      pronto = true;
      resolve({ server: server as Server, port: Number(info.port) });
    }) as Server;
    server.on("error", (err) => {
      if (pronto) return;
      pronto = true;
      server.close();
      reject(err);
    });
  });
}

function fechar(l: Ligado): void {
  try {
    l.server.close();
  } catch {
    /* já estava fechado */
  }
}

/**
 * Deixa os sockets iguais ao que o mundo pede agora.
 *
 * O `port` vem por parâmetro em vez de ser lido do config porque o daemon pode
 * ter subido em porta diferente (`--port 0` nos testes), e escutar o endereço
 * novo em outra porta seria pior que não escutar.
 */
export async function religar(fetchHandler: Fetch, port: number, hostDoConfig = ""): Promise<Estado> {
  const manual = hostDoConfig.trim() === DEFAULT_CONFIG.host ? "" : hostDoConfig;
  const alvos = ondeEscutar(enderecosDaMaquina(), manual);

  for (const l of ligados.filter((l) => !alvos.includes(l.host))) fechar(l);
  ligados = ligados.filter((l) => alvos.includes(l.host));

  const novas: Falha[] = [];
  for (const host of alvos) {
    if (ligados.some((l) => l.host === host)) continue;
    try {
      /*
       * `porta || port`: com `--port 0` o SO escolhe, e os endereços seguintes
       * têm que usar a MESMA porta — túnel escutando em porta diferente do
       * loopback seria pior que túnel nenhum, porque a tela mostraria uma URL
       * que não atende.
       */
      const aberto = await abrir(fetchHandler, host, porta || port);
      porta = aberto.port;
      ligados.push({ host, server: aberto.server });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      novas.push({ host, motivo: e.code ?? e.message ?? "erro" });
    }
  }
  falhas = novas;
  return estadoAtual();
}

/** O servidor de um endereço, pra quem precisa esperar ele fechar. */
export function ligadoEm(host: string): Server | undefined {
  return ligados.find((l) => l.host === host)?.server;
}

export function estadoAtual(): Estado {
  // a ordem de `ligados` segue a de `ondeEscutar`: loopback primeiro
  return { hosts: ligados.map((l) => l.host), falhas, port: porta };
}

/** O endereço que a tela deve mostrar: o túnel se houver, senão o loopback. */
export function melhorHost(e: Estado = estadoAtual()): string {
  return escolherHostDoCelular(e.hosts, enderecosDaMaquina()) ?? e.hosts[0] ?? DEFAULT_CONFIG.host;
}

export function fecharTudo(): void {
  for (const l of ligados) fechar(l);
  ligados = [];
  falhas = [];
  porta = 0;
}

/**
 * Relógio que mantém os endereços em dia. É ele que faz "ligar o Tailscale
 * depois de abrir o Nexo" funcionar sem ninguém clicar em nada.
 *
 * 20 segundos porque o custo é uma varredura de interfaces (microssegundos) e
 * ninguém aceita esperar minuto pra ponte subir. `unref` pra não segurar o
 * processo vivo.
 */
const PERIODO_MS = 20_000;
let relogio: NodeJS.Timeout | null = null;

export function manterEmDia(fetchHandler: Fetch, port: number, hostDoConfig: () => string): void {
  pararDeManter();
  relogio = setInterval(() => {
    void religar(fetchHandler, port, hostDoConfig()).catch(() => {
      /* religar já engole falha por endereço; aqui é só a rede de segurança */
    });
  }, PERIODO_MS);
  relogio.unref?.();
}

export function pararDeManter(): void {
  if (relogio) clearInterval(relogio);
  relogio = null;
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetEscutaForTest(): void {
  pararDeManter();
  fecharTudo();
}
