/**
 * Arquivo da conversa — o que a pessoa anexa no composer e o que o agente entrega
 * (`nexo_arquivo_entregar`). Só classificação e regra, sem DOM: o renderer desenha.
 *
 * O mime vem do daemon (decidido pela extensão, ver daemon/attachments.ts), não do que o
 * navegador declarou no upload.
 */

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Mesmos tetos do daemon (`ATTACH_MAX_BYTES`, `ATTACH_MAX_PER_MESSAGE` em @nexos/shared). */
export const ANEXO_MAX_BYTES = 25 * 1024 * 1024;
export const ANEXO_MAX_POR_MENSAGEM = 6;

/** Planilha que o visualizador do daemon abre como tabela (xls antigo, binário, não). */
const EXT_PLANILHA = new Set(["xlsx", "xlsm"]);

/**
 * O que o preview (painel Browser) sabe mostrar; `outro` só baixa. O nome entra pra planilha:
 * anexo antigo de xlsm ficou gravado como octet-stream.
 */
export function tipoDoArquivo(mime, nome = "") {
  const m = String(mime || "").toLowerCase();
  if (m.includes("spreadsheetml") || m.includes("sheet.macroenabled") || EXT_PLANILHA.has(extensaoDoNome(nome))) return "planilha";
  if (m === "text/html" || m === "image/svg+xml") return "pagina";
  if (m.startsWith("image/")) return "imagem";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || m === "application/json" || m === "application/yaml") return "texto";
  return "outro";
}

export function abreNoPreview(mime, nome = "") {
  return tipoDoArquivo(mime, nome) !== "outro";
}

/** Imagem que o chat desenha como miniatura (as que o daemon confere pela assinatura). */
export function ehMiniatura(anexo) {
  return IMAGE_MIMES.includes(anexo?.mime);
}

/** Extensão do nome, minúscula — é por ela que o desktop pede o ícone do Windows. */
export function extensaoDoNome(nome) {
  return /\.([a-z0-9]{1,10})$/i.exec(String(nome || ""))?.[1]?.toLowerCase() ?? "";
}

/** Selo curto do cartão: a extensão ("PDF", "CSV"), senão o tipo. Fica quando não há ícone. */
export function seloDoArquivo(nome, mime) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(nome || ""))?.[1];
  if (ext) return ext.toUpperCase();
  const tipo = tipoDoArquivo(mime);
  return tipo === "outro" ? "ARQ" : tipo.toUpperCase().slice(0, 4);
}

export function fmtTamanho(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Separa o que entra no composer do que é recusado (com motivo). `ja` = quantos já estão
 * pendentes. Qualquer tipo entra; o teto é de tamanho e de quantidade.
 */
export function triarAnexos(files, ja = 0) {
  const aceitos = [];
  const erros = [];
  let total = ja;
  for (const file of files) {
    if (!file) continue;
    const nome = file.name || "arquivo";
    if (!file.size) {
      erros.push(`${nome}: arquivo vazio`);
      continue;
    }
    if (file.size > ANEXO_MAX_BYTES) {
      erros.push(`${nome}: passa de ${ANEXO_MAX_BYTES / (1024 * 1024)} MB`);
      continue;
    }
    if (total >= ANEXO_MAX_POR_MENSAGEM) {
      erros.push(`no máximo ${ANEXO_MAX_POR_MENSAGEM} arquivos por mensagem`);
      break;
    }
    aceitos.push(file);
    total += 1;
  }
  return { aceitos, erros };
}
