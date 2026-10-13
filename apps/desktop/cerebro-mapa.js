/**
 * Aba "Cérebro", modo Mapa — o LAYOUT, puro (sem DOM, sem relógio): recebe o catálogo e devolve
 * posições, raios e arestas pra view desenhar em SVG.
 *
 * Radial, em três camadas: o centro (o Cérebro do projeto), o anel 1 com um hub por tipo de
 * capacidade e, ao redor de cada hub, as capacidades dele em leques concêntricos. Raio do nó cresce
 * com o uso em 30 dias; nunca usada = tracejada; desligada = apagada; com gatilho = anel. Setor com
 * muitas nunca usadas colapsa num nó "+N" (`expandidos` reabre).
 *
 * Testável sem navegador (apps/desktop/test/cerebro-mapa.test.js). Nada de WebGL nem lib.
 */

/** Ordem fixa dos tipos (sentido horário a partir do topo) e rótulos. */
export const TIPOS = [
  { tipo: "ferramenta", rotulo: "ferramentas" },
  { tipo: "skill", rotulo: "skills" },
  { tipo: "agente", rotulo: "agentes" },
  { tipo: "time", rotulo: "times" },
  { tipo: "memoria", rotulo: "memória" },
  { tipo: "doc", rotulo: "docs" },
  { tipo: "mcp-externo", rotulo: "MCP externos" },
];

export const RAIO_MIN = 6;
export const RAIO_MAX = 22;
export const RAIO_CENTRO = 34;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
/** Acima disto, as nunca usadas de um setor viram um nó "+N". */
export const NOS_PARA_COLAPSAR = 150;
/** Mesmo abaixo do teto geral, um setor com mais que isto de nunca usadas colapsa. */
export const NUNCA_POR_SETOR = 12;

export const nuncaUsada = (c) => !c.ultimoUso && (c.usos30d ?? 0) === 0;

/** Raio do nó pelo uso em 30 dias, proporcional ao maior do catálogo (raiz quadrada: área ~ uso). */
export function raioDoNo(usos30d, maior) {
  if (!maior || !usos30d) return RAIO_MIN;
  return RAIO_MIN + (RAIO_MAX - RAIO_MIN) * Math.sqrt(Math.min(1, usos30d / maior));
}

/**
 * Arestas capacidade→capacidade: uma cita a outra quando o `comoUsar` (ou a descrição) menciona o
 * nome de uma ferramenta/skill/agente do catálogo. Só nomes com 4+ caracteres, pra "doc" não casar tudo.
 */
export function citacoes(itens) {
  const porNome = new Map();
  for (const c of itens) {
    if ((c.tipo === "ferramenta" || c.tipo === "skill" || c.tipo === "agente") && c.nome.length >= 4) porNome.set(c.nome.toLowerCase(), c.id);
  }
  const out = [];
  const vistos = new Set();
  for (const c of itens) {
    const texto = `${c.comoUsar ?? ""} ${c.descricao ?? ""}`.toLowerCase();
    for (const [nome, id] of porNome) {
      if (id === c.id) continue;
      if (!texto.includes(nome)) continue;
      const chave = `${c.id}→${id}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      out.push({ de: c.id, para: id });
    }
  }
  return out;
}

const polar = (cx, cy, r, ang) => ({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });

/**
 * @param {Array} itens   capacidades do catálogo (`GET /v1/cerebro/catalogo`)
 * @param {object} o
 * @param o.largura/o.altura  tamanho do palco (px)
 * @param o.ocultos    Set de tipos escondidos pela legenda
 * @param o.expandidos Set de tipos cujo "+N" foi aberto
 */
export function layoutDoMapa(itens, { largura = 1000, altura = 520, ocultos = new Set(), expandidos = new Set() } = {}) {
  const cx = largura / 2;
  const cy = altura / 2;
  const base = Math.min(largura, altura);
  const r1 = Math.max(90, base * 0.24);
  const maior = Math.max(0, ...itens.map((c) => c.usos30d ?? 0));
  const colapsa = itens.length > NOS_PARA_COLAPSAR;
  const hubs = [];
  const nos = [];
  const arestas = [];
  const colapsados = [];
  const posPorId = new Map();

  TIPOS.forEach((t, i) => {
    const ang = -Math.PI / 2 + (i / TIPOS.length) * Math.PI * 2;
    const lista = itens.filter((c) => c.tipo === t.tipo);
    const oculto = ocultos.has(t.tipo);
    const hub = { tipo: t.tipo, rotulo: t.rotulo, n: lista.length, ang, oculto, r: lista.length ? 14 + Math.min(10, Math.sqrt(lista.length) * 2) : 14, ...polar(cx, cy, r1, ang) };
    hubs.push(hub);
    if (oculto || !lista.length) return;

    // o que vira nó e o que colapsa
    const nunca = lista.filter(nuncaUsada);
    const deveColapsar = !expandidos.has(t.tipo) && (colapsa || nunca.length > NUNCA_POR_SETOR) && nunca.length > 1;
    const visiveis = deveColapsar ? lista.filter((c) => !nuncaUsada(c)) : lista;
    const ordenados = [...visiveis].sort((a, b) => (b.usos30d ?? 0) - (a.usos30d ?? 0) || a.nome.localeCompare(b.nome, "pt-BR"));
    const total = ordenados.length + (deveColapsar ? 1 : 0);

    // leques concêntricos ao redor do hub, abertos pro lado de fora (±70°)
    const abertura = (Math.PI * 140) / 180;
    const porArco = [6, 10, 14, 18, 22];
    let idx = 0;
    let arco = 0;
    const colocar = (item) => {
      while (arco < porArco.length - 1 && idx >= porArco[arco]) {
        idx = 0;
        arco += 1;
      }
      const cabem = Math.min(porArco[arco], total - porArco.slice(0, arco).reduce((s, n) => s + n, 0));
      const passo = cabem > 1 ? abertura / (cabem - 1) : 0;
      const a = ang - abertura / 2 + passo * idx + (cabem === 1 ? abertura / 2 : 0);
      const dist = 58 + arco * 40;
      idx += 1;
      return polar(hub.x, hub.y, dist, a);
    };
    for (const c of ordenados) {
      const p = colocar(c);
      const no = {
        id: c.id,
        tipo: c.tipo,
        nome: c.nome,
        x: p.x,
        y: p.y,
        r: raioDoNo(c.usos30d ?? 0, maior),
        nunca: nuncaUsada(c),
        off: c.ligada === false,
        gatilho: (c.gatilhos?.length ?? 0) > 0,
        item: c,
      };
      nos.push(no);
      posPorId.set(c.id, no);
      arestas.push({ tipo: "hub", de: { x: hub.x, y: hub.y }, para: { x: no.x, y: no.y }, id: c.id, hub: t.tipo });
    }
    if (deveColapsar) {
      const p = colocar(null);
      colapsados.push({ tipo: t.tipo, n: nunca.length, ids: nunca.map((c) => c.id), x: p.x, y: p.y, r: 16 });
      arestas.push({ tipo: "hub", de: { x: hub.x, y: hub.y }, para: p, id: `+${t.tipo}`, hub: t.tipo });
    }
  });

  for (const cit of citacoes(itens)) {
    const a = posPorId.get(cit.de);
    const b = posPorId.get(cit.para);
    if (a && b) arestas.push({ tipo: "cita", de: { x: a.x, y: a.y }, para: { x: b.x, y: b.y }, id: `${cit.de}→${cit.para}` });
  }

  return { centro: { x: cx, y: cy, r: RAIO_CENTRO }, hubs, nos, arestas, colapsados, maior };
}

/** Zoom com a roda ao redor do ponto (px, py) no palco; devolve a vista nova (escala, dx, dy). */
export function aplicarRoda(vista, deltaY, px, py) {
  const fator = deltaY < 0 ? 1.12 : 1 / 1.12;
  const escala = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vista.escala * fator));
  if (escala === vista.escala) return vista;
  // mantém o ponto sob o cursor no mesmo lugar
  const k = escala / vista.escala;
  return { escala, dx: px - (px - vista.dx) * k, dy: py - (py - vista.dy) * k };
}

export function arrastar(vista, ddx, ddy) {
  return { ...vista, dx: vista.dx + ddx, dy: vista.dy + ddy };
}

export const vistaInicial = () => ({ escala: 1, dx: 0, dy: 0 });

/** Texto do tooltip de um nó (também é o `aria-label`). */
export function descricaoDoNo(no) {
  const c = no.item;
  const partes = [`${c.nome} · ${c.tipo}`];
  partes.push(no.nunca ? "nunca usada" : `${c.usos7d ?? 0} usos em 7 d · ${c.usos30d ?? 0} em 30 d`);
  if (c.disparos30d) partes.push(`disparou ${c.disparos30d} → usou ${c.usosAposDisparo30d ?? 0}`);
  if (no.off) partes.push("desligada neste projeto");
  if (no.gatilho) partes.push(`gatilhos: ${c.gatilhos.join(", ")}`);
  return partes.join(" · ");
}

/** KPIs do cabeçalho a partir do catálogo (mesma conta do motor, pra UI não depender de outra rota). */
export function kpisDoMapa(itens) {
  const k = { total: itens.length, auto: 0, pessoa: 0, usadas7d: 0, nuncaUsadas: 0, disparos30d: 0, usosAposDisparo30d: 0 };
  for (const c of itens) {
    if (c.origem === "pessoa") k.pessoa += 1;
    else k.auto += 1;
    if ((c.usos7d ?? 0) > 0) k.usadas7d += 1;
    if (nuncaUsada(c)) k.nuncaUsadas += 1;
    k.disparos30d += c.disparos30d ?? 0;
    k.usosAposDisparo30d += c.usosAposDisparo30d ?? 0;
  }
  return k;
}
