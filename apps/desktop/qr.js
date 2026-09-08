/**
 * Codificador de QR, o suficiente pra caber um endereço curto — e nada além.
 *
 * Por que escrito à mão em vez de uma dependência: o app não compila, então o
 * renderer não alcança `node_modules` sem inventar caminho relativo pra dentro
 * dos links do pnpm. Fazer o daemon gerar resolveria, mas custaria uma rota
 * nova e uma dependência num projeto que tem cinco. O algoritmo é fechado (ISO
 * 18004, não muda) e o teste compara módulo a módulo com uma implementação de
 * referência — inclusive a máscara escolhida, que só bate se a penalidade
 * estiver certa também.
 *
 * O escopo é deliberadamente estreito:
 *
 * - **modo byte** só. O endereço tem `:` `/` `#` e minúsculas, que o modo
 *   alfanumérico não cobre; ter os dois modos economizaria versão num caso que
 *   não existe aqui.
 * - **correção M** (~15%), o padrão pra URL. L erra mais em tela suja de dedo,
 *   Q e H incham o desenho sem ninguém precisar.
 * - **versões 1 a 10** (até 213 bytes). O endereço mais longo que isto gera é
 *   `http://<host>:<porta>/app/#c=NNNNNN`, uns 40 caracteres.
 *
 * Texto que não couber é erro, não silêncio: QR truncado escaneia e leva pro
 * lugar errado.
 */

/* ---------- GF(256): x^8 + x^4 + x^3 + x^2 + 1 ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** g(x) = Π (x + α^i). Índice 0 é o coeficiente de maior grau. */
function gerador(grau) {
  let g = [1];
  for (let i = 0; i < grau; i++) {
    const r = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      r[j] ^= g[j];
      r[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = r;
  }
  return g;
}

/** Resto da divisão — os codewords de correção. */
function correcao(dados, quantos) {
  const g = gerador(quantos);
  const buf = new Uint8Array(dados.length + quantos);
  buf.set(dados);
  for (let i = 0; i < dados.length; i++) {
    const c = buf[i];
    if (!c) continue;
    for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], c);
  }
  return buf.subarray(dados.length);
}

/* ---------- tabelas do nível M, versões 1..10 ---------- */

/** `[correção por bloco, blocos do grupo 1, dados por bloco, blocos do grupo 2]` */
const BLOCOS = [
  [10, 1, 16, 0], // v1
  [16, 1, 28, 0],
  [26, 1, 44, 0],
  [18, 2, 32, 0],
  [24, 2, 43, 0],
  [16, 4, 27, 0],
  [18, 4, 31, 0],
  [22, 2, 38, 2], // v8: 2×38 + 2×39
  [22, 3, 36, 2], // v9: 3×36 + 2×37
  [26, 4, 43, 1], // v10: 4×43 + 1×44
];

/** Centros dos padrões de alinhamento. O primeiro é sempre 6. */
const ALINHAMENTO = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MASCARAS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** Quantos bytes de dados a versão carrega no nível M. */
function capacidade(versao) {
  const [ec, b1, d1, b2] = BLOCOS[versao - 1];
  void ec;
  return b1 * d1 + b2 * (d1 + 1);
}

/** Bits do contador de caracteres: 8 até a v9, 16 daí pra frente (modo byte). */
const bitsDoContador = (versao) => (versao < 10 ? 8 : 16);

/** Em bits, não em bytes: o cabeçalho é 4 + contador, que não fecha byte. */
function menorVersao(bytes) {
  for (let v = 1; v <= BLOCOS.length; v++) {
    if (bytes * 8 + 4 + bitsDoContador(v) <= capacidade(v) * 8) return v;
  }
  return 0;
}

/* ---------- BCH: informação de formato e de versão ---------- */

/**
 * Calculados, não tabelados: são seis constantes hexadecimais que ninguém
 * confere de olho, e errar uma faz o leitor recusar o código inteiro.
 */
function infoDeFormato(mascara) {
  const dados = mascara; // nível M é 0b00, então o campo é só a máscara
  let r = dados << 10;
  for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
  return ((dados << 10) | r) ^ 0x5412;
}

function infoDeVersao(versao) {
  let r = versao << 12;
  for (let i = 17; i >= 12; i--) if ((r >>> i) & 1) r ^= 0x1f25 << (i - 12);
  return (versao << 12) | r;
}

/* ---------- bits de dados ---------- */

function bitsDeDados(texto, versao) {
  const bytes = new TextEncoder().encode(texto);
  const total = capacidade(versao);
  const bits = [];
  const empurrar = (valor, quantos) => {
    for (let i = quantos - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
  };
  empurrar(0b0100, 4); // modo byte
  empurrar(bytes.length, bitsDoContador(versao));
  for (const b of bytes) empurrar(b, 8);

  // terminador: só o que couber, e nada se já encostou no limite
  empurrar(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const dados = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dados[i / 8] = byte;
  }
  // preenchimento fixo da norma, alternando
  for (let i = bits.length / 8; i < total; i++) dados[i] = (i - bits.length / 8) % 2 ? 0x11 : 0xec;
  return dados;
}

/**
 * Intercala os blocos: todos os dados em rodadas, depois toda a correção.
 * Sem isso um borrão localizado cairia inteiro num bloco e estouraria a
 * capacidade dele — intercalar é o que espalha o dano.
 */
function intercalar(dados, versao) {
  const [ec, b1, d1, b2] = BLOCOS[versao - 1];
  const blocos = [];
  let pos = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const n = i < b1 ? d1 : d1 + 1;
    const parte = dados.subarray(pos, pos + n);
    pos += n;
    blocos.push({ dados: parte, ec: correcao(parte, ec) });
  }
  const saida = [];
  for (let i = 0; i < d1 + 1; i++) {
    for (const b of blocos) if (i < b.dados.length) saida.push(b.dados[i]);
  }
  for (let i = 0; i < ec; i++) for (const b of blocos) saida.push(b.ec[i]);
  return Uint8Array.from(saida);
}

/* ---------- desenho ---------- */

function moldura(versao) {
  const lado = 17 + 4 * versao;
  const m = Array.from({ length: lado }, () => new Array(lado).fill(null));
  const por = (i, j, v) => {
    if (i >= 0 && i < lado && j >= 0 && j < lado) m[i][j] = v;
  };

  // localizadores e seus separadores
  for (const [oi, oj] of [
    [0, 0],
    [0, lado - 7],
    [lado - 7, 0],
  ]) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const borda = i === -1 || i === 7 || j === -1 || j === 7;
        const anel = i === 0 || i === 6 || j === 0 || j === 6;
        const miolo = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        por(oi + i, oj + j, borda ? false : anel || miolo);
      }
    }
  }

  // temporização
  for (let i = 8; i < lado - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }

  // alinhamento, menos onde um localizador já manda
  const centros = ALINHAMENTO[versao - 1];
  for (const ci of centros) {
    for (const cj of centros) {
      if ((ci === 6 && cj === 6) || (ci === 6 && cj === lado - 7) || (ci === lado - 7 && cj === 6)) {
        continue;
      }
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          m[ci + i][cj + j] = Math.abs(i) === 2 || Math.abs(j) === 2 || (i === 0 && j === 0);
        }
      }
    }
  }

  // módulo escuro fixo, e as áreas de formato reservadas com `false`
  m[lado - 8][8] = true;
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][lado - 1 - i] === null) m[8][lado - 1 - i] = false;
    if (m[lado - 1 - i][8] === null) m[lado - 1 - i][8] = false;
  }
  if (versao >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[i][lado - 11 + j] = false;
        m[lado - 11 + j][i] = false;
      }
    }
  }
  return m;
}

/** Zigue-zague de duas colunas, da direita pra esquerda, pulando a coluna 6. */
function espalhar(m, bytes, mascara) {
  const lado = m.length;
  const testa = MASCARAS[mascara];
  let linha = lado - 1;
  let passo = -1;
  let bit = 7;
  let idx = 0;
  for (let col = lado - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const j = col - c;
        if (m[linha][j] !== null) continue;
        let escuro = idx < bytes.length ? ((bytes[idx] >>> bit) & 1) === 1 : false;
        if (testa(linha, j)) escuro = !escuro;
        m[linha][j] = escuro;
        if (--bit < 0) {
          bit = 7;
          idx++;
        }
      }
      linha += passo;
      if (linha < 0 || linha >= lado) {
        linha -= passo;
        passo = -passo;
        break;
      }
    }
  }
}

function gravarFormato(m, mascara) {
  const lado = m.length;
  const bits = infoDeFormato(mascara);
  for (let i = 0; i < 15; i++) {
    const on = ((bits >> i) & 1) === 1;
    const linha = i < 6 ? i : i < 8 ? i + 1 : lado - 15 + i;
    m[linha][8] = on;
    // o bit 8 é o único que quebra a sequência: ele cai na coluna 7, porque a
    // coluna 8 dessa linha pertence à cópia vertical (bit 7)
    const col = i < 8 ? lado - 1 - i : i === 8 ? 7 : 14 - i;
    m[8][col] = on;
  }
}

function gravarVersao(m, versao) {
  if (versao < 7) return;
  const lado = m.length;
  const bits = infoDeVersao(versao);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + lado - 11] = on;
    m[(i % 3) + lado - 11][Math.floor(i / 3)] = on;
  }
}

/* ---------- penalidade: quem escolhe a máscara ---------- */

function penalidade(m) {
  const lado = m.length;
  let p = 0;

  // 1: corridas de 5 ou mais da mesma cor
  const corrida = (get) => {
    for (let a = 0; a < lado; a++) {
      let n = 1;
      for (let b = 1; b < lado; b++) {
        if (get(a, b) === get(a, b - 1)) n++;
        else {
          if (n >= 5) p += 3 + (n - 5);
          n = 1;
        }
      }
      if (n >= 5) p += 3 + (n - 5);
    }
  };
  corrida((a, b) => m[a][b]);
  corrida((a, b) => m[b][a]);

  // 2: blocos 2×2 de uma cor
  for (let i = 0; i < lado - 1; i++) {
    for (let j = 0; j < lado - 1; j++) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3;
    }
  }

  // 3: 1011101 com quatro claros de um dos lados — imita o localizador
  const ALVO = [true, false, true, true, true, false, true];
  const claros = (get, a, ini) => {
    for (let k = 0; k < 4; k++) {
      const b = ini + k;
      if (b >= 0 && b < lado && get(a, b)) return false;
    }
    return true;
  };
  const imita = (get) => {
    for (let a = 0; a < lado; a++) {
      for (let b = 0; b + 7 <= lado; b++) {
        let bate = true;
        for (let k = 0; k < 7; k++) if (get(a, b + k) !== ALVO[k]) bate = false;
        if (!bate) continue;
        if (claros(get, a, b - 4) || claros(get, a, b + 7)) p += 40;
      }
    }
  };
  imita((a, b) => m[a][b]);
  imita((a, b) => m[b][a]);

  // 4: desequilíbrio entre claro e escuro
  let escuros = 0;
  for (const linha of m) for (const v of linha) if (v) escuros++;
  const desvio = Math.abs((escuros * 100) / (lado * lado) - 50);
  return p + Math.floor(desvio / 5) * 10;
}

/* ---------- fachada ---------- */

/**
 * Matriz de booleanos (`true` = escuro), sem margem.
 *
 * A margem é de quem desenha porque ela é medida em módulos, e só o desenho
 * sabe o tamanho de um módulo.
 */
export function qrMatriz(texto) {
  const bytes = new TextEncoder().encode(String(texto ?? ""));
  const versao = menorVersao(bytes.length);
  if (!versao) throw new Error(`texto longo demais pra um QR (${bytes.length} bytes)`);
  const codewords = intercalar(bitsDeDados(String(texto), versao), versao);

  // a penalidade é medida ANTES de gravar formato e versão, com essas áreas
  // ainda claras: é o que a norma manda, e escolher a máscara olhando bits que
  // dependem da própria máscara seria circular
  let melhor = null;
  for (let mascara = 0; mascara < 8; mascara++) {
    const m = moldura(versao);
    espalhar(m, codewords, mascara);
    const nota = penalidade(m);
    if (!melhor || nota < melhor.nota) melhor = { nota, mascara, m };
  }
  gravarFormato(melhor.m, melhor.mascara);
  gravarVersao(melhor.m, versao);
  return melhor.m;
}

/**
 * SVG quadrado, um `<path>` só.
 *
 * Um path em vez de um `<rect>` por módulo porque um QR de versão 3 tem 841
 * módulos: seriam centenas de nós no DOM pra desenhar o que é uma figura
 * única. `shape-rendering="crispEdges"` porque QR interpolado não escaneia.
 *
 * `viewBox` sem largura fixa: quem posiciona é o CSS. E a margem clara de 4
 * módulos não é enfeite — sem ela o leitor não acha a borda.
 */
export function qrSvg(texto, { margem = 4 } = {}) {
  const m = qrMatriz(texto);
  const lado = m.length + margem * 2;
  let d = "";
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      if (m[i][j]) d += `M${j + margem} ${i + margem}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR para conectar o celular">` +
    `<rect width="${lado}" height="${lado}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/>` +
    `</svg>`
  );
}
