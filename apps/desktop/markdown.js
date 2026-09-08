/**
 * Markdown mínimo, sem dependência: a CSP da janela é `default-src 'self'`, então
 * nada de biblioteca de CDN. Isto renderiza texto que vem do modelo — é a
 * fronteira mais sensível do app, e a razão de morar num módulo próprio com
 * teste: `escapeHtml` roda ANTES de qualquer formatação, sempre.
 */

// Escapa aspas também: o resultado entra em valor de atributo em vários pontos
// (href do markdown, class, data-*). Sem isso, texto do modelo com `"` fecha o
// atributo e injeta outro — o CSP barra o handler, mas a saída já sai torta.
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escapa primeiro, formata depois: nada do modelo entra como HTML. */
export function mdInline(raw) {
  let t = escapeHtml(raw);
  // code inline sai de cena antes de bold/itálico, senão * dentro de código formata
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // link só https/http; o href já está escapado por escapeHtml
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext="1">$1</a>');
  return t.replace(/\uE000(\d+)\uE000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

function mdTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/** Blocos: código, tabela, título, lista, citação, régua, parágrafo. */
export function mdToHtml(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const flushList = (tag, items) => {
    out.push(`<${tag}>${items.map((li) => `<li>${mdInline(li)}</li>`).join("")}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      const cls = /^[a-z0-9+#-]{1,20}$/i.test(lang) ? ` class="lang-${lang.toLowerCase()}"` : "";
      out.push(`<pre${cls}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*(\*\s*){3,}$/.test(line) || /^\s*(-\s*){3,}$/.test(line) || /^\s*_{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    const head = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const level = head[1].length <= 2 ? 3 : head[1].length === 3 ? 4 : 5;
      out.push(`<h${level}>${mdInline(head[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.includes("|") && lines[i + 1] && isTableSep(lines[i + 1])) {
      const head2 = mdTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(mdTableRow(lines[i]));
        i += 1;
      }
      const th = head2.map((c) => `<th>${mdInline(c)}</th>`).join("");
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      flushList("ul", items);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      flushList("ol", items);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${mdInline(buf.join("\n")).replace(/\n/g, "<br />")}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${mdInline(buf.join("\n")).replace(/\n/g, "<br />")}</p>`);
  }

  return out.join("");
}

/** Links do markdown abrem no navegador do sistema, não dentro do app. */
export function wireExternalLinks(root) {
  for (const a of root.querySelectorAll('a[data-ext="1"]')) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) void window.nexo?.openExternal?.(href).catch(() => {});
    });
  }
}

/**
 * Renderiza markdown dentro de um elemento e liga os links externos.
 *
 * Mora aqui, e não no renderer, porque depende de `wireExternalLinks`: quando as
 * duas ficaram em módulos diferentes o renderer chamou uma função que não
 * enxergava mais, e todo render de resposta estourava. Juntas, não dá.
 */
export function renderMd(el, text) {
  el.innerHTML = mdToHtml(text);
  wireExternalLinks(el);
}
