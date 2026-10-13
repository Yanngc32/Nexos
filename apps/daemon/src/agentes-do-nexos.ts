import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENTES_MAX, type AgentDef } from "@nexos/shared";
import { listAgents, saveAgent } from "./agents.ts";
import { ensureHome } from "./home.ts";
import { log } from "./log.ts";
import { listProfiles } from "./profiles.ts";

/**
 * Subagentes que vêm COM o Nexos: `explorador`, `revisor`, `testador`. Entram em `agents.json`
 * marcados como subagente (`--agents` do claude) com a descrição de "quando chamar" — antes o
 * `--agents` ia vazio porque nenhum agente estava marcado, e o modelo só conhecia os nativos.
 *
 * Mesma regra das skills do Nexos (skills-do-nexos.ts): guardamos o hash do que instalamos
 * (`~/.nexos/agentes-do-nexos.json`); agente diferente desse hash = a pessoa editou, fica como
 * está. Apagado pela pessoa (marca existe, agente não) também não volta. Versão nova do Nexos
 * atualiza só os intocados. Teto `SUBAGENTES_MAX` respeitado: sem vaga, entra desligado.
 */

export type AgenteDoNexos = { id: string; name: string; description: string; instructions: string; color?: string };

const SO_LEITURA =
  "Você é um SUBAGENTE do Nexos: trabalha pra conversa principal e devolve um relatório curto. " +
  "NÃO edite, crie nem apague arquivo; não rode comando que mude o projeto (git commit/push, instalação, migração). " +
  "Antes de ler um arquivo de código, chame `nexo_mapa_simbolos` nele (ou na pasta) — só abra o arquivo se precisar do corpo. ";

export const AGENTES_DO_NEXOS: readonly AgenteDoNexos[] = [
  {
    id: "explorador",
    name: "Explorador",
    description:
      "Varredura ampla de código/docs: onde fica X, como Y funciona, que arquivos tocam Z. Só leitura; devolve conclusão curta com caminho:linha. Use em vez de abrir 5+ arquivos na conversa.",
    instructions:
      SO_LEITURA +
      "Objetivo: responder à pergunta da conversa principal com EVIDÊNCIA (arquivo:linha) e conclusão, não com despejo de código. " +
      "Formato da resposta: 1) resposta direta em 1–3 frases; 2) lista 'onde' com `caminho:linha` e o que há ali (até 10 itens); " +
      "3) o que NÃO encontrou ou ficou em dúvida. Máximo ~25 linhas. Prefira Grep/Glob/`nexo_mapa_simbolos` a Read inteiro.",
    color: "#56b6c2",
  },
  {
    id: "revisor",
    name: "Revisor",
    description:
      "Revisa diff, commit ou arquivos por bugs, regressões, casos de borda e aderência ao design system. Só leitura; achados por gravidade com caminho:linha. Chame antes de commitar.",
    instructions:
      SO_LEITURA +
      "Objetivo: achar o que QUEBRA ou foge do padrão, não reescrever estilo. Leia o diff (`git diff`, `git show`) ou os arquivos indicados; " +
      "confira chamadas, tipos, erros não tratados, concorrência, caminhos no Windows, e tokens/regras do design system do projeto quando houver front. " +
      "Formato: lista ordenada por gravidade (bug > regressão > risco > estilo), cada item com `caminho:linha`, o problema em 1 frase e o cenário que falha. " +
      "Sem achado real, diga 'nada que bloqueie' e cite 1–2 pontos de atenção. Máximo ~30 linhas.",
    color: "#d8a657",
  },
  {
    id: "testador",
    name: "Testador",
    description:
      "Roda testes, typecheck ou build e devolve SÓ o que falhou (comando, erro, caminho:linha), sem log inteiro. Não corrige nada. Chame depois de mudar código.",
    instructions:
      "Você é um SUBAGENTE do Nexos: roda verificação e devolve um relatório curto. NÃO edite arquivo nem tente corrigir — isso é da conversa principal. " +
      "Descubra o comando certo pelo package.json/Makefile/README (ex.: `pnpm test`, `pnpm typecheck`, `npm run build`); se a conversa disse qual, use esse. " +
      "Rode com saída capturada e filtre: devolva 1) comando rodado e resultado (passou/falhou, N testes); 2) cada falha com arquivo:linha, " +
      "mensagem de erro resumida (até 5 linhas) e o nome do teste; 3) nada mais. Se tudo passou, uma linha basta. Nunca cole o log inteiro.",
    color: "#5fae74",
  },
];

const MARCA = "agentes-do-nexos.json";

function hashDe(a: Pick<AgenteDoNexos, "name" | "description" | "instructions">): string {
  return createHash("sha1").update(`${a.name}\n${a.description}\n${a.instructions}`).digest("hex");
}

function marcaPath(home: string): string {
  return join(home, MARCA);
}

function lerMarcas(home: string): Record<string, string> {
  const p = marcaPath(home);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch (err) {
    log.aviso("subagentes", "marca dos agentes do Nexos ilegível, tratando como primeira instalação", { erro: String(err) });
    return {};
  }
}

/** Conta que o agente padrão usa: a primeira `claude` (os subagentes rodam dentro do claude), senão a primeira. */
function contaPadrao(home: string): string | undefined {
  const perfis = listProfiles(home);
  return (perfis.find((p) => p.engine === "claude") ?? perfis[0])?.id;
}

export type ResultadoDaInstalacao = { instalados: string[]; atualizados: string[]; mantidos: string[]; semVaga: string[] };

/**
 * Instala/atualiza os agentes padrão. Idempotente e barato (lê agents.json). Sem conta ainda
 * (primeira subida, antes do login) não faz nada — roda de novo quando uma conta entra.
 */
export function instalarAgentesDoNexos(home: string, padroes: readonly AgenteDoNexos[] = AGENTES_DO_NEXOS): ResultadoDaInstalacao {
  const out: ResultadoDaInstalacao = { instalados: [], atualizados: [], mantidos: [], semVaga: [] };
  const profileId = contaPadrao(home);
  if (!profileId) return out;
  ensureHome(home);
  const marcas = lerMarcas(home);
  let mudou = false;
  for (const padrao of padroes) {
    const atual: AgentDef | undefined = listAgents(home).find((a) => a.id === padrao.id);
    const instalado = marcas[padrao.id];
    const novo = hashDe(padrao);
    if (atual) {
      if (!instalado) {
        // id já usado por um agente da pessoa, criado antes dos padrões existirem: é dela
        out.mantidos.push(padrao.id);
        continue;
      }
      if (instalado === novo) continue;
      if (hashDe({ name: atual.name, description: atual.description ?? "", instructions: atual.instructions ?? "" }) !== instalado) {
        out.mantidos.push(padrao.id);
        log.avisoUmaVez(`agente-editado:${padrao.id}`, "subagentes", `o agente ${padrao.id} foi editado — a versão nova do Nexos não sobrescreveu`);
        continue;
      }
    } else if (instalado) {
      // a pessoa apagou: respeita
      continue;
    }
    const ligados = listAgents(home).filter((a) => a.subagente && a.id !== padrao.id).length;
    const temVaga = ligados < SUBAGENTES_MAX;
    try {
      saveAgent(
        {
          id: padrao.id,
          name: padrao.name,
          description: padrao.description,
          instructions: padrao.instructions,
          ...(atual ? {} : { profileId, ...(padrao.color ? { color: padrao.color } : {}) }),
          ...(atual ? {} : { subagente: temVaga }),
        },
        home,
      );
      marcas[padrao.id] = novo;
      mudou = true;
      (atual ? out.atualizados : out.instalados).push(padrao.id);
      if (!atual && !temVaga) out.semVaga.push(padrao.id);
    } catch (e) {
      log.aviso("subagentes", `não consegui instalar o agente ${padrao.id} do Nexos`, { erro: (e as Error).message });
    }
  }
  if (mudou) {
    try {
      writeFileSync(marcaPath(home), JSON.stringify(marcas, null, 2), "utf8");
    } catch (e) {
      log.aviso("subagentes", "não consegui gravar a marca dos agentes do Nexos", { erro: (e as Error).message });
    }
    const resumo = [...out.instalados, ...out.atualizados];
    if (resumo.length) log.info("subagentes", `agentes do Nexos instalados/atualizados: ${resumo.join(", ")}`, out.semVaga.length ? { semVaga: out.semVaga } : {});
  }
  return out;
}
