/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SEMIS DU BANC D'AUDIT (décision 0050) — base de banc LOCALE uniquement (`amd_bench`), BENCH_SEED_ALLOW=1.
 *
 *   BENCH_SEED_ALLOW=1 npm run audit:assistant -- --semer          # (re)sème
 *   BENCH_SEED_ALLOW=1 npm run audit:assistant -- --retirer        # retire
 *
 * Le semis lui-même vit au module (`infra/testing/audit/semis.ts`, porte `api-banc`) : la suite déterministe sème
 * EXACTEMENT les mêmes personas. Ici, en plus : l'index plein texte du Drive et la Bibliothèque (comme la file de fond
 * le ferait en production), et le plafond quotidien relevé pour le banc (dit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { prisma, estUneBaseDeBancOuDEssai } from "@/lib/prisma";
import { retirerAudit, semerAudit, type SemisAudit } from "@/modules/assistant-ia/api-banc";

export const MANIFESTE = path.join(process.cwd(), "bench-out", "audit-assistant-semis.json");
export const ETIQUETTE = "-q1";

export function garde(): void {
  if (!estUneBaseDeBancOuDEssai(process.env.DATABASE_URL ?? "")) throw new Error("Refus : base de banc locale uniquement (hôte local + nom contenant « bench »), ou la base d'essai déclarée.");
}

export function lireSemis(): SemisAudit | null {
  try { return JSON.parse(fs.readFileSync(MANIFESTE, "utf8")) as SemisAudit; } catch { return null; }
}

export async function semer(): Promise<SemisAudit> {
  garde();
  if (process.env.BENCH_SEED_ALLOW !== "1") throw new Error("Refus : BENCH_SEED_ALLOW=1 est exigé pour semer.");
  await retirerAudit(ETIQUETTE);
  const s = await semerAudit(ETIQUETTE);
  // La Bibliothèque lit les pièces déposées (le dépôt les a inscrites), comme la file de fond en production.
  const { rattraper, traiterFile } = await import("@/modules/bibliotheque/api");
  await rattraper({ lot: 500 });
  for (let i = 0; i < 20; i++) if ((await traiterFile({ max: 50 })).prises === 0) break;
  // Le banc enchaîne ~150 tours sur dix comptes : le plafond quotidien par défaut tomberait au milieu.
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, update: { plafondJetonsJour: 10_000_000 }, create: { id: "global", plafondJetonsJour: 10_000_000 } as never });
  fs.mkdirSync(path.dirname(MANIFESTE), { recursive: true });
  fs.writeFileSync(MANIFESTE, JSON.stringify(s, null, 2));
  console.log(`Semis d'audit : ${Object.keys(s.users).length} comptes, ${Object.keys(s.pieces).length} pièces piégées, validation ${s.validationRef}.`);
  return s;
}

export async function retirer(): Promise<void> {
  garde();
  await retirerAudit(ETIQUETTE);
  fs.rmSync(MANIFESTE, { force: true });
  console.log("Semis d'audit retiré.");
}
