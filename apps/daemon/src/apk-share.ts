import { randomInt } from "node:crypto";
import { APK_CODE_LEN, APK_MAX_ERROS, APK_TTL_MS, PAIR_ALFABETO, normalizarCodigo } from "@nexos/shared";

/**
 * Código de download do APK Android.
 *
 * O problema que o pareamento (`pair.ts`) resolve não serve aqui: pareamento
 * entrega um SEGREDO PERMANENTE (o token) a troco de um código; baixar o APK
 * não entrega segredo nenhum — só deixa um celular AINDA SEM O APP buscar um
 * arquivo por um tempo curto. Mas a rota de resgate (`GET /apk`) é, pela mesma
 * razão, NÃO-AUTENTICADA — precisa funcionar num celular que nunca teve o
 * token — e isso a põe na mesma classe de risco do `POST /pair`. Mesma classe,
 * mesma trava:
 *
 * - vale alguns minutos;
 * - serve UMA vez (some no primeiro resgate certo);
 * - erro demais queima o código, não a conta.
 *
 * Estado PRÓPRIO, e não o `vivo` de `pair.ts`: pareamento e download de APK
 * podem estar abertos ao mesmo tempo (a pessoa mostra os dois QRs em telas
 * diferentes), e reusar o mesmo slot faria abrir um fechar o outro.
 *
 * O QR aqui carrega ENDEREÇO + CÓDIGO, nunca a URL do artefato com o hash
 * embutido — o gerador de QR do desktop (`qr.js`) é de mão, capado em ~213
 * bytes (byte mode, correção M, versão 10), e `URL completa + sha256 (64 hex)`
 * não cabe com folga nenhuma. O código curto resolve isso do mesmo jeito que
 * resolve pro pareamento: o navegador do celular busca `GET /apk?c=CODIGO`, e
 * é o daemon que devolve endereço do artefato e hash, não o QR.
 */

export type DownloadAberto = { codigo: string; expiraEm: number };

type Vivo = { codigo: string; expiraEm: number; erros: number };

let vivo: Vivo | null = null;

function sortear(): string {
  let s = "";
  for (let i = 0; i < APK_CODE_LEN; i++) s += PAIR_ALFABETO[randomInt(0, PAIR_ALFABETO.length)];
  return s;
}

/** Abre um código de download e invalida o anterior. */
export function abrirDownload(agora = Date.now()): DownloadAberto {
  vivo = { codigo: sortear(), expiraEm: agora + APK_TTL_MS, erros: 0 };
  return { codigo: vivo.codigo, expiraEm: vivo.expiraEm };
}

/** O download aberto, se ainda vale. Serve pra tela mostrar o tempo restante. */
export function downloadAberto(agora = Date.now()): DownloadAberto | null {
  if (!vivo || vivo.expiraEm <= agora) return null;
  return { codigo: vivo.codigo, expiraEm: vivo.expiraEm };
}

export function fecharDownload(): void {
  vivo = null;
}

export type Resgate = { ok: true } | { ok: false; motivo: string };

/**
 * Troca o código pelo direito de baixar o artefato — quem serve o artefato
 * (ou o placeholder, enquanto o build não existe) é a rota.
 *
 * Comparação em tempo constante pela mesma razão do pareamento: o código é
 * curto, e um vazamento de tempo diria quantos caracteres já batem.
 */
export function resgatarDownload(codigo: unknown, agora = Date.now()): Resgate {
  if (!vivo || vivo.expiraEm <= agora) {
    fecharDownload();
    return { ok: false, motivo: "nenhum download aberto — peça um código novo no computador" };
  }
  const tentativa = typeof codigo === "string" ? normalizarCodigo(codigo) : "";
  if (!igual(tentativa, vivo.codigo)) {
    vivo.erros++;
    if (vivo.erros >= APK_MAX_ERROS) {
      fecharDownload();
      return { ok: false, motivo: "código errado demais — peça um novo no computador" };
    }
    return { ok: false, motivo: "código errado" };
  }
  // uso único: código reusável seria um link permanente, e o QR não é isso
  fecharDownload();
  return { ok: true };
}

function igual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetApkShareForTest(): void {
  vivo = null;
}
