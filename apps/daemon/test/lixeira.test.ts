import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { listarLixeira, varrerLixeira } from "../src/lixeira.ts";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, createThread, listThreads, marcarLixeira, threadHead } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const DIA = 24 * 60 * 60_000;

/** Conversa com a última mensagem `diasAtras` dias atrás. */
function conversa(home: string, diasAtras: number, extra: Partial<Parameters<typeof createThread>[0]> = {}): string {
  const t = createThread({ projectPath: "/proj", profileId: "p1", ...extra }, home);
  appendEvent({ ts: new Date(Date.now() - diasAtras * DIA).toISOString(), type: "user", threadId: t.id, text: "oi" }, home);
  return t.id;
}

function preparar(): string {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  return home;
}

describe("lixeira", () => {
  it("manda a parada pra lixeira, some da lista e não mexe na recente", async () => {
    const home = preparar();
    const velha = conversa(home, 10);
    const nova = conversa(home, 1);
    const r = await varrerLixeira(home);
    expect(r).toEqual({ movidas: 1, apagadas: 0 });
    expect(listThreads("/proj", home).map((t) => t.id)).toEqual([nova]);
    expect(listarLixeira(home).map((t) => t.id)).toEqual([velha]);
  });

  it("ir pra lixeira não conta como atividade; restaurar conta", async () => {
    const home = preparar();
    const id = conversa(home, 10);
    const antes = threadHead(id, home)!.updatedAt;
    marcarLixeira(id, true, "manual", home);
    expect(threadHead(id, home)!.updatedAt).toBe(antes);
    expect(threadHead(id, home)!.lixeiraEm).toBeTruthy();
    marcarLixeira(id, false, "manual", home);
    expect(threadHead(id, home)!.updatedAt > antes).toBe(true);
    expect(threadHead(id, home)!.lixeiraEm).toBeUndefined();
  });

  it("apaga de vez depois de 7 dias na lixeira", async () => {
    const home = preparar();
    const id = conversa(home, 10);
    await varrerLixeira(home);
    expect(await varrerLixeira(home, Date.now() + 6 * DIA)).toEqual({ movidas: 0, apagadas: 0 });
    expect(await varrerLixeira(home, Date.now() + 8 * DIA)).toEqual({ movidas: 0, apagadas: 1 });
    expect(threadHead(id, home)).toBeUndefined();
  });

  it("restaurada volta pra lista; com atividade nova volta sozinha", async () => {
    const home = preparar();
    const a = conversa(home, 10);
    const b = conversa(home, 10);
    await varrerLixeira(home);
    marcarLixeira(a, false, "manual", home);
    appendEvent({ ts: new Date(Date.now() + 1000).toISOString(), type: "user", threadId: b, text: "voltei" }, home);
    await varrerLixeira(home);
    expect(listarLixeira(home)).toEqual([]);
    expect(listThreads("/proj", home).map((t) => t.id).sort()).toEqual([a, b].sort());
  });

  it("desligado (0) não manda nada; a aberta no app nunca vai", async () => {
    const home = preparar();
    const aberta = conversa(home, 30);
    conversa(home, 30);
    saveConfig(home, { lastThread: aberta, lixeiraAposDias: 0 });
    expect(await varrerLixeira(home)).toEqual({ movidas: 0, apagadas: 0 });
    saveConfig(home, { lixeiraAposDias: 7 });
    expect(await varrerLixeira(home)).toEqual({ movidas: 1, apagadas: 0 });
    expect(threadHead(aberta, home)!.lixeiraEm).toBeUndefined();
  });

  it("passo de time e conversa oculta ficam de fora", async () => {
    const home = preparar();
    conversa(home, 30, { oculta: true });
    expect(await varrerLixeira(home)).toEqual({ movidas: 0, apagadas: 0 });
  });
});
