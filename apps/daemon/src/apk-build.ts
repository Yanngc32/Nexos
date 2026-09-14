import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AndroidSdkTools, Config, ConsoleLog, GradleWrapper, JdkHelper, TwaGenerator, TwaManifest } from "@bubblewrap/core";
import { BUILD_TOOLS_VERSION } from "@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools.js";
import type { TwaManifestJson } from "@bubblewrap/core/dist/lib/TwaManifest.js";
import { garantirKeystore, gerarAssetLinks } from "./apk-keystore.ts";

/**
 * Build do TWA (Trusted Web Activity) que embrulha a PWA do celular — Fase 2 do
 * plano de mobile (ver `docs/superpowers/specs/2026-09-13-mobile-apk-spike.md`).
 * Usa `@bubblewrap/core` (a mesma biblioteca por trás do `bubblewrap` CLI)
 * diretamente, sem a CLI interativa — este build roda sem ninguém pra
 * responder prompt, disparado pelo botão do painel Celular.
 *
 * PRECISA de HTTPS de verdade (`tls-tailscale.ts`/`escuta.ts`): TWA valida
 * Digital Asset Links contra um hostname com certificado — não builda em cima
 * de IP nem de HTTP puro. Quem chama garante isso antes.
 *
 * PRECISA do SDK do Android (`ANDROID_HOME`/`ANDROID_SDK_ROOT`) e de um JDK
 * (`JAVA_HOME`) instalados na máquina — nenhum dos dois vem junto do Nexo, e
 * a imensa maioria de quem só usa o app de desktop não vai ter. Sem eles,
 * falha com mensagem clara ANTES de gastar tempo gerando projeto nenhum.
 *
 * **Não validado de ponta a ponta em CI** — o ambiente onde isto foi escrito
 * não tem acesso ao SDK do Android (host bloqueado por política de rede) e
 * não pôde compilar um APK de verdade. O que FOI validado com ferramentas
 * reais: geração de keystore (`apk-keystore.ts`, com `keytool` de verdade) e
 * a construção do `TwaManifest` (puro JS, sem SDK). A chamada ao Gradle e ao
 * `apksigner` segue a mesma sequência que o comando `bubblewrap build` usa
 * (lido do código-fonte da própria `@bubblewrap/cli`), mas só roda de
 * verdade numa máquina com o SDK instalado.
 */

const RETENCAO = 2;
const APLICACAO_ID = "app.nexo.mobile";

export type EstadoBuild =
  | { fase: "ocioso" }
  | { fase: "construindo"; etapa: string }
  | { fase: "pronto"; caminho: string; sha256: string; hostname: string; versao: string; criadoEm: number }
  | { fase: "erro"; motivo: string };

export function apkDir(home: string): string {
  return join(home, "apk");
}
function buildsDir(home: string): string {
  return join(apkDir(home), "builds");
}
function atualPath(home: string): string {
  return join(apkDir(home), "atual.json");
}

let estado: EstadoBuild = { fase: "ocioso" };
let construindoAgora = false;

/** Só pra teste: o estado é de módulo (um daemon só serve um `home` por vez) e vaza entre casos. */
export function resetApkBuildForTest(): void {
  estado = { fase: "ocioso" };
  construindoAgora = false;
}

/** O estado atual — relê `atual.json` do disco na primeira consulta após religar o daemon. */
export function estadoAtualBuild(home: string): EstadoBuild {
  if (estado.fase === "ocioso" && existsSync(atualPath(home))) {
    try {
      const salvo = JSON.parse(readFileSync(atualPath(home), "utf8")) as Omit<
        Extract<EstadoBuild, { fase: "pronto" }>,
        "fase"
      >;
      if (existsSync(salvo.caminho)) estado = { fase: "pronto", ...salvo };
    } catch {
      /* atual.json corrompido: segue "ocioso", o próximo build sobrescreve */
    }
  }
  return estado;
}

function sdkEnv(): { jdkPath: string; androidSdkPath: string } | null {
  const jdkPath = process.env.JAVA_HOME;
  const androidSdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!jdkPath || !androidSdkPath) return null;
  return { jdkPath, androidSdkPath };
}

/**
 * `@bubblewrap/core` só reconhece um SDK do Android como válido se achar
 * `tools/` ou `bin/` na raiz (`AndroidSdkTools.validatePath`) — layout que o
 * Android removeu faz anos; instalação feita hoje pelo Android Studio só tem
 * `cmdline-tools/<versão>/bin`. Sem isto, `AndroidSdkTools.create` rejeita
 * QUALQUER SDK atual com "The provided androidSdk isn't correct.", mesmo um
 * instalado certinho — não é só nesta máquina, é qualquer usuário do Nexo.
 *
 * Cria `bin -> cmdline-tools/<versão>/bin` E `lib -> cmdline-tools/<versão>/lib`
 * (mesmos nomes que teriam na convenção antiga). Os DOIS, não só `bin`: o
 * `sdkmanager.bat` calcula seu classpath com `%~dp0..\lib` — uma referência
 * léxica ao caminho INVOCADO, que o Windows não resolve através do junction
 * pro alvo de verdade — então sem o `lib` espelhado do mesmo jeito o script
 * roda mas quebra com `ClassNotFoundException: SdkManagerCli` (visto ao
 * testar). Só na primeira vez; se `tools/` ou `bin/` já existir — deste fix
 * ou de um SDK antigo de verdade — não mexe.
 */
function garantirCompatSdkAntigo(androidSdkPath: string): void {
  const legadoTools = join(androidSdkPath, "tools");
  const legadoBin = join(androidSdkPath, "bin");
  if (existsSync(legadoTools) || existsSync(legadoBin)) return;

  const cmdlineDir = join(androidSdkPath, "cmdline-tools");
  if (!existsSync(cmdlineDir)) return; // sem cmdline-tools instalado: deixa o erro original aparecer

  const sdkmanager = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const versoes = readdirSync(cmdlineDir).sort((a, b) => (a === "latest" ? -1 : b === "latest" ? 1 : b.localeCompare(a)));
  const versaoDir = versoes.map((v) => resolve(cmdlineDir, v)).find((v) => existsSync(join(v, "bin", sdkmanager)));
  if (!versaoDir) return;

  const tipoLink = process.platform === "win32" ? "junction" : "dir";
  try {
    symlinkSync(join(versaoDir, "bin"), legadoBin, tipoLink);
    const libAlvo = join(versaoDir, "lib");
    if (existsSync(libAlvo)) symlinkSync(libAlvo, join(androidSdkPath, "lib"), tipoLink);
  } catch {
    /* sem permissão de criar o link: segue sem o shim, o erro original explica o motivo */
  }
}

/**
 * `GradleWrapper` (dentro de `@bubblewrap/core`) invoca `gradlew.bat` pelo
 * nome, sem `.\` na frente, contando com o CMD buscar no diretório atual.
 * Em máquina com `NoDefaultCurrentDirectoryInExePath` definida (endurecimento
 * de segurança comum em ambiente corporativo) essa busca fica desligada pro
 * processo inteiro, e o `CreateProcess` some com "'gradlew.bat' não é
 * reconhecido" mesmo com o arquivo bem ali (visto ao testar). Como
 * `JdkHelper.getEnv()` monta o env do zero (`Object.assign({}, process.env)`)
 * a cada chamada, tirar a variável do `process.env` do daemon só durante a
 * chamada é suficiente — e mais seguro que mexer na variável de verdade do
 * Windows (exigiria admin, e afetaria todo processo da máquina).
 */
async function comNoDefaultCurrentDirectoryInExePathDesligada<T>(fn: () => Promise<T>): Promise<T> {
  const CHAVE = "NoDefaultCurrentDirectoryInExePath";
  const original = process.env[CHAVE];
  try {
    delete process.env[CHAVE];
    return await fn();
  } finally {
    if (original === undefined) delete process.env[CHAVE];
    else process.env[CHAVE] = original;
  }
}

/**
 * Assina o APK rodando `apksigner.jar` direto na JVM, sem shell.
 *
 * Não dá pra usar `AndroidSdkTools.apksigner`: no Windows ele desvia pro
 * `JdkHelper.runJava`, que chama `util.executeFile` com `shell: true`. Com
 * `shell: true` o Node monta uma linha de comando única concatenando programa
 * e argumentos SEM aspas — e como o JDK mora em `C:\Program Files\...` por
 * padrão, o CMD corta no espaço e morre com "'C:\Program' não é reconhecido"
 * (visto ao testar). `execFile` sem shell escapa cada argumento sozinho.
 *
 * Mesmos argumentos que a `@bubblewrap/core` passaria — inclusive o desvio
 * pro `.jar` em vez do `apksigner.bat`, que é workaround dela pro
 * https://issuetracker.google.com/issues/150888434 e continua valendo.
 */
async function assinarApk(
  jdkHelper: JdkHelper,
  androidHome: string,
  keystore: { path: string; alias: string; senha: string },
  entrada: string,
  saida: string,
): Promise<void> {
  const java = join(jdkHelper.getJavaHome(), "bin", process.platform === "win32" ? "java.exe" : "java");
  const jar = join(androidHome, "build-tools", BUILD_TOOLS_VERSION, "lib", "apksigner.jar");
  await promisify(execFile)(
    java,
    [
      "-Xmx1024M",
      "-Xss1m",
      "-jar",
      jar,
      "sign",
      "--ks",
      keystore.path,
      "--ks-key-alias",
      keystore.alias,
      "--ks-pass",
      `pass:${keystore.senha}`,
      "--key-pass",
      `pass:${keystore.senha}`,
      "--out",
      saida,
      entrada,
    ],
    { env: jdkHelper.getEnv() },
  );
}

function podarBuildsAntigos(home: string): void {
  const dir = buildsDir(home);
  if (!existsSync(dir)) return;
  const entradas = readdirSync(dir)
    .map((nome) => ({ nome, caminho: join(dir, nome), mtime: statSync(join(dir, nome)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const velho of entradas.slice(RETENCAO)) rmSync(velho.caminho, { recursive: true, force: true });
}

/**
 * Dispara o build em segundo plano — NÃO espera terminar. Quem chamou consulta
 * `estadoAtualBuild` depois (o painel Celular faz polling enquanto `fase` for
 * `"construindo"`). Uma tentativa de cada vez: uma segunda chamada enquanto a
 * primeira ainda roda é ignorada, não enfileirada nem cancelada.
 */
export function construirApk(home: string, https: { hostname: string; port: number }): void {
  if (construindoAgora) return;
  construindoAgora = true;
  estado = { fase: "construindo", etapa: "preparando" };
  rodar(home, https)
    .then((pronto) => {
      estado = pronto;
    })
    .catch((err) => {
      estado = { fase: "erro", motivo: (err as Error)?.message || "erro desconhecido" };
    })
    .finally(() => {
      construindoAgora = false;
    });
}

async function rodar(home: string, https: { hostname: string; port: number }): Promise<EstadoBuild> {
  const sdk = sdkEnv();
  if (!sdk) {
    return {
      fase: "erro",
      motivo: "SDK do Android não encontrado — defina JAVA_HOME e ANDROID_HOME (ou ANDROID_SDK_ROOT) e tente de novo.",
    };
  }

  estado = { fase: "construindo", etapa: "gerando chave de assinatura" };
  const keystore = await garantirKeystore(home, sdk.jdkPath);

  estado = { fase: "construindo", etapa: "gerando assetlinks.json (Digital Asset Links)" };
  // Sem isto o app instala e abre, mas o Android não confia que ele
  // representa o site — cai pro Chrome com barra de endereço em vez de tela
  // cheia. Só depende do keystore (acima) + do applicationId, não do build
  // em si, então falhar aqui não deveria acontecer se o keystore existe.
  await gerarAssetLinks(home, sdk.jdkPath, APLICACAO_ID);

  estado = { fase: "construindo", etapa: "gerando projeto Android" };
  const versao = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14); // AAAAMMDDHHMMSS
  const manifestJson: TwaManifestJson = {
    packageId: APLICACAO_ID,
    host: https.hostname,
    name: "Nexo",
    launcherName: "Nexo",
    display: "standalone",
    themeColor: "#16161a",
    navigationColor: "#16161a",
    backgroundColor: "#16161a",
    enableNotifications: false,
    startUrl: "/app/",
    // PNG, não o icone.svg: o Jimp (usado pelo TwaGenerator pra gerar os
    // ícones em cada densidade) não decodifica SVG. Servido estaticamente
    // pelo próprio daemon (qualquer coisa em apps/mobile/ é servida sob
    // /app/*, sem rota nova) — igual à referência normal do bubblewrap
    // buscando ícone de um site no ar.
    iconUrl: `https://${https.hostname}:${https.port}/app/icone-512.png`,
    splashScreenFadeOutDuration: 300,
    signingKey: { path: keystore.path, alias: keystore.alias },
    appVersion: versao,
    fallbackType: "customtabs",
  };
  const twaManifest = new TwaManifest(manifestJson);
  const erroValidacao = twaManifest.validate();
  if (erroValidacao) return { fase: "erro", motivo: `manifest inválido: ${erroValidacao}` };

  const projeto = mkdtempSync(join(tmpdir(), "nexo-twa-"));
  try {
    const generator = new TwaGenerator();
    await generator.createTwaProject(projeto, twaManifest, new ConsoleLog("apk"));
    // Projeto é de uso único (`rmSync` no finally logo depois do build) —
    // nunca há uma segunda invocação pra reaproveitar um Gradle Daemon já
    // quente, só o custo de manter um processo JVM órfão de pé apontando pra
    // um diretório que já foi apagado. NÃO evita o protocolo cliente/daemon
    // do Gradle em si (versões atuais usam a mesma conexão mesmo com
    // `--no-daemon`, confirmado ao testar) — só evita persistir o processo.
    appendFileSync(join(projeto, "gradle.properties"), "\norg.gradle.daemon=false\n");

    estado = { fase: "construindo", etapa: "compilando (gradle)" };
    garantirCompatSdkAntigo(sdk.androidSdkPath);
    const config = new Config(sdk.jdkPath, sdk.androidSdkPath);
    const jdkHelper = new JdkHelper(process, config);
    const androidSdkTools = await AndroidSdkTools.create(process, config, jdkHelper);
    if (!(await androidSdkTools.checkBuildTools())) {
      estado = { fase: "construindo", etapa: "instalando build-tools do Android" };
      await androidSdkTools.installBuildTools();
    }
    const gradle = new GradleWrapper(process, androidSdkTools, projeto);
    await comNoDefaultCurrentDirectoryInExePathDesligada(() => gradle.assembleRelease());

    // Mesma sequência do comando `bubblewrap build`: o Android Gradle Plugin
    // já entrega o .apk alinhado, então `zipalignOnlyVerification` só CONFERE
    // — quem alinha de fato é o próprio `assembleRelease`.
    estado = { fase: "construindo", etapa: "assinando" };
    const semAssinar = join(projeto, "app/build/outputs/apk/release/app-release-unsigned.apk");
    const alinhado = join(projeto, "app-release-unsigned-aligned.apk");
    await androidSdkTools.zipalignOnlyVerification(semAssinar);
    copyFileSync(semAssinar, alinhado);

    const assinado = join(projeto, "app-release-signed.apk");
    await assinarApk(jdkHelper, sdk.androidSdkPath, keystore, alinhado, assinado);

    estado = { fase: "construindo", etapa: "salvando" };
    const destDir = join(buildsDir(home), `${Date.now()}-${randomUUID().slice(0, 8)}`);
    mkdirSync(destDir, { recursive: true });
    const destApk = join(destDir, "nexo.apk");
    copyFileSync(assinado, destApk);
    const sha256 = createHash("sha256").update(readFileSync(destApk)).digest("hex");

    const pronto = { caminho: destApk, sha256, hostname: https.hostname, versao, criadoEm: Date.now() };
    writeFileSync(atualPath(home), JSON.stringify(pronto), "utf8");
    podarBuildsAntigos(home);
    return { fase: "pronto", ...pronto };
  } finally {
    rmSync(projeto, { recursive: true, force: true });
  }
}
