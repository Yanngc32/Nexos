import { describe, expect, it } from "vitest";
import { atualizacaoDasRegras, blocosDeRegras } from "../src/engines/regras-da-sessao.ts";

const A = "# Perguntar com opções\nuse nexo_perguntar";
const MEM = "# Memória do projeto\nfoo\n\n## detalhe\nbar";
const DS = "# Design system do projeto: X\nPasta: G:/ds\n\n## Tokens\n--a: 1";

describe("regras da sessão", () => {
  it("separa pelos `# ` do topo; `## ` fica dentro do bloco", () => {
    const b = blocosDeRegras([A, MEM, DS].join("\n\n"));
    expect([...b.keys()]).toEqual(["# Perguntar com opções", "# Memória do projeto", "# Design system do projeto: X"]);
    expect(b.get("# Memória do projeto")).toContain("## detalhe");
  });

  it("sem mudança não manda nada; DS novo vai sozinho; memória alterada vai; bloco que saiu é avisado", () => {
    const antes = [A, MEM].join("\n\n");
    expect(atualizacaoDasRegras(antes, antes)).toBe("");
    const comDs = atualizacaoDasRegras(antes, [A, MEM, DS].join("\n\n"));
    expect(comDs).toContain("Pasta: G:/ds");
    expect(comDs).not.toContain("use nexo_perguntar");
    expect(comDs).not.toContain("## detalhe");
    const memNova = atualizacaoDasRegras(antes, [A, MEM.replace("foo", "foo2")].join("\n\n"));
    expect(memNova).toContain("foo2");
    expect(memNova).not.toContain("use nexo_perguntar");
    expect(atualizacaoDasRegras(antes, A)).toContain("Não valem mais: Memória do projeto.");
    expect(comDs.endsWith("\n\n---\n\n")).toBe(true);
  });

  it("sessão sem registro (antiga) recebe tudo uma vez", () => {
    const tudo = atualizacaoDasRegras(null, [A, DS].join("\n\n"));
    expect(tudo).toContain("regras atuais desta conversa");
    expect(tudo).toContain("use nexo_perguntar");
    expect(tudo).toContain("Pasta: G:/ds");
  });
});
