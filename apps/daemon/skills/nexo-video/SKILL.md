---
name: nexo-video
description: Montar um vídeo curto de lançamento ou de release (15–25 s) com a cara do design system do projeto, cena a cena, no painel Vídeo do Canvas do Nexos. Use quando pedirem "faz um vídeo de lançamento", "vídeo da release", "brag", "/brag", "transforma isso num vídeo", "vídeo pro LinkedIn/X/Reels" ou quando quiserem mostrar o que foi construído. Monta as cenas no painel com as ferramentas nexo_video_*; o render final é a pessoa quem dispara.
---

# Vídeo de lançamento no painel do Canvas

Esta skill segue o fluxo do brag (inspecionar → planejar → compor → entregar), mas o
resultado é um **vídeo editável no painel Vídeo do Canvas**, não um MP4 solto. Cada cena
vira um card; a pessoa reordena, ajusta por prompt, aprova e só então renderiza.

**Regra de ouro: tudo passa pelas ferramentas `nexo_video_*`.** Nada de pasta
`brag-output/`, `composition/`, `npx hyperframes init` ou MP4 gravado à mão no repo. O
motor (Hyperframes 0.8.82, FFmpeg) é do Nexos: ele compõe, checa, tira print e renderiza.

Se as ferramentas `nexo_video_*` não estiverem disponíveis, diga que o painel de vídeo
precisa de uma conversa de projeto numa conta `claude` do Nexos e pare aí.

Não entre na entrevista do roteador `/hyperframes` e não peça `feedback` do Hyperframes
depois do render.

## Ferramentas

| Ferramenta | Pra quê |
|---|---|
| `nexo_video_listar` | vídeos do projeto; com `video`, cenas (id, duração, início/fim), transições, áudio e o HTML de cada cena; músicas do Nexos, telas do DS importáveis e (com `efeitos: true`) o catálogo de efeitos |
| `nexo_video_criar` | cria o vídeo (nome + formato 16:9 / 9:16 / 1:1) e abre o painel no Canvas |
| `nexo_video_importar_tela` | tela do DS oficial (ou, se o vídeo for sobre ela, do painel de mocks) vira cena (CÓPIA) |
| `nexo_video_cena_salvar` | cria/edita uma cena (fragmento HTML + duração) |
| `nexo_video_ordem` | reordena as cenas |
| `nexo_video_transicao` | transição entre duas cenas vizinhas (pronta ou código próprio) |
| `nexo_video_audio` | música de fundo, volume, efeitos sonoros presos às cenas |
| `nexo_video_print` | frame em qualquer tempo, renderizado pelo motor (confira sempre) |
| `nexo_video_check` | `hyperframes check` — o portão antes do render |
| `nexo_video_render` | só **rascunho**; o final é a pessoa que dispara no painel |
| `nexo_video_entrega` | texto pra postar + capa (melhor frame assentado) |

## Passo 1 — Inspecionar o projeto

Leia o projeto antes de propor qualquer cena:

1. **DS oficial** (tokens + DESIGN.md): o vídeo usa só `var(--token)` dele — cores, fontes,
   raios, espaços. É isso que dá "a cara do projeto".
2. **Telas prontas** (`nexo_video_listar`): as do **DS oficial** são as telas do app — a coisa
   real. Prefira importar a redesenhar, e use várias pra mostrar o produto, não uma só. As do
   **painel de mocks** são propostas de planos (podem ser rascunho ou teste): só entram se o vídeo
   for sobre aquela mudança ou se a pessoa pedir.
3. **O que mudou**: pra vídeo de release, o `CHANGELOG.md` (a entrada da versão) é o roteiro.
   Pra lançamento, README, `package.json` e as telas do app.
4. **O fluxo de uso**: entrada → ação principal → resultado. O produto *fazendo* a coisa vale
   mais que o produto *descrevendo* a coisa.

Responda antes de seguir (pra você, curto):

1. O que é o app, numa frase?
2. Qual a afirmação mais forte ou mais engraçada (texto real do projeto)?
3. Qual o gancho visual (a tela ou elemento mais marcante)?
4. Que tela real vai aparecer (importar do DS ou recriar)?
5. Qual o vídeo mais curto que ainda funciona (15? 20 s?)?
6. Qual o tom (preset abaixo, ou o que a pessoa pediu)?
7. Como o som deve soar (base quente, poucos acentos, épico, silêncio)?
8. Qual a frase pra postar?
9. Qual o fluxo de uso que vale mostrar (2–3 batidas)?

**Nada secreto sai daqui.** Token, chave, URL interna, nome ou e-mail de cliente real nunca
entram em cena nem no texto pra postar. Dado real na tela vira exemplo fictício plausível.

## Passo 2 — Planejar (curto, na conversa)

Formato padrão: **gancho (2–3 s) → revelação (2–4 s) → 2–3 destaques (5–12 s) → fecho (2–4 s)**.
Adapte; não é template. Some as durações: **15–25 s** (18–22 s é o ponto doce), lembrando que
cada transição de T s **encurta o vídeo em T s** (as cenas se sobrepõem).

Mostre o plano pra pessoa em poucas linhas (cenas, duração, tom, música) e siga se ela não
objetar. Não pergunte o óbvio.

### Leis criativas (valem pra todo tom)

- **Curto.** 15–25 s. Nem um segundo a mais sem motivo.
- **Legível.** O ritmo vem do movimento e dos cortes, nunca de piscar texto. Rótulo curto:
  ~0,8 s parado na tela; frase: ~0,3 s por palavra (mínimo 1,2 s). Entra rápido, **segura**.
- **Específico.** Tem que parecer feito pra ESTE projeto.
- **Mostre a coisa.** Pelo menos uma cena com a interface, o texto ou o visual real.
  Importar a tela do DS é o caminho preferido.
- **Sem jargão SaaS.** "Otimize seu fluxo de trabalho" está banido. Use o texto do projeto.
- **Sem números nem depoimentos inventados.** Só o que existe no projeto.
- **O gancho é tudo.** Os 2 primeiros segundos decidem se alguém continua vendo.
- **O humor vem do projeto**, não de tentar ser engraçado.
- **Revelação em sequência e interação simulada** dão vida: cards chegando um a um, cursor
  clicando, texto sendo digitado. Decida isso no plano, não depois.
- Texto em sequência numa batida rápida (< 0,6 s entre batidas) atropela a leitura: use uma
  batida sim, outra não, ou revele rápido e segure o conjunto.

### Tons

| Tom | Energia | Cenas / ritmo | Transição |
|---|---|---|---|
| `default` | leve, limpo, postável | 4–5 cenas de 3–5 s | fade ou deslizar |
| `polished` | sério, elegante, contido | 3–4 cenas de 4–6 s | fade lento (0,6–0,8 s) |
| `yc-parody` | lançamento de startup dito com seriedade total | 4–5, uma afirmação por cena | corte ou fade curto (0,2 s) |
| `chaotic` | rápido, alto, CAIXA ALTA | 6–8, algumas < 2 s, nenhuma > 4 s | corte seco, zoom de entrada |
| `deadpan` | calmo, seco; o ritmo é a piada | 3–4 cenas longas de 4–7 s | fade muito lento ou segura |
| `cinematic` | trailer, frases declarativas | 4–5 de 3–5 s | máscara ou fade com escala |
| `app-store` | cards de recurso, profissional | 4–6 | deslizar/máscara 0,35–0,45 s |

Tom livre ("lançamento fake de 2016", "exposição de museu") vale: escolha o preset mais
perto pro ritmo e preserve a direção da pessoa.

## Passo 3 — Compor no painel

1. `nexo_video_criar` (ou reuse o vídeo que já existe: `nexo_video_listar`).
2. Telas reais: `nexo_video_importar_tela` (entra como cópia num palco do tamanho do vídeo).
   Depois anime com `nexo_video_cena_salvar` (mesmo `id`).
3. Cenas novas: `nexo_video_cena_salvar` com o HTML (contrato abaixo).
4. Ordem: `nexo_video_ordem` se precisar.
5. Transições: `nexo_video_transicao` entre cada par de vizinhas.
6. Áudio: `nexo_video_audio` (música + 1–3 efeitos nos momentos-chave).
7. **Confira cada cena com `nexo_video_print`** no tempo em que ela já assentou, e o frame
   do meio de cada transição. Corrija o que não ficou legível.
8. `nexo_video_check` e corrija todo erro. Aviso de contraste/sobreposição: avalie.

### Contrato da cena (o essencial do hyperframes-core)

A cena é um **fragmento HTML** (sem `<html>`, `<head>`, `<body>`):

```html
<style>
  .titulo { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
            font-family:var(--font-family-display); font-weight:var(--font-weight-semibold);
            letter-spacing:var(--font-letter-spacing-title); font-size:120px; color:var(--color-text); }
  .titulo span { color: var(--color-primary-text); }
</style>
<h1 class="titulo">Três chats. <span>Um motor.</span></h1>
<script>
  tl.fromTo(".titulo", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 0.2);
</script>
```

- O palco tem o tamanho do vídeo (1920×1080, 1080×1920 ou 1080×1080) e o fundo
  `var(--color-bg)`. Tamanho de fonte em px pensando nesse palco (título 96–140 px, texto
  40–64 px em 16:9; em 9:16 a largura é 1080: quebre linhas).
- `<script>` recebe **`tl`** (timeline GSAP pausada, tempo LOCAL: 0 = início da cena) e
  **`cena`** (o elemento raiz). O GSAP já está carregado.
- **Determinístico**: nada de `Date.now`, `Math.random`, `setTimeout`, `setInterval`,
  `fetch`, `requestAnimationFrame`, `<script src>`, fonte ou imagem de URL externa. O render
  faz *seek* frame a frame; só a timeline manda.
- Prefira **`tl.fromTo`** (estado inicial explícito: o seek pra trás funciona). `tl.to` só
  quando o estado de partida é o do CSS.
- CSS e seletor são **escopados por cena**: `.titulo` numa cena não pega na outra.
- Imagem do projeto: caminho relativo à raiz do repo (`public/logo.svg`), como nos cards do
  DS — o motor copia pra composição.
- Não ponha `<audio>`/`<video>` na cena: som vai por `nexo_video_audio`.
- Centralizar texto: `display:flex` num **wrapper**, nunca no próprio `<h1>`/`<p>` que tem
  `<span>` dentro — flex no elemento de texto transforma cada pedaço numa coluna ("v0.11: o
  agente já abre | o seu Chrome | ."). Apareceu no piloto; o `check` não pega, só o print.

### Tela importada do DS

`nexo_video_importar_tela` põe a tela na largura em que ela foi desenhada no Canvas e amplia até
a largura do quadro (margem de 64 px). Tela mais alta que o quadro alinha no **topo** e o resto
fica recortado de propósito. Pra mostrar outra parte, anime o `.tela` na cena:
`tl.fromTo(".tela", { y: 0 }, { y: -420, duration: 2, ease: "power1.inOut" }, 1)`.
Achados do `check` DENTRO da tela real (contraste da própria interface, texto com reticências,
elemento sobreposto do mock) são da tela, não da sua cena: avalie no print; só corrija se
atrapalhar a leitura no vídeo.
- Nada de fundo abstrato genérico (gradiente, partícula, onda) que serviria pra qualquer vídeo.

### Transições

Prontas: `corte` · `fade` · `fundo` (sai pro fundo e a próxima entra) · `deslizar-esq` ·
`deslizar-cima` · `mascara` (círculo abrindo). Duração 0,1–2,0 s, no máximo metade da cena
mais curta.

- **Fade entre duas telas cheias vira borrão**: use `fundo`.
- Pedido livre ("sai girando e entra pelo logo"): antes de escrever à mão, veja se há bloco
  pronto: `npx hyperframes@0.8.82 catalog --query <termo>` (só pra se inspirar; o código vai
  pela ferramenta). Depois `tipo: "personalizada"`, `nome` curto pro chip (≤ 3 palavras) e
  `codigo` = corpo JS que recebe `(tl, a, b, inicio, duracao)`: `a`/`b` são os elementos das
  duas cenas, `tl` a timeline RAIZ (tempo absoluto). Use `tl.fromTo(..., { ..., immediateRender:
  false }, inicio)` dentro de `[inicio, inicio + duracao]`. Mesmas regras de determinismo.
- Confira o frame do meio: `nexo_video_print` em `inicio + duracao / 2`.

Quando o pedido vem do popover do Canvas ("Transição no vídeo … Pedido: …"), responda com
`nexo_video_transicao` nesse par e confira o frame do meio — o popover atualiza sozinho.

### Áudio

- Música: uma das 5 do Nexos (`nexo_video_listar`), ende.app, CC BY 4.0 — o crédito entra
  sozinho no texto pra postar. Volume **0,3–0,4** (nunca > 0,5). Ela é cortada no fim do vídeo
  com fade-out de 1 s automaticamente.
- Batidas: `nexo_video_audio` devolve as batidas fortes. Encaixe 1–3 momentos grandes
  (revelação, logo) a ≤ 0,15 s de uma batida forte; sequências pequenas numa batida sim,
  outra não. Legibilidade e história vêm antes da batida.
- Efeitos (Kenney, CC0): poucos e casados com o movimento — impacto suave na revelação, clique
  numa interação simulada. Volume **0,55–0,85**. Efeito marcado **CANSA** (agudo) só como
  acento raro. O efeito fica preso à cena (`cena` + `t` relativo) e anda junto se ela mudar de
  lugar.

## Passo 4 — Entregar

1. `nexo_video_check` sem erro.
2. `nexo_video_render` (rascunho) se quiser conferir o vídeo inteiro com som.
3. `nexo_video_entrega` com:
   - `texto`: uma frase pra postar, no tom do vídeo, sem jargão (o crédito da música entra sozinho);
   - `capa`: o tempo do **melhor frame já assentado** (título legível, tela real à mostra) —
     nunca o frame 0, que quase sempre está vazio ou entrando.
4. Diga à pessoa, em poucas linhas: o vídeo está no painel Vídeo do Canvas, quantas cenas e
   quanto dura, o que você conferiu, e que o **render final** (qualidade alta) é no botão
   `Render ▾ → Final` depois que ela aprovar as cenas. O MP4 fica só neste computador.

---

Baseado no [brag](https://github.com/latent-spaces/brag) (MIT, © 2026 Shunit Haviv Hakimi) e
em trechos das skills do [Hyperframes](https://github.com/heygen-com/hyperframes) (Apache 2.0,
© 2026 HeyGen, Inc.). Licenças completas em `THIRD_PARTY_NOTICES.md` do Nexos.
