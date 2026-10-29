/**
 * OPS VAGUE 4a — outils partagés par plusieurs familles : le format de date du jour et le statut lu
 * dans une liste FR → énumération.
 */
import { matchLabel } from "../../impl-regulatory";

export const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function statusIn(raw: string, entries: [string, string][]): string | null | { error: string } {
  const q = raw.trim();
  if (!q) return null;
  const m = matchLabel(q, entries);
  return typeof m === "object" ? m : m;
}
