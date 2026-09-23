import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // vários testes sobem processo de verdade (CLI falso, keytool, git, servidor HTTP). Sozinhos
    // levam 1–4s; com a suíte inteira em paralelo a fila de CPU passava dos 5s padrão e caía um
    // diferente a cada rodada. 15s absorve a fila sem esconder travamento.
    testTimeout: 15_000,
  },
});
