import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { addProfile, getProfile } from "../src/profiles.ts";
import {
  cancelAllLogins,
  cancelLogin,
  loginSessionCount,
  loginStatus,
  startLogin,
  submitCode,
} from "../src/login-session.ts";
import { tempHome } from "./helpers.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-auth-login.mjs");

afterEach(() => {
  cancelAllLogins();
  delete process.env.NEXO_CLAUDE_BIN;
  delete process.env.FAKE_LOGIN_NO_URL;
  delete process.env.FAKE_LOGIN_CALLBACK;
});

describe("login in-app", () => {
  it("devolve a URL de autorização e loga com o código", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    const { loginId, url } = await startLogin("c1", home);
    expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(loginSessionCount()).toBe(1);
    const res = await submitCode(loginId, "codigo-do-callback#state", home);
    expect(res.ok).toBe(true);
    expect(getProfile("c1", home)?.status).toBe("ready");
    expect(loginSessionCount()).toBe(0);
  });

  it("callback automático fecha o login sem código", async () => {
    const home = tempHome();
    addProfile({ id: "cb", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    process.env.FAKE_LOGIN_CALLBACK = "1";
    const { loginId } = await startLogin("cb", home);
    expect(loginStatus(loginId, home).state).toBe("waiting");
    await new Promise((r) => setTimeout(r, 1500));
    const done = loginStatus(loginId, home);
    expect(done.state).toBe("done");
    expect(done.profile?.status).toBe("ready");
    // status consome a sessão e mata o processo pendurado no prompt
    expect(loginSessionCount()).toBe(0);
    expect(() => loginStatus(loginId, home)).toThrow(/expirou/);
  });

  it("código recusado não deixa o perfil ready", async () => {
    const home = tempHome();
    addProfile({ id: "c2", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    const { loginId } = await startLogin("c2", home);
    const res = await submitCode(loginId, "codigo-ruim-do-callback", home);
    expect(res.ok).toBe(false);
    expect(res.message).toBeTruthy();
    expect(getProfile("c2", home)?.status).toBe("unauthenticated");
  });

  it("recusa código com espaço ou quebra de linha", async () => {
    const home = tempHome();
    addProfile({ id: "c3", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    const { loginId } = await startLogin("c3", home);
    await expect(submitCode(loginId, "abc\nmais-uma-linha", home)).rejects.toThrow(/inválido/);
    await expect(submitCode(loginId, "curto", home)).rejects.toThrow(/inválido/);
    cancelLogin(loginId);
    expect(loginSessionCount()).toBe(0);
  });

  it("engine que não é claude não entra nesse fluxo", async () => {
    const home = tempHome();
    addProfile({ id: "s1", engine: "stub" }, home);
    await expect(startLogin("s1", home)).rejects.toThrow(/claude/);
    await expect(startLogin("nao-existe", home)).rejects.toThrow(/não existe/);
  });

  it("e-mail inválido não vai pro argv", async () => {
    const home = tempHome();
    addProfile({ id: "c4", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    await expect(startLogin("c4", home, { email: "a b@c" })).rejects.toThrow(/e-mail/);
  });

  it("CLI sem URL falha em vez de pendurar", async () => {
    const home = tempHome();
    addProfile({ id: "c5", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fake;
    process.env.FAKE_LOGIN_NO_URL = "1";
    await expect(startLogin("c5", home)).rejects.toThrow(/URL/);
    expect(loginSessionCount()).toBe(0);
  });

  it("sessão desconhecida não aceita código", async () => {
    const home = tempHome();
    await expect(submitCode("naoexiste", "codigo-valido-aqui", home)).rejects.toThrow(/expirou/);
  });
});
