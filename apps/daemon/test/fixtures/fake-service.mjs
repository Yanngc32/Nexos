#!/usr/bin/env node
// Serviço de mentira pros testes: imprime uma linha e fica vivo até ser morto.
// Com argumento "exit <código>", sai na hora com aquele código.
// Com argumento "listen <porta>", escuta nessa porta em 127.0.0.1 (pra testar porta ocupada).
import { createServer } from "node:http";

const [modo, arg] = process.argv.slice(2);

if (modo === "exit") {
  process.stdout.write(`saindo com ${arg}\n`);
  process.exit(Number(arg) || 0);
}

if (modo === "listen") {
  createServer((_req, res) => res.end("ok")).listen(Number(arg), "127.0.0.1", () => {
    process.stdout.write("ouvindo\n");
  });
} else {
  process.stdout.write(
    `servico no ar cwd=${process.cwd()} MARCA=${process.env.MARCA ?? ""} PORT=${process.env.PORT ?? ""} ARGS=${process.argv.slice(2).join(" ")}\n`,
  );
  setInterval(() => {}, 1000);
}
