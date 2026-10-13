import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBAGENTES_MAX } from "@nexos/shared";
import { getAgent, listAgents, removeAgent, saveAgent, subagentesDaConversa } from "../src/agents.ts";
import { AGENTES_DO_NEXOS, instalarAgentesDoNexos } from "../src/agentes-do-nexos.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

describe("agentes do Nexos (subagentes padrão)", () => {
  it("sem conta não instala; com conta instala os 3 como subagente, idempotente", () => {
    const home = tempHome();
    expect(instalarAgentesDoNexos(home).instalados).toEqual([]);
    expect(listAgents(home)).toEqual([]);

    addProfile({ id: "cx", engine: "codex" }, home, { skipBinCheck: true });
    addProfile({ id: "cl", engine: "claude" }, home, { skipBinCheck: true });
    const r = instalarAgentesDoNexos(home);
    expect(r.instalados).toEqual(["explorador", "revisor", "testador"]);
    for (const a of AGENTES_DO_NEXOS) {
      const def = getAgent(a.id, home)!;
      expect(def).toMatchObject({ subagente: true, profileId: "cl", description: a.description, instructions: a.instructions });
    }
    expect(subagentesDaConversa(home, undefined).map((a) => a.id)).toEqual(["explorador", "revisor", "testador"]);
    expect(existsSync(join(home, "agentes-do-nexos.json"))).toBe(true);

    const r2 = instalarAgentesDoNexos(home);
    expect(r2).toEqual({ instalados: [], atualizados: [], mantidos: [], semVaga: [] });
  });

  it("não sobrescreve agente editado pela pessoa nem recria agente apagado", () => {
    const home = tempHome();
    addProfile({ id: "cl", engine: "claude" }, home, { skipBinCheck: true });
    instalarAgentesDoNexos(home);
    saveAgent({ id: "revisor", instructions: "do meu jeito" }, home);
    removeAgent("testador", home);
    // versão nova do Nexos: os 3 padrões mudaram
    const v2 = AGENTES_DO_NEXOS.map((a) => ({ ...a, instructions: `${a.instructions} v2` }));
    const r = instalarAgentesDoNexos(home, v2);
    expect(r.atualizados).toEqual(["explorador"]);
    expect(r.mantidos).toEqual(["revisor"]);
    expect(getAgent("revisor", home)!.instructions).toBe("do meu jeito");
    expect(getAgent("testador", home)).toBeUndefined();
    expect(getAgent("explorador", home)!.subagente).toBe(true);
    expect(getAgent("explorador", home)!.instructions).toMatch(/ v2$/);
  });

  it("agente da pessoa com o mesmo id é dela; sem vaga no teto entra desligado", () => {
    const home = tempHome();
    addProfile({ id: "cl", engine: "claude" }, home, { skipBinCheck: true });
    saveAgent({ id: "explorador", name: "Meu explorador", profileId: "cl", description: "meu" }, home);
    for (let i = 0; i < SUBAGENTES_MAX - 1; i++) saveAgent({ id: `s${i}`, name: `S${i}`, profileId: "cl", description: "d", subagente: true }, home);
    const r = instalarAgentesDoNexos(home);
    expect(r.mantidos).toEqual(["explorador"]);
    expect(getAgent("explorador", home)!.name).toBe("Meu explorador");
    expect(r.instalados).toEqual(["revisor", "testador"]);
    expect(getAgent("revisor", home)!.subagente).toBe(true);
    expect(r.semVaga).toEqual(["testador"]);
    expect(getAgent("testador", home)!.subagente).toBeUndefined();
    expect(listAgents(home).filter((a) => a.subagente)).toHaveLength(SUBAGENTES_MAX);
  });
});
