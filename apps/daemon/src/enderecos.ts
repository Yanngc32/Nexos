import { networkInterfaces } from "node:os";

/**
 * Onde o daemon PODE ser alcançado, descoberto em vez de digitado.
 *
 * A versão anterior te fazia rodar `tailscale ip -4`, colar o endereço num
 * campo e reiniciar o motor. Três passos pra uma informação que a máquina já
 * tem — e que muda sozinha quando o túnel sobe, cai ou troca de IP.
 *
 * O que decide o que serve é a CLASSE do endereço, não o nome da interface:
 *
 * - **túnel** é o que a gente quer. Tailscale usa o bloco CGNAT `100.64/10` no
 *   IPv4 e `fd7a:115c:a1e0::/48` no IPv6 — os dois são reconhecíveis pelo
 *   endereço, sem depender do nome da interface. Pra WireGuard puro não há
 *   bloco reservado (o endereço é escolhido por quem configura), então aí sim
 *   cai no nome da interface (`wg0`, `tun0`, `utun3`, `wt0` no Windows).
 * - **LAN** (`192.168/16`, `10/8`, `172.16/12`) fica de FORA por padrão. É o
 *   Wi-Fi compartilhado do café, e publicar ali é escolha, não conveniência.
 * - **link-local** (`169.254/16`, `fe80::/10`) fica de fora: não é roteável e
 *   IPv6 link-local precisa de `%zona` na URL, que nenhum celular vai digitar.
 * - **loopback** é tratado à parte, porque é o único obrigatório: é por ele que
 *   o app do desktop fala com o daemon.
 * - **público** fica de fora, sempre. Máquina com IP público de verdade
 *   publicaria o Nexo na internet, e isso nunca é um padrão aceitável.
 */

export type Classe = "loopback" | "tunel" | "lan" | "link-local" | "publico";

export type Endereco = {
  host: string;
  classe: Classe;
  /** Nome da interface, só pra explicar na tela de onde saiu. */
  interface: string;
};

/** Interfaces cujo nome denuncia um túnel quando o endereço não denuncia. */
const NOME_DE_TUNEL = /^(wg|tun|utun|tailscale|nordlynx|proton|zt|wt)/i;

const LOOPBACK_HOST = new Set(["127.0.0.1", "localhost", "::1"]);

function octetos(host: string): number[] {
  return host.split(".").map(Number);
}

/** `true` se `host` está no bloco IPv4 `a.b.c.d/bits`. */
function dentro(host: string, bloco: string, bits: number): boolean {
  const h = octetos(host);
  const b = octetos(bloco);
  if (h.length !== 4 || h.some((n) => !Number.isInteger(n))) return false;
  const mascara = -1 << (32 - bits);
  const num = (o: number[]) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return ((num(h) ^ num(b)) & mascara) >>> 0 ? false : true;
}

export function classificar(host: string, nomeDaInterface = ""): Classe {
  const h = host.trim().toLowerCase().split("%")[0] ?? "";
  const v6 = h.includes(":");

  // `localhost` é nome, não endereço, mas o config aceita e o resto daqui
  // pensa em números — sem esta linha ele cairia em "publico"
  if (h === "localhost" || h === "::1" || dentro(h, "127.0.0.0", 8)) return "loopback";
  if (v6) {
    if (h.startsWith("fe80")) return "link-local";
    // o /48 do Tailscale; o resto do fc00::/7 é ULA de rede local
    if (h.startsWith("fd7a:115c:a1e0")) return "tunel";
    if (NOME_DE_TUNEL.test(nomeDaInterface)) return "tunel";
    if (h.startsWith("fc") || h.startsWith("fd")) return "lan";
    return "publico";
  }
  if (dentro(h, "169.254.0.0", 16)) return "link-local";
  if (dentro(h, "100.64.0.0", 10)) return "tunel";
  if (NOME_DE_TUNEL.test(nomeDaInterface)) return "tunel";
  if (dentro(h, "10.0.0.0", 8) || dentro(h, "192.168.0.0", 16) || dentro(h, "172.16.0.0", 12)) return "lan";
  return "publico";
}

type Bruto = Record<string, { address: string; internal: boolean; family: string | number }[] | undefined>;

/**
 * Tudo que a máquina tem, classificado. `ler` entra por parâmetro porque o
 * resultado depende da máquina, e teste que depende da máquina onde roda não
 * prova nada.
 */
export function enderecosDaMaquina(ler: () => Bruto = networkInterfaces): Endereco[] {
  const achados: Endereco[] = [];
  const vistos = new Set<string>();
  for (const [nome, lista] of Object.entries(ler())) {
    for (const item of lista ?? []) {
      const host = item.address.split("%")[0] ?? "";
      if (!host || vistos.has(host)) continue;
      vistos.add(host);
      achados.push({ host, classe: classificar(host, nome), interface: nome });
    }
  }
  return achados;
}

/**
 * Quão bom um endereço é pro QR do celular. Menor = melhor.
 *
 * IPv4 do Tailscale primeiro: o IPv6 (`fd7a:115c:…`) entra na escuta, mas o
 * QR com ele falha calado no telefone — colchete, Happy Eyeballs, IPv6 do
 * app Tailscale desligado. CGNAT `100.64/10` que NÃO é Tailscale (WireGuard
 * `wt0`, ISP) fica atrás: o celular está no tailnet, não nesse outro túnel.
 */
export function scoreAlcance(host: string, enderecos: Endereco[] = []): number {
  if (LOOPBACK_HOST.has(host) || host === "0.0.0.0" || host === "::") return 99;
  const v6 = host.includes(":");
  const ifacesTs = new Set(
    enderecos.filter((x) => x.host.toLowerCase().startsWith("fd7a:115c:a1e0")).map((x) => x.interface),
  );
  const info = enderecos.find((x) => x.host === host);
  const noTs = /tailscale/i.test(info?.interface ?? "") || (info ? ifacesTs.has(info.interface) : false);
  if (!v6 && noTs) return 0;
  if (!v6) return 1;
  if (noTs) return 2;
  return 3;
}

/** O host que o QR deve carregar: túnel IPv4 do Tailscale, se houver. */
export function escolherHostDoCelular(hosts: string[], enderecos: Endereco[] = []): string | undefined {
  const candidatos = hosts.filter((h) => !LOOPBACK_HOST.has(h));
  if (!candidatos.length) return hosts[0];
  return [...candidatos].sort(
    (a, b) => scoreAlcance(a, enderecos) - scoreAlcance(b, enderecos) || a.localeCompare(b),
  )[0];
}

/**
 * Os endereços em que o daemon deve escutar, em ordem: loopback primeiro, depois
 * os túneis do melhor pro pior pro celular (IPv4 do Tailscale antes de IPv6).
 *
 * `extra` é o que você escreveu à mão no config — entra mesmo que a
 * classificação não goste dele, porque escolha explícita ganha de heurística.
 * `0.0.0.0` e `::` são o caso especial: eles JÁ incluem todo o resto, e tentar
 * ligar o loopback junto daria `EADDRINUSE`.
 */
export function ondeEscutar(enderecos: Endereco[], extra = ""): string[] {
  const manual = extra.trim();
  if (manual === "0.0.0.0" || manual === "::") return [manual];

  const alvos = ["127.0.0.1"];
  const juntar = (h: string) => {
    // a guarda é contra DUPLICATA, não contra a classe: `127.0.0.2` é um
    // endereço diferente do `127.0.0.1` e ligar um não faz o outro atender.
    // `localhost` é o único nome que precisa de tratamento, porque resolve pro
    // endereço que já está na lista.
    if (h && h !== "localhost" && !alvos.includes(h)) alvos.push(h);
  };
  const tuneis = enderecos
    .filter((e) => e.classe === "tunel")
    .sort(
      (a, b) => scoreAlcance(a.host, enderecos) - scoreAlcance(b.host, enderecos) || a.host.localeCompare(b.host),
    );
  for (const e of tuneis) juntar(e.host);
  juntar(manual);
  return alvos;
}
