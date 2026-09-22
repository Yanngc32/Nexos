import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  cancelAllGithubLogins,
  disconnectGithub,
  githubAccount,
  githubLoginStatus,
  githubToken,
  startGithubLogin,
} from "../src/github-auth.ts";
import { tempHome } from "./helpers.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-gh.mjs");

/** `finalize()` roda em background após o `close` do child — espera sair de "waiting". */
async function waitDone(loginId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = githubLoginStatus(loginId);
    if (status.state !== "waiting") return status;
    if (Date.now() > deadline) throw new Error("timeout esperando o login terminar");
    await new Promise((r) => setTimeout(r, 30));
  }
}

afterEach(() => {
  cancelAllGithubLogins();
  delete process.env.NEXOS_GH_BIN;
  delete process.env.FAKE_GH_NO_CODE;
  delete process.env.FAKE_GH_LOGIN_FAIL;
  delete process.env.FAKE_GH_TOKEN_FAIL;
});

describe("login do GitHub (conta única, global)", () => {
  it("loga, guarda o token global e devolve a conta conectada", async () => {
    const home = tempHome();
    process.env.NEXOS_GH_BIN = fake;
    const { loginId, code, url } = await startGithubLogin(home);
    expect(code).toBe("XXXX-YYYY");
    expect(url).toBe("https://github.com/login/device");

    const status = await waitDone(loginId);
    expect(status.state).toBe("done");
    expect(status.username).toBe("octocat");
    expect(githubToken(home)).toBe("ghu_fake_token_123");
    expect(githubAccount(home)).toMatchObject({ connected: true, username: "octocat" });
  });

  it("desconectar apaga o token local (não é por perfil)", async () => {
    const home = tempHome();
    process.env.NEXOS_GH_BIN = fake;
    const { loginId } = await startGithubLogin(home);
    await waitDone(loginId);
    expect(githubAccount(home).connected).toBe(true);

    disconnectGithub(home);
    expect(githubAccount(home)).toEqual({ connected: false });
    expect(githubToken(home)).toBeUndefined();
  });

  it("gh sem código falha em vez de pendurar", async () => {
    const home = tempHome();
    process.env.NEXOS_GH_BIN = fake;
    process.env.FAKE_GH_NO_CODE = "1";
    await expect(startGithubLogin(home)).rejects.toThrow(/código/);
  });

  it("login recusado no GitHub não guarda token", async () => {
    const home = tempHome();
    process.env.NEXOS_GH_BIN = fake;
    process.env.FAKE_GH_LOGIN_FAIL = "1";
    const { loginId } = await startGithubLogin(home);
    const status = await waitDone(loginId);
    expect(status.state).toBe("failed");
    expect(githubToken(home)).toBeUndefined();
  });

  it("sessão desconhecida não devolve status", () => {
    expect(() => githubLoginStatus("naoexiste")).toThrow(/expirou/);
  });

  it("sem conta conectada, token e conta ficam vazios", () => {
    const home = tempHome();
    expect(githubToken(home)).toBeUndefined();
    expect(githubAccount(home)).toEqual({ connected: false });
  });
});
