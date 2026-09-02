import { resolve } from "node:path";

export function spawnCwd(projectPath: string): string {
  return resolve(projectPath);
}
