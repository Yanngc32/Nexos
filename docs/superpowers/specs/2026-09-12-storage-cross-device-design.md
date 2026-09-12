# Nexo — pasta única por projeto, cross-device (design)

Data: 2026-09-12
Status: aprovado pelo usuário, aguardando plano de implementação

Primeiro de 4 specs de uma iniciativa maior ("gestão de memória/tarefas entre dispositivos +
reformulação da página de tarefas/projeto"). Ordem combinada com o usuário:

- **A (este spec)** — identidade de projeto + pasta única cross-device.
- **B** — modelo de tarefa avançado (subtarefas/dependências, tipo, vínculo automático com
  git, automações simples de coluna).
- **C** — novas visualizações (tabela, calendário, timeline) + kanban redesenhado.
- **D** — ferramenta MCP pro LLM listar/ler/criar/mover tarefas sob demanda.

B, C e D dependem do layout de dados que este spec define, e serão desenhados em specs
próprios depois deste ser implementado.

## Problema

Memória (`memoria.ts`), tarefas (`tarefas.ts`) e repo map (`repo-map-indice.ts`) já vivem
fora da pasta do projeto e já têm raiz configurável (`memoriaDir`, `tarefasDir`, `graphDir`
em `config.json`) — a ideia de apontar essa raiz pra uma pasta sincronizada (Drive, etc.) já
existe desde o spec de memória
([2026-09-09-memoria-projeto-design.md](2026-09-09-memoria-projeto-design.md)). Mas dois
problemas impedem "cross-device" de verdade hoje:

1. **Layout por tipo, não por projeto.** Cada um dos três módulos tem sua PRÓPRIA raiz, e
   dentro dela uma subpasta nomeada com o sha1 de `projectKey(projectPath)` — reimplementado
   três vezes com o mesmo resultado (`projectHash` em `memoria.ts:29`, `tarefasHash` em
   `tarefas.ts:101`, `repoMapHash` em `repo-map-indice.ts:31`). Não existe "a pasta do
   projeto X": existem três pastas de hash idêntico espalhadas em três raízes possivelmente
   diferentes.
2. **Identidade por path local.** `projectKey` normaliza o path absoluto — mas o path muda
   entre máquinas (usuário diferente, letra de unidade diferente, SO diferente). O mesmo
   projeto aberto em duas máquinas gera dois hashes diferentes e, portanto, duas pastas
   (memórias, tarefas e repo map) sem relação nenhuma entre si.

## Objetivo

Cada projeto ganha UMA pasta, com nome legível, a mesma em qualquer máquina que abra aquele
projeto (via identidade estável, não o path local) — contendo memória, tarefas e repo map
dentro dela. Apontar a raiz pra uma pasta do Google Drive/OneDrive já sincronizada localmente
resolve o acesso entre dispositivos; o Nexo continua sem transporte de sync próprio (mesma
decisão do spec de memória).

## Fora de escopo

- **B/C/D** (ver acima) — modelo de tarefa, novas telas, ferramenta de LLM.
- **Lock distribuído / resolução de conflito de escrita concorrente.** Dois daemons escrevendo
  no MESMO arquivo ao mesmo tempo (duas máquinas ativas simultaneamente no mesmo projeto) não
  é resolvido — cada escrita é "last write wins", igual hoje. Se o cliente de sync gerar uma
  cópia de conflito (`quadro (1).md`, `quadro-conflict.md`, etc.), o Nexo simplesmente ignora
  esses arquivos (não casam o nome exato esperado). Documentado como limitação conhecida: na
  prática, uso é de uma máquina ativa por vez.
- **Sync automático feito pelo Nexo.** Continua sendo responsabilidade do cliente de
  Drive/OneDrive/Dropbox já instalado na máquina.
- **Auto-detecção de merge/rename de slug** (ex.: usuário troca o remote git de um projeto já
  em uso) — troca de slug hoje é só via override manual; não migra pastas antigas sozinho
  nesse caso específico (só na migração do layout velho→novo, ver abaixo).

## Identidade do projeto (slug)

Nova função `projectSlug(projectPath: string, home: string): { slug: string; origem: "git" |
"manual" | "pasta" }` (novo módulo `apps/daemon/src/projeto-dir.ts`):

1. **Override manual** — `config.json` ganha `slugOverrides?: Record<string, string>`, chave
   = `projectKey(projectPath)`, valor = slug escolhido pelo usuário. Checado primeiro; sempre
   vence.
2. **Git remote** — `git -C <projectPath> remote get-url origin` (via `execFileSync`,
   best-effort, timeout curto, nunca lança). Da URL (HTTPS ou SSH, com ou sem `.git`), extrai
   os dois últimos segmentos de path (`owner/repo`) e normaliza: minúsculo, `/` → `-`,
   qualquer caractere fora de `[a-z0-9-]` vira `-`, colapsa `-` repetido, corta em 60
   caracteres. Ex.: `git@github.com:Yanngc32/Nexos.git` → `yanngc32-nexos`.
3. **Fallback (sem remote, sem override)** — nome sanitizado da própria pasta (basename de
   `projectPath`, mesma normalização acima). Se colidir com o slug de OUTRO `projectPath` já
   registrado (`meta.json` de uma pasta existente com `projectPath` diferente), acrescenta
   sufixo `-<4 chars do sha1 de projectKey>` automaticamente — evita pisar em cima de pasta
   alheia sem intervenção, mas fica sinalizado como "instável" (`origem: "pasta"`) pra UI
   sugerir definir manualmente.

`projectSlug` é síncrona (spawnSync do git é aceitável aqui — chamada só ao abrir/registrar
projeto e no migrador, não por turno).

## Layout de arquivos

Novo módulo `projeto-dir.ts`:

```ts
export function projetosRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.projetosDir || join(home, "projetos");
}

export function projectDir(projectPath: string, home: string): string {
  const { slug, origem } = projectSlug(projectPath, home);
  const dir = join(projetosRoot(home), slug);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ projectPath, slug, origem }, null, 2), "utf8");
  }
  return dir;
}
```

Resultado em disco:

```
<projetosRoot>/
  yanngc32-nexos/
    meta.json
    memoria/MEMORIA.md
    tarefas/quadro.md
    tarefas/itens/<id>.md
    repo-map/indice.json
    repo-map/resumos.json
```

`memoria.ts`, `tarefas.ts` e `repo-map-indice.ts` passam a chamar `projectDir(projectPath,
home)` e só acrescentar seu próprio subnome (`"memoria"`, `"tarefas"`, `"repo-map"`) — as três
funções de hash duplicadas (`projectHash`, `tarefasHash`, `repoMapHash`) são removidas, mesma
limpeza que já era duplicação acidental antes deste spec.

**Compatibilidade com overrides existentes**: se `memoriaDir`/`tarefasDir`/`graphDir`
estiverem definidos em `config.json`, esse tipo específico IGNORA `projectDir` inteiramente e
usa `join(<seuDirAntigo>, projectHashAntigo)` como hoje (path calculado inline, já que a
função dedicada é removida — poucas linhas, não justifica manter função só pro caminho
legado). Quem nunca usou os campos antigos (a maioria) migra pro layout novo sem perceber.

## Migração automática

Nova função `migrarProjeto(projectPath: string, home: string): void`, best-effort (nunca
lança, loga uma linha por tentativa), chamada em `cmdUp()` (`cli.ts`) pra cada projeto
conhecido (`config.repos` ∪ `projectsFromThreads`, mesma lista que `GET /v1/projects` já
usa), em paralelo, sem bloquear a subida:

- Para cada par (raiz antiga, subpasta nova): `memoriaDir`-ou-padrão + hash → `.../memoria`;
  idem tarefas e repo-map.
- Só migra quando a pasta antiga EXISTE e a nova NÃO existe ainda (nunca sobrescreve).
- Só roda quando o tipo NÃO tem override explícito (`memoriaDir`/etc. definido) — nesse caso
  o layout antigo é o layout de verdade pra esse tipo, não há o que migrar.
- `renameSync` (mesma partição — caso comum, é tudo dentro de `~/.nexo` ou uma raiz nova
  ainda não usada); se falhar (`EXDEV`, raiz nova já aponta pra outro volume/pasta de Drive),
  cai pra copiar recursivamente e apagar a origem só depois da cópia confirmada.

## Config (`packages/shared` + `config.ts`)

`NexoConfig` ganha:

```ts
projetosDir?: string;                    // raiz nova unificada; default join(home, "projetos")
slugOverrides?: Record<string, string>;  // projectKey(path) -> slug escolhido manualmente
```

`loadConfig`/`saveConfig` seguem o mesmo padrão dos campos existentes (`str()` pra
`projetosDir`, merge raso validando string→string pra `slugOverrides`, teto de 200 entradas
igual o teto de 50 em `cleanRepos` — mesma razão, não crescer sem fim).

## UI (Settings)

Tela de Settings (`index.html:1148-1213`) troca os três campos de path atuais por UM campo
"Pasta de projetos" (`projetosDir`) com o mesmo texto de ajuda que já existia (apontar pra
`G:\Meu Drive\...`). Os três campos antigos continuam existindo, mas RECOLHIDOS num
"Avançado" — quem nunca mexeu neles nem vê.

Na tela de projeto (`pane-graph`), quando o slug detectado é `origem: "pasta"` (instável),
mostra um aviso com botão "definir nome manualmente" → grava em `slugOverrides` e dispara
`migrarProjeto` pra esse projeto na hora (pra não esperar o próximo restart do daemon).

## Testes

- `apps/daemon/test`: `projectSlug` — git remote HTTPS e SSH geram o mesmo slug; sem remote
  cai pro nome da pasta; override manual sempre vence; colisão de fallback gera sufixo
  automático e marca `origem: "pasta"`.
- `apps/daemon/test`: `projectDir` — cria `meta.json` na primeira chamada, não recria nem
  sobrescreve em chamadas seguintes; dois projetos com projectPath diferente nunca colidem.
- `apps/daemon/test`: `memoriaPath` (`memoria.ts`), `quadroPath`/`itensDir` (`tarefas.ts`) e
  `projectIndiceDir` (`repo-map-indice.ts`) — ajustados pra usar `projectDir` — resolvem pro
  layout novo quando não há override, e pro layout antigo quando há.
- `apps/daemon/test`: `migrarProjeto` — move pasta antiga pra nova quando só a antiga existe;
  não faz nada quando a nova já existe (não sobrescreve) nem quando a antiga não existe; tipo
  com override explícito nunca migra.
- `apps/desktop/test`: Settings mostra `projetosDir` como campo principal; campos antigos
  atrás de "Avançado"; aviso de slug instável some depois de definir manualmente.
