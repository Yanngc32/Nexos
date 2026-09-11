import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extrairSimbolos, linguagemPorCaminho } from "../src/repo-map-parser.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "repo-map");

function ler(nome: string): string {
  return readFileSync(join(fixturesDir, nome), "utf8");
}

/*
 * Cada expectativa aqui foi conferida contra a saída REAL do parser (não deduzida da
 * gramática) — tree-sitter varia nome de nó entre linguagens de um jeito que só medir
 * garante certo. Ver o comentário no topo de `repo-map-parser.ts`.
 */
describe("extrairSimbolos", () => {
  it("javascript: função, classe, export desembrulhado, const com arrow function", async () => {
    const r = await extrairSimbolos("sample.js", ler("sample.js"));
    expect(r.linguagem).toBe("javascript");
    expect(r.simbolos).toEqual(["function login(user, pass)", "class AuthError", "function ping()", "function helper(x)"]);
  });

  it("typescript: método privado sai, sem modificador conta como público, interface e type", async () => {
    const r = await extrairSimbolos("sample.ts", ler("sample.ts"));
    expect(r.linguagem).toBe("typescript");
    expect(r.simbolos).toEqual([
      "function login(user: string, pass: string)",
      "class AuthError { login(), logout() }",
      "interface Foo { bar() }",
      "type Bar",
    ]);
  });

  it("tsx: função com JSX no corpo não quebra a extração", async () => {
    const r = await extrairSimbolos("sample.tsx", ler("sample.tsx"));
    expect(r.linguagem).toBe("tsx");
    expect(r.simbolos).toEqual(["function App()"]);
  });

  it("python: sem conceito de visibilidade — todo método de classe aparece, mesmo `_private`", async () => {
    const r = await extrairSimbolos("sample.py", ler("sample.py"));
    expect(r.linguagem).toBe("python");
    expect(r.simbolos).toEqual(["function login(user, pass_)", "class AuthError { _private(self), public_method(self) }"]);
  });

  it("go: só identificador exportado (inicial maiúscula) — convenção da própria linguagem", async () => {
    const r = await extrairSimbolos("sample.go", ler("sample.go"));
    expect(r.linguagem).toBe("go");
    expect(r.simbolos).toEqual(["func Login(user string)", "type Server", "func (s *Server) Start()"]);
  });

  it("rust: só `pub` — e `impl` em si nunca é pub, só os itens dentro dele", async () => {
    const r = await extrairSimbolos("sample.rs", ler("sample.rs"));
    expect(r.linguagem).toBe("rust");
    expect(r.simbolos).toEqual(["fn login(user: &str)", "struct Server", "impl Server { start(&self) }"]);
  });

  it("java: método privado/protected sai, sem modificador (package-private) conta como visível", async () => {
    const r = await extrairSimbolos("sample.java", ler("sample.java"));
    expect(r.linguagem).toBe("java");
    expect(r.simbolos).toEqual(["class AuthError { login(), packagePrivate() }"]);
  });

  it("extensão sem gramática conhecida: linguagem undefined, não lista vazia por engano", async () => {
    const r = await extrairSimbolos("sample.rb", "def foo; end");
    expect(r.linguagem).toBeUndefined();
    expect(r.simbolos).toEqual([]);
  });

  it("linguagemPorCaminho reconhece as extensões da spec", () => {
    expect(linguagemPorCaminho("a/b.ts")).toBe("typescript");
    expect(linguagemPorCaminho("a/b.tsx")).toBe("tsx");
    expect(linguagemPorCaminho("a/b.js")).toBe("javascript");
    expect(linguagemPorCaminho("a/b.py")).toBe("python");
    expect(linguagemPorCaminho("a/b.go")).toBe("go");
    expect(linguagemPorCaminho("a/b.rs")).toBe("rust");
    expect(linguagemPorCaminho("a/b.java")).toBe("java");
    expect(linguagemPorCaminho("a/b.rb")).toBeUndefined();
  });
});
