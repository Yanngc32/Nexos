import { afterEach, describe, it, expect, vi } from "vitest";
import {
  ago,
  clip,
  elapsed,
  fmtDetail,
  fmtReset,
  fmtTokens,
  fmtWhen,
  folderName,
  normPath,
  samePath,
} from "../format.js";

/*
 * `fmtReset` e `fmtWhen` caem em `toLocaleDateString("pt-BR")` no ramo de mais
 * de um dia, e o texto exato varia com a versão do ICU — o CI roda Linux e
 * Windows em dois Node. Por isso os testes desse ramo checam a forma, não a
 * string: travar o literal daria falha por diferença de plataforma, não por bug.
 */

afterEach(() => {
  vi.useRealTimers();
});

function congelar(iso) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("clip", () => {
  it("corta com reticências só quando passa do limite", () => {
    expect(clip("abcdef", 3)).toBe("abc…");
    expect(clip("abc", 3)).toBe("abc");
  });

  it("não estoura com null", () => {
    expect(clip(null, 5)).toBe("");
  });
});

describe("folderName", () => {
  it("pega o último segmento, em barra ou contrabarra", () => {
    expect(folderName("/home/user/Nexos")).toBe("Nexos");
    expect(folderName("C:\\proj\\meu-app")).toBe("meu-app");
  });

  it("ignora barra sobrando no fim", () => {
    expect(folderName("/home/user/Nexos/")).toBe("Nexos");
  });

  it("sem caminho, rótulo de vazio", () => {
    expect(folderName("")).toBe("Nenhum projeto");
  });
});

describe("ago", () => {
  it("as quatro faixas", () => {
    congelar("2026-01-01T12:00:00Z");
    expect(ago("2026-01-01T11:59:30Z")).toBe("agora");
    expect(ago("2026-01-01T11:50:00Z")).toBe("10m");
    expect(ago("2026-01-01T09:00:00Z")).toBe("3h");
    expect(ago("2025-12-29T12:00:00Z")).toBe("3d");
  });

  it("futuro não vira número negativo", () => {
    congelar("2026-01-01T12:00:00Z");
    expect(ago("2026-01-01T13:00:00Z")).toBe("agora");
  });

  it("sem timestamp devolve vazio", () => {
    expect(ago("")).toBe("");
    expect(ago(null)).toBe("");
  });
});

describe("elapsed", () => {
  it("segundos e minutos com dois dígitos", () => {
    congelar("2026-01-01T12:00:00Z");
    const agora = Date.now();
    expect(elapsed(agora - 5_000)).toBe("5s");
    expect(elapsed(agora - 125_000)).toBe("2m05");
    expect(elapsed(agora - 600_000)).toBe("10m00");
  });

  it("sem início devolve vazio", () => {
    expect(elapsed(0)).toBe("");
  });
});

describe("fmtTokens", () => {
  it("abaixo de mil sai cru", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  it("milhar e milhão", () => {
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(150_000)).toBe("150.0k");
    expect(fmtTokens(2_000_000)).toBe("2M");
    expect(fmtTokens(2_500_000)).toBe("2.5M");
  });

  it("lixo vira 0 em vez de NaN", () => {
    expect(fmtTokens(undefined)).toBe("0");
    expect(fmtTokens("abc")).toBe("0");
  });
});

describe("fmtReset", () => {
  it("prazo vencido", () => {
    congelar("2026-01-01T12:00:00Z");
    expect(fmtReset(Date.now() / 1000 - 10)).toBe("Reinicia agora");
  });

  it("dentro de 24 h conta em hora e minuto", () => {
    congelar("2026-01-01T12:00:00Z");
    expect(fmtReset(Date.now() / 1000 + 2 * 3600 + 30 * 60)).toBe("Reinicia em 2 h 30 min");
    expect(fmtReset(Date.now() / 1000 + 45 * 60)).toBe("Reinicia em 45 min");
  });

  it("depois de 24 h mostra dia da semana (forma, não literal)", () => {
    congelar("2026-01-01T12:00:00Z");
    const out = fmtReset(Date.now() / 1000 + 3 * 86400);
    expect(out.startsWith("Reinicia ")).toBe(true);
    expect(out).not.toContain("em ");
  });

  it("valor ausente ou inválido devolve vazio", () => {
    expect(fmtReset(0)).toBe("");
    expect(fmtReset("abc")).toBe("");
    expect(fmtReset(undefined)).toBe("");
  });
});

describe("fmtWhen", () => {
  it("data inválida volta como veio, em vez de 'Invalid Date'", () => {
    expect(fmtWhen("não é data")).toBe("não é data");
  });

  it("ISO válido vira algo diferente do ISO", () => {
    const out = fmtWhen("2026-01-01T12:00:00.000Z");
    expect(out).not.toBe("2026-01-01T12:00:00.000Z");
    expect(out).toContain("2026");
  });
});

describe("fmtDetail", () => {
  it("achata objeto pelas chaves conhecidas", () => {
    expect(fmtDetail({ message: "quebrou" })).toBe("quebrou");
    expect(fmtDetail({ result: "deu ruim" })).toBe("deu ruim");
    expect(fmtDetail({ type: "erro" })).toBe("erro");
  });

  it("limpa [object Object] e espaço repetido", () => {
    expect(fmtDetail("a  [object Object]   b")).toBe("a b");
  });

  it("rate_limit cru vira mensagem explicada", () => {
    expect(fmtDetail("rate_limit_error")).toMatch(/Limite de uso do Claude/);
  });

  it("mas texto de limite que já se explica passa direto", () => {
    const cru = "you've hit your rate_limit for the week";
    expect(fmtDetail(cru)).toBe(cru);
  });

  it("nulo e vazio viram vazio", () => {
    expect(fmtDetail(null)).toBe("");
    expect(fmtDetail("")).toBe("");
  });
});

describe("normPath / samePath", () => {
  it("normaliza contrabarra, barra final e caixa", () => {
    expect(normPath("C:\\Proj\\App\\")).toBe("c:/proj/app");
    expect(normPath("/home/User/App//")).toBe("/home/user/app");
  });

  it("mesma pasta escrita de formas diferentes bate", () => {
    expect(samePath("C:\\proj\\app", "c:/PROJ/app/")).toBe(true);
    expect(samePath("/a/b", "/a/c")).toBe(false);
  });

  it("vazio nunca bate com nada, nem com outro vazio", () => {
    expect(samePath("", "")).toBe(false);
    expect(samePath("/a", "")).toBe(false);
    expect(samePath(null, null)).toBe(false);
  });
});
