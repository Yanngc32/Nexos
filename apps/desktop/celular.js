/**
 * O aviso do painel Celular.
 *
 * Está num módulo próprio porque tem regra e ordem, e porque `renderer.js` não
 * tem teste: são quatro situações que a pessoa não tem como adivinhar olhando a
 * tela, e a ordem entre elas é o conteúdo. O que manda é o endereço em que o
 * daemon está ESCUTANDO — o campo mostra o que foi pedido, e os dois divergem
 * com frequência.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const TUDO = new Set(["0.0.0.0", "::"]);

/**
 * @param real onde o daemon escuta agora
 * @param pedido o que está no config (o valor do campo)
 * @param falhou o endereço que o daemon TENTOU e não existia, se houve
 */
export function celAviso(real, pedido, falhou) {
  // primeiro a falha de verdade: sua escolha não valeu, e sem isto escrito a
  // tela mostraria o endereço do túnel como se estivesse valendo
  if (falhou) {
    return `Não consegui escutar em ${falhou} — esse endereço não existe nesta máquina agora (túnel fora do ar? IP mudou?). O Nexo subiu em ${real}, e do celular ninguém alcança até o endereço voltar.`;
  }
  // depois a espera: você mudou o campo e ainda não reiniciou o motor
  if (pedido && real && pedido !== real) {
    return `Salvo: ${pedido}. Ainda escutando em ${real} — vale a partir da próxima subida, e o QR só muda depois disso.`;
  }
  if (TUDO.has(real)) {
    return "Atenção: assim o Nexo é publicado na rede inteira, e o token é a única barreira. Não faça isso em Wi-Fi compartilhado.";
  }
  if (LOOPBACK.has(real)) {
    return "Assim só esta máquina alcança. Ponha o IP do túnel pra conectar do celular.";
  }
  return "";
}
