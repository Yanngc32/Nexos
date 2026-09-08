import { describe, it, expect } from "vitest";
import { tipoDeArquivo } from "../file-kind.js";

describe("tipo de arquivo pela extensão", () => {
  it("mapeia as famílias que a árvore pinta", () => {
    const casos = {
      "README.md": "md",
      "notas.mdx": "md",
      "file-tree.ts": "ts",
      "app.tsx": "ts",
      "renderer.js": "js",
      "main.mjs": "js",
      "package.json": "json",
      "compose.yaml": "yaml",
      "ci.yml": "yaml",
      "deploy.ps1": "shell",
      "build.bat": "shell",
      "setup.sh": "shell",
      "index.html": "html",
      "pom.xml": "html",
      "styles.css": "css",
      "tema.scss": "css",
      "app.py": "py",
      "logo.png": "img",
      "logo.svg": "svg",
      "pnpm-lock.yaml": "yaml",
      "config.toml": "config",
      "Nexo.lnk": "link",
      "saida.log": "texto",
      "pacote.zip": "arq",
      "electron.exe": "bin",
    };
    for (const [nome, esperado] of Object.entries(casos)) {
      expect(tipoDeArquivo(nome), nome).toBe(esperado);
    }
  });

  it("extensão é case-insensitive", () => {
    expect(tipoDeArquivo("README.MD")).toBe("md");
    expect(tipoDeArquivo("Foto.JPEG")).toBe("img");
    expect(tipoDeArquivo("Deploy.PS1")).toBe("shell");
  });

  it("extensão desconhecida cai no default", () => {
    expect(tipoDeArquivo("dados.xyz")).toBe("");
    expect(tipoDeArquivo("arquivo.")).toBe("");
  });

  it("nome sem extensão nenhuma cai no default", () => {
    expect(tipoDeArquivo("CHANGELOG")).toBe("");
    expect(tipoDeArquivo("")).toBe("");
    expect(tipoDeArquivo(null)).toBe("");
    expect(tipoDeArquivo(undefined)).toBe("");
  });
});

describe("tipo por nome inteiro", () => {
  it("arquivo oculto não tem o nome lido como extensão", () => {
    expect(tipoDeArquivo(".gitignore")).toBe("config");
    expect(tipoDeArquivo(".env")).toBe("config");
    expect(tipoDeArquivo(".editorconfig")).toBe("config");
    // oculto sem regra própria não vira tipo inventado a partir do nome
    expect(tipoDeArquivo(".alguma-coisa")).toBe("");
  });

  it("o nome inteiro ganha da extensão", () => {
    expect(tipoDeArquivo("Dockerfile")).toBe("docker");
    expect(tipoDeArquivo("dockerfile")).toBe("docker");
    expect(tipoDeArquivo("LICENSE")).toBe("doc");
    expect(tipoDeArquivo("Makefile")).toBe("config");
    // mas com extensão de verdade quem manda é ela
    expect(tipoDeArquivo("LICENSE.md")).toBe("md");
  });

  it(".env com sufixo continua config", () => {
    expect(tipoDeArquivo(".env.local")).toBe("config");
    expect(tipoDeArquivo(".env.production")).toBe("config");
  });
});
