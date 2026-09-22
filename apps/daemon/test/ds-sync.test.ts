import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { addProfile } from "../src/profiles.ts";
import { criarDs, estadoDs } from "../src/design-system.ts";
import { blocoDoDsParaPack, conformidade, exportar, ressincronizar } from "../src/ds-sync.ts";
import { createThread } from "../src/threads.ts";
import { getLive, postMessage } from "../src/session.ts";
import type { StubEngine } from "../src/engines/stub.ts";

let home: string;
let proj: string;
beforeEach(() => {
  home = tempHome();
  proj = mkdtempSync(join(tmpdir(), "nexo-sync-"));
  mkdirSync(join(proj, "src"));
  // esqueleto tem color.primary #c81e2c e color.bg #161616
  writeFileSync(
    join(proj, "src", "app.css"),
    [
      "/* #ffffff em comentário não conta */",
      "#main { color: #c81e2c; }", // seletor de id não conta; #c81e2c é exato
      ".a { background: #c91f2d; }", // quase o primário
      ".b { color: #00ff88; }", // fora da paleta
      ".c { color: #00ff88; } .d { border-color: #00ff88; } .e{color:#00ff88}",
    ].join("\n"),
  );
  writeFileSync(join(proj, "src", "App.tsx"), `export const A = () => <a href="#topo" style={{ color: "#161616" }}>x</a>;`);
});

describe("conformidade", () => {
  it("acha cor solta, diz o token exato ou o mais perto, e ignora comentário/âncora/seletor de id", () => {
    criarDs(proj, home, { nome: "Teste" });
    const r = conformidade(proj, home);
    const valores = r.achados.map((a) => a.valor.toLowerCase());
    expect(valores).not.toContain("#ffffff");
    expect(valores).not.toContain("#main");
    expect(valores).not.toContain("#topo");
    const exato = r.achados.find((a) => a.valor === "#c81e2c")!;
    expect(exato.exato).toBe("--color-primary");
    const quase = r.achados.find((a) => a.valor === "#c91f2d")!;
    expect(quase.sugestao?.token).toBe("--color-primary");
    expect(quase.sugestao!.distancia).toBeLessThan(40);
    expect(r.achados.find((a) => a.arquivo === "src/App.tsx")?.exato).toBe("--color-bg");
    expect(r.foraDaPaleta).toBeGreaterThanOrEqual(4);
    expect(r.porArquivo[0]!.arquivo).toBe("src/app.css");
  });
});

describe("ressincronizar", () => {
  it("cor usada 3+ vezes que nenhum token cobre aparece como nova; token sem uso aparece também", () => {
    criarDs(proj, home, { nome: "Teste" });
    const r = ressincronizar(proj, home);
    expect(r.coresNovas.map((c) => c.hex)).toContain("#00ff88");
    expect(r.coresNovas.map((c) => c.hex)).not.toContain("#c91f2d"); // coberta de perto pelo primário
    expect(r.coresSemUso.map((c) => c.token)).toContain("--color-warning");
  });
});

describe("exportar", () => {
  it("css, tailwind4 (namespaces do v4, referência resolvida), tailwind3 e dtcg", () => {
    criarDs(proj, home, { nome: "Teste" });
    expect(exportar(proj, home, "css").texto).toContain("--color-primary: #c81e2c;");
    const tw4 = exportar(proj, home, "tailwind4").texto;
    expect(tw4).toContain("@theme {");
    expect(tw4).toContain("--color-primary: #c81e2c;");
    expect(tw4).toContain("--spacing-4: 16px;");
    expect(tw4).toContain("--text-sm: 13px;");
    expect(tw4).toContain('--font-body: "IBM Plex Sans", system-ui, sans-serif;');
    const tw3 = exportar(proj, home, "tailwind3").texto;
    expect(tw3).toContain('"primary": "#c81e2c"');
    expect(tw3).toContain('"body": [');
    expect(JSON.parse(exportar(proj, home, "dtcg").texto).color.primary.$value).toBe("#c81e2c");
  });
});

describe("design system no contexto do agente", () => {
  it("bloco com caminho, regras e tokens; entra no pack da conversa do projeto", async () => {
    expect(blocoDoDsParaPack(proj, home)).toBeNull();
    criarDs(proj, home, { nome: "Teste" });
    const bloco = blocoDoDsParaPack(proj, home)!;
    expect(bloco).toContain("# Design system do projeto: Teste");
    expect(bloco).toContain(estadoDs(proj, home).ds!.pastaAbs);
    expect(bloco).toContain("--color-primary: #c81e2c");

    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: proj, profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    expect((getLive(t.id)?.engine as StubEngine).lastStart?.contextPack).toContain("# Design system do projeto: Teste");
    // conversa de trabalho do próprio DS não recebe o bloco (já tem tudo no pedido)
    const oculta = createThread({ projectPath: proj, profileId: "p1", oculta: true }, home);
    await postMessage(oculta.id, "oi", home);
    expect((getLive(oculta.id)?.engine as StubEngine).lastStart?.contextPack ?? "").not.toContain("# Design system do projeto");
  });
});
