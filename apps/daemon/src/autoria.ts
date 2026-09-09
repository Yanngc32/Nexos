import {
  AGENT_INSTRUCTIONS_MAX,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  TEAM_CANAIS,
  TEAM_MEMBERS_MAX,
  TEAM_TOPOLOGIES,
} from "@nexo/shared";
import { listAgents, saveAgent, type AgentInput } from "./agents.ts";
import { HOOK_EVENTS, listarRegras, saveRegra, type RegraInput } from "./hooks.ts";
import { listProfiles } from "./profiles.ts";
import { listTeams, saveTeam, type TeamInput } from "./teams.ts";
import type { Conjunto, Ferramenta, Saida } from "./mcp.ts";

/**
 * Ferramentas de AUTORIA: o modelo cria e edita agentes, times e regras de Nexo Hook.
 *
 * O que ele NÃO pode fazer aqui é executar. Nem rodar time, nem apagar
 * definição. A assimetria é o critério: uma definição errada você conserta ou
 * apaga em um segundo, enquanto um run gasta quota de verdade e escreve branch
 * no seu repositório — isso continua sendo um clique seu. Apagar ficou de fora
 * pela mesma razão pelo outro lado: é a única ação de autoria que perde
 * trabalho, e criar time não precisa dela.
 *
 * Hook tem uma segunda assimetria, mais séria: `git.pre-push` bloqueante trava o `git push` de
 * QUEM CASAR com a regra até alguém desligar — bem diferente de "definição ruim, apago". Por
 * isso `nexo_hook_salvar` recusa `bloqueante` mesmo que o modelo mande: essa única opção fica só
 * na tela Hooks, pra pessoa.
 *
 * **As regras moram nas descrições, não num arquivo à parte.** É isso que faz
 * funcionar sem instalar nada: o modelo lê o `tools/list` e já sabe que id é
 * minúsculo, que um time tem no máximo 8 membros, e que supervisor precisa de
 * mais alguém. Documentação longe do código envelhece; descrição de ferramenta
 * o modelo lê a cada turno.
 *
 * A validação NÃO é reimplementada aqui: `saveAgent` e `saveTeam` são as mesmas
 * funções que a tela usa. Um segundo validador divergiria, e aí a tela e o
 * modelo aceitariam coisas diferentes.
 */

/** Erro de validação vira texto pro modelo, com `ok: false`, pra ele corrigir. */
function tentar(f: () => string): Saida {
  try {
    return { ok: true, texto: f() };
  } catch (e) {
    const err = e as Error & { status?: number };
    // deixa o 5xx subir: defeito nosso não é coisa que o modelo conserte
    if (err.status && err.status >= 500) throw err;
    return { ok: false, texto: err.message || "não deu" };
  }
}

export function ferramentasDeAutoria(home: string): Conjunto {
  return () => {
    const contas = listProfiles(home);
    const agentes = listAgents(home);
    const idsDeAgente = agentes.map((a) => a.id);
    const idsDeConta = contas.map((c) => c.id);

    const ferramentas: Ferramenta[] = [
      {
        name: "nexo_contexto",
        description:
          "O que existe no Nexo agora: contas (motor e estado de login), agentes e times. " +
          "CHAME ISTO PRIMEIRO. Agente precisa de uma conta que exista, e time precisa de agentes " +
          "que existam — criar sem olhar dá erro que você poderia ter evitado.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        executar: () => ({
          ok: true,
          texto: [
            "## Contas",
            contas.length
              ? contas.map((c) => `- ${c.id} — motor ${c.engine}, ${c.status}`).join("\n")
              : "- nenhuma. Sem conta não dá pra criar agente; quem cria conta é a pessoa, na tela.",
            "",
            "## Agentes",
            agentes.length
              ? agentes.map((a) => `- ${a.id} — ${a.name} (conta ${a.profileId})`).join("\n")
              : "- nenhum",
            "",
            "## Times",
            (() => {
              const times = listTeams(home);
              return times.length
                ? times
                    .map(
                      (t) =>
                        `- ${t.id} — ${t.name}, ${t.topology}${t.canal ? `/${t.canal}` : ""}: ` +
                        t.members.map((m) => m.agentId).join(" → "),
                    )
                    .join("\n")
                : "- nenhum";
            })(),
            "",
            "## Nexo Hooks",
            (() => {
              const regras = listarRegras(home);
              return regras.length
                ? regras
                    .map((r) => {
                      const escopo = r.escopo.tipo === "global" ? "global" : r.escopo.projectPath;
                      const quem = r.teamId ? `time ${r.teamId}` : `agente ${r.agentId}`;
                      return `- ${r.id} — ${r.evento} @ ${escopo} → ${quem}${r.bloqueante ? " [bloqueante]" : ""}`;
                    })
                    .join("\n")
                : "- nenhuma";
            })(),
          ].join("\n"),
        }),
      },
      {
        name: "nexo_agente_salvar",
        description:
          "Cria ou atualiza um agente. Mesmo id = atualiza, e campo que você não mandar fica como " +
          "estava. O que define um agente é o `instructions`: é ele que vai no topo de todo turno " +
          "e faz o agente ser um revisor e não um escritor. " +
          `Ids: minúsculas, números, - e _. Instruções: até ${AGENT_INSTRUCTIONS_MAX} caracteres.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "minúsculas, números, - e _" },
            name: { type: "string", description: "nome curto, como aparece na tela" },
            profileId: {
              type: "string",
              description: "conta que ele usa",
              ...(idsDeConta.length ? { enum: idsDeConta } : {}),
            },
            description: { type: "string", description: "uma linha sobre pra que ele serve" },
            instructions: {
              type: "string",
              description:
                "o que ele é e como trabalha. Escreva no imperativo e seja específico: é o que " +
                "separa um agente útil de um genérico.",
            },
            model: { type: "string" },
            effort: { type: "string", enum: [...EFFORT_LEVELS] },
            permissionMode: { type: "string", enum: [...PERMISSION_MODES] },
          },
          required: ["id", "name", "profileId"],
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const a = saveAgent(args as unknown as AgentInput, home);
            return `agente ${a.id} salvo (conta ${a.profileId})`;
          }),
      },
      {
        name: "nexo_time_salvar",
        description:
          "Cria ou atualiza um time. Escolha a topologia pelo que o trabalho é:\n" +
          "- `pipeline`: um membro por vez, a saída de um é a entrada do próximo. Pra escrever e " +
          "depois revisar.\n" +
          "- `fanin`: todos menos o último ao mesmo tempo, e o último junta. Pra várias leituras " +
          "independentes do mesmo código. Em projeto git cada um ganha árvore de trabalho própria; " +
          "fora de git eles dividem a pasta e se atropelam se escreverem arquivo.\n" +
          "- `supervisor`: o PRIMEIRO membro decide quem chamar, uma rodada por vez, até encerrar. " +
          "Pra trabalho cujo caminho não dá pra escrever antes. Ele não trabalha, só decide — " +
          "precisa de pelo menos um membro além dele.\n" +
          `Até ${TEAM_MEMBERS_MAX} membros. A ordem importa nas três topologias. ` +
          "Criar time NÃO o executa: quem dispara o run é a pessoa.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "minúsculas, números, - e _" },
            name: { type: "string" },
            description: { type: "string" },
            topology: { type: "string", enum: [...TEAM_TOPOLOGIES] },
            canal: {
              type: "string",
              enum: [...TEAM_CANAIS],
              description:
                "só no supervisor. `turno` (padrão) roda em qualquer motor e custa um turno por " +
                "decisão; `mcp` cabe num turno só, mas exige conta claude.",
            },
            members: {
              type: "array",
              maxItems: TEAM_MEMBERS_MAX,
              description: "na ordem de trabalho. No supervisor, o PRIMEIRO é quem decide.",
              items: {
                type: "object",
                properties: {
                  agentId: {
                    type: "string",
                    ...(idsDeAgente.length ? { enum: idsDeAgente } : {}),
                  },
                  papel: { type: "string", description: "o que ele faz NESTE time" },
                },
                required: ["agentId"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "name", "topology", "members"],
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const t = saveTeam(args as unknown as TeamInput, home);
            const quem = t.members.map((m) => m.agentId).join(" → ");
            return `time ${t.id} salvo — ${t.topology}: ${quem}. Pra rodar, a pessoa dispara na tela.`;
          }),
      },
      {
        name: "nexo_hook_salvar",
        description:
          "Cria ou atualiza uma regra de Nexo Hook: dispara um agente ou time SOZINHO quando um " +
          "evento acontece (commit, push, ou a primeira vez que um projeto abre no Nexo) — sem " +
          "precisar ninguém pedir de novo. Mesmo id = atualiza, e campo que você não mandar fica " +
          "como estava. Escopo `global` vale em TODO projeto; `projeto` só num `projectPath`. " +
          "Exatamente um de `agentId`/`teamId`. NÃO cria regra bloqueante: `git.pre-push` bloqueante " +
          "trava o `git push` de quem casar com a regra até alguém desligar — por segurança, só a " +
          "pessoa liga isso na tela Hooks.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "só pra ATUALIZAR uma regra já existente" },
            nome: { type: "string", description: "rótulo curto pra achar a regra na lista" },
            descricao: { type: "string" },
            escopo: {
              type: "object",
              properties: {
                tipo: { type: "string", enum: ["global", "projeto"] },
                projectPath: { type: "string", description: "obrigatório quando tipo=projeto" },
              },
              required: ["tipo"],
              additionalProperties: false,
            },
            evento: { type: "string", enum: [...HOOK_EVENTS] },
            branch: {
              type: "string",
              description: "só em git.post-push/git.pre-push. Vazio/ausente casa qualquer branch.",
            },
            agentId: {
              type: "string",
              description: "um agente avulso",
              ...(idsDeAgente.length ? { enum: idsDeAgente } : {}),
            },
            teamId: { type: "string", description: "um time já montado (Team Studio)" },
          },
          required: ["escopo", "evento"],
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const a = args as Record<string, unknown>;
            if (a.bloqueante !== undefined) {
              throw Object.assign(
                new Error(
                  "regra bloqueante só na tela Hooks, não por aqui — trava git push de quem casar até a pessoa desligar",
                ),
                { status: 400 },
              );
            }
            const r = saveRegra(a as RegraInput, home);
            const quem = r.teamId ? `time ${r.teamId}` : `agente ${r.agentId}`;
            return `regra ${r.id} salva — ${r.evento} (${r.escopo.tipo}) → ${quem}`;
          }),
      },
      {
        name: "nexo_hook_listar",
        description: "Lista as regras de Nexo Hook que já existem — escopo, evento, branch, quem roda, se é bloqueante.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        executar: () => {
          const regras = listarRegras(home);
          if (!regras.length) return { ok: true, texto: "nenhuma regra ainda" };
          const linhas = regras.map((r) => {
            const escopo = r.escopo.tipo === "global" ? "global" : r.escopo.projectPath;
            const quem = r.teamId ? `time ${r.teamId}` : `agente ${r.agentId}`;
            const extra = [r.branch ? `branch ${r.branch}` : "", r.bloqueante ? "bloqueante" : ""]
              .filter(Boolean)
              .join(", ");
            return `- ${r.id}${r.nome ? ` (${r.nome})` : ""} — ${r.evento} @ ${escopo} → ${quem}${extra ? ` [${extra}]` : ""}`;
          });
          return { ok: true, texto: linhas.join("\n") };
        },
      },
    ];
    return ferramentas;
  };
}
