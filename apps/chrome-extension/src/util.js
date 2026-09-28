/** Funções puras do service worker — separadas pra teste sem `chrome.*`. */

export const BASE_PADRAO = "http://127.0.0.1:7432";

/**
 * Leitor de SSE incremental: recebe pedaços de texto, chama `aoEvento({ event, data })` a cada
 * bloco completo (separado por linha em branco). Devolve a função que alimenta.
 */
export function criarLeitorSse(aoEvento) {
  let resto = "";
  return (pedaco) => {
    resto += pedaco.replace(/\r\n/g, "\n");
    let fim;
    while ((fim = resto.indexOf("\n\n")) >= 0) {
      const bloco = resto.slice(0, fim);
      resto = resto.slice(fim + 2);
      let event = "message";
      const dados = [];
      for (const linha of bloco.split("\n")) {
        if (linha.startsWith(":")) continue;
        const i = linha.indexOf(":");
        const campo = i < 0 ? linha : linha.slice(0, i);
        const valor = i < 0 ? "" : linha.slice(i + 1).replace(/^ /, "");
        if (campo === "event") event = valor;
        else if (campo === "data") dados.push(valor);
      }
      if (dados.length || event !== "message") aoEvento({ event, data: dados.join("\n") });
    }
  };
}

/** Só http/https: nada de `chrome://`, `file:`, `javascript:` vindo do agente. */
export function urlPermitida(bruta) {
  try {
    const u = new URL(String(bruta).trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Endereço do motor digitado no popup → origem limpa, sem barra no fim. `null` se não for http(s). */
export function normalizarBase(bruta) {
  const s = String(bruta || "").trim() || BASE_PADRAO;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

const TECLAS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};

const MODIFICADORES = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

/** Atalhos de edição que o CDP só executa com `commands` explícito (tecla sozinha não basta). */
const COMANDOS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

/**
 * "Control+a" → parâmetros de `Input.dispatchKeyEvent` (sem o `type`). Lança erro com tecla que
 * não conhece — melhor o agente saber na hora do que apertar a tecla errada.
 */
export function teclaParaCdp(bruta) {
  const partes = String(bruta || "").split("+").map((p) => p.trim());
  const nome = partes.pop();
  if (!nome) throw new Error('faltou a tecla (ex.: "Enter", "Control+a")');
  let modifiers = 0;
  for (const m of partes) {
    const bit = MODIFICADORES[m[0].toUpperCase() + m.slice(1).toLowerCase()];
    if (!bit) throw new Error(`modificador desconhecido: ${m} (use Control, Shift, Alt ou Meta)`);
    modifiers |= bit;
  }
  const atalho = modifiers & (2 | 4);
  const def = TECLAS[nome] ?? TECLAS[nome[0].toUpperCase() + nome.slice(1)];
  if (def) {
    return { key: def.key ?? nome, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers, ...(def.text && !atalho ? { text: def.text } : {}) };
  }
  if (nome.length === 1) {
    const baixa = nome.toLowerCase();
    const letra = /[a-z]/.test(baixa);
    const digito = /[0-9]/.test(nome);
    const key = modifiers & 8 && letra ? nome.toUpperCase() : nome;
    return {
      key,
      code: letra ? `Key${baixa.toUpperCase()}` : digito ? `Digit${nome}` : "",
      windowsVirtualKeyCode: letra ? baixa.toUpperCase().charCodeAt(0) : nome.charCodeAt(0),
      modifiers,
      ...(atalho ? (COMANDOS[baixa] ? { commands: [COMANDOS[baixa]] } : {}) : { text: key }),
    };
  }
  throw new Error(`tecla desconhecida: ${nome}`);
}

/** Linha do log do popup, curta: "clicar ref_17", "abrir exemplo.com/x". */
export function resumoDaAcao(ev) {
  switch (ev.acao) {
    case "abrir": {
      try {
        const u = new URL(ev.url);
        return `abrir ${u.host}${u.pathname === "/" ? "" : u.pathname}`;
      } catch {
        return "abrir";
      }
    }
    case "clicar":
      return `clicar ${ev.ref}${ev.real ? " (real)" : ""}`;
    case "digitar":
      return `digitar ${ev.ref}`;
    case "rolar":
      return `rolar ${ev.ref || ev.direcao || ""}`.trim();
    case "tecla":
      return `tecla ${ev.tecla}`;
    case "abas":
      return "listar abas";
    default:
      return ev.acao;
  }
}
