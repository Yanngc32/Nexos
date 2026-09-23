import { describe, expect, it } from "vitest";
import { lerElementos, textoComElementos } from "../src/attachments.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread, readThread } from "../src/threads.ts";
import { getLive, postMessage } from "../src/session.ts";
import type { StubEngine } from "../src/engines/stub.ts";
import { tempHome } from "./helpers.ts";

describe("elementos do preview (picker do browser)", () => {
  it("o chat guarda só o pedido + os elementos; o motor recebe o detalhe de cada um", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/p", profileId: "p1" }, home);
    const elementos = lerElementos([
      { rotulo: "svg1", seletor: "div.recharts-wrapper > svg", texto: "fev/26 mar/26", html: "<svg>…</svg>" },
      { lixo: true },
    ]);
    await postMessage(t.id, "faltando jan/26", home, [], { elementos });
    const ev = readThread(t.id, home).find((e) => e.type === "user");
    expect(ev).toMatchObject({ text: "faltando jan/26", elementos: [{ rotulo: "svg1", seletor: "div.recharts-wrapper > svg" }] });
    const enviado = (getLive(t.id)?.engine as StubEngine).lastSend ?? "";
    expect(enviado).toContain("faltando jan/26");
    expect(enviado).toContain('1. [svg1] div.recharts-wrapper > svg — "fev/26 mar/26"');
    expect(enviado).toContain("<svg>…</svg>");
  });

  it("sem elementos o texto passa igual; só elementos ganha um pedido-padrão", () => {
    expect(textoComElementos("oi", [])).toBe("oi");
    expect(textoComElementos("", [{ rotulo: "div1", seletor: "div", html: "<div/>" }])).toMatch(/^\(sem pedido escrito\)/);
  });
});
