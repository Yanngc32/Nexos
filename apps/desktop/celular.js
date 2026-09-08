import { hostNaUrl } from "./url.js";

/**
 * O texto do painel Celular: onde o celular alcança o Nexo, e o que está no
 * caminho quando não alcança.
 *
 * Está num módulo próprio porque tem regra e ordem, e porque `renderer.js` não
 * tem teste. O daemon descobre os endereços sozinho e os mantém em dia enquanto
 * roda, então isto não é mais "o que você configurou" — é um relatório do que
 * está de pé agora.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const TUDO = new Set(["0.0.0.0", "::"]);

/** Os endereços por onde um celular chega — loopback não conta. */
export function alcancaveis(hosts = []) {
  return hosts.filter((h) => !LOOPBACK.has(h));
}

/**
 * Frase de estado. Dita no presente, porque é presente: nada aqui depende de
 * reiniciar nada.
 *
 * @param escuta `{ hosts, falhas, melhor, port }` de `GET /v1/escuta`
 */
export function celAlcance(escuta) {
  const hosts = escuta?.hosts ?? [];
  const porta = escuta?.port || 7432;
  if (!hosts.length) return "O Nexo não está escutando. Ligue o motor no rodapé.";
  if (TUDO.has(hosts[0])) {
    return `Escutando na rede inteira, na porta ${porta}. Qualquer um que alcance esta máquina depende só do token.`;
  }
  const fora = alcancaveis(hosts);
  if (!fora.length) {
    return `Só esta máquina alcança. Ligue seu túnel (Tailscale, WireGuard) e o Nexo entra nele sozinho, em segundos, sem reiniciar nada.`;
  }
  return `Alcançável em ${fora.map((h) => `${hostNaUrl(h)}:${porta}`).join(" e ")} — quem estiver no seu túnel chega, e mais ninguém.`;
}

/**
 * O aviso, quando há um. Vazio é o caso bom, e o caso bom não merece linha.
 *
 * A ordem é o conteúdo: falha de endereço vem antes de tudo, porque é a única
 * coisa aqui que a pessoa não tem como adivinhar olhando a tela.
 */
export function celAviso(escuta) {
  const falhas = escuta?.falhas ?? [];
  const hosts = escuta?.hosts ?? [];
  if (falhas.length) {
    const lista = falhas.map((f) => `${f.host} (${f.motivo})`).join(", ");
    return `Não consegui escutar em ${lista}. Se for o endereço do seu túnel, ele deve estar fora do ar — quando voltar, o Nexo entra sozinho.`;
  }
  if (TUDO.has(hosts[0])) {
    return "Atenção: escutar em toda a rede deixa o token como única barreira. Não faça isso em Wi-Fi compartilhado.";
  }
  // só loopback NÃO é aviso: é o padrão, e a frase de alcance já diz o que fazer
  return "";
}
