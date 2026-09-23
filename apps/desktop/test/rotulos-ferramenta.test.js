import { describe, it, expect } from "vitest";
import { rotuloDaFerramenta } from "../rotulos-ferramenta.js";

describe("rotuloDaFerramenta", () => {
  it("ferramentas do Nexos ganham texto legível; o resto fica com o nome", () => {
    expect(rotuloDaFerramenta("mcp__nexo__nexo_navegador_ler")).toEqual({ texto: "Navegando · lendo a página", ico: "◎" });
    expect(rotuloDaFerramenta("mcp__nexo__nexo_navegador_screenshot")?.texto).toBe("Navegando · tirando print");
    expect(rotuloDaFerramenta("mcp__nexo__nexo_navegador_novo")?.texto).toBe("Navegando…");
    expect(rotuloDaFerramenta("mcp__nexo__nexo_windows_estado")?.texto).toBe("No Windows · lendo a tela");
    expect(rotuloDaFerramenta("mcp__nexo__nexo_mapa_simbolos")?.texto).toBe("Mapeando símbolos");
    expect(rotuloDaFerramenta("Bash")).toBeNull();
    expect(rotuloDaFerramenta("mcp__outro__x")).toBeNull();
  });
});
