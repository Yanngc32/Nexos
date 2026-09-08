/**
 * Lógica pura do inspector de elemento do painel Browser: gerar um seletor legível pro
 * elemento clicado e truncar o que vira texto (`capturarElemento`, chamado no clique).
 *
 * CJS (não `.js`/ESM como o resto do desktop) porque quem consome isto na Electron é
 * `browser-inspector-preload.cjs`, um preload — só enxerga `require`. Fica num arquivo à
 * parte porque é a única fatia disto testável sem Electron nem `<webview>` de verdade.
 *
 * A composição da mensagem final (`montarMensagem`) mora em `inspector-mensagem.js`, não
 * aqui: quem chama ela é `renderer.js`, que carrega como ESM de navegador puro
 * (`<script type="module">`, sem Node) — não entende `module.exports`/`require` deste
 * arquivo.
 */

const MAX_HTML = 300;
const MAX_TEXTO = 150;

/**
 * Classe que parece gerada por ferramenta (hash de CSS-in-JS, CSS Modules) não ajuda o
 * agente a localizar nada no código-fonte — é ruído. Heurística, não perfeita: descarta
 * prefixo comum de gerador (`css-`, `sc-`, `emotion-`, `jsx-`, `_`), sufixo de CSS Modules
 * (`__abc123`) e classe que é só um hash hex.
 */
const CLASSE_GERADA_RE = /^(css-|sc-|emotion-|jsx-|_)|__[a-z0-9]{5,}$|^[a-f0-9]{6,}$/i;

function classesEstaveis(el) {
  const lista = el?.classList ? Array.from(el.classList) : [];
  return lista.filter((c) => !CLASSE_GERADA_RE.test(c)).slice(0, 2);
}

/** Um segmento do seletor: id (mais específico) > poucas classes estáveis > posição entre irmãos do mesmo tipo. */
function segmentoDe(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `#${el.id}`;
  const classes = classesEstaveis(el);
  if (classes.length) return `${tag}.${classes.join(".")}`;
  const pai = el.parentElement;
  if (!pai) return tag;
  // conta só os irmãos do MESMO tipo (não é nth-child de CSS de verdade — é contexto legível
  // pro agente, tipo "o segundo <li>", não uma query que precise bater exato)
  const irmaosMesmoTipo = Array.from(pai.children).filter((c) => c.tagName === el.tagName);
  if (irmaosMesmoTipo.length <= 1) return tag;
  return `${tag}:nth-child(${irmaosMesmoTipo.indexOf(el) + 1})`;
}

/**
 * Sobe do elemento até `maxAncestrais` níveis, ou até achar um `#id` (já específico o
 * bastante, não precisa subir mais). Não precisa ser um seletor CSS globalmente único —
 * é contexto pro agente localizar o componente no código, não uma query real.
 */
function gerarSeletor(el, maxAncestrais = 4) {
  const partes = [];
  let atual = el;
  let nivel = 0;
  // <html>/<body> nunca ajudam o agente a localizar nada — para antes deles, não só no teto
  const raiz = el?.ownerDocument?.body;
  while (atual && atual.nodeType === 1 && atual !== raiz && atual.tagName !== "HTML" && nivel < maxAncestrais) {
    partes.unshift(segmentoDe(atual));
    if (atual.id) break;
    atual = atual.parentElement;
    nivel++;
  }
  return partes.join(" > ");
}

/** Corte simples por caractere — o texto é informativo, ninguém reparseia isto como HTML/DOM. */
function truncar(s, max) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function outerHtmlResumido(el, max = MAX_HTML) {
  return truncar(el?.outerHTML, max);
}

function textoVisivel(el, max = MAX_TEXTO) {
  const bruto = String(el?.textContent ?? "").trim().replace(/\s+/g, " ");
  return truncar(bruto, max);
}

/** O que sai do clique dentro do preview, pronto pra mandar pro host via `sendToHost`. */
function capturarElemento(el) {
  return {
    tag: el.tagName.toLowerCase(),
    seletor: gerarSeletor(el),
    outerHtml: outerHtmlResumido(el),
    texto: textoVisivel(el),
  };
}

module.exports = {
  classesEstaveis,
  gerarSeletor,
  truncar,
  outerHtmlResumido,
  textoVisivel,
  capturarElemento,
};
