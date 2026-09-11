import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installGitHookScript, uninstallGitHookScript } from "../src/git-hooks.ts";
import { tempHome } from "./helpers.ts";

function repo(): string {
  const dir = tempHome();
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

describe("installGitHookScript", () => {
  it("cria o arquivo do zero, com shebang e a linha do evento", () => {
    const dir = repo();
    expect(installGitHookScript(dir, "git.post-commit")).toBe(true);
    const conteudo = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(conteudo).toContain("#!/bin/sh");
    expect(conteudo).toContain("nexo hook fire git.post-commit");
  });

  it("anexa a um hook já existente, sem apagar o que tinha", () => {
    const dir = repo();
    const path = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(path, "#!/bin/sh\necho ja-tinha-algo\n", "utf8");
    installGitHookScript(dir, "git.post-commit");
    const conteudo = readFileSync(path, "utf8");
    expect(conteudo).toContain("echo ja-tinha-algo");
    expect(conteudo).toContain("nexo hook fire git.post-commit");
  });

  it("é idempotente: instalar duas vezes não duplica a linha", () => {
    const dir = repo();
    installGitHookScript(dir, "git.post-commit");
    const primeira = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    const mudou = installGitHookScript(dir, "git.post-commit");
    const segunda = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(mudou).toBe(false);
    expect(segunda).toBe(primeira);
    expect(segunda.match(/nexo hook fire/g)).toHaveLength(1);
  });

  it("arquivo existe mas está vazio (sobra de um uninstall que removeu o último bloco): reinstala COM shebang, não anexa num arquivo sem shebang nenhum", () => {
    /*
     * Bug real, visto neste repo: instalar → desinstalar (uninstall esvazia o arquivo,
     * mas não apaga) → instalar de novo tratava "arquivo existe" como "já tem conteúdo,
     * só anexar", perdendo o shebang pra sempre. O git tentava rodar o hook direto e
     * falhava com "cannot spawn ...: No such file or directory".
     */
    const dir = repo();
    const path = join(dir, ".git", "hooks", "post-commit");
    installGitHookScript(dir, "git.post-commit");
    uninstallGitHookScript(dir, "git.post-commit");
    expect(readFileSync(path, "utf8").trim()).toBe(""); // pré-condição: ficou vazio, não apagado
    installGitHookScript(dir, "git.post-commit");
    const conteudo = readFileSync(path, "utf8");
    expect(conteudo.startsWith("#!/bin/sh")).toBe(true);
    expect(conteudo).toContain("nexo hook fire git.post-commit");
  });

  it("post-commit e post-push são arquivos separados", () => {
    const dir = repo();
    installGitHookScript(dir, "git.post-commit");
    installGitHookScript(dir, "git.post-push");
    expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(true);
    expect(existsSync(join(dir, ".git", "hooks", "post-push"))).toBe(true);
  });

  it("recusa evento sem hook de git conhecido", () => {
    const dir = repo();
    expect(() => installGitHookScript(dir, "run.done")).toThrow(/sem hook de git conhecido/);
  });

  it("pre-push propaga exit code (sem `|| true`) — é o único que pode bloquear", () => {
    const dir = repo();
    installGitHookScript(dir, "git.pre-push");
    const conteudo = readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8");
    expect(conteudo).toContain("nexo hook fire git.pre-push --branch");
    expect(conteudo).not.toContain("|| true");
    expect(conteudo).toContain('if [ "$status" -ne 0 ]; then exit "$status"; fi');
  });
});

describe("uninstallGitHookScript", () => {
  it("remove só o bloco do evento, preservando o resto do arquivo", () => {
    const dir = repo();
    const path = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(path, "#!/bin/sh\necho ja-tinha-algo\n", "utf8");
    installGitHookScript(dir, "git.post-commit");
    expect(uninstallGitHookScript(dir, "git.post-commit")).toBe(true);
    const conteudo = readFileSync(path, "utf8");
    expect(conteudo).toContain("echo ja-tinha-algo");
    expect(conteudo).not.toContain("nexo hook fire");
  });

  it("apaga o conteúdo se sobrar só o shebang", () => {
    const dir = repo();
    installGitHookScript(dir, "git.post-commit");
    uninstallGitHookScript(dir, "git.post-commit");
    const conteudo = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(conteudo.trim()).toBe("");
  });

  it("sem sentinela ou sem arquivo, não muda nada", () => {
    const dir = repo();
    expect(uninstallGitHookScript(dir, "git.post-commit")).toBe(false);
    writeFileSync(join(dir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho outra-coisa\n", "utf8");
    expect(uninstallGitHookScript(dir, "git.post-commit")).toBe(false);
  });
});
