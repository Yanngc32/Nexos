/**
 * O app grava no MESMO `daemon.log` do motor, no mesmo formato (ver `apps/daemon/src/log.ts`):
 *
 *   2026-09-24T16:53:01.123-03:00 AVISO [app] motor sem resposta há 15 s {"pid":1234}
 *
 * Por quê: com o motor travado, só o app consegue contar o que aconteceu. Grava só o que ele vê
 * e decide sobre o motor (saúde, destravar, subir) — não é o log completo do app.
 *
 * `appendFileSync` por linha: abre e fecha a cada escrita, então nunca segura o arquivo e não
 * briga com a rotação, que é do motor (ele é o dono do `daemon.log`).
 */
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const NIVEIS = ["debug", "info", "aviso", "erro"];
const ROTULO = { debug: "DEBUG", info: "INFO ", aviso: "AVISO", erro: "ERRO " };
const CHAVE_SECRETA = /token|senha|password|secret|authorization|cookie|api_?key/i;
/** O nível é relido do config no máximo a cada tanto — trocar na tela vale sem reiniciar o app. */
const RELER_NIVEL_MS = 5000;

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function horaLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sinal = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sinal}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function limpar(valor, profundidade = 0) {
  if (valor instanceof Error) return { erro: valor.message, stack: valor.stack };
  if (valor === null || typeof valor !== "object" || profundidade > 5) return valor;
  if (Array.isArray(valor)) return valor.map((v) => limpar(v, profundidade + 1));
  const out = {};
  for (const [k, v] of Object.entries(valor)) out[k] = CHAVE_SECRETA.test(k) ? "***" : limpar(v, profundidade + 1);
  return out;
}

function formatarLinha(nivel, origem, msg, dados, quando = new Date(), segredos = []) {
  let json = "";
  if (dados !== undefined) {
    try {
      json = ` ${JSON.stringify(limpar(dados))}`;
    } catch {
      json = ' {"dados":"(não serializável)"}';
    }
  }
  let linha = `${horaLocal(quando)} ${ROTULO[nivel]} [${origem}] ${String(msg).replace(/\r?\n/g, " ⏎ ")}${json}`;
  linha = linha.replace(/(bearer\s+)[\w.~+/-]+=*/gi, "$1***");
  for (const s of segredos) if (s) linha = linha.split(s).join("***");
  return `${linha}\n`;
}

function nivelDoHome(home, env = process.env) {
  const doEnv = String(env.NEXOS_LOG || "").trim().toLowerCase();
  if (NIVEIS.includes(doEnv)) return doEnv;
  try {
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (NIVEIS.includes(raw.logNivel)) return raw.logNivel;
  } catch {
    /* sem config ainda */
  }
  return "info";
}

/**
 * `home` é função (e não string) porque o app pode trocar de home depois de carregar este módulo
 * (modo dev seta `NEXOS_HOME` no boot).
 */
function criarLog({ home, agora = () => Date.now(), env = process.env } = {}) {
  let nivel = "info";
  let lidoEm = -Infinity;
  const nivelAtual = () => {
    const t = agora();
    if (t - lidoEm > RELER_NIVEL_MS) {
      nivel = nivelDoHome(home(), env);
      lidoEm = t;
    }
    return nivel;
  };
  const token = () => {
    try {
      return readFileSync(join(home(), "daemon.token"), "utf8").trim();
    } catch {
      return "";
    }
  };
  const escrever = (n, origem, msg, dados) => {
    if (NIVEIS.indexOf(n) < NIVEIS.indexOf(nivelAtual())) return;
    const linha = formatarLinha(n, origem, msg, dados, new Date(agora()), [token()].filter((s) => s.length >= 8));
    try {
      appendFileSync(join(home(), "daemon.log"), linha, "utf8");
    } catch {
      /* home sumiu ou disco cheio: log é melhor-esforço */
    }
  };
  return {
    debug: (origem, msg, dados) => escrever("debug", origem, msg, dados),
    info: (origem, msg, dados) => escrever("info", origem, msg, dados),
    aviso: (origem, msg, dados) => escrever("aviso", origem, msg, dados),
    erro: (origem, msg, dados) => escrever("erro", origem, msg, dados),
  };
}

module.exports = { criarLog, formatarLinha, horaLocal, nivelDoHome };
