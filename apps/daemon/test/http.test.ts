import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http.ts";
import { addProfile, engineEnv, getProfile } from "../src/profiles.ts";
import { createThread, readThread } from "../src/threads.ts";
import { postMessage } from "../src/session.ts";
import { liveCred, tempHome } from "./helpers.ts";
import { cancelAllLogins } from "../src/login-session.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const fakeLogin = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-auth-login.mjs");

const token = "test-token";

describe("http projects", () => {
  it("devolve pastas do config e das conversas", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    createThread({ projectPath: "C:/proj/da-conversa", profileId: "p1" }, home);
    const res = await app.request("/v1/config", {
      method: "PUT",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ repos: ["C:/proj/salvo"], lastProject: "C:/proj/salvo" }),
    });
    expect(res.status).toBe(200);

    const proj = await app.request("/v1/projects", { headers: { authorization: "Bearer t" } });
    const body = (await proj.json()) as {
      repos: string[];
      lastProject: string;
      fromConfig: number;
      fromThreads: number;
    };
    expect(body.repos).toContain("C:/proj/salvo");
    expect(body.repos).toContain("C:/proj/da-conversa");
    expect(body.lastProject).toBe("C:/proj/salvo");
    expect(body.fromConfig).toBe(1);
    expect(body.fromThreads).toBe(1);
  });

  it("sem config, ainda acha a pasta pela conversa", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    createThread({ projectPath: "C:/proj/orfao", profileId: "p1" }, home);
    const proj = await app.request("/v1/projects", { headers: { authorization: "Bearer t" } });
    expect(((await proj.json()) as { repos: string[] }).repos).toEqual(["C:/proj/orfao"]);
  });

  it("pasta escondida some da lista mesmo com conversa apontando pra ela", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    createThread({ projectPath: "C:/proj/fora", profileId: "p1" }, home);
    const res = await app.request("/v1/config", {
      method: "PUT",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      // o app grava a chave normalizada; a dedução pelas conversas usa a original
      body: JSON.stringify({ repos: [], hiddenRepos: ["c:/proj/fora"] }),
    });
    expect(res.status).toBe(200);
    const proj = await app.request("/v1/projects", { headers: { authorization: "Bearer t" } });
    expect(((await proj.json()) as { repos: string[] }).repos).toEqual([]);
  });
});

describe("http agents", () => {
  it("lista uma linha por conversa viva, com a conta de cada uma", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const a = createThread({ projectPath: "C:/proj/a", profileId: "p1" }, home);
    const b = createThread({ projectPath: "C:/proj/b", profileId: "p2" }, home);
    await postMessage(a.id, "oi de a", home);
    await postMessage(b.id, "oi de b", home);

    const res = await app.request("/v1/agents", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threadId: string;
      profileId: string;
      projectPath: string;
      preview: string;
      busy: boolean;
      engine: string;
    }[];
    const porThread = Object.fromEntries(body.map((x) => [x.threadId, x]));
    expect(porThread[a.id]).toMatchObject({
      profileId: "p1",
      projectPath: "C:/proj/a",
      preview: "oi de a",
      busy: false,
      engine: "stub",
    });
    expect(porThread[b.id]).toMatchObject({ profileId: "p2", projectPath: "C:/proj/b", busy: false });
  });

  it("conversa sem turno nenhum não aparece: motor só sobe quando alguém fala", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "C:/proj/a", profileId: "p1" }, home);
    const res = await app.request("/v1/agents", { headers: { authorization: "Bearer t" } });
    // `lives` é global do processo: outras conversas dos testes vizinhos podem estar de pé
    const body = (await res.json()) as { threadId: string }[];
    expect(body.some((x) => x.threadId === t.id)).toBe(false);
  });
});

describe("http agent defs", () => {
  const auth = { authorization: "Bearer t", "content-type": "application/json" };

  it("cria, lista, edita e apaga", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);

    const criado = await app.request("/v1/agents/defs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "rev", name: "Revisor", profileId: "p1", model: "opus" }),
    });
    expect(criado.status).toBe(201);

    const lista = await app.request("/v1/agents/defs", { headers: auth });
    expect((await lista.json()) as unknown[]).toMatchObject([{ id: "rev", name: "Revisor", model: "opus" }]);

    // A rota manda no id: body com outro id não cria um segundo agente.
    const editado = await app.request("/v1/agents/defs/rev", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: "outro", name: "Revisor 2" }),
    });
    expect(await editado.json()).toMatchObject({ id: "rev", name: "Revisor 2", model: "opus" });

    const apagado = await app.request("/v1/agents/defs/rev", { method: "DELETE", headers: auth });
    expect(apagado.status).toBe(200);
    expect(await (await app.request("/v1/agents/defs", { headers: auth })).json()).toEqual([]);
    const denovo = await app.request("/v1/agents/defs/rev", { method: "DELETE", headers: auth });
    expect(denovo.status).toBe(404);
  });

  it("recusa agente com conta inexistente", async () => {
    const app = createApp(tempHome(), "t");
    const res = await app.request("/v1/agents/defs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "x", name: "X", profileId: "fantasma" }),
    });
    expect(res.status).toBe(400);
  });

  it("conversa aberta pelo agente herda a conta dele e grava o vínculo", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    await app.request("/v1/agents/defs", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "rev", name: "Revisor", profileId: "p2" }),
    });
    const res = await app.request("/v1/threads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ projectPath: "C:/proj", agentId: "rev" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(readThread(id, home)[0]).toMatchObject({ type: "thread_meta", profileId: "p2", agentId: "rev" });

    const semAgente = await app.request("/v1/threads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ projectPath: "C:/proj", agentId: "fantasma" }),
    });
    expect(semAgente.status).toBe(400);
  });
});

describe("http accounts", () => {
  it("expõe metadado da conta sem vazar token", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("c1", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), liveCred(), "utf8");
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "eu@exemplo.com", organizationName: "acme" } }),
      "utf8",
    );
    const res = await app.request("/v1/accounts/c1", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: "c1", engine: "claude", status: "ready", credential: "live" });
    expect(body.email).toBe("eu@exemplo.com");
    expect(body.organization).toBe("acme");
    expect(JSON.stringify(body)).not.toContain("at-live");
    expect(JSON.stringify(body)).not.toContain("rt-live");

    const all = await app.request("/v1/accounts", { headers: { authorization: "Bearer t" } });
    expect((await all.json()).map((a: { id: string }) => a.id)).toContain("c1");
  });

  it("PATCH salva modelo e esforço, e barra valor inválido", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "c2", engine: "claude" }, home, { skipBinCheck: true });
    const ok = await app.request("/v1/profiles/c2", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "opus", effort: "max" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ model: "opus", effort: "max" });
    const bad = await app.request("/v1/profiles/c2", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ effort: "ultra" }),
    });
    expect(bad.status).toBe(400);
    const mode = await app.request("/v1/profiles/c2", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ permissionMode: "acceptEdits" }),
    });
    expect(mode.status).toBe(200);
    expect(await mode.json()).toMatchObject({ permissionMode: "acceptEdits" });
    const badMode = await app.request("/v1/profiles/c2", {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ permissionMode: "yolo" }),
    });
    expect(badMode.status).toBe(400);
  });

  it("login in-app: start devolve URL e code loga", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "c3", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXO_CLAUDE_BIN = fakeLogin;
    try {
      const started = await app.request("/v1/profiles/c3/login/start", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{}",
      });
      expect(started.status).toBe(200);
      const { loginId, url } = (await started.json()) as { loginId: string; url: string };
      expect(url).toMatch(/oauth\/authorize/);

      const bad = await app.request("/v1/profiles/c3/login/code", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ loginId, code: "com espaço" }),
      });
      expect(bad.status).toBe(400);

      const ok = await app.request("/v1/profiles/c3/login/code", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ loginId, code: "codigo-do-callback#state" }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, profile: { id: "c3", status: "ready" } });
    } finally {
      cancelAllLogins();
      delete process.env.NEXO_CLAUDE_BIN;
    }
  });

  it("login in-app recusa engine que não é claude", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "s1", engine: "stub" }, home);
    const res = await app.request("/v1/profiles/s1/login/start", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/claude/);
  });

  it("conta inexistente dá 404", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    const res = await app.request("/v1/accounts/nada", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(404);
  });
});

describe("http", () => {
  it("rejeita bearer errado", async () => {
    const app = createApp(tempHome(), token);
    const res = await app.request("/v1/profiles", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("libera CORS pra desktop", async () => {
    const app = createApp(tempHome(), token);
    const res = await app.request("/v1/profiles", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:1420",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("mensagem stub e switch sem confirmed = 400", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const sent = await app.request(`/v1/threads/${t.id}/messages`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ text: "oi" }),
    });
    expect(sent.status).toBe(200);
    const sw = await app.request(`/v1/threads/${t.id}/switch`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ profileId: "p2", confirmed: false }),
    });
    expect(sw.status).toBe(400);
  });

  it("grava accent no config", async () => {
    const home = tempHome();
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const put = await app.request("/v1/config", {
      method: "PUT",
      headers: hdr,
      body: JSON.stringify({ accent: "#7c5cbf" }),
    });
    expect(put.status).toBe(200);
    const got = await app.request("/v1/config", { headers: hdr });
    const body = await got.json();
    expect(body.accent).toBe("#7c5cbf");
  });

  it("import claude sem credencial global = 400", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    const prev = process.env.NEXO_CLAUDE_GLOBAL;
    const prevJson = process.env.NEXO_CLAUDE_GLOBAL_JSON;
    process.env.NEXO_CLAUDE_GLOBAL = join(home, "empty-claude");
    process.env.NEXO_CLAUDE_GLOBAL_JSON = join(home, "nope.json");
    try {
      const app = createApp(home, token);
      const res = await app.request("/v1/profiles/c1/import", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.NEXO_CLAUDE_GLOBAL;
      else process.env.NEXO_CLAUDE_GLOBAL = prev;
      if (prevJson === undefined) delete process.env.NEXO_CLAUDE_GLOBAL_JSON;
      else process.env.NEXO_CLAUDE_GLOBAL_JSON = prevJson;
    }
  });

  it("GET perfil reconhece credencial isolada", async () => {
    const home = tempHome();
    addProfile({ id: "c9", engine: "claude" }, home, { skipBinCheck: true });
    const dir = join(home, "profiles", "c9", "claude");
    writeFileSync(join(dir, ".credentials.json"), "{}", "utf8");
    const app = createApp(home, token);
    const res = await app.request("/v1/profiles/c9", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
  });

  it("abort de thread sem live = 200", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const app = createApp(home, token);
    const res = await app.request(`/v1/threads/${t.id}/abort`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("clear grava a marca e some da live; thread inexistente = 404", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await app.request(`/v1/threads/${t.id}/messages`, { method: "POST", headers: hdr, body: JSON.stringify({ text: "oi" }) });
    const res = await app.request(`/v1/threads/${t.id}/clear`, { method: "POST", headers: hdr });
    expect(res.status).toBe(200);
    expect(readThread(t.id, home).some((e) => e.type === "cleared")).toBe(true);
    const miss = await app.request("/v1/threads/nao-existe/clear", { method: "POST", headers: hdr });
    expect(miss.status).toBe(404);
  });

  it("serviços: lista, start/stop, log, trust e 404", async () => {
    const home = tempHome();
    const proj = tempHome();
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
    writeFileSync(
      join(proj, "nexo.json"),
      JSON.stringify({
        services: [
          { id: "svc", name: "Fake", cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`, url: "http://127.0.0.1:9/" },
        ],
      }),
      "utf8",
    );
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const q = `projectPath=${encodeURIComponent(proj)}`;

    const lista = await app.request(`/v1/services?${q}`, { headers: hdr });
    expect(lista.status).toBe(200);
    const rel = await lista.json();
    expect(rel.trusted).toBe(false);
    expect(rel.services[0]).toMatchObject({ id: "svc", name: "Fake", proc: "off", portNumber: 9 });

    const trust = await app.request("/v1/services/trust", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ projectPath: proj }),
    });
    expect(trust.status).toBe(200);
    const depois = await app.request(`/v1/services?${q}`, { headers: hdr });
    expect((await depois.json()).trusted).toBe(true);

    const start = await app.request("/v1/services/svc/start", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ projectPath: proj }),
    });
    expect(start.status).toBe(200);
    expect((await start.json()).proc).toBe("running");

    const logs = await app.request(`/v1/services/svc/logs?${q}`, { headers: hdr });
    expect(logs.status).toBe(200);
    expect(typeof (await logs.json()).log).toBe("string");

    const stop = await app.request("/v1/services/svc/stop", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ projectPath: proj }),
    });
    expect((await stop.json()).proc).toBe("exited");

    const miss = await app.request("/v1/services/nao-existe/start", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ projectPath: proj }),
    });
    expect(miss.status).toBe(404);

    const semPath = await app.request("/v1/services", { headers: hdr });
    expect(semPath.status).toBe(400);
  });

  it("probe recusa host fora de loopback e responde porta fechada", async () => {
    const app = createApp(tempHome(), token);
    const hdr = { authorization: `Bearer ${token}` };
    const fora = await app.request("/v1/probe?url=http%3A%2F%2Fexample.com", { headers: hdr });
    expect(fora.status).toBe(400);
    const fechada = await app.request("/v1/probe?url=http%3A%2F%2F127.0.0.1%3A1%2F", { headers: hdr });
    expect(fechada.status).toBe(200);
    expect((await fechada.json()).ok).toBe(false);
  });

  it("DELETE thread some e 404 de novo", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}` };
    const del = await app.request(`/v1/threads/${t.id}`, { method: "DELETE", headers: hdr });
    expect(del.status).toBe(200);
    const again = await app.request(`/v1/threads/${t.id}`, { method: "DELETE", headers: hdr });
    expect(again.status).toBe(404);
  });

  /**
   * O id da conversa vem do caminho da rota e virava nome de arquivo. Com `..`
   * escapava do NEXO_HOME: a mensagem era gravada antes da validação e criava
   * arquivo (e pasta) em qualquer lugar onde o daemon tenha escrita.
   */
  it("threadId com .. na rota não cria arquivo fora do home", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const app = createApp(home, token);
    const fora = join(home, "..", "escapou.jsonl");
    const res = await app.request("/v1/threads/..%2Fescapou/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(fora)).toBe(false);
  });

  it("conversa sem projectPath é recusada em vez de nascer órfã", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const app = createApp(home, token);
    const res = await app.request("/v1/threads", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ profileId: "p1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/projectPath/);
  });

  it("perfil com .. na rota é 404, não erro de servidor", async () => {
    const home = tempHome();
    const app = createApp(home, token);
    const res = await app.request("/v1/profiles/..%2F..%2Fetc", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("http teams e runs", () => {
  const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  function base() {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    return { home, app: createApp(home, token) };
  }

  async function criarAgente(app: ReturnType<typeof createApp>, id: string) {
    return app.request("/v1/agents/defs", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ id, name: id.toUpperCase(), profileId: "p1" }),
    });
  }

  it("CRUD de time pela API", async () => {
    const { app } = base();
    await criarAgente(app, "a1");

    const criar = await app.request("/v1/teams", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ id: "time", name: "Time", members: [{ agentId: "a1", papel: "faz" }] }),
    });
    expect(criar.status).toBe(201);

    expect((await (await app.request("/v1/teams", { headers: hdr })).json())).toHaveLength(1);
    expect((await (await app.request("/v1/teams/time", { headers: hdr })).json()).name).toBe("Time");

    const put = await app.request("/v1/teams/time", {
      method: "PUT",
      headers: hdr,
      body: JSON.stringify({ id: "outro", name: "Renomeado" }),
    });
    // a rota manda no id: o body com outro id não cria nem renomeia
    expect((await put.json()).id).toBe("time");

    expect((await app.request("/v1/teams/time", { method: "DELETE", headers: hdr })).status).toBe(200);
    expect((await app.request("/v1/teams/time", { headers: hdr })).status).toBe(404);
  });

  it("time com agente inexistente é 400, com o motivo", async () => {
    const { app } = base();
    const res = await app.request("/v1/teams", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ id: "t", name: "T", members: [{ agentId: "fantasma" }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agente não existe/);
  });

  it("run roda o pipeline inteiro e o resultado aparece na consulta", async () => {
    const { app } = base();
    await criarAgente(app, "a1");
    await criarAgente(app, "a2");
    await app.request("/v1/teams", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ id: "t", name: "T", members: [{ agentId: "a1" }, { agentId: "a2" }] }),
    });

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ teamId: "t", projectPath: "/proj", goal: "objetivo-de-teste" }),
    });
    // 201 com o run parado: a execução segue em segundo plano
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.steps.every((s: { status: string }) => s.status === "pending")).toBe(true);

    // espera o run fechar, consultando como a UI faria
    let atual = run;
    for (let i = 0; i < 100 && atual.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      atual = await (await app.request(`/v1/runs/${run.id}`, { headers: hdr })).json();
    }
    expect(atual.status).toBe("done");
    expect(atual.steps.map((s: { status: string }) => s.status)).toEqual(["done", "done"]);
  });

  it("run com time que não existe é 400", async () => {
    const { app } = base();
    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ teamId: "fantasma", projectPath: "/p", goal: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("abort de run que não está rodando responde running:false em vez de erro", async () => {
    const { app } = base();
    const res = await app.request("/v1/runs/r-nao-existe/abort", { method: "POST", headers: hdr });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, running: false });
  });

  it("run inexistente é 404", async () => {
    const { app } = base();
    expect((await app.request("/v1/runs/r-nada", { headers: hdr })).status).toBe(404);
  });
});
