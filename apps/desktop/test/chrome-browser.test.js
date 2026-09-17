import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("chrome do preview (tipo Cursor)", () => {
  it("aba + fica colado na lista, popout vai pra direita", () => {
    const iList = html.indexOf('id="work-tabs-list"');
    const iAdd = html.indexOf('id="btn-tab-add"');
    const iGrow = html.indexOf('class="work-tabs-grow"');
    const iPop = html.indexOf('id="btn-browser-popout"');
    expect(iList).toBeGreaterThan(0);
    expect(iAdd).toBeGreaterThan(iList);
    expect(iGrow).toBeGreaterThan(iAdd);
    expect(iPop).toBeGreaterThan(iGrow);
  });

  it("urlbar sem botão Ir visível e sem caixa no input", () => {
    expect(html).toMatch(/id="browser-url"[^>]*placeholder="Buscar ou colar URL"/);
    expect(html).toMatch(/<button type="submit" class="sr-only">Ir<\/button>/);
    expect(html).toContain('id="btn-browser-back"');
    expect(css).toMatch(/#browser-url\s*\{[^}]*background:\s*transparent/);
    expect(css).not.toMatch(/\.work-tab\[aria-selected="true"\]\s*\{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--accent\)/);
  });

  it("webview stowed e pane inativo usam visibility hidden (opacity pintava tudo e travava a troca)", () => {
    expect(css).toMatch(/#browser-pool webview\.stowed\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/#work-stage > \.pane\.is-on\s*\{[^}]*visibility:\s*visible/);
  });
});
