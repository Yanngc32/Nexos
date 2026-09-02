import { describe, it, expect } from "vitest";
import { createApp } from "../src/http.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const token = "test-token";

describe("http", () => {
  it("rejeita bearer errado", async () => {
    const app = createApp(tempHome(), token);
    const res = await app.request("/v1/profiles", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
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
});
