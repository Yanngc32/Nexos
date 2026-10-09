import { describe, it, expect } from "vitest";
import { registrarChamadaDeSubagente, usoDosSubagentes } from "../src/subagentes-uso.ts";
import { tempHome } from "./helpers.ts";

describe("uso dos subagentes do Nexos", () => {
  it("conta só o Agent/Task que abre um subagente do Nexos", () => {
    const home = tempHome();
    const nexos = new Set(["revisor"]);
    expect(registrarChamadaDeSubagente("Agent", { subagent_type: "revisor", prompt: "x" }, nexos, home)).toBe("revisor");
    expect(registrarChamadaDeSubagente("Task", { subagent_type: "revisor" }, nexos, home)).toBe("revisor");
    // nativo do CLI, outra ferramenta ou input torto não contam
    expect(registrarChamadaDeSubagente("Agent", { subagent_type: "Explore" }, nexos, home)).toBeNull();
    expect(registrarChamadaDeSubagente("Read", { subagent_type: "revisor" }, nexos, home)).toBeNull();
    expect(registrarChamadaDeSubagente("Agent", undefined, nexos, home)).toBeNull();
    const uso = usoDosSubagentes(home);
    expect(Object.keys(uso)).toEqual(["revisor"]);
    expect(uso.revisor?.usos).toBe(2);
    expect(Date.parse(uso.revisor?.ultimoUso ?? "")).not.toBeNaN();
  });
});
