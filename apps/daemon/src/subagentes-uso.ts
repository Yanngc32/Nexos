import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsoDeSubagente } from "@nexos/shared";
import { ensureHome } from "./home.ts";
import { log } from "./log.ts";

/**
 * Quantas vezes a ferramenta `Agent` das conversas chamou cada subagente do Nexos. É o que mostra,
 * na tela do agente, se ligar ele como subagente serviu pra alguma coisa — agente ligado e nunca
 * chamado só ocupa a descrição da ferramenta em todo turno.
 *
 * Fica só nesta máquina (`~/.nexos/subagentes-uso.json`): é medição, não configuração.
 */

/** Nomes da ferramenta que abre subagente no CLI (`Task` nas versões antigas). */
const FERRAMENTAS_DE_SUBAGENTE = new Set(["Agent", "Task"]);

function usoPath(home: string): string {
  return join(home, "subagentes-uso.json");
}

export function usoDosSubagentes(home: string): Record<string, UsoDeSubagente> {
  const path = usoPath(home);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, UsoDeSubagente>) : {};
  } catch (err) {
    log.aviso("subagentes", "uso dos subagentes ilegível, recomeçando a contagem", { erro: String(err) });
    return {};
  }
}

/**
 * Chamada de ferramenta da conversa: se for o `Agent` abrindo um subagente da lista do Nexos,
 * conta. `idsDoNexos` vem de quem chama — subagente nativo (Explore etc.) não entra.
 */
export function registrarChamadaDeSubagente(nome: string, input: unknown, idsDoNexos: ReadonlySet<string>, home: string): string | null {
  if (!FERRAMENTAS_DE_SUBAGENTE.has(nome)) return null;
  const tipo = (input as { subagent_type?: unknown } | undefined)?.subagent_type;
  if (typeof tipo !== "string" || !idsDoNexos.has(tipo)) return null;
  const uso = usoDosSubagentes(home);
  const atual = uso[tipo];
  uso[tipo] = { usos: (atual?.usos ?? 0) + 1, ultimoUso: new Date().toISOString() };
  try {
    ensureHome(home);
    writeFileSync(usoPath(home), JSON.stringify(uso, null, 2), "utf8");
  } catch (err) {
    log.aviso("subagentes", "não consegui gravar o uso do subagente", { subagente: tipo, erro: String(err) });
  }
  return tipo;
}
