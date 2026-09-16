import { describe, it, expect } from "vitest";
import {
  abaAtiva,
  abrirAba,
  ativarAba,
  chaveWork,
  fecharAba,
  hidratarRecents,
  hidratarSessao,
  indiceSelecionavel,
  itensDaPaleta,
  lembrarRecent,
  rotuloDaAba,
  rotuloDeUrl,
  sessaoVazia,
  setUrlDaAba,
} from "../work-session.js";

const MODULES = [
  { id: "file", name: "Arquivo", keys: "Ctrl+G", ico: "📄" },
  { id: "browser", name: "Browser", keys: "Ctrl+Shift+B", ico: "🌐" },
];

describe("chaveWork", () => {
  it("conversa usa o id; sem conversa, o projeto", () => {
    expect(chaveWork("t-1", "/proj")).toBe("t-1");
    expect(chaveWork("", "/proj")).toBe("proj:/proj");
    expect(chaveWork("", "")).toBe("_none");
  });
});

describe("hidratarSessao", () => {
  it("lixo vira sessão vazia", () => {
    expect(hidratarSessao(null)).toEqual(sessaoVazia());
    expect(hidratarSessao({ tabs: [{ id: "x", kind: "nope" }] }).tabs).toEqual([]);
  });

  it("descarta aba sem id/kind e corrige activeId órfão", () => {
    const s = hidratarSessao({
      activeId: "sumiu",
      tabs: [
        { id: "a", kind: "file" },
        { id: "b", kind: "browser", url: "http://localhost:5173/" },
      ],
    });
    expect(s.activeId).toBe("a");
    expect(s.tabs[1].url).toBe("http://localhost:5173/");
  });
});

describe("abrirAba / fecharAba", () => {
  it("módulo único não duplica: segunda abertura só foca", () => {
    const s = sessaoVazia();
    const a = abrirAba(s, "file");
    const b = abrirAba(s, "file");
    expect(a.id).toBe(b.id);
    expect(s.tabs).toHaveLength(1);
  });

  it("browser com a mesma URL foca a aba, não cria outra", () => {
    const s = sessaoVazia();
    const a = abrirAba(s, "browser", { url: "http://localhost:5175/" });
    const b = abrirAba(s, "browser", { url: "http://localhost:5175/" });
    expect(a.id).toBe(b.id);
    expect(s.tabs).toHaveLength(1);
  });

  it("browser nova: cria outra aba mesmo com uma já aberta", () => {
    const s = sessaoVazia();
    abrirAba(s, "browser", { url: "http://localhost:5175/" });
    abrirAba(s, "browser", { nova: true });
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1].url).toBe("about:blank");
  });

  it("URL nova reusa aba em branco em vez de empilhar", () => {
    const s = sessaoVazia();
    const vazia = abrirAba(s, "browser");
    const mesma = abrirAba(s, "browser", { url: "http://127.0.0.1:3000/" });
    expect(mesma.id).toBe(vazia.id);
    expect(vazia.url).toBe("http://127.0.0.1:3000/");
    expect(s.tabs).toHaveLength(1);
  });

  it("fechar aba ativa foca a vizinha; última aba esvazia", () => {
    const s = sessaoVazia();
    const a = abrirAba(s, "file");
    const b = abrirAba(s, "terminal");
    expect(abaAtiva(s).id).toBe(b.id);
    fecharAba(s, b.id);
    expect(abaAtiva(s).id).toBe(a.id);
    fecharAba(s, a.id);
    expect(abaAtiva(s)).toBeNull();
  });

  it("ativarAba ignora id que não existe", () => {
    const s = sessaoVazia();
    abrirAba(s, "file");
    expect(ativarAba(s, "nope").kind).toBe("file");
  });
});

describe("setUrlDaAba / rotulo", () => {
  it("só browser guarda URL", () => {
    const s = sessaoVazia();
    const f = abrirAba(s, "file");
    expect(setUrlDaAba(s, f.id, "http://x")).toEqual(f);
    const b = abrirAba(s, "browser");
    setUrlDaAba(s, b.id, "localhost:5173");
    expect(b.url).toBe("http://localhost:5173/");
  });

  it("rótulo da aba browser é host+path", () => {
    expect(rotuloDeUrl("http://localhost:5175/pos-precificacao")).toBe("localhost:5175/pos-precificacao");
    expect(rotuloDaAba({ kind: "file" })).toBe("Arquivos");
    expect(rotuloDaAba({ kind: "browser", url: "about:blank" })).toBe("Browser");
  });
});

describe("recents e paleta", () => {
  it("lembrarRecent põe o mais novo na frente e dedup", () => {
    let r = [];
    r = lembrarRecent(r, "http://localhost:5173/");
    r = lembrarRecent(r, "http://localhost:5175/");
    r = lembrarRecent(r, "http://localhost:5173/");
    expect(r.map((x) => x.url)).toEqual(["http://localhost:5173/", "http://localhost:5175/"]);
  });

  it("hidratarRecents ignora about:blank e duplicata", () => {
    expect(hidratarRecents(["about:blank", { url: "http://a/" }, { url: "http://a/" }])).toEqual([
      { url: "http://a/", at: 0 },
    ]);
  });

  it("itensDaPaleta junta módulos + Recentes e URL digitada", () => {
    const items = itensDaPaleta({
      modules: MODULES,
      recents: [{ url: "http://localhost:5173/" }],
      filtro: "",
    });
    expect(items.some((i) => i.tipo === "sep")).toBe(true);
    expect(items.some((i) => i.tipo === "recent" && i.url === "http://localhost:5173/")).toBe(true);
  });

  it("filtro de URL solta vira item url: e pula o sep no índice", () => {
    const items = itensDaPaleta({ modules: MODULES, recents: [], filtro: "localhost:5175" });
    expect(items.some((i) => i.tipo === "url")).toBe(true);
    const sep = items.findIndex((i) => i.tipo === "sep");
    expect(indiceSelecionavel(items, sep)).not.toBe(sep);
  });

  it("filtro de nome de módulo esconde o resto", () => {
    const items = itensDaPaleta({ modules: MODULES, recents: [{ url: "http://x/" }], filtro: "arquivo" });
    expect(items.every((i) => i.tipo === "mod")).toBe(true);
    expect(items[0].id).toBe("file");
  });
});
