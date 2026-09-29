import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { criarGpu, ehQuedaDeGpu, JANELA_MS, SEM_GPU_POR_MS } = require("../gpu.cjs");

function novo() {
  const d = mkdtempSync(join(tmpdir(), "nexos-gpu-"));
  let t = 1_000_000;
  const gpu = criarGpu({ dir: () => d, agora: () => t });
  return { d, gpu, passar: (ms) => (t += ms) };
}

describe("queda do GPU", () => {
  it("só conta GPU que não saiu limpo", () => {
    expect(ehQuedaDeGpu({ type: "GPU", reason: "crashed" })).toBe(true);
    expect(ehQuedaDeGpu({ type: "GPU", reason: "killed" })).toBe(true);
    expect(ehQuedaDeGpu({ type: "GPU", reason: "clean-exit" })).toBe(false);
    expect(ehQuedaDeGpu({ type: "Utility", reason: "crashed" })).toBe(false);
  });

  it("2 quedas em 24 h, mesmo em boots diferentes, desligam a aceleração", () => {
    const { d, gpu, passar } = novo();
    expect(gpu.semAceleracao()).toBe(false);
    expect(gpu.registrarQueda()).toEqual({ quedas: 1, desligou: false });
    passar(60_000);
    const outroBoot = criarGpu({ dir: () => d, agora: () => 1_060_000 });
    expect(outroBoot.registrarQueda()).toEqual({ quedas: 2, desligou: true });
    expect(outroBoot.semAceleracao()).toBe(true);
  });

  it("queda velha fora da janela não soma", () => {
    const { gpu, passar } = novo();
    gpu.registrarQueda();
    passar(JANELA_MS + 1);
    expect(gpu.registrarQueda()).toEqual({ quedas: 1, desligou: false });
    expect(gpu.semAceleracao()).toBe(false);
  });

  it("volta sozinho depois do prazo e na mão com reativar", () => {
    const { gpu, passar } = novo();
    gpu.registrarQueda();
    gpu.registrarQueda();
    expect(gpu.semAceleracao()).toBe(true);
    passar(SEM_GPU_POR_MS);
    expect(gpu.semAceleracao()).toBe(false);
    gpu.registrarQueda();
    gpu.registrarQueda();
    gpu.reativar();
    expect(gpu.semAceleracao()).toBe(false);
  });

  it("gpu.json corrompido vale como vazio", () => {
    const { d, gpu } = novo();
    writeFileSync(join(d, "gpu.json"), "{lixo");
    expect(gpu.semAceleracao()).toBe(false);
    expect(gpu.registrarQueda().quedas).toBe(1);
  });
});
