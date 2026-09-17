/**
 * Mede a escolha de modelo por complexidade (modelo "Automático"). Experimento
 * isolado, como os outros typesafe-*.ts: não é chamado por produção.
 *
 * Uso: npx tsx apps/daemon/scripts/typesafe-modelo-experiment.ts
 */
import { escolherModelo } from "../src/typesafe.ts";
import { nexoHome } from "../src/home.ts";

const CASOS = [
  "Qual a capital da França?",
  "Traduz 'a reunião foi remarcada' pro inglês",
  "Renomeia a variável `x` pra `total` nesse arquivo",
  "Resume esse changelog em duas linhas",
  "Por que o drag do cartão para de funcionar quando o listener da coluna chama preventDefault no dragstart?",
  "Projeta o esquema de permissões multi-tenant do zero, com herança de papéis e auditoria",
  "Temos um deadlock intermitente entre o worker de fila e a migração; investiga e propõe correção",
];

async function main() {
  const home = nexoHome();
  for (const mensagem of CASOS) {
    const r = await escolherModelo({ mensagem }, home);
    const alvo = r ? `${r.model} (confiança ${r.confianca.toFixed(2)})` : "— (sem escolha, cairia no fallback)";
    console.log(`\n${mensagem.slice(0, 80)}`);
    console.log(`  → ${alvo}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
