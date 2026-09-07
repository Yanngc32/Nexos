import { randomInt } from "node:crypto";
import { PAIR_ALFABETO, PAIR_CODE_LEN, PAIR_MAX_ERROS, PAIR_TTL_MS, normalizarCodigo } from "@nexo/shared";

/**
 * Pareamento do celular.
 *
 * O problema: pra falar com o daemon o celular precisa do token, que tem 48
 * caracteres hex e mora num arquivo `0600`. Ninguém digita isso no telefone.
 *
 * A solução é a de aparelho de TV: o desktop mostra um código curto, o celular
 * manda, e o daemon troca o código pelo token. A tela do desktop mostra também
 * um QR, mas com o ENDEREÇO e o CÓDIGO dentro — nunca o token. É essa diferença
 * que torna o QR aceitável: quem fotografa a tela leva um segredo que expira em
 * 2 minutos e serve uma vez, e não uma credencial permanente.
 *
 * Isto é a ÚNICA rota de escrita sem autenticação do daemon, então as travas
 * são o que a torna defensável:
 *
 * - vale 2 minutos;
 * - serve UMA vez (some no primeiro resgate);
 * - 5 tentativas erradas queimam o código, não a conta.
 *
 * Dá 5 chances em 32^6 (mais de um bilhão) pra quem já consegue alcançar a
 * porta — e alcançar a porta já exige estar no túnel ou na LAN. O teto de erros
 * continua sendo a trava principal: sem ele, nenhum segredo que caiba em seis
 * caracteres sobrevive a um varrimento. O alfabeto de 32 só encarece cada
 * chance, o que é barato de fazer e não custa nada a quem digita.
 *
 * Um código por vez, de propósito: pedir um novo invalida o anterior. Vários
 * códigos vivos multiplicariam as chances de acerto sem servir pra nada — quem
 * pareia está com o celular na mão, agora.
 */

export type Pareamento = { codigo: string; expiraEm: number };

type Vivo = { codigo: string; expiraEm: number; erros: number };

let vivo: Vivo | null = null;

/**
 * Um caractere por sorteio, do CSPRNG.
 *
 * `randomInt` com teto potência de dois seria uniforme de graça, mas 32 já é
 * potência de dois e ele descarta o resto de qualquer jeito — não há viés a
 * corrigir aqui, e sortear caractere por caractere é o que deixa o alfabeto
 * trocável sem refazer a conta.
 */
function sortear(): string {
  let s = "";
  for (let i = 0; i < PAIR_CODE_LEN; i++) s += PAIR_ALFABETO[randomInt(0, PAIR_ALFABETO.length)];
  return s;
}

/** Abre um pareamento e invalida o anterior. */
export function abrirPareamento(agora = Date.now()): Pareamento {
  vivo = { codigo: sortear(), expiraEm: agora + PAIR_TTL_MS, erros: 0 };
  return { codigo: vivo.codigo, expiraEm: vivo.expiraEm };
}

/** O pareamento aberto, se ainda vale. Serve pra tela mostrar o tempo restante. */
export function pareamentoAberto(agora = Date.now()): Pareamento | null {
  if (!vivo || vivo.expiraEm <= agora) return null;
  return { codigo: vivo.codigo, expiraEm: vivo.expiraEm };
}

export function fecharPareamento(): void {
  vivo = null;
}

export type Resgate = { ok: true } | { ok: false; motivo: string };

/**
 * Troca o código pelo direito de receber o token. Quem entrega o token é a
 * rota — aqui só se decide se pode.
 *
 * Comparação em tempo constante: o código é curto e um vazamento de tempo
 * diria quantos dígitos já batem, o que transformaria 10^6 em 10×6.
 */
export function resgatar(codigo: unknown, agora = Date.now()): Resgate {
  if (!vivo || vivo.expiraEm <= agora) {
    // mesma mensagem pra "não existe" e "expirou": distinguir contaria a quem
    // está adivinhando se vale a pena continuar tentando
    fecharPareamento();
    return { ok: false, motivo: "nenhum pareamento aberto — peça um código novo no computador" };
  }
  // normaliza antes de comparar: quem digitou "ab3-k9z" ou "AB3K9Z" acertou os
  // dois, e o I que a pessoa leu no lugar do 1 não deve custar uma tentativa
  // o tipo é checado antes de normalizar: `String({})` daria "[object Object]",
  // que virava "0BJECT" e passava por código plausível — corpo malformado é
  // corpo malformado, não um chute
  const tentativa = typeof codigo === "string" ? normalizarCodigo(codigo) : "";
  if (!igual(tentativa, vivo.codigo)) {
    vivo.erros++;
    if (vivo.erros >= PAIR_MAX_ERROS) {
      fecharPareamento();
      return { ok: false, motivo: "código errado demais — peça um novo no computador" };
    }
    return { ok: false, motivo: "código errado" };
  }
  // serve uma vez: o token já saiu, e um código reusável seria um token curto
  fecharPareamento();
  return { ok: true };
}

function igual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetPairForTest(): void {
  vivo = null;
}
