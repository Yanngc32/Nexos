import { DEFAULT_CONFIG } from "@nexo/shared";

/**
 * Onde o daemon REALMENTE está escutando.
 *
 * Existe porque as duas coisas não podem ser a mesma: `config.host` é o que
 * você pediu, e só vale a partir da próxima subida; isto é o que aconteceu.
 * Elas divergem em dois casos comuns — você acabou de mudar o endereço e ainda
 * não reiniciou, ou o endereço pedido não existia e o `startDaemon` caiu pro
 * loopback.
 *
 * A tela precisa disto, e não do config, porque é ela que desenha o QR: um QR
 * com o endereço que você *queria* leva o celular a um lugar onde não há
 * ninguém, e ele falha calado. Endereço em QR tem que ser o de verdade.
 *
 * Estado de módulo em vez de campo do `createApp` porque o app é construído
 * ANTES de escutar — o servidor precisa existir pra poder ligar.
 */
type Escuta = { host: string; hostPedido?: string };

let atual: Escuta = { host: DEFAULT_CONFIG.host };

export function registrarEscuta(e: Escuta): void {
  atual = e;
}

export function escutaAtual(): Escuta {
  return atual;
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetEscutaForTest(): void {
  atual = { host: DEFAULT_CONFIG.host };
}
