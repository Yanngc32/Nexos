/**
 * Onde a quota foi gasta nos últimos N dias — lê só o disco, não chama modelo nenhum.
 *
 *   pnpm medir [--dias 7] [--home <pasta>] [--json]      (na raiz do repositório)
 *
 * Rodar antes e depois de atualizar o Nexos (mesmo `--dias`) é o que mostra o ganho real.
 */
import { nexoHome } from "../src/home.ts";
import { medirConsumo, pesoRelativo, type Linha } from "../src/medir-consumo.ts";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dias = Number(arg("dias") ?? 7);
const home = arg("home") ?? nexoHome();
const desde = new Date(Date.now() - dias * 24 * 60 * 60_000);
const r = medirConsumo(home, desde);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const mil = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const tabela = (cab: string[], linhas: string[][]) => {
  const larg = cab.map((c, i) => Math.max(c.length, ...linhas.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((c, i) => (i < 2 ? c.padEnd(larg[i]!) : c.padStart(larg[i]!))).join("  ");
  console.log(fmt(cab));
  console.log(larg.map((n) => "-".repeat(n)).join("  "));
  for (const l of linhas) console.log(fmt(l));
};

const pesoTotal = r.linhas.reduce((s, l) => s + pesoRelativo(l), 0);
const pct = (l: Linha) => (pesoTotal ? `${((pesoRelativo(l) / pesoTotal) * 100).toFixed(1)}%` : "-");

console.log(`\nConsumo desde ${r.desde.slice(0, 10)} (${dias} dias) — ${home}\n`);
tabela(
  ["origem", "modelo", "turnos", "entrada", "cache escrito", "cache lido", "saída", "peso*", "% do peso"],
  r.linhas.map((l) => [
    l.origem,
    l.modelo,
    String(l.turnos),
    mil(l.input),
    mil(l.cacheCreate),
    mil(l.cacheRead),
    mil(l.output),
    pesoRelativo(l) ? `$${pesoRelativo(l).toFixed(2)}` : "-",
    pct(l),
  ]),
);
console.log(
  "\n* peso = equivalente em preço de API, só pra comparar origens e modelos entre si. A assinatura não",
  "\n  publica como converte token em quota; modelo sem preço conhecido (codex) fica sem peso.",
);

const porOrigem = new Map<string, number>();
for (const l of r.linhas) porOrigem.set(l.origem, (porOrigem.get(l.origem) ?? 0) + pesoRelativo(l));
console.log("\nPor origem (peso):");
for (const [o, p] of [...porOrigem].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${o.padEnd(28)} $${p.toFixed(2)}  ${pesoTotal ? ((p / pesoTotal) * 100).toFixed(1) : "0"}%`);
}

console.log(`\nPing de uso: ${r.ping.sessoes} sessões; ${r.ping.semMensagemHa2h} sem mensagem sua nas 2h anteriores`);
console.log("  (com a versão nova essas não rodam, e as que rodam vão no haiku)");

if (r.compactacoes.length) {
  console.log("\nCompactações gravadas:");
  for (const c of r.compactacoes) {
    const nota = c.engine === "codex" ? "  ← cada uma foi um turno extra cujo resumo o codex nunca leu" : "";
    console.log(`  ${c.engine.padEnd(8)} ${c.quantas} turnos de resumo, ~${mil(c.tokensAntes)} tokens de entrada${nota}`);
  }
}

const comExcesso = r.memoria.filter((m) => m.excessoTotal > 0);
console.log(`\nMemória (teto novo: 8000 caracteres no pack):`);
if (!r.memoria.length) console.log("  nenhum MEMORIA.md");
for (const m of r.memoria) {
  console.log(`  ${m.projeto}: ${m.caracteres} caracteres, ${m.sessoesNovas} conversas novas no período`);
}
if (comExcesso.length) {
  const total = comExcesso.reduce((s, m) => s + m.excessoTotal, 0);
  console.log(`  → o teto corta ~${mil(Math.round(total / 4))} tokens de entrada no período (só nas sessões novas)`);
}
console.log();
