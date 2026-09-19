import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GIT_HOOK_FILES, installGitHookScript, uninstallGitHookScript } from "../src/git-hooks.ts";
import { tempHome } from "./helpers.ts";

/** Mesma forma que o bloco do hook usa pra caminho absoluto: barra `/`, nunca `\`. */
const shPath = (p: string): string => p.split("\\").join("/");

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
    // O `|| true` dos outros eventos não pode encostar no disparo: é o código dele que
    // decide o push. (O log do caso "não achei a CLI" tem `|| true` próprio, e pode.)
    expect(conteudo).not.toMatch(/hook fire git\.pre-push[^\n]*\|\| true/);
    expect(conteudo).toContain('if [ "$status" -ne 0 ]; then exit "$status"; fi');
  });

  it("chama a CLI por caminho absoluto, com o `nexo` do PATH só de fallback", () => {
    const dir = repo();
    installGitHookScript(dir, "git.post-commit");
    const conteudo = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    const cli = shPath(fileURLToPath(new URL("../scripts/nexo.mjs", import.meta.url)));
    expect(conteudo).toContain(`nexo_cli="${cli}"`);
    expect(conteudo).toContain('node "$nexo_cli" hook fire git.post-commit');
    expect(conteudo).toContain("elif command -v nexo >/dev/null 2>&1; then");
    // Caminho de Windows vai com `/`: dentro de aspas no `sh`, `\` é escape.
    expect(conteudo).not.toMatch(/nexo_cli="[^"]*\\/);
  });

  it("bloco escrito por versão antiga é TROCADO, não ignorado", () => {
    const dir = repo();
    const path = join(dir, ".git", "hooks", "post-commit");
    const antigo = [
      "#!/bin/sh",
      "echo ja-tinha-algo",
      "# nexo-hook:BEGIN:git.post-commit",
      "nexo hook fire git.post-commit >/dev/null 2>&1 || true",
      "# nexo-hook:END:git.post-commit",
      "",
    ].join("\n");
    writeFileSync(path, antigo, "utf8");

    expect(installGitHookScript(dir, "git.post-commit")).toBe(true);
    const conteudo = readFileSync(path, "utf8");
    expect(conteudo).toContain('node "$nexo_cli" hook fire git.post-commit');
    expect(conteudo).toContain("echo ja-tinha-algo");
    expect(conteudo.match(/nexo-hook:BEGIN:git\.post-commit/g)).toHaveLength(1);
    // Agora sim não muda mais: o bloco já é o atual.
    expect(installGitHookScript(dir, "git.post-commit")).toBe(false);
  });
});

/**
 * O hook é shell script, e o modo como ele falhava antes (`command not found` engolido
 * pelo `|| true`) só aparece rodando de verdade. `sh` existe no Windows via Git for
 * Windows, que é quem executa estes hooks na prática.
 */
describe("o script gerado roda", () => {
  /*
   * `sh` por caminho absoluto: estes testes rodam o script com um PATH controlado (é assim
   * que se tira `node`/`nexo` de vista), e um PATH sem o diretório do próprio `sh` faria o
   * spawn falhar antes de o script rodar.
   */
  const SH = (() => {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["sh"], { encoding: "utf8" });
    return (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? "sh";
  })();

  const sh = (script: string, path: string): { status: number; erro: string } => {
    // SystemRoot: o Windows precisa dele pra abrir socket/DLL; sem isso o processo nem sobe.
    const env = { PATH: path, SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "" };
    const r = spawnSync(SH, [script], { encoding: "utf8", env });
    return { status: r.status ?? -1, erro: `${r.error?.message ?? ""}${r.stderr ?? ""}` };
  };

  it("é sh válido", () => {
    const dir = repo();
    for (const ev of ["git.post-commit", "git.post-push", "git.pre-push"]) {
      installGitHookScript(dir, ev);
      const path = join(dir, ".git", "hooks", GIT_HOOK_FILES[ev]!);
      const r = spawnSync("sh", ["-n", path], { encoding: "utf8" });
      expect(`${ev}: ${r.stderr}`).toBe(`${ev}: `);
      expect(r.status).toBe(0);
    }
  });

  it("sem node e sem CLI, cai no `nexo` do PATH", () => {
    const dir = repo();
    const bin = tempHome();
    // `$nexo_cli` existe (é a CLI de verdade do repo), mas com este PATH não há `node` —
    // é o que força o elif, o mesmo caminho de quem instalou o Nexo global.
    writeFileSync(join(bin, "nexo"), `#!/bin/sh\necho "$@" > "${shPath(join(bin, "chamado.txt"))}"\n`, "utf8");
    chmodSync(join(bin, "nexo"), 0o755);
    installGitHookScript(dir, "git.post-commit");

    const r = sh(join(dir, ".git", "hooks", "post-commit"), bin);
    expect(r.status).toBe(0);
    expect(readFileSync(join(bin, "chamado.txt"), "utf8").trim()).toBe("hook fire git.post-commit");
  });

  it("sem node, sem CLI e sem `nexo` no PATH, registra no log em vez de sumir calado", () => {
    const dir = repo();
    const home = tempHome();
    const anterior = process.env.NEXO_HOME;
    process.env.NEXO_HOME = home;
    try {
      installGitHookScript(dir, "git.post-commit");
    } finally {
      if (anterior === undefined) delete process.env.NEXO_HOME;
      else process.env.NEXO_HOME = anterior;
    }

    const vazio = tempHome();
    const r = sh(join(dir, ".git", "hooks", "post-commit"), vazio);
    // `git commit` não pode quebrar nem quando o Nexo está inalcançável.
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, "daemon.log"), "utf8")).toContain("git.post-commit não disparou");
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
