import { sessionBus } from "./bus.ts";
import { ativarDs, criarDs, estadoDs, painelDeMocks, salvarCardDaFerramenta, type DsCompleto } from "./design-system.ts";
import { canalGeracao, geracaoBus } from "./ds-gerar.ts";
import type { Conjunto, Saida } from "./mcp.ts";

/**
 * `nexo_ds_print`: o agente VÊ o card renderizado. O daemon não desenha HTML — quem desenha é o
 * app: o renderer monta o mesmo documento do Canvas (tokens, kit, fontes, card) e o processo
 * principal do Electron renderiza numa janela invisível e tira o print. Funciona com o Canvas
 * fechado. Mesma ponte de `navegador.ts` (evento no bus "*" + rota que resolve a Promise), com
 * id por pedido em vez de por thread: dois agentes podem pedir print ao mesmo tempo.
 */

/** Liberada no `--allowed-tools` do claude (session.ts) — a ferramenta some sozinha se não houver DS. */
export const MCP_TOOLS_DS_PRINT = [
  "mcp__nexo__nexo_ds_print",
  "mcp__nexo__nexo_ds_listar",
  "mcp__nexo__nexo_ds_criar",
  "mcp__nexo__nexo_ds_ativar",
  "mcp__nexo__nexo_ds_card_salvar",
  "mcp__nexo__nexo_mock_salvar",
];

export type ResultadoPrint = { ok: boolean; texto: string; imagem?: { dataBase64: string; mimeType: string } };

type Pendente = { resolve: (r: ResultadoPrint) => void; timeoutId: ReturnType<typeof setTimeout> };
const pendentes = new Map<string, Pendente>();

/** Renderizar + esperar fonte leva alguns segundos; sem app aberto não vem resposta nunca. */
const PRINT_TIMEOUT_MS = 30_000;
let seq = 0;

export function pedirPrint(threadId: string, projectPath: string, card: string, tema: string): Promise<ResultadoPrint> {
  seq += 1;
  const id = `dp-${Date.now().toString(36)}-${seq}`;
  return new Promise<ResultadoPrint>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendentes.delete(id);
      resolve({ ok: false, texto: "o app não respondeu a tempo — a janela do Nexos está aberta?" });
    }, PRINT_TIMEOUT_MS);
    pendentes.set(id, { resolve, timeoutId });
    // threadId no evento: o stream global do app descarta evento sem conversa
    sessionBus.emit("*", { type: "ds_print", threadId, id, projectPath, card, tema });
  });
}

export function responderPrint(id: string, resultado: ResultadoPrint): boolean {
  const p = pendentes.get(id);
  if (!p) return false;
  clearTimeout(p.timeoutId);
  pendentes.delete(id);
  p.resolve(resultado);
  return true;
}

export function resetPrintForTest(): void {
  for (const p of pendentes.values()) clearTimeout(p.timeoutId);
  pendentes.clear();
}

const erroDe = (e: unknown): Saida => ({ ok: false, texto: (e as Error).message });

/** Resposta de card gravado: onde foi parar e os avisos do lint (o agente corrige e grava de novo). */
function textoDoCardSalvo(r: { ds: DsCompleto; id: string; novo: boolean }): string {
  const card = r.ds.cards.find((c) => c.id === r.id)!;
  const avisos = card.lint.map((l) => `- ${l.msg}${l.trecho ? `: ${l.trecho}` : ""}`);
  return (
    `${r.novo ? "Card criado" : "Card atualizado"}: ${r.id} (seção ${card.secao}, largura ${card.largura ?? "1/2"}) no DS "${r.ds.nome}" (id ${r.ds.id}).` +
    (avisos.length ? `\n\nAvisos do lint — corrija e grave de novo:\n${avisos.join("\n")}` : " Sem avisos do lint.")
  );
}

/** O Canvas aberto troca pro DS novo (o stream dele vigia a pasta do DS que estava ativo). */
function avisarCanvas(projectPath: string, ativo: string | null): void {
  geracaoBus.emit(canalGeracao(projectPath), { type: "ds_ativo", ativo });
}

/**
 * Ferramentas do design system pra conversa de projeto: listar, criar (ex.: "Mocks" copiando o
 * visual do ativo, pra montar uma tela de teste), ativar, salvar card e ver o card renderizado.
 * Criar/listar existem mesmo sem DS; salvar e print só com um ativo.
 */
export function ferramentaDePrintDoDs(threadId: string, projectPath: string, home: string): Conjunto {
  return () => {
    let ds;
    try {
      ds = estadoDs(projectPath, home).ds;
    } catch {
      return [];
    }
    const gestao = [
      {
        name: "nexo_ds_listar",
        description:
          "Lista os design systems deste projeto no Nexos (id, nome, qual é o OFICIAL, quais são painéis de mocks e qual está ativo no Canvas).",
        inputSchema: { type: "object", properties: {} },
        executar: (): Saida => {
          const est = estadoDs(projectPath, home);
          if (!est.sistemas.length) return { ok: true, texto: "Este projeto ainda não tem design system. Crie com nexo_ds_criar." };
          const linhas = est.sistemas.map(
            (x) =>
              `- ${x.id} · ${x.nome}${x.id === est.oficial ? " · OFICIAL" : ""}${x.mocksDe ? ` · painel de mocks de ${x.mocksDe}` : ""}${x.id === est.ativo ? " · ATIVO" : ""}`,
          );
          return { ok: true, texto: `${linhas.join("\n")}${est.ds ? `\n\nPasta do ativo: ${est.ds.pastaAbs}` : ""}` };
        },
      },
      {
        name: "nexo_ds_criar",
        description:
          "Cria um design system NOVO neste projeto (outra identidade visual) e deixa ele ATIVO no Canvas. " +
          "NÃO use pra mock de tela: pra isso é nexo_mock_salvar (painel de mocks que usa o DS oficial sem copiar). " +
          "`base`: \"ativo\" (copia tokens, regras e cards do DS ativo), \"zero\" (vazio) ou \"padrao\" (esqueleto do Nexos).",
        inputSchema: {
          type: "object",
          properties: {
            nome: { type: "string", description: "nome do design system" },
            base: { type: "string", enum: ["ativo", "zero", "padrao"], description: "ponto de partida; padrão: ativo se houver, senão zero" },
          },
          required: ["nome"],
        },
        executar: (args: Record<string, unknown>): Saida => {
          try {
            const tem = !!estadoDs(projectPath, home).ds;
            const base = typeof args.base === "string" && args.base ? args.base : tem ? "ativo" : "zero";
            const est = criarDs(projectPath, home, { nome: args.nome, base });
            avisarCanvas(projectPath, est.ativo);
            return { ok: true, texto: `Criado e ativo: "${est.ds!.nome}" (id ${est.ativo}, base ${base}) — pasta: ${est.ds!.pastaAbs}. ${est.ds!.cards.length} card(s).` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_ds_ativar",
        description: "Troca o design system ativo do projeto (o que o Canvas mostra e onde nexo_ds_card_salvar grava). `id` de nexo_ds_listar.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        executar: (args: Record<string, unknown>): Saida => {
          try {
            const est = ativarDs(projectPath, home, String(args.id ?? ""));
            avisarCanvas(projectPath, est.ativo);
            return { ok: true, texto: `Ativo: "${est.ds!.nome}" — pasta: ${est.ds!.pastaAbs}` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_mock_salvar",
        description:
          "Grava uma tela de MOCK (protótipo, rascunho, \"mostra como ficaria\") no painel de mocks do design system OFICIAL do projeto. " +
          "Na 1ª vez o painel é criado (só as telas — tokens, regras e kit vêm do DS oficial, nada é copiado); depois, " +
          "cada tela nova entra no MESMO painel. Mesma tela de novo = passe o `id` dela pra atualizar (fica versão guardada). " +
          "Deixa o painel ativo no Canvas pra pessoa ver. `html`: fragmento com <style> + marcação, só var(--token) do DS oficial, " +
          "sem <script> (KIT.md na pasta do DS oficial). `largura` padrão 1 (tela inteira). Depois confira com nexo_ds_print.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "id da tela pra atualizar; sem id, sai do título" },
            titulo: { type: "string" },
            subtitulo: { type: "string" },
            secao: { type: "string", description: "seção do painel (padrão: Telas)" },
            html: { type: "string" },
            largura: { type: "string", enum: ["1/3", "1/2", "2/3", "1"] },
          },
          required: ["titulo", "html"],
        },
        executar: (args: Record<string, unknown>): Saida => {
          try {
            const painel = painelDeMocks(projectPath, home);
            const est = ativarDs(projectPath, home, painel.id);
            avisarCanvas(projectPath, est.ativo);
            const id = typeof args.id === "string" ? args.id.trim() : "";
            const existe = !!id && !!est.ds?.cards.some((c) => c.id === id);
            const r = salvarCardDaFerramenta(projectPath, home, {
              ...args,
              secao: typeof args.secao === "string" && args.secao.trim() ? args.secao : existe ? undefined : "telas",
              largura: args.largura ?? (existe ? undefined : "1"),
            });
            const telas = r.ds.cards.length;
            return {
              ok: true,
              texto:
                `${textoDoCardSalvo(r)}\nPainel de mocks "${r.ds.nome}" (sistema ${r.ds.id}${r.ds.origem ? `, tokens do DS oficial "${r.ds.origem.nome}"` : ""}) — ${telas} tela(s), ativo no Canvas. ` +
                `Pra anexar num card do plano: { tipo: "ds", sistema: "${r.ds.id}", card: "${r.id}" }.`,
            };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
    ];
    if (!ds) return gestao;
    return [
      ...gestao,
      {
        name: "nexo_ds_card_salvar",
        description:
          "Grava um card no design system ATIVO (novo ou atualização) — componente ou peça do DS. Mock de tela é nexo_mock_salvar. " +
          "`html`: fragmento com <style> + marcação, cor/fonte/espaço/raio só por var(--token) do tokens.json, sem <script>; " +
          "use as classes do kit (KIT.md na pasta do DS). `id` existente atualiza (fica versão guardada); sem id, sai do título. " +
          "`secao`: id ou título (seção nova é criada). `largura`: 1/3, 1/2, 2/3 ou 1 (tela inteira: 1). Devolve os avisos do lint — " +
          "corrija e grave de novo se houver. Depois confira com nexo_ds_print.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            titulo: { type: "string" },
            subtitulo: { type: "string" },
            secao: { type: "string" },
            html: { type: "string" },
            largura: { type: "string", enum: ["1/3", "1/2", "2/3", "1"] },
            tipo: { type: "string", enum: ["cores", "tipografia", "espacamento", "forma", "componente", "livre"] },
          },
          required: ["titulo", "html"],
        },
        executar: (args: Record<string, unknown>): Saida => {
          try {
            return { ok: true, texto: textoDoCardSalvo(salvarCardDaFerramenta(projectPath, home, args)) };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_ds_print",
        description:
          "Print do card do design system RENDERIZADO (como aparece no Canvas: tokens, fontes e classes do kit aplicados). " +
          "Use depois de criar ou editar um card pra conferir o visual antes de dizer que ficou pronto. " +
          "Sem `card`, devolve a PASTA do design system e a lista de cards (id, seção, largura, avisos do lint) — chame assim " +
          "antes de procurar arquivo do DS no disco. `tema` opcional (tema de tokens.json).",
        inputSchema: {
          type: "object",
          properties: {
            card: { type: "string", description: "id do card (nome do arquivo em cards/, sem .html) ou de um Fundamento (fund-cores…)" },
            tema: { type: "string", description: "tema declarado em tokens.json ($extensions.nexos.temas); vazio = padrão" },
          },
        },
        executar: async (args: Record<string, unknown>): Promise<Saida> => {
          const atual = estadoDs(projectPath, home).ds;
          if (!atual) return { ok: false, texto: "este projeto não tem design system" };
          const todos = [
            ...atual.fundamentos.map((f) => ({ id: f.id, secao: "fundamentos", largura: f.largura ?? "1/2", avisos: 0 })),
            ...atual.cards.map((c) => ({ id: c.id, secao: c.secao, largura: c.largura ?? "1/2", avisos: c.lint.length })),
          ];
          const card = typeof args.card === "string" ? args.card.trim() : "";
          if (!card) {
            // a pasta vai junto: conversa que começou antes do DS existir não tem ela nas regras e o
            // agente saía varrendo o disco atrás dos arquivos (o DS mora na pasta do projeto no Nexos)
            return {
              ok: true,
              texto:
                `Design system "${atual.nome}" — pasta: ${atual.pastaAbs}\n` +
                "Arquivos: tokens.json, DESIGN.md, meta.json (layout) e cards/<id>.html. Pra criar/editar card, leia KIT.md nessa pasta.\n\n" +
                `Cards:\n${todos.map((c) => `- ${c.id} · ${c.secao} · ${c.largura}${c.avisos ? ` · ${c.avisos} aviso(s)` : ""}`).join("\n")}`,
            };
          }
          if (!todos.some((c) => c.id === card)) return { ok: false, texto: `card "${card}" não existe. Chame sem \`card\` pra ver a lista.` };
          const tema = typeof args.tema === "string" ? args.tema.trim() : "";
          return pedirPrint(threadId, projectPath, card, tema);
        },
      },
    ];
  };
}
