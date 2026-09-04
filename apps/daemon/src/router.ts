import { getProfile, listProfiles } from "./profiles.ts";
import { loadConfig } from "./config.ts";

export function assertSwitch(input: { confirmed: boolean }): void {
  if (input.confirmed !== true) throw new Error("confirmed obrigatório");
}

export function suggestFallback(currentId: string, home: string): string | undefined {
  const order = loadConfig(home).fallbackOrder;
  const start = order.indexOf(currentId);
  const slice = start === -1 ? order : order.slice(start + 1);
  const inOrder = new Set(order);
  for (const id of slice) {
    if (id === currentId) continue;
    const p = getProfile(id, home);
    if (p?.status === "ready") return id;
  }
  for (const p of listProfiles(home)) {
    if (p.id === currentId || inOrder.has(p.id)) continue;
    if (p.status === "ready") return p.id;
  }
  return undefined;
}
