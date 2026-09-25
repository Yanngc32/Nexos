import { describe, expect, it } from "vitest";
import { DEMORA_MS, faseDaAbertura, linhaDoErro } from "../abertura.js";

const desde = 1_000_000;
const estados = (f) => f.passos.map((p) => p.estado);

describe("faseDaAbertura", () => {
  it("ligando: passo atual pulsa, os seguintes esperam; sem conversa o 3º passo some", () => {
    const f = faseDaAbertura({ info: { starting: true }, desde, agora: desde + 2000, comConversa: true });
    expect(f.fase).toBe("ligando");
    expect(f.status).toBe("Ligando o motor…");
    expect(estados(f)).toEqual(["agora", "espera", "espera"]);
    const semConversa = faseDaAbertura({ info: { ok: true }, passos: { motor: true }, desde, agora: desde });
    expect(semConversa.passos.map((p) => p.id)).toEqual(["motor", "dados"]);
    expect(estados(semConversa)).toEqual(["feito", "agora"]);
  });

  it("tudo pronto: null (a tela sai)", () => {
    expect(faseDaAbertura({ info: { ok: true }, passos: { motor: true, dados: true }, desde })).toBeNull();
    expect(faseDaAbertura({ info: { ok: true }, passos: { motor: true, dados: true }, comConversa: true, desde })).not.toBeNull();
  });

  it(`demorando depois de ${DEMORA_MS / 1000} s: oferece tentar, log e entrar`, () => {
    const f = faseDaAbertura({ info: { starting: true }, desde, agora: desde + 32_000 });
    expect(f.fase).toBe("demorando");
    expect(f.meta).toBe("há 32 s");
    expect(f.acoes.map((a) => a.id)).toEqual(["tentar", "log", "entrar"]);
  });

  it("travado: conta o reinício sozinho; com agente pergunta; PID recusado oferece forçar", () => {
    const base = { ok: false, estado: "sem_resposta" };
    const sozinho = faseDaAbertura({ info: { ...base, travado: { desde: desde } }, desde, agora: desde + 3000 });
    expect(sozinho.fase).toBe("travado");
    expect(sozinho.aviso).toBe("Reiniciando sozinho em 12 s");
    expect(sozinho.nota).toMatch(/Nenhum agente/);
    expect(estados(sozinho)[0]).toBe("erro");
    expect(sozinho.passos[0].rotulo).toBe("Motor não responde");

    const agente = faseDaAbertura({ info: { ...base, travado: { agentes: 1 } }, desde, agora: desde });
    expect(agente.aviso).toMatch(/perde o turno/);
    expect(agente.acoes[0].id).toBe("destravar");

    const recusado = faseDaAbertura({ info: { ...base, travado: { recusado: true, pid: 42, motivo: "outro app" } }, desde, agora: desde });
    expect(recusado.acoes.map((a) => a.id)).toEqual(["forcar", "log"]);
  });

  it("erro na subida: mostra a linha útil do stack", () => {
    const f = faseDaAbertura({ info: { ok: false, erro: "boom\nError: EADDRINUSE 7432\n    at x\nNode.js v20" }, desde, agora: desde });
    expect(f.fase).toBe("erro");
    expect(f.meta).toBe("Error: EADDRINUSE 7432");
    expect(linhaDoErro("")).toBe("");
  });
});
