import { writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { entregar } from "../src/entregar-arquivo.ts";
import { createApp } from "../src/http.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread, readThread } from "../src/threads.ts";
import {
  dadosDoVisualizador,
  decodificar,
  detectarSeparador,
  lerCsv,
  lerXlsx,
  paginaDoVisualizador,
} from "../src/visualizador.ts";
import { tempHome } from "./helpers.ts";

/** xlsx mínimo de verdade: texto compartilhado, número, data (estilo 14), booleano, aba oculta. */
function xlsx(): Buffer {
  const zip = new AdmZip();
  const add = (nome: string, xml: string) => zip.addFile(nome, Buffer.from(xml, "utf8"));
  add(
    "xl/workbook.xml",
    `<workbook xmlns:r="r"><sheets><sheet name="Vendas &amp; metas" sheetId="1" r:id="rId1"/><sheet name="Escondida" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  );
  add("xl/sharedStrings.xml", `<sst><si><t>Cliente</t></si><si><r><t>Va</t></r><r><t>lor</t></r></si><si><t>Ana</t></si></sst>`);
  add("xl/styles.xml", `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  add(
    "xl/worksheets/sheet1.xml",
    `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Quando</t></is></c><c r="E1" t="inlineStr"><is><t>Pago</t></is></c></row>` +
      `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" s="1"><v>45292</v></c><c r="E2" t="b"><v>1</v></c></row>` +
      `<row r="3"/>` +
      `<row r="4"><c r="B4"><f>B2*2</f><v>2469</v></c></row>` +
      `</sheetData></worksheet>`,
  );
  add("xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`);
  return zip.toBuffer();
}

describe("visualizador: leitura", () => {
  it("CSV brasileiro: separador ;, aspas com quebra de linha, Windows-1252", () => {
    const bruto = Buffer.from('nome;valor;obs\r\n"Jo\xe3o";1.234,56;"linha 1\nlinha 2"\r\nMaria;10;"diz ""oi"""\r\n', "latin1");
    const texto = decodificar(bruto);
    expect(texto.startsWith("nome;")).toBe(true);
    expect(texto).toContain("João");
    expect(detectarSeparador(texto)).toBe(";");
    const { linhas, total } = lerCsv(texto, ";");
    expect(total).toBe(3);
    expect(linhas[1]).toEqual(["João", "1.234,56", "linha 1\nlinha 2"]);
    expect(linhas[2]).toEqual(["Maria", "10", 'diz "oi"']);
  });

  it("CSV vira tabela no jeito do pandas: cabeçalho, vazio = nulo, coluna sem nome e repetida", () => {
    const d = dadosDoVisualizador(Buffer.from("a,,a\n1,,x\n2,3\n"), "csv");
    expect(d?.tipo).toBe("tabela");
    if (d?.tipo !== "tabela") return;
    const p = d.planilhas[0]!;
    expect(p.colunas).toEqual(["a", "Unnamed: 1", "a.1"]);
    expect(p.linhas).toEqual([
      ["1", null, "x"],
      ["2", "3", null],
    ]);
    expect(p.total).toBe(2);
    expect(p.decimal).toBe(".");
  });

  it("xlsx: textos, número, data pelo estilo, booleano, fórmula pelo valor; aba oculta fora", () => {
    const abas = lerXlsx(xlsx());
    expect(abas.map((a) => a.nome)).toEqual(["Vendas & metas"]);
    const p = abas[0]!;
    expect(p.colunas).toEqual(["Cliente", "Valor", "Quando", "Unnamed: 3", "Pago"]);
    expect(p.linhas).toEqual([
      ["Ana", 1234.5, "2024-01-01", null, true],
      [null, 2469, null, null, null],
    ]);
    expect(p.total).toBe(2);
    expect(dadosDoVisualizador(xlsx(), "xlsm")?.tipo).toBe("tabela");
    expect(dadosDoVisualizador(Buffer.from("não é zip"), "xlsx")).toBeNull();
  });

  it("JSON de registros ganha tabela; markdown sai formatado e escapado; binário vai cru", () => {
    const j = dadosDoVisualizador(Buffer.from('[{"a":1,"b":{"c":2}},{"a":2,"d":"x"}]'), "json");
    expect(j?.tipo === "json" && j.tabela?.colunas).toEqual(["a", "b", "d"]);
    expect(j?.tipo === "json" && j.tabela?.linhas[0]).toEqual([1, '{"c":2}', null]);
    const md = dadosDoVisualizador(Buffer.from("# Título\n\n<script>alert(1)</script> **forte**"), "md");
    expect(md?.tipo === "markdown" && md.html).toContain("<strong>forte</strong>");
    expect(md?.tipo === "markdown" && md.html).not.toContain("<script>");
    expect(dadosDoVisualizador(Buffer.from("x = 1"), "py")).toEqual({ tipo: "codigo", texto: "x = 1", linguagem: "py" });
    expect(dadosDoVisualizador(Buffer.from([0x89, 0x50]), "png")).toBeNull();
    expect(dadosDoVisualizador(Buffer.from("x"), "zip")).toBeNull();
  });

  it("página: dado do arquivo não fecha o <script>, nome escapado, cor só hex", () => {
    const html = paginaDoVisualizador(
      { tipo: "codigo", texto: "</script><script>alert(1)</script>", linguagem: "txt" },
      { nome: '<b>"x".txt', bytes: 10, hrefBaixar: "?k=1&baixar=1", cor: "red;}</style>" },
    );
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("&lt;b&gt;&quot;x&quot;.txt");
    expect(html).not.toContain("red;}");
    expect(html).toContain("export function montar");
  });
});

describe("visualizador: rota do link", () => {
  it("CSV abre no visualizador (HTML em sandbox); baixar e bruto continuam o arquivo", async () => {
    const home = tempHome();
    const app = createApp(home, "t");
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: home, profileId: "p1" }, home);
    writeFileSync(join(home, "dados.csv"), "a;b\n1;2\n");
    expect(entregar(t.id, { caminho: "dados.csv" }, home).ok).toBe(true);
    const ev = readThread(t.id, home).find((e) => e.type === "arquivo_entregue");
    const file = ev?.type === "arquivo_entregue" ? ev.arquivo.file : "";
    const link = await app.request(`/v1/threads/${t.id}/attachments/${file}/link`, { headers: { authorization: "Bearer t" } });
    const { url } = (await link.json()) as { url: string };

    const pagina = await app.request(`${url}&n=dados.csv&cor=%237c5cbf`);
    expect(pagina.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(pagina.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts/);
    expect(pagina.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    const html = await pagina.text();
    expect(html).toContain('"colunas":["a","b"]');
    expect(html).toContain("--accent:#7c5cbf");
    expect(html).toMatch(/href="\?[^"]*baixar=1/);

    const baixar = await app.request(`${url}&baixar=1&n=dados.csv`);
    expect(baixar.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await baixar.text()).toBe("a;b\n1;2\n");
    const bruto = await app.request(`${url}&bruto=1`);
    expect(bruto.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});
