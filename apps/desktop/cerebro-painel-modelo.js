/**
 * Aba "Cérebro", modo Painel — a parte PURA (sem DOM, sem relógio próprio): filtro, ordenação,
 * séries dos KPIs, faixa da linha do tempo, resultado de um disparo e marcação dos termos que
 * bateram no "Testar gatilhos". Testada em apps/desktop/test/cerebro-painel-modelo.test.js.
 */

export const TIPOS_DO_PAINEL = [
  { tipo: "ferramenta", rotulo: "ferramenta" },
  { tipo: "skill", rotulo: "skill" },
  { tipo: "agente", rotulo: "agente" },
  { tipo: "time", rotulo: "time" },
  { tipo: "memoria", rotulo: "memória" },
  { tipo: "doc", rotulo: "doc" },
  { tipo: "mcp-externo", rotulo: "mcp-externo" },
];

export const ESTADOS = [
  { estado: "ligada", rotulo: "ligada" },
  { estado: "desligada", rotulo: "desligada" },
  { estado: "nunca", rotulo: "nunca usada" },
  { estado: "gatilho", rotulo: "com gatilho" },
];

/** Disparo sem uso ainda, mais novo que isto, está "esperando" (a janela fecha em 3 mensagens). */
export const ESPERANDO_MS = 15 * 60_000;

export const nuncaUsada = (c) => !c.ultimoUso && (c.usos30d ?? 0) === 0;
export const ignorados = (c) => Math.max(0, (c.disparos30d ?? 0) - (c.usosAposDisparo30d ?? 0));
const soma = (xs) => (xs ?? []).reduce((s, n) => s + (n || 0), 0);

/** Sem acento e em minúsculas, mantendo o tamanho do texto (1 caractere → 1 caractere). */
export function normalizarMesmoTamanho(s) {
  let out = "";
  for (const ch of String(s)) {
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    out += (base.length === 1 ? base : ch).toLowerCase();
  }
  return out;
}

/**
 * @param {Array} itens catálogo
 * @param {object} f { busca, tipos:Set, estados:Set, usadas7d:boolean, ids:Set|null }
 * Tipos e estados vazios = sem filtro. Estados combinam por E (ligada + com gatilho = as duas).
 */
export function filtrar(itens, f = {}) {
  const busca = normalizarMesmoTamanho(f.busca ?? "").trim();
  return itens.filter((c) => {
    if (f.ids && !f.ids.has(c.id)) return false;
    if (f.tipos?.size && !f.tipos.has(c.tipo)) return false;
    if (f.usadas7d && !((c.usos7d ?? 0) > 0)) return false;
    for (const e of f.estados ?? []) {
      if (e === "ligada" && c.ligada === false) return false;
      if (e === "desligada" && c.ligada !== false) return false;
      if (e === "nunca" && !nuncaUsada(c)) return false;
      if (e === "gatilho" && !(c.gatilhos?.length > 0)) return false;
    }
    if (busca) {
      const alvo = normalizarMesmoTamanho(`${c.nome} ${c.descricao ?? ""} ${(c.gatilhos ?? []).join(" ")} ${c.tipo}`);
      if (!busca.split(/\s+/).every((t) => alvo.includes(t))) return false;
    }
    return true;
  });
}

const CHAVES = {
  tipo: (c) => TIPOS_DO_PAINEL.findIndex((t) => t.tipo === c.tipo),
  nome: (c) => c.nome.toLowerCase(),
  gatilhos: (c) => c.gatilhos?.length ?? 0,
  tendencia: (c) => soma(c.porDia),
  usos: (c) => (c.usos30d ?? 0) * 1e6 + (c.usos7d ?? 0),
  disparos: (c) => (c.disparos30d ?? 0) * 1e6 + (c.usosAposDisparo30d ?? 0),
  ignorados: (c) => ignorados(c),
  ultimo: (c) => (c.ultimoUso ? Date.parse(c.ultimoUso) : 0),
  ligada: (c) => (c.ligada === false ? 0 : 1),
};
export const COLUNAS_ORDENAVEIS = Object.keys(CHAVES);

/** Ordena por uma coluna (`asc`/`desc`); empate = nome. Não muda a lista de entrada. */
export function ordenar(itens, { coluna = "usos", dir = "desc" } = {}) {
  const k = CHAVES[coluna] ?? CHAVES.usos;
  const sinal = dir === "asc" ? 1 : -1;
  return [...itens].sort((a, b) => {
    const x = k(a);
    const y = k(b);
    if (x < y) return -1 * sinal;
    if (x > y) return 1 * sinal;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });
}

export function contagemPorTipo(itens) {
  const out = Object.fromEntries(TIPOS_DO_PAINEL.map((t) => [t.tipo, 0]));
  for (const c of itens) out[c.tipo] = (out[c.tipo] ?? 0) + 1;
  return out;
}

/** Séries de 14 dias dos KPIs: usos totais, capacidades distintas usadas, disparos. */
export function seriesDosKpis(itens) {
  const z = () => Array.from({ length: 14 }, () => 0);
  const usos = z();
  const usadas = z();
  const disparos = z();
  for (const c of itens) {
    (c.porDia ?? []).forEach((n, i) => {
      usos[i] += n;
      if (n > 0) usadas[i] += 1;
    });
    (c.disparosPorDia ?? []).forEach((n, i) => (disparos[i] += n));
  }
  return { usos, usadas, disparos };
}

/** Alturas 0–100 de uma série, proporcional ao maior (mín. 6% pra barra não sumir quando há valor). */
export function alturas(serie) {
  const max = Math.max(0, ...serie);
  return serie.map((n) => (max && n ? Math.max(6, Math.round((n / max) * 100)) : 0));
}

export function tempoRelativo(iso, agora) {
  if (!iso) return "nunca";
  const d = agora - Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  if (d < 60_000) return "agora";
  const m = Math.round(d / 60_000);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function pctUsou(c) {
  const d = c.disparos30d ?? 0;
  return d ? Math.round(((c.usosAposDisparo30d ?? 0) / d) * 100) : null;
}

/** "usou" | "esperando" | "ignorou". */
export function resultadoDoDisparo(d, agora) {
  if (d.usou) return "usou";
  return agora - Date.parse(d.ts) < ESPERANDO_MS ? "esperando" : "ignorou";
}

export const JANELAS = {
  "24h": { ms: 24 * 3600_000, bins: 24, rotuloInicio: "24 h atrás" },
  "7d": { ms: 7 * 86_400_000, bins: 28, rotuloInicio: "7 d atrás" },
  "30d": { ms: 30 * 86_400_000, bins: 30, rotuloInicio: "30 d atrás" },
};

/** Disparos da janela, mais novo primeiro. */
export function disparosNaJanela(disparos, janela, agora, chave = null) {
  const j = JANELAS[janela] ?? JANELAS["24h"];
  return disparos.filter((d) => agora - Date.parse(d.ts) <= j.ms && (!chave || d.chave === chave));
}

/** Faixa da linha do tempo: `bins` colunas (mais antiga → agora), cada uma com os resultados. */
export function faixaDeDisparos(disparos, janela, agora) {
  const j = JANELAS[janela] ?? JANELAS["24h"];
  const largura = j.ms / j.bins;
  const bins = Array.from({ length: j.bins }, () => []);
  for (const d of disparos) {
    const idade = agora - Date.parse(d.ts);
    if (!(idade >= 0) || idade > j.ms) continue;
    const i = Math.min(j.bins - 1, j.bins - 1 - Math.floor(idade / largura));
    bins[i].push(resultadoDoDisparo(d, agora));
  }
  return bins;
}

/**
 * Pedaços do texto com os termos marcados (sem acento, sem caixa, palavra inteira). Pra pintar o
 * fundo das palavras que bateram, atrás do campo de "Testar gatilhos".
 */
export function trechosMarcados(texto, termos) {
  const t = normalizarMesmoTamanho(texto);
  const marcas = Array.from({ length: texto.length }, () => false);
  const letra = (ch) => /[\p{L}\p{N}_]/u.test(ch ?? " ");
  for (const termoBruto of termos ?? []) {
    const termo = normalizarMesmoTamanho(termoBruto).trim();
    if (!termo) continue;
    let i = t.indexOf(termo);
    while (i >= 0) {
      if (!letra(t[i - 1]) && !letra(t[i + termo.length])) for (let k = i; k < i + termo.length; k++) marcas[k] = true;
      i = t.indexOf(termo, i + 1);
    }
  }
  const out = [];
  for (let i = 0; i < texto.length; i++) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.marca === marcas[i]) ultimo.texto += texto[i];
    else out.push({ texto: texto[i], marca: marcas[i] });
  }
  return out;
}

/** Id de capacidade nova a partir do tipo e do nome (`doc:guia-de-uso`). */
export function idDeNova(tipo, nome) {
  const slug = normalizarMesmoTamanho(nome)
    .replace(/[^a-z0-9_.\/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug ? `${tipo}:${slug}` : "";
}

/** Linha que a capacidade nova ocuparia no bloco `# Cérebro` do pack. */
export function previaNoPack({ gatilhos = [], comoUsar = "", descricao = "" }) {
  const quando = gatilhos.length ? gatilhos.slice(0, 4).join(" / ") : descricao || "…";
  return `${quando} → ${comoUsar || "…"}`;
}

/** Próximo índice ao navegar com ↑/↓ (fica nas pontas). */
export function proximoIndice(atual, delta, total) {
  if (!total) return -1;
  if (atual < 0) return delta > 0 ? 0 : total - 1;
  return Math.max(0, Math.min(total - 1, atual + delta));
}
