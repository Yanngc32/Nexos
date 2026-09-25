import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { ativarDs, criarDs, definirOficial, dsDoProjeto, estadoDs, painelDeMocks, salvarTokens } from "../src/design-system.ts";
import { ferramentaDePrintDoDs } from "../src/ds-print.ts";
import { blocoDoDsParaPack } from "../src/ds-sync.ts";

const projeto = () => mkdtempSync(join(tmpdir(), "nexo-mocks-"));
const TELA = '<style>.t{color:var(--color-text)}</style><div class="t">Login</div>';

function mockSalvar(proj: string, home: string, args: Record<string, unknown>) {
  const f = ferramentaDePrintDoDs("t1", proj, home)().find((x) => x.name === "nexo_mock_salvar")!;
  return f.executar(args) as { ok: boolean; texto: string };
}

describe("DS oficial", () => {
  it("sem escolha é o primeiro e fica fixo ao criar/trocar; escolhido fica mesmo trocando o ativo; painel não pode", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Marca" });
    expect(estadoDs(p, home).oficial).toBe("marca");
    criarDs(p, home, { nome: "Outro" });
    expect(estadoDs(p, home)).toMatchObject({ ativo: "outro", oficial: "marca" });
    definirOficial(p, home, "outro");
    ativarDs(p, home, "marca");
    expect(estadoDs(p, home).oficial).toBe("outro");
    definirOficial(p, home, "marca");
    ativarDs(p, home, "outro");
    expect(estadoDs(p, home).oficial).toBe("marca");
    expect(dsDoProjeto(p, home)!.id).toBe("marca");
    const painel = painelDeMocks(p, home);
    expect(() => definirOficial(p, home, painel.id)).toThrow(/painel de mocks/);
  });

  it("regras das conversas seguem o oficial mesmo com o painel de mocks ativo", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Marca" });
    ativarDs(p, home, painelDeMocks(p, home).id);
    const bloco = blocoDoDsParaPack(p, home)!;
    expect(bloco).toContain("# Design system do projeto: Marca");
    expect(bloco).toContain("Painel de mocks deste DS");
  });
});

describe("painel de mocks", () => {
  it("nasce só com as telas: tokens e regras vêm do oficial, sem copiar nem repetir os Fundamentos", () => {
    const home = tempHome();
    const p = projeto();
    const oficial = criarDs(p, home, { nome: "Marca" }).ds!;
    const painel = painelDeMocks(p, home);
    expect(painel.mocksDe).toBe("marca");
    const pasta = join(oficial.pastaAbs, "..", painel.id);
    expect(existsSync(join(pasta, "tokens.json"))).toBe(false);
    expect(readdirSync(join(pasta, "cards"))).toEqual([]);
    const ds = ativarDs(p, home, painel.id).ds!;
    expect(ds.css).toBe(oficial.css);
    expect(ds.designMd).toBe(oficial.designMd);
    expect(ds.fundamentos).toEqual([]);
    expect(ds.origem?.id).toBe("marca");
    // tokens se editam no oficial
    expect(() => salvarTokens(p, home, {})).toThrow(/painel de mocks/);
  });

  it("nexo_mock_salvar: 1ª tela cria o painel, a 2ª entra no mesmo; id existente atualiza", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Marca" });
    const a = mockSalvar(p, home, { titulo: "Login", html: TELA });
    expect(a.ok).toBe(true);
    expect(a.texto).toMatch(/Card criado: login .*largura 1\)/);
    expect(a.texto).toContain("Sem avisos do lint");
    mockSalvar(p, home, { titulo: "Cadastro", html: TELA });
    mockSalvar(p, home, { id: "login", titulo: "Login", html: TELA.replace("Login", "Entrar") });
    const est = estadoDs(p, home);
    expect(est.sistemas.filter((s) => s.mocksDe)).toHaveLength(1);
    expect(est.ativo).toBe("mocks");
    expect(est.ds!.cards.map((c) => [c.id, c.secao])).toEqual([
      ["login", "telas"],
      ["cadastro", "telas"],
    ]);
    expect(est.ds!.cards[0]!.html).toContain("Entrar");
  });

  it("adota o DS \"Mocks\" antigo (cópia inteira) em vez de criar outro", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Marca" });
    const velho = criarDs(p, home, { nome: "Mocks", base: "ativo" }).ds!;
    definirOficial(p, home, "marca");
    writeFileSync(join(velho.pastaAbs, "cards", "tela-x.html"), TELA);
    const painel = painelDeMocks(p, home);
    expect(painel).toEqual({ id: "mocks", nome: "Mocks", mocksDe: "marca" });
    expect(estadoDs(p, home).sistemas).toHaveLength(2);
  });

  it("sem DS nenhum: cria um \"Mocks\" comum com o padrão do Nexos", () => {
    const home = tempHome();
    const p = projeto();
    const r = mockSalvar(p, home, { titulo: "Home", html: TELA });
    expect(r.ok).toBe(true);
    const est = estadoDs(p, home);
    expect(est.sistemas).toEqual([{ id: "mocks", nome: "Mocks" }]);
    expect(est.ds!.vars.length).toBeGreaterThan(0);
    // a 2ª tela entra no mesmo "Mocks", sem painel de painel
    mockSalvar(p, home, { titulo: "Perfil", html: TELA });
    expect(estadoDs(p, home).sistemas).toHaveLength(1);
    expect(estadoDs(p, home).ds!.cards).toHaveLength(2);
  });
});
