import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Node, Parser } from "web-tree-sitter";

/**
 * Camada 2 do repo map (`nexo_mapa_simbolos`): extrai assinatura top-level (função, classe,
 * export, interface/type) de um arquivo, sem descer no corpo. Ver
 * `docs/superpowers/specs/2026-09-10-repo-map-design.md`.
 *
 * **`web-tree-sitter` (WASM), não bindings nativos.** O daemon roda em Windows, e bindings
 * nativos de tree-sitter exigem `node-gyp`/Visual Studio Build Tools — mais uma dependência de
 * build frágil (a mesma classe de problema que o bug do `cmd.exe` desta sessão já mostrou). WASM
 * só carrega o `.wasm`, sem compilar nada. As gramáticas vêm de `tree-sitter-wasms`, que empacota
 * binários pré-compilados — inclui as 6 linguagens da spec (confirmado por inspeção do pacote:
 * `javascript`, `typescript`, `tsx`, `python`, `go`, `rust`, `java` — todos presentes em
 * `tree-sitter-wasms/out/`).
 *
 * **Tudo abaixo foi medido contra o parser de verdade** (script de dump da árvore rodado uma vez
 * durante o desenvolvimento, não deduzido de documentação) — os nomes de nó variam de grafo pra
 * gramática, e adivinhar errado aqui faria `nexo_mapa_simbolos` devolver lista vazia em silêncio.
 */

const requireDaqui = createRequire(import.meta.url);

/** Extensão de arquivo -> nome da gramática em `tree-sitter-wasms/out/tree-sitter-<nome>.wasm`. */
const GRAMATICA_POR_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export function linguagemPorCaminho(caminho: string): string | undefined {
  const m = /\.[^./\\]+$/.exec(caminho);
  const ext = m ? m[0].toLowerCase() : "";
  return GRAMATICA_POR_EXT[ext];
}

let initPromise: Promise<void> | undefined;
function garantirParserPronto(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

/** Raiz de `tree-sitter-wasms` no disco — resolvida uma vez, cacheada, independente do cwd do processo. */
let wasmDir: string | undefined;
function pastaDosWasm(): string {
  if (!wasmDir) {
    const pkgJson = requireDaqui.resolve("tree-sitter-wasms/package.json");
    wasmDir = join(dirname(pkgJson), "out");
  }
  return wasmDir;
}

/** Uma linguagem carregada custa um `fetch`/leitura de `.wasm` — cacheada por nome, não por chamada. */
const linguagens = new Map<string, Language>();

async function carregarLinguagem(nome: string): Promise<Language> {
  const cacheada = linguagens.get(nome);
  if (cacheada) return cacheada;
  await garantirParserPronto();
  const linguagem = await Language.load(join(pastaDosWasm(), `tree-sitter-${nome}.wasm`));
  linguagens.set(nome, linguagem);
  return linguagem;
}

/** Um parser por linguagem, reaproveitado — `setLanguage` é barato, recriar o `Parser` não é. */
const parsers = new Map<string, Parser>();

async function parserPara(nomeLinguagem: string): Promise<Parser> {
  const cacheado = parsers.get(nomeLinguagem);
  if (cacheado) return cacheado;
  const linguagem = await carregarLinguagem(nomeLinguagem);
  const parser = new Parser();
  parser.setLanguage(linguagem);
  parsers.set(nomeLinguagem, parser);
  return parser;
}

function texto(node: Node | null | undefined): string {
  return node?.text ?? "";
}

/** Primeiro filho (nomeado ou não) com o `type` pedido — várias gramáticas só expõem modificador/nome como child solto, não como field. */
function filhoDoTipo(node: Node, tipo: string): Node | undefined {
  for (const c of node.children) {
    if (c && c.type === tipo) return c;
  }
  return undefined;
}

function primeiroFilhoNomeadoDoTipo(node: Node, tipos: Set<string>): Node | undefined {
  for (const c of node.namedChildren) {
    if (c && tipos.has(c.type)) return c;
  }
  return undefined;
}

/** `(a, b)` — como veio no código-fonte, sem reformatar. */
function paramsDe(node: Node, tipoParams: string): string {
  const p = node.namedChildren.find((c) => c?.type === tipoParams) ?? filhoDoTipo(node, tipoParams);
  return texto(p) || "()";
}

// ---------- JavaScript / TypeScript / TSX ----------

const JS_DECLARACOES = new Set([
  "function_declaration",
  "class_declaration",
  "lexical_declaration",
  "variable_declaration",
  "interface_declaration",
  "type_alias_declaration",
]);

/** Modificador de acesso explícito (TS): ausência = público. */
function metodoJsEhPublico(node: Node): boolean {
  const mod = filhoDoTipo(node, "accessibility_modifier");
  const texto1 = mod?.text ?? "";
  return texto1 !== "private" && texto1 !== "protected";
}

function assinaturasDeClasseJs(corpo: Node): string[] {
  const out: string[] = [];
  for (const membro of corpo.namedChildren) {
    if (!membro || membro.type !== "method_definition") continue;
    if (!metodoJsEhPublico(membro)) continue;
    const nome = texto(membro.childForFieldName("name")) || texto(filhoDoTipo(membro, "property_identifier"));
    if (!nome || nome === "constructor") continue;
    out.push(`${nome}${paramsDe(membro, "formal_parameters")}`);
  }
  return out;
}

function assinaturasDeInterface(corpo: Node): string[] {
  const out: string[] = [];
  for (const membro of corpo.namedChildren) {
    if (!membro || membro.type !== "method_signature") continue;
    const nome = texto(membro.childForFieldName("name")) || texto(filhoDoTipo(membro, "property_identifier"));
    if (!nome) continue;
    out.push(`${nome}${paramsDe(membro, "formal_parameters")}`);
  }
  return out;
}

function comMembros(rotulo: string, nome: string, membros: string[]): string {
  return membros.length ? `${rotulo} ${nome} { ${membros.join(", ")} }` : `${rotulo} ${nome}`;
}

function simboloDeDeclaracaoJs(node: Node): string | undefined {
  if (node.type === "function_declaration") {
    const nome = texto(node.childForFieldName("name"));
    if (!nome) return undefined;
    return `function ${nome}${paramsDe(node, "formal_parameters")}`;
  }
  if (node.type === "class_declaration") {
    const nome = texto(node.childForFieldName("name")) || texto(filhoDoTipo(node, "type_identifier"));
    if (!nome) return undefined;
    const corpo = node.childForFieldName("body") ?? filhoDoTipo(node, "class_body");
    return comMembros("class", nome, corpo ? assinaturasDeClasseJs(corpo) : []);
  }
  if (node.type === "interface_declaration") {
    const nome = texto(filhoDoTipo(node, "type_identifier"));
    if (!nome) return undefined;
    const corpo = filhoDoTipo(node, "interface_body");
    return comMembros("interface", nome, corpo ? assinaturasDeInterface(corpo) : []);
  }
  if (node.type === "type_alias_declaration") {
    const nome = texto(filhoDoTipo(node, "type_identifier"));
    return nome ? `type ${nome}` : undefined;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const out: string[] = [];
    for (const decl of node.namedChildren) {
      if (!decl || decl.type !== "variable_declarator") continue;
      const valor = decl.childForFieldName("value");
      if (!valor || (valor.type !== "arrow_function" && valor.type !== "function_expression")) continue;
      const nome = texto(decl.childForFieldName("name"));
      if (!nome) continue;
      out.push(`function ${nome}${paramsDe(valor, "formal_parameters")}`);
    }
    // uma `const` pode declarar mais de uma função — devolve todas, uma por linha do resultado final
    return out.length ? out.join("\n") : undefined;
  }
  return undefined;
}

function simbolosJs(raiz: Node): string[] {
  const out: string[] = [];
  for (const node of raiz.namedChildren) {
    if (!node) continue;
    const alvo = node.type === "export_statement" ? (primeiroFilhoNomeadoDoTipo(node, JS_DECLARACOES) ?? node) : node;
    if (!JS_DECLARACOES.has(alvo.type)) continue;
    const s = simboloDeDeclaracaoJs(alvo);
    if (s) out.push(...s.split("\n"));
  }
  return out;
}

// ---------- Python ----------

function simbolosPython(raiz: Node): string[] {
  const out: string[] = [];
  for (const node of raiz.namedChildren) {
    if (!node) continue;
    if (node.type === "function_definition") {
      const nome = texto(node.childForFieldName("name"));
      if (nome) out.push(`function ${nome}${paramsDe(node, "parameters")}`);
    } else if (node.type === "class_definition") {
      const nome = texto(node.childForFieldName("name"));
      if (!nome) continue;
      const corpo = node.childForFieldName("body");
      const metodos: string[] = [];
      for (const membro of corpo?.namedChildren ?? []) {
        if (membro?.type !== "function_definition") continue;
        const nomeMetodo = texto(membro.childForFieldName("name"));
        if (nomeMetodo) metodos.push(`${nomeMetodo}${paramsDe(membro, "parameters")}`);
      }
      out.push(comMembros("class", nome, metodos));
    }
  }
  return out;
}

// ---------- Go ----------

/** Convenção do próprio Go: identificador exportado = inicial maiúscula. Não é opinião nossa. */
function goEhExportado(nome: string): boolean {
  return /^[A-Z]/.test(nome);
}

function simbolosGo(raiz: Node): string[] {
  const out: string[] = [];
  for (const node of raiz.namedChildren) {
    if (!node) continue;
    if (node.type === "function_declaration") {
      const nome = texto(node.childForFieldName("name"));
      if (nome && goEhExportado(nome)) out.push(`func ${nome}${paramsDe(node, "parameter_list")}`);
    } else if (node.type === "method_declaration") {
      const nome = texto(node.childForFieldName("name"));
      if (nome && goEhExportado(nome)) {
        const listas = node.namedChildren.filter((c) => c?.type === "parameter_list");
        const receptor = texto(listas[0]);
        const params = texto(listas[1]) || "()";
        out.push(`func ${receptor} ${nome}${params}`);
      }
    } else if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec?.type !== "type_spec") continue;
        const nome = texto(spec.childForFieldName("name"));
        if (nome && goEhExportado(nome)) out.push(`type ${nome}`);
      }
    }
  }
  return out;
}

// ---------- Rust ----------

function rustEhPub(node: Node): boolean {
  return Boolean(filhoDoTipo(node, "visibility_modifier"));
}

function simbolosRust(raiz: Node): string[] {
  const out: string[] = [];
  for (const node of raiz.namedChildren) {
    if (!node) continue;
    // `impl` em si nunca é "pub" (a gramática não marca o bloco, só os itens dentro dele) —
    // por isso fica de fora do filtro genérico abaixo, e filtra os membros um a um.
    if (node.type === "impl_item") {
      const nome = texto(node.childForFieldName("type"));
      const corpo = node.childForFieldName("body") ?? filhoDoTipo(node, "declaration_list");
      const metodos: string[] = [];
      for (const membro of corpo?.namedChildren ?? []) {
        if (membro?.type !== "function_item" || !rustEhPub(membro)) continue;
        const nomeMetodo = texto(membro.childForFieldName("name"));
        if (nomeMetodo) metodos.push(`${nomeMetodo}${paramsDe(membro, "parameters")}`);
      }
      if (nome) out.push(comMembros("impl", nome, metodos));
      continue;
    }
    if (!rustEhPub(node)) continue;
    if (node.type === "function_item") {
      const nome = texto(node.childForFieldName("name"));
      if (nome) out.push(`fn ${nome}${paramsDe(node, "parameters")}`);
    } else if (node.type === "struct_item") {
      const nome = texto(node.childForFieldName("name"));
      if (nome) out.push(`struct ${nome}`);
    } else if (node.type === "enum_item") {
      const nome = texto(node.childForFieldName("name"));
      if (nome) out.push(`enum ${nome}`);
    }
  }
  return out;
}

// ---------- Java ----------

function javaModificadores(node: Node): string {
  return texto(filhoDoTipo(node, "modifiers"));
}

function javaMetodoEhPublico(node: Node): boolean {
  const mods = javaModificadores(node);
  return !mods.includes("private") && !mods.includes("protected");
}

function assinaturasDeClasseJava(corpo: Node): string[] {
  const out: string[] = [];
  for (const membro of corpo.namedChildren) {
    if (membro?.type !== "method_declaration" || !javaMetodoEhPublico(membro)) continue;
    const nome = texto(membro.childForFieldName("name"));
    if (nome) out.push(`${nome}${paramsDe(membro, "formal_parameters")}`);
  }
  return out;
}

function simbolosJava(raiz: Node): string[] {
  const out: string[] = [];
  for (const node of raiz.namedChildren) {
    if (!node) continue;
    if (node.type === "class_declaration" || node.type === "interface_declaration") {
      const nome = texto(node.childForFieldName("name"));
      if (!nome) continue;
      const corpo = node.childForFieldName("body");
      out.push(comMembros(node.type === "class_declaration" ? "class" : "interface", nome, corpo ? assinaturasDeClasseJava(corpo) : []));
    }
  }
  return out;
}

const EXTRATORES: Record<string, (raiz: Node) => string[]> = {
  javascript: simbolosJs,
  typescript: simbolosJs,
  tsx: simbolosJs,
  python: simbolosPython,
  go: simbolosGo,
  rust: simbolosRust,
  java: simbolosJava,
};

export type ResultadoExtracao = {
  /** `undefined` = extensão sem gramática conhecida (diferente de "arquivo sem símbolo"). */
  linguagem: string | undefined;
  simbolos: string[];
};

/** Só os nós top-level de declaração — nunca desce no corpo de função/método. */
export async function extrairSimbolos(caminho: string, conteudo: string): Promise<ResultadoExtracao> {
  const linguagem = linguagemPorCaminho(caminho);
  if (!linguagem) return { linguagem: undefined, simbolos: [] };
  const extrator = EXTRATORES[linguagem];
  const parser = await parserPara(linguagem);
  const arvore = parser.parse(conteudo);
  if (!arvore) return { linguagem, simbolos: [] };
  return { linguagem, simbolos: extrator(arvore.rootNode) };
}
