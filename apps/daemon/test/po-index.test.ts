import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { MOTIVO_PADRAO_FECHAMENTO } from "../src/po/aplicar.ts";
import { ARQUIVO_DECISOES_PO } from "../src/po/decisoes.ts";
import {
  abrirRodadaPO,
  definirDepsDoPOParaTeste,
  entrarNaEsperaDoPO,
  fecharRodadaPO,
  resetPOParaTeste,
  statusDoPO,
  type EventoPO,
} from "../src/po/index.ts";
import { PO_NEXT_SECTION } from "../src/po/texto.ts";
import { canalTarefas, getTarefa, listarTarefas, statusEfetivo, tarefasBus } from "../src/tarefas.ts";
import {
  MARCA_FIM_DE_TURNO,
  criarTarefaDoPO,
  idDoCard,
  resetTarefasAgenteForTest,
  sincronizarTarefasDoAgente,
} from "../src/tarefas-agente.ts";
import { appendEvent } from "../src/threads.ts";

const P = "/projetos/um";
let seq = 0;

type Chamada = { prompt: string; o: { modelo?: string; projectPath?: string } };

/** Motor falso: devolve `texto` (ou lança) e guarda o prompt que recebeu. */
function motorFalso(texto: string | Error): Chamada[] {
  const chamadas: Chamada[] = [];
  definirDepsDoPOParaTeste({
    rodar: async (prompt, o) => {
      chamadas.push({ prompt, o: o as Chamada["o"] });
      if (texto instanceof Error) throw texto;
      return { texto, rota: "fake" };
    },
    git: async () => null,
    limpar: (s) => s,
  });
  return chamadas;
}

/** Conversa nova por teste (a fila segura 60 s por conversa+fase). */
function conversa(home: string, pedido: string, resposta?: string): string {
  const T = `th-po-${++seq}`;
  const ts = new Date().toISOString();
  appendEvent({ ts, type: "user", threadId: T, text: pedido }, home);
  if (resposta) {
    appendEvent({ ts, type: "tool", threadId: T, name: "Bash", summary: "npm test" }, home);
    appendEvent({ ts, type: "assistant", threadId: T, text: resposta }, home);
  }
  return T;
}

function cardEmAndamento(home: string, T: string, titulo: string): string {
  sincronizarTarefasDoAgente(P, home, T, "sess-1", [{ id: "1", titulo, status: "in_progress" }]);
  return idDoCard(T, "1");
}

function status(home: string, id: string) {
  const t = getTarefa(P, home, id)!;
  return statusEfetivo(t);
}

function diario(home: string): Array<{ outcome: string; phase: string }> {
  const arq = join(home, ARQUIVO_DECISOES_PO);
  if (!existsSync(arq)) return [];
  return readFileSync(arq, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

afterEach(async () => {
  await resetPOParaTeste();
  resetTarefasAgenteForTest();
});

describe("fechamento com motor falso", () => {
  it("CONCLUIR conclui o card e publica po.rodada no canal do quadro", async () => {
    const home = tempHome();
    const T = conversa(home, "arruma o login", "Pronto, login corrigido e testes passando.");
    const id = cardEmAndamento(home, T, "Arrumar o login");
    const chamadas = motorFalso(`CONCLUIR ${id} | testes passaram`);
    const eventos: EventoPO[] = [];
    const ouvir = (e: EventoPO) => eventos.push(e);
    tarefasBus.on(canalTarefas(P), ouvir);
    try {
      await fecharRodadaPO(T, P, home, undefined);
    } finally {
      tarefasBus.off(canalTarefas(P), ouvir);
    }
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.o.modelo).toBe("sonnet");
    expect(chamadas[0]!.prompt).toContain("arruma o login");
    expect(chamadas[0]!.prompt).toContain("Bash: npm test");
    expect(chamadas[0]!.prompt).toContain(id);
    expect(status(home, id)).toBe("completed");
    const po = eventos.filter((e) => e?.tipo === "po.rodada");
    expect(po).toHaveLength(1);
    expect(po[0]!.ultima).toMatchObject({ fase: "fechamento", resultado: "ok", cards: [id] });
    expect(statusDoPO(P, home)).toMatchObject({ ligado: true, ultima: { fase: "fechamento", resultado: "ok" } });
    expect(statusDoPO(undefined, home)).toEqual({ ligado: true });
    expect(diario(home).map((d) => d.outcome)).toEqual(["ok"]);
  });

  it("card devolvido que o veredito não julgou é concluído com o motivo padrão", async () => {
    const home = tempHome();
    const T = conversa(home, "faz o deploy", "Deploy feito.");
    const id = cardEmAndamento(home, T, "Fazer o deploy");
    motorFalso("OK");
    await fecharRodadaPO(T, P, home, undefined);
    const t = getTarefa(P, home, id)!;
    expect(statusEfetivo(t)).toBe("completed");
    expect(t.po?.motivo).toBe(MOTIVO_PADRAO_FECHAMENTO);
  });

  it("PENDENTE devolve a fazer com a marca do fim do turno e o que a pessoa faz", async () => {
    const home = tempHome();
    const T = conversa(home, "liga o pagamento", "Falta a chave da API.");
    const id = cardEmAndamento(home, T, "Ligar o pagamento");
    motorFalso(`PENDENTE ${id} | falta a chave | VOCÊ: colar a chave no .env | RESPONDER`);
    await fecharRodadaPO(T, P, home, undefined);
    const t = getTarefa(P, home, id)!;
    expect(statusEfetivo(t)).toBe("pending");
    expect(t.po?.motivo?.startsWith(MARCA_FIM_DE_TURNO)).toBe(true);
    expect(t.po?.motivo).toContain("falta a chave");
    expect(t.po?.acaoVoce).toBe("colar a chave no .env");
    expect(t.po?.tipoResposta).toBe("responder");
  });

  it("card concluído nunca reabre com PENDENTE; NOVA com título que já existe não duplica", async () => {
    const home = tempHome();
    const T = conversa(home, "revisa o README", "Revisei.");
    const feito = criarTarefaDoPO(P, home, { titulo: "Revisar o README", status: "completed", motivo: "feito antes", threadId: T });
    const chamadas = motorFalso(`PENDENTE ${feito.id} | parece faltar algo\nNOVA | revisar o readme | de novo`);
    const antes = listarTarefas(P, home).length;
    await fecharRodadaPO(T, P, home, undefined);
    expect(chamadas).toHaveLength(1);
    expect(status(home, feito.id)).toBe("completed");
    expect(listarTarefas(P, home)).toHaveLength(antes);
    expect(diario(home).map((d) => d.outcome)).toEqual(["sem-mudanca"]);
  });

  it("resposta ilegível não mexe em nada (nem o padrão) e vai pro diário", async () => {
    const home = tempHome();
    const T = conversa(home, "faz X", "Feito.");
    const id = cardEmAndamento(home, T, "Fazer X");
    motorFalso("Acho que está tudo certo, segue o plano.");
    await fecharRodadaPO(T, P, home, undefined);
    expect(status(home, id)).toBe("in_progress");
    expect(diario(home).map((d) => d.outcome)).toEqual(["ilegivel"]);
    expect(statusDoPO(P, home).ultima?.resultado).toBe("erro");
  });

  it("motor que falha vira erro no status e no diário, sem rejeitar o fim do turno", async () => {
    const home = tempHome();
    const T = conversa(home, "faz Y", "Feito.");
    const id = cardEmAndamento(home, T, "Fazer Y");
    motorFalso(new Error("cota estourada"));
    await expect(fecharRodadaPO(T, P, home, undefined)).resolves.toBeUndefined();
    expect(status(home, id)).toBe("in_progress");
    expect(statusDoPO(P, home).ultima).toMatchObject({ fase: "fechamento", resultado: "erro" });
    expect(diario(home)[0]!.outcome).toBe("erro");
  });

  it("mensagem na espera entra como próximo da fila no prompt do fechamento", async () => {
    const home = tempHome();
    const T = conversa(home, "faz Z", "Feito.");
    cardEmAndamento(home, T, "Fazer Z");
    const chamadas = motorFalso("OK");
    const sair = entrarNaEsperaDoPO(T, "agora publica a versão");
    await fecharRodadaPO(T, P, home, undefined);
    sair();
    expect(chamadas[0]!.prompt).toContain(PO_NEXT_SECTION);
    expect(chamadas[0]!.prompt).toContain("agora publica a versão");
  });
});

describe("abertura com motor falso", () => {
  it("NOVA cria card em andamento da conversa", async () => {
    const home = tempHome();
    const T = conversa(home, "cria a tela de login");
    const chamadas = motorFalso("NOVA | Criar a tela de login | pedido novo");
    await abrirRodadaPO(T, P, home, undefined);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.prompt).toContain("cria a tela de login");
    const novos = listarTarefas(P, home).filter((t) => t.threadId === T);
    expect(novos).toHaveLength(1);
    expect(novos[0]!.titulo).toBe("Criar a tela de login");
    expect(statusEfetivo(novos[0]!)).toBe("in_progress");
    expect(statusDoPO(P, home).ultima).toMatchObject({ fase: "abertura", resultado: "ok" });
  });

  it("poModelo da config vai pro motor", async () => {
    const home = tempHome();
    saveConfig(home, { poModelo: "haiku" });
    const T = conversa(home, "oi");
    const chamadas = motorFalso("OK");
    await abrirRodadaPO(T, P, home, undefined);
    expect(chamadas[0]!.o.modelo).toBe("haiku");
  });
});

describe("filtros", () => {
  it.each([
    ["auditorPO", { auditorPO: false }],
    ["quadroTarefas", { quadroTarefas: false }],
  ])("desligado (%s) não chama o motor e o status diz desligado", async (_nome, m) => {
    const home = tempHome();
    saveConfig(home, { modulos: { ...loadConfig(home).modulos, ...m } });
    const T = conversa(home, "faz algo", "Feito.");
    const chamadas = motorFalso("OK");
    await abrirRodadaPO(T, P, home, undefined);
    await fecharRodadaPO(T, P, home, undefined);
    expect(chamadas).toHaveLength(0);
    expect(statusDoPO(P, home)).toEqual({ ligado: false });
  });

  it("sem projeto não chama o motor", async () => {
    const home = tempHome();
    const T = conversa(home, "faz algo", "Feito.");
    const chamadas = motorFalso("OK");
    await fecharRodadaPO(T, undefined, home, undefined);
    expect(chamadas).toHaveLength(0);
  });
});

describe("GET /v1/po/status", () => {
  it("devolve ligado e a última rodada do projeto", async () => {
    const home = tempHome();
    const app = createApp(home, "tk");
    const h = { authorization: "Bearer tk" };
    const vazio = await app.request("/v1/po/status?projectPath=%2Fprojetos%2Fum", { headers: h });
    expect(vazio.status).toBe(200);
    expect(await vazio.json()).toEqual({ ligado: true });

    const T = conversa(home, "faz W", "Feito.");
    cardEmAndamento(home, T, "Fazer W");
    motorFalso("OK");
    await fecharRodadaPO(T, P, home, undefined);
    const r = await app.request("/v1/po/status?projectPath=%2Fprojetos%2Fum", { headers: h });
    const j = (await r.json()) as { ligado: boolean; ultima?: { fase: string; resultado: string; cards: string[]; em: string } };
    expect(j.ligado).toBe(true);
    expect(j.ultima).toMatchObject({ fase: "fechamento", resultado: "ok" });
    expect(typeof j.ultima!.em).toBe("string");

    const sem = await app.request("/v1/po/status", { headers: h });
    expect(await sem.json()).toEqual({ ligado: true });
    expect((await app.request("/v1/po/status")).status).toBe(401);
  });
});
