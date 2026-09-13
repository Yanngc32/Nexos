import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidSdkTools, Config, ConsoleLog, GradleWrapper, JdkHelper, TwaGenerator, TwaManifest } from "@bubblewrap/core";
import type { TwaManifestJson } from "@bubblewrap/core/dist/lib/TwaManifest.js";
import { garantirKeystore } from "./apk-keystore.ts";

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

    estado = { fase: "construindo", etapa: "compilando (gradle)" };
    const config = new Config(sdk.jdkPath, sdk.androidSdkPath);
    const jdkHelper = new JdkHelper(process, config);
    const androidSdkTools = await AndroidSdkTools.create(process, config, jdkHelper);
    if (!(await androidSdkTools.checkBuildTools())) {
      estado = { fase: "construindo", etapa: "instalando build-tools do Android" };
      await androidSdkTools.installBuildTools();
    }
    const gradle = new GradleWrapper(process, androidSdkTools, projeto);
    await gradle.assembleRelease();

    // Mesma sequência do comando `bubblewrap build`: o Android Gradle Plugin
    // já entrega o .apk alinhado, então `zipalignOnlyVerification` só CONFERE
    // — quem alinha de fato é o próprio `assembleRelease`.
    estado = { fase: "construindo", etapa: "assinando" };
    const semAssinar = join(projeto, "app/build/outputs/apk/release/app-release-unsigned.apk");
    const alinhado = join(projeto, "app-release-unsigned-aligned.apk");
    await androidSdkTools.zipalignOnlyVerification(semAssinar);
    copyFileSync(semAssinar, alinhado);

    const assinado = join(projeto, "app-release-signed.apk");
    await androidSdkTools.apksigner(keystore.path, keystore.senha, keystore.alias, keystore.senha, alinhado, assinado);

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
