import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apkDir, garantirKeystore } from "../src/apk-keystore.ts";
import { tempHome } from "./helpers.ts";

const JDK = process.env.JAVA_HOME;

describe.runIf(JDK)("garantirKeystore (JDK real via JAVA_HOME)", () => {
  it("gera um keystore novo com keytool de verdade, e nunca em texto plano no disco fora do arquivo 0600", async () => {
    const home = tempHome();
    const info = await garantirKeystore(home, JDK as string);
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(join(apkDir(home), "keystore.json"))).toBe(true);
    expect(info.alias).toBe("nexo");
    expect(info.senha).toHaveLength(48); // 24 bytes em hex
  });

  it("chamar de novo reusa o MESMO keystore — regenerar quebraria update de quem já instalou", async () => {
    const home = tempHome();
    const primeiro = await garantirKeystore(home, JDK as string);
    const bytesAntes = readFileSync(primeiro.path);
    const segundo = await garantirKeystore(home, JDK as string);
    expect(segundo).toEqual(primeiro);
    expect(readFileSync(primeiro.path)).toEqual(bytesAntes);
  });
});

describe.skipIf(JDK)("garantirKeystore", () => {
  it.skip("sem JAVA_HOME neste ambiente — pulado", () => {});
});
