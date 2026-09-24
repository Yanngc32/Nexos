/**
 * Atualização por TROCA DE PASTA — o jeito principal no Windows, com o instalador (electron-updater
 * + NSIS) só de reserva.
 *
 * Por quê: o `quitAndInstall` fecha o app e roda o instalador calado, sem janela nenhuma, até ele
 * reabrir — do lado de quem usa, o Nexos "morreu" por um tempo. Aqui a versão nova já fica
 * EXTRAÍDA do lado da instalação enquanto o app roda; reiniciar vira renomear duas pastas (ms) e
 * abrir de novo.
 *
 *   <pai>/Nexos            instalação (caminho fixo: atalho, firewall e desinstalador continuam
 *                          valendo — regra de firewall é por caminho do exe)
 *   <pai>/Nexos.proxima    versão nova extraída, esperando reinício
 *   <pai>/Nexos.proxima.json  marcador: qual versão está em `.proxima`
 *   <pai>/Nexos.antiga     a de antes, até a nova confirmar que subiu (depois some em background)
 *
 * `<pai>` e não `%TEMP%`: a limpeza automática do Windows apaga o TEMP, e em outro volume o
 * "renomear" viraria cópia de 300 MB.
 *
 * A troca em si roda num PowerShell destacado (`SCRIPT_TROCA`): o Nexos.exe trava a própria pasta
 * enquanto roda, então quem troca tem que ser outro processo, depois que ele sair.
 */
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

/** Asset publicado junto de cada release (ver scripts/after-all-artifacts.cjs). */
const ARQUIVO_INFO = "nexos-portatil.json";
const EXE = "Nexos.exe";
/** Sem confirmação da versão nova nesse prazo, o script volta a antiga. */
const PRAZO_BOOT_S = 90;

function caminhos(instalacao) {
  const pai = dirname(instalacao);
  const base = basename(instalacao);
  const irma = (sufixo) => join(pai, `${base}.${sufixo}`);
  return {
    pai,
    base,
    proxima: irma("proxima"),
    marcador: irma("proxima.json"),
    antiga: irma("antiga"),
    download: irma("download"),
    subiuOk: irma("subiu-ok"),
    recusadas: irma("recusadas.json"),
    script: irma("troca.ps1"),
    log: irma("troca.log"),
  };
}

/** `1` se a > b, `-1` se a < b, `0` se iguais. Só MAJOR.MINOR.PATCH (é o que as tags usam). */
function compararVersoes(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * Dá pra trocar pasta aqui? Precisa escrever na instalação E ao lado dela — instalação em
 * Program Files (sem admin) não dá, e aí fica o instalador.
 */
function podeTrocar(instalacao) {
  if (process.platform !== "win32") return false;
  if (!existsSync(join(instalacao, EXE))) return false;
  const { pai, base } = caminhos(instalacao);
  for (const dir of [pai, instalacao]) {
    const teste = join(dir, `.${base}-escrita-${process.pid}`);
    try {
      writeFileSync(teste, "");
      unlinkSync(teste);
    } catch {
      return false;
    }
  }
  return true;
}

/** Pasta com cara de Nexos inteiro: exe e o app empacotado. */
function pastaValida(dir) {
  return existsSync(join(dir, EXE)) && existsSync(join(dir, "resources", "app.asar"));
}

function lerJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Versões que já subiram quebradas nesta máquina: pra elas fica o instalador (ver SCRIPT_TROCA). */
function recusada(instalacao, versao) {
  const lista = lerJson(caminhos(instalacao).recusadas);
  return Array.isArray(lista) && lista.includes(versao);
}

/** Versão já extraída e maior que a rodando — `null` se não tem nada pronto. */
function atualizacaoPronta(instalacao, versaoAtual) {
  const c = caminhos(instalacao);
  const m = lerJson(c.marcador);
  if (!m || typeof m.versao !== "string") return null;
  if (compararVersoes(m.versao, versaoAtual) <= 0 || !pastaValida(c.proxima)) return null;
  return { versao: m.versao };
}

function tirar(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Baixa pra `destino` calculando o sha512 no caminho (base64, mesmo formato do latest.yml). */
async function baixar(url, destino, { fetchImpl = fetch, onProgresso = () => {} } = {}) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} em ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha512");
  const out = createWriteStream(destino);
  let baixado = 0;
  try {
    for await (const pedaco of res.body) {
      hash.update(pedaco);
      baixado += pedaco.length;
      if (!out.write(pedaco)) await new Promise((r) => out.once("drain", r));
      if (total) onProgresso((baixado / total) * 100);
    }
  } finally {
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
  }
  return { sha512: hash.digest("base64"), tamanho: baixado };
}

/** Extrai com o `tar.exe` do próprio Windows (bsdtar, lê zip) — sem dependência a mais. */
function extrair(zip, destino) {
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const r = spawnSync(tar, ["-xf", zip, "-C", destino], { windowsHide: true, encoding: "utf8" });
  if (r.error) throw new Error(`tar não rodou: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar saiu com ${r.status}: ${(r.stderr || "").trim()}`);
}

/**
 * O zip pode vir com os arquivos na raiz ou dentro de uma pasta só: devolve a pasta que tem o
 * Nexos de fato, ou `null`.
 */
function raizDoNexos(dir) {
  if (pastaValida(dir)) return dir;
  const filhos = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (filhos.length === 1 && pastaValida(join(dir, filhos[0].name))) return join(dir, filhos[0].name);
  return null;
}

/**
 * Baixa, confere e extrai a `versao` em `.proxima`. Idempotente: se já está pronta, não baixa de
 * novo. Lança em qualquer falha — quem chama cai no instalador.
 */
async function prepararAtualizacao({ instalacao, versao, baseUrl, fetchImpl = fetch, onProgresso = () => {} }) {
  const c = caminhos(instalacao);
  const pronta = lerJson(c.marcador);
  if (pronta?.versao === versao && pastaValida(c.proxima)) return { versao, jaEstava: true };

  const infoRes = await fetchImpl(`${baseUrl}/v${versao}/${ARQUIVO_INFO}`, { redirect: "follow" });
  if (!infoRes.ok) throw new Error(`release v${versao} sem ${ARQUIVO_INFO} (${infoRes.status})`);
  const info = await infoRes.json();
  if (info.version !== versao || !info.arquivo || !info.sha512) throw new Error(`${ARQUIVO_INFO} inválido pra v${versao}`);

  tirar(c.marcador);
  tirar(c.proxima);
  tirar(c.download);
  mkdirSync(c.download, { recursive: true });
  const zip = join(c.download, basename(info.arquivo));
  const { sha512, tamanho } = await baixar(`${baseUrl}/v${versao}/${encodeURIComponent(info.arquivo)}`, zip, { fetchImpl, onProgresso });
  if (sha512 !== info.sha512 || (info.tamanho && tamanho !== info.tamanho)) {
    tirar(c.download);
    throw new Error("download corrompido (sha512 não bate)");
  }
  const extraido = join(c.download, "extraido");
  mkdirSync(extraido, { recursive: true });
  extrair(zip, extraido);
  const raiz = raizDoNexos(extraido);
  if (!raiz) {
    tirar(c.download);
    throw new Error("zip sem o Nexos dentro");
  }
  // mesmo volume (é irmã da instalação): renomear é instantâneo
  renameSync(raiz, c.proxima);
  tirar(c.download);
  writeFileSync(c.marcador, JSON.stringify({ versao }), "utf8");
  return { versao, jaEstava: false };
}

/**
 * Parâmetros vêm por nome (`-Inst` etc.) e o script não confia em nada além deles. Em ordem:
 * espera o app sair; mata o que ainda roda do exe da pasta (o motor roda no mesmo Nexos.exe, em
 * modo Node, e trava os arquivos); leva o desinstalador pra pasta nova (o zip não tem, e sem ele
 * "Aplicativos instalados" não desinstala); troca as pastas com retentativa (antivírus segura exe
 * recém-extraído por uns segundos); abre; espera a nova confirmar (`-SubiuOk`) e só aí apaga a
 * antiga. Sem confirmação no prazo, volta a antiga e anota a versão como recusada.
 */
const SCRIPT_TROCA = String.raw`param(
  [int]$AppPid, [string]$Inst, [string]$Prox, [string]$Velha, [string]$Versao, [string]$VersaoAntiga,
  [string]$Marcador, [string]$SubiuOk, [string]$Recusadas, [string]$Log, [int]$PrazoBoot = 90, [string]$Abrir = ''
)
$ErrorActionPreference = 'Stop'
function L([string]$m) { try { Add-Content -LiteralPath $Log -Value ("{0:o} {1}" -f (Get-Date), $m) } catch {} }
function Tentar([scriptblock]$b, [int]$n = 40) {
  for ($i = 0; $i -lt $n; $i++) { try { & $b; return $true } catch { Start-Sleep -Milliseconds 500 } }
  return $false
}
function MatarDaPasta([string]$dir) {
  $prefixo = $dir.TrimEnd('\') + '\'
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefixo, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
}
function Versao([string]$v) {
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    if ($p.UninstallString -and $p.UninstallString.IndexOf($Inst.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $v
      if ($p.DisplayName -like 'Nexos*') { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayName -Value "Nexos $v" }
    }
  }
}
function Abrir() {
  $exe = if ($Abrir) { $Abrir } else { Join-Path $Inst 'Nexos.exe' }
  Start-Process -FilePath $exe
}
$nomeInst = Split-Path -Leaf $Inst
L "troca $VersaoAntiga -> $Versao"
try { Wait-Process -Id $AppPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
MatarDaPasta $Inst
Start-Sleep -Milliseconds 300
Get-ChildItem -LiteralPath $Inst -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Prox -Force }
if (Test-Path -LiteralPath $Velha) { Remove-Item -LiteralPath $Velha -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $SubiuOk -Force -ErrorAction SilentlyContinue
if (-not (Tentar { Rename-Item -LiteralPath $Inst -NewName (Split-Path -Leaf $Velha) })) {
  L 'a pasta atual não saiu do lugar (arquivo preso); segue a versão de antes'
  Abrir; exit 1
}
if (-not (Tentar { Rename-Item -LiteralPath $Prox -NewName $nomeInst })) {
  L 'a nova não entrou no lugar; voltando a de antes'
  Tentar { Rename-Item -LiteralPath $Velha -NewName $nomeInst } | Out-Null
  Abrir; exit 1
}
Remove-Item -LiteralPath $Marcador -Force -ErrorAction SilentlyContinue
Versao $Versao
Abrir
L 'nova no lugar; esperando ela confirmar que subiu'
$ate = (Get-Date).AddSeconds($PrazoBoot)
while ((Get-Date) -lt $ate -and -not (Test-Path -LiteralPath $SubiuOk)) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path -LiteralPath $SubiuOk)) {
  L "a $Versao não confirmou em $PrazoBoot s; voltando a $VersaoAntiga"
  MatarDaPasta $Inst
  $quebrada = "$Inst.quebrada"
  if (Test-Path -LiteralPath $quebrada) { Remove-Item -LiteralPath $quebrada -Recurse -Force -ErrorAction SilentlyContinue }
  if ((Tentar { Rename-Item -LiteralPath $Inst -NewName (Split-Path -Leaf $quebrada) }) -and (Tentar { Rename-Item -LiteralPath $Velha -NewName $nomeInst })) {
    $lista = @()
    if (Test-Path -LiteralPath $Recusadas) { try { $lista = @(Get-Content -LiteralPath $Recusadas -Raw | ConvertFrom-Json) } catch {} }
    $lista = @($lista + $Versao | Select-Object -Unique)
    Set-Content -LiteralPath $Recusadas -Value (ConvertTo-Json -InputObject $lista -Compress)
    Versao $VersaoAntiga
    Abrir
    Tentar { Remove-Item -LiteralPath $quebrada -Recurse -Force } 20 | Out-Null
  } else { L 'não consegui voltar a antiga' }
  exit 1
}
L 'subiu; apagando a de antes'
Tentar { Remove-Item -LiteralPath $Velha -Recurse -Force } 20 | Out-Null
Remove-Item -LiteralPath $SubiuOk -Force -ErrorAction SilentlyContinue
L 'pronto'
`;

/**
 * Solta o script de troca destacado e volta na hora — quem chama sai logo depois (o script espera
 * o `pid` morrer). `abrir` só existe pro teste: em produção abre o Nexos.exe da instalação.
 */
function aplicar({ instalacao, versao, versaoAntiga, pid = process.pid, prazoBootS = PRAZO_BOOT_S, abrir = "" }) {
  const c = caminhos(instalacao);
  writeFileSync(c.script, SCRIPT_TROCA, "utf8");
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const params = {
    AppPid: pid,
    Inst: instalacao,
    Prox: c.proxima,
    Velha: c.antiga,
    Versao: versao,
    VersaoAntiga: versaoAntiga,
    Marcador: c.marcador,
    SubiuOk: c.subiuOk,
    Recusadas: c.recusadas,
    Log: c.log,
    PrazoBoot: prazoBootS,
    ...(abrir ? { Abrir: abrir } : {}),
  };
  const chamada = `& ${q(c.script)} ${Object.entries(params)
    .map(([k, v]) => `-${k} ${typeof v === "number" ? v : q(v)}`)
    .join(" ")}`;
  /*
   * Medido (Windows 11, PowerShell 5.1): `powershell.exe` spawnado DIRETO com `detached` sai com
   * código 0 sem rodar nada — processo de console sem console. Pelo `cmd.exe` destacado roda, e
   * sobrevive ao Electron sair. A chamada vai em `-EncodedCommand` (base64, sem espaço nem aspas)
   * porque o `cmd /c` reinterpreta aspas, e caminho de usuário com espaço quebraria os parâmetros.
   */
  const filho = spawn(
    join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
    ["/d", "/c", "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(chamada, "utf16le").toString("base64")],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  filho.unref();
  return filho;
}

/** A versão nova chegou de pé: o script da troca pode apagar a antiga. */
function confirmarBoot(instalacao) {
  try {
    writeFileSync(caminhos(instalacao).subiuOk, String(Date.now()), "utf8");
  } catch {
    /* pasta sem escrita: não houve troca por aqui */
  }
}

/**
 * Sobra de troca que o script não terminou (máquina desligou no meio): `.antiga`/`.quebrada`
 * velhas e download pela metade. Em background, sem pressa — só o que já passou do prazo do
 * script, pra não brigar com uma troca em andamento.
 */
function limparRestos(instalacao, agora = Date.now()) {
  const c = caminhos(instalacao);
  const velho = (p) => {
    try {
      return agora - statSync(p).mtimeMs > (PRAZO_BOOT_S + 60) * 1000;
    } catch {
      return false;
    }
  };
  for (const p of [c.antiga, `${instalacao}.quebrada`, c.download]) {
    if (existsSync(p) && velho(p)) {
      try {
        tirar(p);
      } catch {
        /* preso: tenta no próximo boot */
      }
    }
  }
}

module.exports = {
  ARQUIVO_INFO,
  SCRIPT_TROCA,
  aplicar,
  atualizacaoPronta,
  baixar,
  caminhos,
  compararVersoes,
  confirmarBoot,
  extrair,
  limparRestos,
  pastaValida,
  podeTrocar,
  prepararAtualizacao,
  recusada,
};
