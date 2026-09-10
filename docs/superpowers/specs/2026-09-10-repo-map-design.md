# Nexo — repo map em 2 camadas, substitui o graphify (design)

Data: 2026-09-10
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

O `graphify` (grafo semântico construído por LLM, `graphify extract`/`update`, ferramentas
`nexo_grafo_perguntar`/`nexo_grafo_explicar`) não está pagando o próprio custo:

- `extract` gasta quota de verdade pra construir um grafo que, na prática, o modelo evita usar
  ou usa mal.
- `nexo_grafo_perguntar` (busca livre) faz BFS a partir do nó mais parecido com a pergunta —
  quando o nó de partida é errado, a resposta vem irrelevante, e isso aconteceu repetidas vezes
  nos testes desta sessão.
- A definição das duas ferramentas MCP entra no `tools/list` de TODA conversa com grafo
  disponível, e o nudge em `withInstructions` (session.ts) também — ou seja, parte do custo já é
  pago todo turno mesmo quando a ferramenta nunca é chamada.
- Depende de um binário externo (`graphify`, instalado via `uv`/`pip`) — mais uma peça que pode
  faltar/quebrar fora do controle do Nexo.

## Objetivo

Trocar por uma memória estrutural em duas camadas, nenhuma delas dependente de LLM pra existir:

1. **Índice** — sempre no pack (como o `MEMORIA.md` já é hoje): árvore de arquivos do projeto,
   compacta, com teto rígido de tokens.
2. **Símbolos sob demanda** — ferramenta MCP determinística: dado um arquivo/pasta, devolve as
   assinaturas top-level (função, classe, export) daquele caminho, sem exigir grafo nenhum
   construído de antemão.

Uma camada de enriquecimento por IA (resumo de uma linha por arquivo) fica OPCIONAL e por cima
do índice — nunca é a fonte de verdade, e some sem quebrar nada se nunca for ligada.

## Fora de escopo

- **Reaproveitar qualquer parte do `graphify`** — sai por inteiro (binário externo, `extract`,
  `update`, as duas ferramentas MCP, a visualização `graph.html`/D3). O novo parser é interno ao
  Nexo.
- **"Ver grafo" (visualização D3 de comunidades)** — sem grafo, não há o que desenhar. Fica de
  fora desta v1; se fizer falta, uma visualização de árvore de arquivos é candidata futura, não
  desenhada aqui.
- **Grafo de relações entre símbolos** (quem chama quem, dependências) — o repo map é estrutural
  (o que existe, onde), não relacional. Se isso fizer falta depois de usar a v1, é um design à
  parte.
- **Negative memory formal** — boa prática que o usuário trouxe (registrar decisões rejeitadas e
  o motivo), mas cabe como convenção de conteúdo dentro do `MEMORIA.md` que já existe, sem
  mecanismo novo. Fora do escopo desta spec.
- **Escolha de linguagem além do parser tree-sitter em si** — o parser cobre qualquer gramática
  tree-sitter instalada; a lista inicial de gramáticas (abaixo) é o ponto de partida, não um teto
  fechado.

## Camada 1 — Índice

Gerado por parsing puro (tree-sitter — ver seção Parser), sem custo de LLM. Contém:

- Árvore de pastas/arquivos do projeto, respeitando `.gitignore` (mesma lista que o `git` do
  projeto já usa — não reimplementa parsing de `.gitignore`, chama `git ls-files` ou equivalente
  pra já vir filtrado).
- **Sem símbolos** — só estrutura. É o que mantém o índice pequeno (teto de ~1200 tokens,
  configurável). Adicionar símbolos aqui foi cogitado e descartado: era exatamente o "erro
  clássico" de carregar detalhe demais todo turno.
- Se o módulo de enriquecimento estiver ligado (ver abaixo), cada linha de arquivo ganha o
  resumo de uma linha ao lado — dentro do mesmo teto; se estourar, os arquivos SEM resumo
  aparecem só com o caminho (índice nunca ultrapassa o teto por causa do enriquecimento).

**Onde entra**: `withInstructions` (`session.ts`), mesmo bloco que hoje injeta `MEMORIA.md` —
texto fixo no topo do pack, não ferramenta. Herda o benefício de prompt caching que esse bloco já
tem (texto igual entre turnos da mesma conversa = cache read, não input cheio).

**Cache em disco**: um arquivo por projeto (mesma convenção de `graphDir`/hash de
`projectKey` que `graphify.ts` já usa hoje, reaproveitada pro índice novo). Recalculado:

- Na primeira vez que o projeto abre no Nexo (eco de `nexo.projeto-novo`).
- No hook `git.post-commit` (ver Migração do hook, abaixo) — incremental: só re-varre arquivos
  que o commit tocou, não o projeto inteiro.
- Manualmente, botão "Atualizar" na tela "Memória do Projeto" (mesmo lugar que hoje tem os
  botões do grafo).

Corte por teto: se a árvore ultrapassar o limite mesmo sem símbolos (projeto muito grande),
trunca por prioridade — arquivos na raiz e pastas de primeiro nível entram inteiros; pastas
profundas viram uma linha resumida (`src/vendor/… (128 arquivos)`) em vez de listadas por
extenso.

## Camada 2 — Símbolos sob demanda

Ferramenta MCP `nexo_mapa_simbolos`, parte de `ferramentasDeAutoria`/conjunto padrão (mesmo lugar
onde `ferramentasDeGraphify` entrava hoje — `mcpDaConversa`/session.ts decide quando somar,
condicionado a existir um índice pra aquele projeto, do jeito que `graphifyDisponivel` condicionava
antes).

**Args**: `{ caminho: string }` — arquivo ou pasta, relativo à raiz do projeto.

**Comportamento**: roda o mesmo parser tree-sitter da Camada 1, mas só nesse caminho, na hora da
chamada (sem depender de nada pré-construído) — devolve, por arquivo, uma linha no formato
"caminho + lista de símbolos" (`src/auth/login.ts: function login(user, pass), class AuthError`).
Pasta devolve uma linha dessas por arquivo dentro dela. É o detalhe de símbolo que a Camada 1
propositalmente omite (ela só lista o caminho, sem os símbolos).

Isto é o sucessor direto de `nexo_grafo_explicar` (a parte do `graphify` que funcionou de forma
confiável nos testes desta sessão) — mesma ideia (detalhe sob pedido, não grafo pronto), agora
sem depender de nada construído por LLM.

**Nudge no pack**: um bloco curto em `withInstructions`, substituindo o nudge do graphify — algo
como "pra ver os símbolos de um arquivo antes de abrir ele inteiro, chame `nexo_mapa_simbolos`".

## Enriquecimento (opcional)

Resumo de uma linha por arquivo ("cuida de autenticação"), gerado por IA, mostrado na Camada 1
ao lado do caminho.

- **Liga/desliga**: toggle na tela "Memória do Projeto" (substitui o toggle "grafo automático"
  de hoje — mesmo lugar, mesmo tipo de controle, `NexoConfig.modulos` ganha o campo novo no lugar
  do antigo).
- **Gatilho**: só sob pedido — botão "Gerar resumos" na mesma tela, que roda pros arquivos que
  ainda não têm resumo (ou têm um desatualizado). Não roda sozinho a cada commit nem a cada
  abertura de projeto — é a pessoa quem decide gastar essa quota.
- **Manutenção incremental**: depois do primeiro "Gerar resumos", o hook `git.post-commit`
  (reaproveitando o mecanismo de `grafo-auto.ts` — agente com id fixo + regra global) marca só os
  arquivos tocados no commit como "precisa de resumo novo", sem re-resumir o projeto inteiro. Um
  agente batendo o resumo de um arquivo por vez, na mesma pasta, é suficiente — não precisa de
  paralelismo nem de fila.
- **Cache**: um resumo por arquivo, chaveado por caminho + hash do conteúdo (sha1, mesmo padrão
  já usado em `graphify.ts`/`memoria.ts` pra chaves de projeto). Arquivo mudou → hash não bate →
  Camada 1 mostra só o caminho até o próximo "Gerar resumos"/commit re-resumir. Nunca inventa
  informação: sem resumo cacheado, mostra o caminho puro, nunca um resumo velho como se fosse
  atual.
- **Se nunca for ligado**: a Camada 1 funciona sozinha, só sem os resumos — nada quebra, nada
  fica pela metade.

## Parser (tree-sitter)

Dependência nova em `apps/daemon` (`tree-sitter` + gramáticas por linguagem). Lista inicial:
JavaScript, TypeScript (+ TSX), Python, Go, Rust, Java — cobre o Nexo e os stacks mencionados
pelo usuário (NestJS/Next.js, Python). Arquivo de linguagem não coberta entra na árvore da
Camada 1 (é só estrutura), mas a Camada 2 devolve "sem parser pra esta linguagem" em vez de
lista vazia — distinção que interessa (arquivo sem símbolo extraído ≠ arquivo vazio).

Extração por linguagem: nós top-level de declaração (função, classe, `export`, `interface`/`type`
em TS) — sem descer no corpo. Mesmo em classes, só a assinatura de métodos públicos top-level,
não o corpo deles.

## Migração

- **Remove**: `apps/daemon/src/graphify.ts` inteiro (inclui `ensureGraphifyInstalled`,
  `ferramentasDeGraphify`, `MCP_TOOLS_GRAPHIFY`, `caminhoDaArvoreDoGrafo`), a dependência do
  binário `graphify` via `uv`/`pip`, e o botão "Ver grafo"/visualização `graph.html` na tela
  "Memória do Projeto".
- **Reescreve**: `apps/daemon/src/grafo-auto.ts` — mesmo padrão (agente + 2 regras globais,
  reconhecidas por `agentId` fixo), trocando o que as regras disparam: de "rodar
  `graphify extract`/`update` via Bash" pra "chamar o indexador determinístico direto" (função
  TypeScript, não comando de agente — não precisa mais de LLM pra manter a Camada 1 fresca). O
  módulo troca de nome (`modulos.grafoAuto` → algo como `modulos.repoMap`), mantendo o padrão de
  liga/desliga + conta configurável só pro enriquecimento opcional (a Camada 1 não precisa de
  conta nenhuma, roda sem LLM).
- **`session.ts`**: troca o bloco de nudge do graphify por um novo (símbolos sob demanda) e a
  condição de somar `nexo_mapa_simbolos` ao conjunto (de `graphifyDisponivel` pra "índice existe
  pra este projeto").
- **UI (tela "Memória do Projeto")**: seção "Grafo" vira "Repo map" — status (existe/não existe,
  quando foi atualizado pela última vez), botão "Atualizar" (força recálculo da Camada 1), toggle
  "Resumos por IA" + botão "Gerar resumos" (a parte de enriquecimento) no lugar do antigo toggle
  "Manter o grafo sozinho".

## Testes

- **Parser**: por gramática (JS/TS/Python/Go/Rust/Java) — arquivo de exemplo conhecido, símbolos
  esperados batem exatamente (nome, tipo de declaração).
- **Índice**: teto de token respeitado mesmo em árvore grande (trunca pastas profundas em vez de
  listar tudo); projeto pequeno cabe inteiro sem truncar; `.gitignore` filtra corretamente.
- **`nexo_mapa_simbolos`**: caminho de arquivo devolve símbolos daquele arquivo; caminho de pasta
  devolve por arquivo dentro dela; caminho inexistente é erro de ferramenta (`isError`, não
  derruba o processo); linguagem sem gramática devolve aviso explícito, não lista vazia.
- **Enriquecimento**: resumo cacheado por hash — arquivo mudado invalida o cache dele e só dele;
  "Gerar resumos" não re-gera o que já está com hash batendo; hook de commit marca só os arquivos
  do commit, não o projeto inteiro.
- **Migração**: nenhuma referência viva a `graphify.ts`/binário `graphify` sobra no código
  depois da remoção (grep de garantia no CI/teste, não só remoção manual).
