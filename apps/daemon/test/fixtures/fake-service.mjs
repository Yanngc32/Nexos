#!/usr/bin/env node
// Serviço de mentira pros testes: imprime uma linha e fica vivo até ser morto.
// Com argumento "exit <código>", sai na hora com aquele código.
const [modo, arg] = process.argv.slice(2);

if (modo === "exit") {
  process.stdout.write(`saindo com ${arg}\n`);
  process.exit(Number(arg) || 0);
}

process.stdout.write(`servico no ar cwd=${process.cwd()} MARCA=${process.env.MARCA ?? ""}\n`);
setInterval(() => {}, 1000);
