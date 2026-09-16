import { describe, it, expect } from "vitest";
import { apagarSessaoClaude, gravarSessaoClaude, lerSessaoClaude, sessaoIdValido } from "../src/claude-session.ts";
import { tempHome } from "./helpers.ts";

describe("sessão persistida do CLI claude", () => {
  it("grava e lê o par perfil+sessionId", () => {
    const home = tempHome();
    gravarSessaoClaude("thread-aa", "conta-1", "sess-abcd-1234", home);
    expect(lerSessaoClaude("thread-aa", home)).toEqual({ profileId: "conta-1", sessionId: "sess-abcd-1234" });
  });

  it("recusa id curto ou com espaço — não vai pra argv", () => {
    expect(sessaoIdValido("abc")).toBe(false);
    expect(sessaoIdValido("sess id com espaço-1234")).toBe(false);
    expect(sessaoIdValido("sess-abcd-1234")).toBe(true);
    const home = tempHome();
    gravarSessaoClaude("thread-bb", "conta-1", "ruim", home);
    expect(lerSessaoClaude("thread-bb", home)).toBeUndefined();
  });

  it("apagar some do disco", () => {
    const home = tempHome();
    gravarSessaoClaude("thread-cc", "conta-1", "sess-abcd-1234", home);
    apagarSessaoClaude("thread-cc", home);
    expect(lerSessaoClaude("thread-cc", home)).toBeUndefined();
  });
});
