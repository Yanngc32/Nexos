import { describe, it, expect } from "vitest";
import { abreNoPreview, ehMiniatura, extensaoDoNome, fmtTamanho, seloDoArquivo, tipoDoArquivo, triarAnexos } from "../anexo-arquivo.js";

const arq = (name, size, type = "") => ({ name, size, type });

describe("anexo-arquivo", () => {
  it("classifica pelo mime o que o preview mostra; o resto só baixa", () => {
    expect(tipoDoArquivo("application/pdf")).toBe("pdf");
    expect(tipoDoArquivo("image/png")).toBe("imagem");
    expect(tipoDoArquivo("image/svg+xml")).toBe("pagina");
    expect(tipoDoArquivo("text/html")).toBe("pagina");
    expect(tipoDoArquivo("text/csv")).toBe("texto");
    expect(tipoDoArquivo("application/json")).toBe("texto");
    expect(tipoDoArquivo("video/mp4")).toBe("video");
    expect(tipoDoArquivo("application/zip")).toBe("outro");
    expect(abreNoPreview("application/pdf")).toBe(true);
    expect(abreNoPreview("application/octet-stream")).toBe(false);
    expect(abreNoPreview(undefined)).toBe(false);
    expect(tipoDoArquivo("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("planilha");
    // anexo antigo de xlsm foi gravado como octet-stream: o nome resolve
    expect(abreNoPreview("application/octet-stream", "Alvo.XLSM")).toBe(true);
    expect(abreNoPreview("application/vnd.ms-excel", "velho.xls")).toBe(false);
  });

  it("miniatura só pra imagem conferida; SVG vira cartão", () => {
    expect(ehMiniatura({ mime: "image/webp" })).toBe(true);
    expect(ehMiniatura({ mime: "image/svg+xml" })).toBe(false);
    expect(ehMiniatura({ mime: "application/pdf" })).toBe(false);
  });

  it("selo é a extensão; sem extensão, o tipo", () => {
    expect(seloDoArquivo("relatorio.pdf", "application/pdf")).toBe("PDF");
    expect(seloDoArquivo("dados.xlsx", "")).toBe("XLSX");
    expect(seloDoArquivo("LEIAME", "text/plain")).toBe("TEXT");
    expect(seloDoArquivo("sem-nada", "")).toBe("ARQ");
  });

  it("extensão pro ícone do Windows: minúscula, só o final simples", () => {
    expect(extensaoDoNome("Alvo Espaço-Tempo.XLSM")).toBe("xlsm");
    expect(extensaoDoNome("arquivo.tar.gz")).toBe("gz");
    expect(extensaoDoNome("LEIAME")).toBe("");
    expect(extensaoDoNome("x.com espaço")).toBe("");
  });

  it("tamanho legível", () => {
    expect(fmtTamanho(300)).toBe("1 KB");
    expect(fmtTamanho(340 * 1024)).toBe("340 KB");
    expect(fmtTamanho(1.25 * 1024 * 1024)).toBe("1,3 MB");
  });

  it("aceita qualquer tipo; recusa vazio, grande demais e o que passa do teto por mensagem", () => {
    const { aceitos, erros } = triarAnexos(
      [arq("a.pdf", 10), arq("b.zip", 10), arq("vazio.txt", 0), arq("enorme.mp4", 30 * 1024 * 1024)],
      0,
    );
    expect(aceitos.map((f) => f.name)).toEqual(["a.pdf", "b.zip"]);
    expect(erros).toEqual(["vazio.txt: arquivo vazio", "enorme.mp4: passa de 25 MB"]);
    const cheio = triarAnexos([arq("c.csv", 10), arq("d.csv", 10)], 5);
    expect(cheio.aceitos).toHaveLength(1);
    expect(cheio.erros).toEqual(["no máximo 6 arquivos por mensagem"]);
  });
});
