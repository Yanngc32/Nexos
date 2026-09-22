#!/usr/bin/env node
// Imita o `gh` da GitHub CLI só nos subcomandos que github-auth.ts usa.
const args = process.argv.slice(2);

if (args[0] === "auth" && args[1] === "token") {
  if (process.env.FAKE_GH_TOKEN_FAIL === "1") process.exit(1);
  process.stdout.write("ghu_fake_token_123\n");
  process.exit(0);
}

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("octocat\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  if (process.env.FAKE_GH_NO_CODE === "1") {
    process.stdout.write("nada de código aqui\n");
    process.exit(0);
  }
  process.stdout.write("! First copy your one-time code: XXXX-YYYY\n");
  process.stdout.write("Open this URL to continue in your web browser: https://github.com/login/device\n");
  // Imita o `gh` real: fica pendurado até o device code ser aprovado (ou expirar).
  setTimeout(() => process.exit(process.env.FAKE_GH_LOGIN_FAIL === "1" ? 1 : 0), 150);
  setInterval(() => {}, 1000);
}
