import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalSkillsDir } from "./home.ts";
import { log } from "./log.ts";

/**
 * Skills que vêm DENTRO do pacote do motor (`apps/daemon/skills/<nome>/`, no `files` do
 * package.json) e vão pra pasta global do Nexos na subida — a mesma que `syncGlobalSkills` copia
 * pra cada perfil, e que o projeto pode desligar como qualquer skill global. Hoje: `nexo-video`
 * (painel de vídeo do Canvas).
 *
 * Versão nova do Nexos atualiza a skill instalada SÓ se a pessoa não mexeu nela: guardamos o hash
 * do que instalamos (`.nexos-origem`); SKILL.md diferente desse hash = edição da pessoa, fica.
 */
export function pastaDasSkillsDoNexos(): string {
  // src/ e dist/ ficam na mesma profundidade
  return process.env.NEXOS_SKILLS_DO_NEXOS || join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

const MARCA = ".nexos-origem";

function hash(texto: string): string {
  return createHash("sha1").update(texto).digest("hex");
}

export function instalarSkillsDoNexos(home: string): { instaladas: string[]; mantidas: string[] } {
  const origem = pastaDasSkillsDoNexos();
  const out = { instaladas: [] as string[], mantidas: [] as string[] };
  let nomes: string[] = [];
  try {
    nomes = readdirSync(origem, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    log.aviso("skill", `skills do Nexos não estão em ${origem}`, { erro: (e as Error).message });
    return out;
  }
  for (const nome of nomes) {
    try {
      const de = join(origem, nome);
      const para = join(globalSkillsDir(home), nome);
      const novo = readFileSync(join(de, "SKILL.md"), "utf8");
      const marca = join(para, MARCA);
      if (existsSync(join(para, "SKILL.md"))) {
        const atual = readFileSync(join(para, "SKILL.md"), "utf8");
        const instalado = existsSync(marca) ? readFileSync(marca, "utf8").trim() : "";
        if (hash(atual) === hash(novo)) continue;
        if (hash(atual) !== instalado) {
          out.mantidas.push(nome);
          log.avisoUmaVez(`skill-editada:${nome}`, "skill", `a skill ${nome} foi editada à mão — a versão nova do Nexos não sobrescreveu`, { pasta: para });
          continue;
        }
      }
      mkdirSync(para, { recursive: true });
      cpSync(de, para, { recursive: true });
      writeFileSync(marca, hash(novo), "utf8");
      out.instaladas.push(nome);
    } catch (e) {
      log.aviso("skill", `não consegui instalar a skill ${nome} do Nexos`, { erro: (e as Error).message });
    }
  }
  if (out.instaladas.length) log.info("skill", `skills do Nexos instaladas: ${out.instaladas.join(", ")}`);
  return out;
}
