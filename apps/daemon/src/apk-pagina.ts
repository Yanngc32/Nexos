/**
 * Página que `GET /apk` devolve — HTML solto, de propósito, e não a SPA de
 * `/app/`: quem chega aqui é um celular que ainda NÃO tem o Nexos instalado, às
 * vezes sem nem abrir o navegador antes, e a página tem que se explicar
 * sozinha sem depender de módulo nenhum carregando certo.
 *
 * Duas variantes só, porque é tudo que existe pra mostrar nesta fase: o
 * código não serviu, ou serviu mas o build do APK ainda não existe (Fase 2 do
 * plano, ainda não construída). Quando o build existir, esta função ganha uma
 * terceira variante com o link do artefato e o sha256 — não antes.
 */

export type EstadoApk = { tipo: "erro"; motivo: string } | { tipo: "sem-build" };

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<title>${titulo}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #141417; color: #ececef;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .cartao { max-width: 360px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 8px; color: #9b9ba4; }
</style>
</head>
<body><div class="cartao">${corpo}</div></body>
</html>`;
}

export function paginaApk(estado: EstadoApk): string {
  if (estado.tipo === "erro") {
    return pagina("Nexos — código inválido", `<h1>Código inválido</h1><p>${escapar(estado.motivo)}</p>`);
  }
  return pagina(
    "Nexos — APK",
    `<h1>Ainda não tem build pronto</h1><p>Peça um código novo no computador quando o build do APK existir.</p>`,
  );
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
