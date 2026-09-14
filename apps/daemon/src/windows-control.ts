import { randomUUID } from "node:crypto";
import type { Conjunto } from "./mcp.ts";
import { garantirHelperCompilado, windowsControlClient } from "./windows-control/client.ts";

/**
 * `nexo_windows_*`: dá ao agente controle real de QUALQUER janela do Windows —
 * não só o painel Browser do próprio Nexo (isso já existe em `navegador.ts`).
 * Lista janelas/apps abertos, lê a árvore de UI Automation, captura screenshot
 * e manda clique/tecla/scroll/drag — via processo nativo separado
 * (`windows-control/native`, .NET) porque o daemon é Node puro, sem acesso a
 * UI Automation nem `SendInput` de dentro do próprio processo.
 *
 * Gate de risco alto, deliberadamente FORA do padrão "modo por conta" que
 * `navegador.ts`/`delegar.ts` usam: uma chave GLOBAL (`config.windowsControlEnabled`),
 * porque a superfície de risco (mexer em QUALQUER app da máquina, não só o
 * Nexo) é grande demais pra decisão por conta ou por thread. Quem decide se
 * este `Conjunto` entra na montagem é `http.ts` (rota `/v1/mcp`); o filtro
 * final e incondicional — que NADA pode contornar, nem `allowedTools` escrito
 * à mão no perfil — é em `engines/cli.ts::profileFlags`.
 */

type WindowBounds = { x: number; y: number; width: number; height: number };
type WindowEntry = {
  id: string;
  title: string;
  processId: number;
  processName: string;
  executablePath?: string | null;
  isMinimized: boolean;
  bounds: WindowBounds;
};
type AppEntry = { id: string; displayName: string; executablePath?: string | null; windows: WindowEntry[] };
type AccessibilitySnapshot = { tree: string; focusedElement?: string | null; documentText?: string | null; elementCount: number };
type CaptureResult = { dataBase64: string; width: number; height: number; mimeType: "image/png" };

type ScreenshotRef = { windowId: string; imageWidth: number; imageHeight: number; windowWidth: number; windowHeight: number };

/** Cache de screenshot → janela, pra traduzir coordenada relativa à imagem em coordenada de tela real. */
const screenshots = new Map<string, ScreenshotRef>();
const MAX_SCREENSHOTS = 25;

function lembrarScreenshot(id: string, ref: ScreenshotRef): void {
  esquecerScreenshots(ref.windowId);
  screenshots.set(id, ref);
  while (screenshots.size > MAX_SCREENSHOTS) {
    const oldest = screenshots.keys().next().value;
    if (oldest === undefined) break;
    screenshots.delete(oldest);
  }
}

function esquecerScreenshots(windowId: string): void {
  for (const [id, ref] of screenshots) if (ref.windowId === windowId) screenshots.delete(id);
}

/** Traduz (x,y) relativo à IMAGEM do screenshot pra coordenada relativa à JANELA (o que o helper nativo espera). */
function escalarPonto(windowId: string, screenshotId: string, x: number, y: number): { x: number; y: number } {
  const ref = screenshots.get(screenshotId);
  if (!ref || ref.windowId !== windowId) {
    throw new Error("screenshotId expirou ou pertence a outra janela; capture o estado de novo com nexo_windows_estado.");
  }
  if (x < 0 || y < 0 || x >= ref.imageWidth || y >= ref.imageHeight) {
    throw new Error("as coordenadas estão fora da captura informada.");
  }
  return { x: (x * ref.windowWidth) / ref.imageWidth, y: (y * ref.windowHeight) / ref.imageHeight };
}

async function pedir<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  await garantirHelperCompilado();
  return windowsControlClient.request<T>(method, params);
}

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS_WINDOWS_CONTROL = [
  "mcp__nexo__nexo_windows_listar_janelas",
  "mcp__nexo__nexo_windows_listar_apps",
  "mcp__nexo__nexo_windows_abrir_app",
  "mcp__nexo__nexo_windows_ativar_janela",
  "mcp__nexo__nexo_windows_estado",
  "mcp__nexo__nexo_windows_clicar_elemento",
  "mcp__nexo__nexo_windows_clicar",
  "mcp__nexo__nexo_windows_digitar",
  "mcp__nexo__nexo_windows_tecla",
  "mcp__nexo__nexo_windows_rolar",
  "mcp__nexo__nexo_windows_arrastar",
  "mcp__nexo__nexo_windows_definir_valor",
  "mcp__nexo__nexo_windows_acao_secundaria",
];

const idJanela = { type: "string", pattern: "^\\d+$", description: "id de janela devolvido por nexo_windows_listar_janelas" };
const idScreenshot = { type: "string", format: "uuid", description: "screenshotId do nexo_windows_estado mais recente desta janela" };

export function ferramentasDeControleDoWindows(): Conjunto {
  return () => [
    {
      name: "nexo_windows_listar_janelas",
      description: "Lista as janelas abertas no Windows que podem ser controladas — id, título, app, posição.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: async () => {
        const janelas = await pedir<WindowEntry[]>("list_windows");
        const texto = janelas.length
          ? janelas.map((w) => `- ${w.id} — "${w.title}" (${w.processName})`).join("\n")
          : "nenhuma janela encontrada";
        return { ok: true, texto };
      },
    },
    {
      name: "nexo_windows_listar_apps",
      description: "Lista os aplicativos do Windows que têm janela aberta agora, agrupando as janelas de cada um.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: async () => {
        const apps = await pedir<AppEntry[]>("list_apps");
        const texto = apps.length
          ? apps.map((a) => `- ${a.displayName} (${a.windows.length} janela${a.windows.length === 1 ? "" : "s"})`).join("\n")
          : "nenhum app com janela aberta";
        return { ok: true, texto };
      },
    },
    {
      name: "nexo_windows_abrir_app",
      description:
        "Abre um app instalado do Windows por caminho do executável ou identificador do shell. " +
        "Depois, chame nexo_windows_listar_janelas e ache a janela nova.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "caminho do executável ou identificador do app" },
          argumentos: { type: "array", items: { type: "string" }, description: "argumentos de linha de comando (opcional)" },
        },
        required: ["app"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const app = typeof args.app === "string" ? args.app.trim() : "";
        if (!app) return { ok: false, texto: 'faltou "app"' };
        const argumentos = Array.isArray(args.argumentos) ? args.argumentos.filter((a) => typeof a === "string") : [];
        await pedir("launch_app", { app, arguments: argumentos });
        return { ok: true, texto: `pedido de abrir "${app}" enviado` };
      },
    },
    {
      name: "nexo_windows_ativar_janela",
      description: "Traz uma janela (por id de nexo_windows_listar_janelas) pra frente.",
      inputSchema: { type: "object", properties: { windowId: idJanela }, required: ["windowId"], additionalProperties: false },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        if (!windowId) return { ok: false, texto: 'faltou "windowId"' };
        await pedir("activate_window", { windowId });
        return { ok: true, texto: "janela ativada" };
      },
    },
    {
      name: "nexo_windows_estado",
      description:
        "Observa uma janela: devolve um screenshot (com screenshotId, pra usar em nexo_windows_clicar/" +
        "nexo_windows_rolar/nexo_windows_arrastar) e a árvore de UI Automation (com elementIndex, pra usar " +
        "em nexo_windows_clicar_elemento/nexo_windows_definir_valor/nexo_windows_acao_secundaria). " +
        "Observe de novo depois de qualquer ação que possa ter mudado a tela.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          incluirScreenshot: { type: "boolean", description: "captura a imagem da janela (padrão true)" },
          incluirTexto: { type: "boolean", description: "lê a árvore de UI Automation (padrão true)" },
          profundidadeMaxima: { type: "integer", minimum: 1, maximum: 20 },
          elementosMaximos: { type: "integer", minimum: 1, maximum: 1000 },
        },
        required: ["windowId"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        if (!windowId) return { ok: false, texto: 'faltou "windowId"' };
        const incluirScreenshot = args.incluirScreenshot !== false;
        const incluirTexto = args.incluirTexto !== false;
        esquecerScreenshots(windowId);
        const [janelas, acessibilidade, captura] = await Promise.all([
          pedir<WindowEntry[]>("list_windows"),
          incluirTexto
            ? pedir<AccessibilitySnapshot>("get_accessibility", {
                windowId,
                maxDepth: typeof args.profundidadeMaxima === "number" ? args.profundidadeMaxima : 7,
                maxElements: typeof args.elementosMaximos === "number" ? args.elementosMaximos : 350,
              })
            : Promise.resolve(undefined),
          incluirScreenshot ? pedir<CaptureResult>("capture_window", { windowId }) : Promise.resolve(undefined),
        ]);
        const janela = janelas.find((w) => w.id === windowId);
        if (!janela) return { ok: false, texto: "a janela não existe mais; liste as janelas de novo" };

        let screenshotId: string | undefined;
        if (captura) {
          screenshotId = randomUUID();
          lembrarScreenshot(screenshotId, {
            windowId,
            imageWidth: captura.width,
            imageHeight: captura.height,
            windowWidth: janela.bounds.width,
            windowHeight: janela.bounds.height,
          });
        }
        const resumo = {
          janela: { id: janela.id, titulo: janela.title, app: janela.processName, bounds: janela.bounds },
          acessibilidade: acessibilidade
            ? { arvore: acessibilidade.tree, focado: acessibilidade.focusedElement, totalElementos: acessibilidade.elementCount }
            : undefined,
          screenshotId,
        };
        return {
          ok: true,
          texto: JSON.stringify(resumo, null, 2),
          ...(captura ? { imagem: { dataBase64: captura.dataBase64, mimeType: captura.mimeType } } : {}),
        };
      },
    },
    {
      name: "nexo_windows_clicar_elemento",
      description: "Clica/aciona um elemento (por elementIndex da última árvore de UI Automation observada).",
      inputSchema: {
        type: "object",
        properties: { windowId: idJanela, elementIndex: { type: "integer", minimum: 0, maximum: 9999 } },
        required: ["windowId", "elementIndex"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const elementIndex = typeof args.elementIndex === "number" ? args.elementIndex : NaN;
        if (!windowId || !Number.isInteger(elementIndex)) return { ok: false, texto: 'faltou "windowId" ou "elementIndex"' };
        await pedir("click_element", { windowId, elementIndex });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "elemento clicado" };
      },
    },
    {
      name: "nexo_windows_clicar",
      description: "Clica numa coordenada relativa ao screenshot mais recente (nexo_windows_estado) de uma janela.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          screenshotId: idScreenshot,
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
          botao: { type: "string", enum: ["esquerdo", "direito", "meio"] },
          cliques: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["windowId", "screenshotId", "x", "y"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const screenshotId = typeof args.screenshotId === "string" ? args.screenshotId : "";
        const x = typeof args.x === "number" ? args.x : NaN;
        const y = typeof args.y === "number" ? args.y : NaN;
        if (!windowId || !screenshotId || !Number.isFinite(x) || !Number.isFinite(y)) {
          return { ok: false, texto: 'faltou "windowId", "screenshotId", "x" ou "y"' };
        }
        const botao = { esquerdo: "left", direito: "right", meio: "middle" }[String(args.botao ?? "esquerdo")] ?? "left";
        const cliques = typeof args.cliques === "number" ? args.cliques : 1;
        const ponto = escalarPonto(windowId, screenshotId, x, y);
        await pedir("click", { windowId, ...ponto, button: botao, clickCount: cliques });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "clique enviado" };
      },
    },
    {
      name: "nexo_windows_digitar",
      description: "Digita texto literal no controle focado da janela agora. Confira o foco antes (nexo_windows_estado).",
      inputSchema: {
        type: "object",
        properties: { windowId: idJanela, texto: { type: "string", maxLength: 100_000 } },
        required: ["windowId", "texto"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const texto = typeof args.texto === "string" ? args.texto : "";
        if (!windowId) return { ok: false, texto: 'faltou "windowId"' };
        await pedir("type_text", { windowId, text: texto });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "texto enviado" };
      },
    },
    {
      name: "nexo_windows_tecla",
      description: 'Aperta uma tecla ou combinação separada por "+" na janela, ex.: Return, Tab, Control+a, Shift+F10.',
      inputSchema: {
        type: "object",
        properties: { windowId: idJanela, tecla: { type: "string", maxLength: 200 } },
        required: ["windowId", "tecla"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const tecla = typeof args.tecla === "string" ? args.tecla.trim() : "";
        if (!windowId || !tecla) return { ok: false, texto: 'faltou "windowId" ou "tecla"' };
        await pedir("press_key", { windowId, key: tecla });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "tecla enviada" };
      },
    },
    {
      name: "nexo_windows_rolar",
      description: "Rola a partir de uma coordenada relativa ao screenshot mais recente. scrollY positivo desce, negativo sobe.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          screenshotId: idScreenshot,
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
          scrollX: { type: "integer", minimum: -50_000, maximum: 50_000 },
          scrollY: { type: "integer", minimum: -50_000, maximum: 50_000 },
        },
        required: ["windowId", "screenshotId", "x", "y", "scrollY"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const screenshotId = typeof args.screenshotId === "string" ? args.screenshotId : "";
        const x = typeof args.x === "number" ? args.x : NaN;
        const y = typeof args.y === "number" ? args.y : NaN;
        const scrollY = typeof args.scrollY === "number" ? args.scrollY : NaN;
        const scrollX = typeof args.scrollX === "number" ? args.scrollX : 0;
        if (!windowId || !screenshotId || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scrollY)) {
          return { ok: false, texto: 'faltou "windowId", "screenshotId", "x", "y" ou "scrollY"' };
        }
        const ponto = escalarPonto(windowId, screenshotId, x, y);
        await pedir("scroll", { windowId, ...ponto, scrollX, scrollY });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "scroll enviado" };
      },
    },
    {
      name: "nexo_windows_arrastar",
      description: "Arrasta entre dois pontos relativos ao screenshot mais recente da janela.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          screenshotId: idScreenshot,
          deX: { type: "number", minimum: 0 },
          deY: { type: "number", minimum: 0 },
          paraX: { type: "number", minimum: 0 },
          paraY: { type: "number", minimum: 0 },
        },
        required: ["windowId", "screenshotId", "deX", "deY", "paraX", "paraY"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const screenshotId = typeof args.screenshotId === "string" ? args.screenshotId : "";
        const deX = typeof args.deX === "number" ? args.deX : NaN;
        const deY = typeof args.deY === "number" ? args.deY : NaN;
        const paraX = typeof args.paraX === "number" ? args.paraX : NaN;
        const paraY = typeof args.paraY === "number" ? args.paraY : NaN;
        if (![deX, deY, paraX, paraY].every(Number.isFinite) || !windowId || !screenshotId) {
          return { ok: false, texto: 'faltou "windowId", "screenshotId", "deX", "deY", "paraX" ou "paraY"' };
        }
        const de = escalarPonto(windowId, screenshotId, deX, deY);
        const para = escalarPonto(windowId, screenshotId, paraX, paraY);
        await pedir("drag", { windowId, fromX: de.x, fromY: de.y, toX: para.x, toY: para.y });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "arraste enviado" };
      },
    },
    {
      name: "nexo_windows_definir_valor",
      description: "Substitui o valor de um elemento editável (por elementIndex da última árvore de UI Automation).",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          elementIndex: { type: "integer", minimum: 0, maximum: 9999 },
          valor: { type: "string", maxLength: 100_000 },
        },
        required: ["windowId", "elementIndex", "valor"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const elementIndex = typeof args.elementIndex === "number" ? args.elementIndex : NaN;
        const valor = typeof args.valor === "string" ? args.valor : "";
        if (!windowId || !Number.isInteger(elementIndex)) return { ok: false, texto: 'faltou "windowId" ou "elementIndex"' };
        await pedir("set_value", { windowId, elementIndex, value: valor });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "valor definido" };
      },
    },
    {
      name: "nexo_windows_acao_secundaria",
      description: "Roda uma ação de acessibilidade num elemento: invoke, expand, collapse, select, toggle, scroll_into_view ou focus.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: idJanela,
          elementIndex: { type: "integer", minimum: 0, maximum: 9999 },
          acao: { type: "string", enum: ["invoke", "expand", "collapse", "select", "toggle", "scroll_into_view", "focus"] },
        },
        required: ["windowId", "elementIndex", "acao"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const windowId = typeof args.windowId === "string" ? args.windowId : "";
        const elementIndex = typeof args.elementIndex === "number" ? args.elementIndex : NaN;
        const acao = typeof args.acao === "string" ? args.acao : "";
        if (!windowId || !Number.isInteger(elementIndex) || !acao) {
          return { ok: false, texto: 'faltou "windowId", "elementIndex" ou "acao"' };
        }
        await pedir("secondary_action", { windowId, elementIndex, action: acao });
        esquecerScreenshots(windowId);
        return { ok: true, texto: "ação executada" };
      },
    },
  ];
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetControleDoWindowsForTest(): void {
  screenshots.clear();
  windowsControlClient.stop("reset de teste");
}
