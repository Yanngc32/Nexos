import { getProfile } from "./profiles.ts";
import { loadConfig } from "./config.ts";

export function assertSwitch(input: { confirmed: boolean }): void {
  if (input.confirmed !== true) throw new Error("confirmed obrigatório");
}

export function suggestFallback(currentId: string, home: string): string | undefined {
  const order = loadConfig(home).fallbackOrder;
  const start = order.indexOf(currentId);
  const slice = start === -1 ? order : order.slice(start + 1);
  for (const id of slice) {
    if (id === currentId) continue;
    const p = getProfile(id, home);
    if (p?.status === "ready") return id;
  }
  return undefined;
}
