import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { criarDs } from "../src/design-system.ts";
import { sincronizavel } from "../src/sync-decisao.ts";
import {
  apagarCena,
  audiosDoVideo,
  comporVideo,
  criarVideo,
  definirMusica,
  definirTransicao,
  desfazerTransicao,
  documentoRaiz,
  encaixarNaBatida,
  htmlDaTelaImportada,
  importarTela,
  lerMeta,
  lerVideo,
  linhaDoTempo,
  lintCena,
  maximoDaTransicao,
  ordenarCenas,
  salvarCena,
  salvarEfeito,
  textoParaPostar,
  type MetaVideo,
} from "../src/video.ts";
import { achadosDoCheck, motivoDaFalha } from "../src/video-motor.ts";

function projeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-proj-"));
}

function base(): { pp: string; home: string; id: string } {
  const home = tempHome();
  const pp = projeto();
  const id = criarVideo(pp, home, { nome: "Nexos v0.11.0" }).id;
  return { pp, home, id };
}

function metaDe(cenas: [string, number][], transicoes: MetaVideo["transicoes"] = []): MetaVideo {
  return {
    id: "v",
    nome: "v",
    formato: "16:9",
    criadoEm: "",
    cenas: cenas.map(([id, duracao]) => ({ id, nome: id, duracao })),
    transicoes,
    audio: { musica: null, efeitos: [] },
  };
}

describe("dados do vídeo no sync", () => {
  it("cenas, meta e música própria sincronizam; render/ (MP4, capa, composição) não", () => {
    expect(sincronizavel("proj/videos/x/meta.json")).toBe(true);
    expect(sincronizavel("proj/videos/x/cenas/gancho.html")).toBe(true);
    expect(sincronizavel("proj/videos/x/audio/minha.mp3")).toBe(true);
    expect(sincronizavel("proj/videos/x/render/v.mp4")).toBe(false);
    expect(sincronizavel("proj/videos/x/render/capa.png")).toBe(false);
    expect(sincronizavel("proj/videos/x/render/comp/index.html")).toBe(false);
    expect(sincronizavel("proj/videos/x/render")).toBe(false);
  });
});

describe("linha do tempo: transição sobrepõe as cenas", () => {
  it("transição de T s encurta o vídeo em T s e antecipa o data-start da cena seguinte", () => {
    const semT = linhaDoTempo(metaDe([["a", 4], ["b", 3], ["c", 5]]));
    expect(semT.total).toBe(12);
    const comT = linhaDoTempo(metaDe([["a", 4], ["b", 3], ["c", 5]], [{ de: "a", para: "b", tipo: "fade", duracao: 0.6 }]));
    expect(comT.total).toBe(11.4);
    expect(comT.cenas.map((c) => c.inicio)).toEqual([0, 3.4, 6.4]);
  });

  it("limite: metade da cena mais curta; corte = 0", () => {
    expect(maximoDaTransicao(4, 2.4)).toBe(1.2);
    const l = linhaDoTempo(metaDe([["a", 4], ["b", 2.4]], [{ de: "a", para: "b", tipo: "fundo", duracao: 2 }]));
    expect(l.transicoes[0]!.duracao).toBe(1.2);
    expect(l.total).toBe(5.2);
    const corte = linhaDoTempo(metaDe([["a", 4], ["b", 2]], [{ de: "a", para: "b", tipo: "corte", duracao: 1 }]));
    expect(corte.total).toBe(6);
  });

  it("transição de par que não é mais vizinho (depois de reordenar) não conta", () => {
    const l = linhaDoTempo(metaDe([["b", 3], ["a", 4]], [{ de: "a", para: "b", tipo: "fade", duracao: 1 }]));
    expect(l.total).toBe(7);
  });
});

describe("cenas, ordem e transições no disco", () => {
  it("cria, reordena (regenera a composição) e limita a transição com aviso", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { nome: "Gancho", duracao: 3, html: "<h1 class='t'>Oi</h1><script>tl.fromTo('.t',{opacity:0},{opacity:1,duration:.5},0)</script>" });
    salvarCena(pp, home, id, { nome: "Mago", duracao: 2.4, html: "<p>mago</p>" });
    const r = definirTransicao(pp, home, id, { de: "gancho", para: "mago", tipo: "fade", duracao: 2 });
    expect(r.limitada).toBe(true);
    expect(r.transicao.duracao).toBe(1.2);
    let comp = comporVideo(pp, home, id);
    expect(readFileSync(join(comp, "index.html"), "utf8")).toContain('data-composition-src="compositions/cena-mago.html" data-start="1.8"');
    ordenarCenas(pp, home, id, ["mago", "gancho"]);
    comp = comporVideo(pp, home, id);
    const idx = readFileSync(join(comp, "index.html"), "utf8");
    expect(idx.indexOf("cena-mago.html")).toBeLessThan(idx.indexOf("cena-gancho.html"));
    expect(lerVideo(pp, home, id).linha.total).toBe(5.4);
    expect(() => ordenarCenas(pp, home, id, ["mago"])).toThrow(/todas as cenas/);
  });

  it("cena da composição carrega o script do agente com tl e o seek da prévia", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "c1", nome: "C1", duracao: 2, html: "<style>.t{color:var(--color-text)}</style><h1 class='t'>X</h1><script>tl.to('.t',{x:10,duration:1},0)</script>" });
    const comp = comporVideo(pp, home, id);
    const sub = readFileSync(join(comp, "compositions", "cena-c1.html"), "utf8");
    expect(sub).toContain('data-composition-id="cena-c1"');
    expect(sub).toContain("tl.to('.t'");
    expect(sub).toContain('window.__timelines["cena-c1"] = tl');
    expect(sub).toContain('src="assets/gsap.min.js"');
    const previa = readFileSync(join(comp, "previa", "cena-c1.html"), "utf8");
    expect(previa).toContain('src="../assets/gsap.min.js"');
    expect(previa).toContain('m.tipo === "seek"');
    expect(existsSync(join(comp, "assets", "gsap.min.js"))).toBe(true);
    expect(existsSync(join(comp, "player.html"))).toBe(true);
  });

  it("desfazer volta um passo da transição", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "a", duracao: 4 });
    salvarCena(pp, home, id, { id: "b", duracao: 4 });
    definirTransicao(pp, home, id, { de: "a", para: "b", tipo: "fade", duracao: 0.6 });
    definirTransicao(pp, home, id, { de: "a", para: "b", tipo: "deslizar-esq", duracao: 0.4 });
    desfazerTransicao(pp, home, id, "a", "b");
    expect(lerMeta(pp, home, id).transicoes[0]).toMatchObject({ tipo: "fade", duracao: 0.6 });
  });

  it("personalizada exige código determinístico", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "a", duracao: 4 });
    salvarCena(pp, home, id, { id: "b", duracao: 4 });
    expect(() => definirTransicao(pp, home, id, { de: "a", para: "b", tipo: "personalizada" })).toThrow(/codigo/);
    expect(() => definirTransicao(pp, home, id, { de: "a", para: "b", tipo: "personalizada", codigo: "tl.to(a,{x:Math.random()})" })).toThrow(/determin/);
    definirTransicao(pp, home, id, { de: "a", para: "b", tipo: "personalizada", nome: "Giro + logo", codigo: "tl.fromTo(a,{rotation:0},{rotation:90,duration:duracao},inicio)", duracao: 0.8 });
    const idx = documentoRaiz(lerMeta(pp, home, id), linhaDoTempo(lerMeta(pp, home, id)));
    expect(idx).toContain('(function (tl, a, b, inicio, duracao) {');
    expect(idx).toContain('})(tl, "#h-a", "#h-b", 3.2, 0.8);');
  });

  it("tela do DS entra como CÓPIA (mudar a original não mexe na cena)", () => {
    const { pp, home, id } = base();
    const est = criarDs(pp, home, { nome: "Oficial", base: "padrao" });
    const ds = est.ds!;
    const card = ds.cards[0]!;
    const r = importarTela(pp, home, id, ds.id, card.id);
    expect(r.cena.origem).toMatchObject({ sistema: ds.id, card: card.id });
    const html = lerVideo(pp, home, id).html[r.cena.id]!;
    expect(html).toContain(card.html.trim().slice(0, 40));
  });

  it("lint da cena pega o que quebra o render", () => {
    expect(lintCena("<html><body>x</body></html>")[0]).toMatch(/fragmento/);
    expect(lintCena("<script>tl.to('.a',{x:Math.random()})</script>").join()).toMatch(/determin/);
    expect(lintCena('<img src="https://x/y.png">').join()).toMatch(/externa/);
    expect(lintCena("<audio src='a.mp3'></audio>").join()).toMatch(/sem id/);
    expect(lintCena("<h1>ok</h1>")).toEqual([]);
  });
});

describe("trilha de áudio", () => {
  it("música do Nexos cortada no fim com fade-out de 1 s e crédito no texto pra postar", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "a", duracao: 10 });
    salvarCena(pp, home, id, { id: "b", duracao: 12.5 });
    definirMusica(pp, home, id, { fonte: "nexos:happy-beats-business-moves-vol-10-by-ende-dot-app" });
    const meta = lerMeta(pp, home, id);
    const [m] = audiosDoVideo(meta, linhaDoTempo(meta));
    expect(m).toMatchObject({ id: "musica", inicio: 0, duracao: 22.5, fadeOut: 1, volume: 0.35, musica: true });
    expect(documentoRaiz(meta, linhaDoTempo(meta))).toContain('<audio id="musica" data-timeline-role="music"');
    expect(textoParaPostar(meta)).toContain("Music: ende.app (CC BY 4.0)");
  });

  it("efeito encaixa na batida (≤ 0,15 s) e anda junto com a própria cena", () => {
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "a", duracao: 3 });
    salvarCena(pp, home, id, { id: "b", duracao: 4 });
    definirMusica(pp, home, id, { fonte: "nexos:happy-beats-business-moves-vol-10-by-ende-dot-app" });
    const r = salvarEfeito(pp, home, id, { arquivo: "impact/impactSoft_medium_001.ogg", tAbsoluto: 3.9 });
    expect(r.efeito.cena).toBe("b");
    const batida = r.naBatida;
    expect(typeof batida).toBe("boolean");
    const antes = r.efeito.t;
    ordenarCenas(pp, home, id, ["b", "a"]);
    const meta = lerMeta(pp, home, id);
    const ef = audiosDoVideo(meta, linhaDoTempo(meta)).find((x) => x.id.startsWith("efeito-"))!;
    expect(ef.inicio).toBeCloseTo(antes, 3);
    // apagar a cena leva os efeitos dela junto (o painel oferece desfazer)
    expect(apagarCena(pp, home, id, "b").efeitosRemovidos).toHaveLength(1);
  });

  it("encaixe só dentro da tolerância", () => {
    const batidas = [{ t: 1, forca: 1 }, { t: 2, forca: 1 }];
    expect(encaixarNaBatida(1.14, batidas)).toEqual({ t: 1, naBatida: true });
    expect(encaixarNaBatida(1.3, batidas)).toEqual({ t: 1.3, naBatida: false });
  });
});

describe("motor: mensagens claras", () => {
  it("sem rede na 1ª vez não mostra o erro cru do npm", () => {
    const m = motivoDaFalha({ codigo: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/hyperframes failed", cancelado: false });
    expect(m).toBe("Precisa de internet pra baixar o motor de vídeo na primeira vez");
  });

  it("achados do check apontam a cena", () => {
    const a = achadosDoCheck({
      lint: { findings: [{ code: "media_missing_id", severity: "error", message: "<audio> sem id", sourceFile: "C:\\x\\compositions\\cena-gancho.html" }] },
    });
    expect(a[0]).toMatchObject({ severidade: "erro", regra: "media_missing_id", cena: "gancho" });
  });
});

describe("tela importada cabe no quadro", () => {
  it("entra na largura do card e amplia pela largura do quadro (--vp-w), sem medir no script", () => {
    const html = htmlDaTelaImportada("<div>tela</div>", 1560);
    expect(html).toContain("width:1560px;zoom:calc((var(--vp-w) - 128) / 1560)");
    expect(html).toContain("data-layout-allow-overflow");
    expect(html).not.toMatch(/offsetHeight|clientWidth/);
    const { pp, home, id } = base();
    salvarCena(pp, home, id, { id: "t", duracao: 2, html });
    const sub = readFileSync(join(comporVideo(pp, home, id), "compositions", "cena-t.html"), "utf8");
    expect(sub).toContain("--vp-w:1920;--vp-h:1080");
  });
});

describe("imagem do projeto na cena", () => {
  it("copia pra assets/projeto e reescreve o src (render e prévia); o que não existe fica", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { pp, home, id } = base();
    mkdirSync(join(pp, "pets"), { recursive: true });
    writeFileSync(join(pp, "pets", "mago.png"), "png");
    salvarCena(pp, home, id, { id: "c", duracao: 2, html: '<img src="pets/mago.png"><img src="nao/existe.png"><div style="background:url(pets/mago.png)"></div>' });
    const comp = comporVideo(pp, home, id);
    const sub = readFileSync(join(comp, "compositions", "cena-c.html"), "utf8");
    expect(sub).toContain('src="assets/projeto/pets/mago.png"');
    expect(sub).toContain("url(assets/projeto/pets/mago.png)");
    expect(sub).toContain('src="nao/existe.png"');
    expect(readFileSync(join(comp, "previa", "cena-c.html"), "utf8")).toContain('src="../assets/projeto/pets/mago.png"');
    expect(existsSync(join(comp, "assets", "projeto", "pets", "mago.png"))).toBe(true);
    expect(lerVideo(pp, home, id).html.c).toContain('src="pets/mago.png"');
  });
});

describe("rotas do painel de vídeo", () => {
  it("/v1/videos exige bearer; a prévia sai pela chave, sem bearer, e não escapa da pasta", async () => {
    const { createApp } = await import("../src/http.ts");
    const home = tempHome();
    const pp = projeto();
    const app = createApp(home, "t");
    const q = `projectPath=${encodeURIComponent(pp)}`;
    expect((await app.request(`/v1/videos?${q}`)).status).toBe(401);
    const auth = { authorization: "Bearer t", "content-type": "application/json" };
    const criado = await app.request(`/v1/videos?${q}`, { method: "POST", headers: auth, body: JSON.stringify({ nome: "Teste", formato: "9:16" }) });
    expect(criado.status).toBe(201);
    const v = (await criado.json()) as { id: string; previa: string; formato: string };
    expect(v.formato).toBe("9:16");
    const cena = await app.request(`/v1/videos/${v.id}/cenas?${q}`, { method: "POST", headers: auth, body: JSON.stringify({ nome: "Gancho", duracao: 2, html: "<h1>oi</h1>" }) });
    expect(cena.status).toBe(201);
    const player = await app.request(`${v.previa}player.html`);
    expect(player.status).toBe(200);
    expect(await player.text()).toContain('src="previa/cena-gancho.html"');
    const gsap = await app.request(`${v.previa}assets/gsap.min.js`, { headers: { range: "bytes=0-9" } });
    expect(gsap.status).toBe(206);
    expect((await app.request(`${v.previa}..%2F..%2Fmeta.json`)).status).toBe(404);
    expect((await app.request(`/video-previa/chave-falsa/player.html`)).status).toBe(404);
    const sem = await app.request(`/v1/videos/${v.id}/transicoes?${q}`, { method: "PUT", headers: auth, body: JSON.stringify({ de: "gancho", para: "x", tipo: "fade" }) });
    expect(sem.status).toBe(400);
  });
});
