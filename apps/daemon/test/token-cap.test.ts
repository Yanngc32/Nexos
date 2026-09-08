import { describe, expect, it } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { createThread, appendEvent, readThread } from "../src/threads.ts";
import { modeloDoMotor } from "../src/session.ts";
import { pack, tetoDeToken } from "../src/packer.ts";
import { DEFAULT_CONFIG } from "@nexo/shared";
import { tempHome } from "./helpers.ts";

/*
 * O que o teto de 8000 estava custando, medido: uma conversa longa numa conta
 * de janela 1M era cortada, e com o teto derivado ela passa inteira.
 */
describe("teto derivado, ponta a ponta", () => {
  function conversaLonga(home: string, model: string) {
    const t = createThread({ projectPath: "/p", profileId: "claudinho" }, home);
    // ~60k tokens de histórico: passa folgado dos 8000 antigos
    for (let i = 0; i < 60; i++) {
      appendEvent({ ts: "2026-01-01T00:00:00.000Z", type: "user", threadId: t.id, text: `pergunta ${i} ${"x".repeat(2000)}` }, home);
      appendEvent({ ts: "2026-01-01T00:00:00.000Z", type: "assistant", threadId: t.id, text: `resposta ${i} ${"y".repeat(2000)}` }, home);
      appendEvent({ ts: "2026-01-01T00:00:00.000Z", type: "usage", threadId: t.id, model, input: 1, output: 1, cacheRead: 0, cacheCreate: 0, contextTokens: 2 }, home);
    }
    return t.id;
  }

  it("conta de janela 1M passa a conversa inteira; com o teto antigo era cortada", () => {
    const home = tempHome();
    addProfile({ id: "claudinho", engine: "claude" }, home, { skipBinCheck: true });
    const id = conversaLonga(home, "claude-opus-5[1m]");
    const eventos = readThread(id, home);
    const perfil = { id: "claudinho", engine: "claude" as const, createdAt: "", status: "ready" as const };

    const antigo = pack(eventos, DEFAULT_CONFIG.pack, 8000);
    expect(antigo.trimmed).toBeDefined();
    expect(antigo.trimmed!.droppedMessages).toBeGreaterThan(0);

    const modelo = modeloDoMotor(perfil, eventos, undefined, home);
    const agora = pack(eventos, DEFAULT_CONFIG.pack, tetoDeToken(1_000_000));
    expect(modelo).toBe("claude-opus-5[1m]");
    expect(agora.trimmed).toBeUndefined();
    expect(agora.text.length).toBeGreaterThan(antigo.text.length * 5);
  });

  it("a mesma conversa numa janela de 200k também passa: 100k de teto cobre", () => {
    const home = tempHome();
    addProfile({ id: "claudinho", engine: "claude" }, home, { skipBinCheck: true });
    const id = conversaLonga(home, "claude-sonnet-5");
    const eventos = readThread(id, home);
    expect(pack(eventos, DEFAULT_CONFIG.pack, tetoDeToken(200_000)).trimmed).toBeUndefined();
  });
});
