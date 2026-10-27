"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { repriseParCle } from "@/lib/referentiels/reprises";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import { MODULE_JOURNAL_REPRISES, TAILLE_LOT_REPRISE, resumeBilan } from "@/lib/referentiels/reprises/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LANCER UNE REPRISE DE LA REFONTE DES DONNÉES — Super Admin seul (`docs/architecture/refonte-vague-2.md`).
 *
 * Deux gestes, pour toutes les reprises du registre (`referentiels/reprises/index.ts`) :
 *   • l'APERÇU, à blanc — rien n'est écrit, mais il est tracé (on sait qui a regardé quoi, et quand) ;
 *   • l'EXÉCUTION d'UN lot après le curseur — l'écran rappelle l'action avec la `suite` tant qu'il en reste.
 * Chaque appel est écrit au journal (`AuditLog`, module « Refonte des données », champ = clé de la reprise) :
 * c'est ce que l'écran relit. La reprise ne tourne jamais toute seule : il n'existe pas d'autre appelant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatReprise {
  ok: boolean;
  error?: string;
  bilan?: BilanReprise;
  suite?: string | null;
}

async function superAdmin() {
  const user = await requireUser();
  return user.role === "SUPER_ADMIN" ? user : null;
}

export async function apercuReprise(cle: string): Promise<ResultatReprise> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  const reprise = repriseParCle(cle);
  if (!reprise) return { ok: false, error: "Reprise inconnue." };
  try {
    const bilan = await reprise.apercu();
    await recordAudit({
      actorId: user.id, action: "IMPORT", module: MODULE_JOURNAL_REPRISES, field: cle, newValue: JSON.stringify({ apercu: true, ...bilan }),
      summary: `Aperçu à blanc — ${reprise.titre} : ${resumeBilan(bilan)}`,
    });
    return { ok: true, bilan };
  } catch (e) {
    return { ok: false, error: `Aperçu impossible : ${(e as Error).message}` };
  }
}

export async function executerReprise(cle: string, apresId: string | null): Promise<ResultatReprise> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  const reprise = repriseParCle(cle);
  if (!reprise) return { ok: false, error: "Reprise inconnue." };
  try {
    const { suite, ...bilan } = await reprise.executer({ taille: TAILLE_LOT_REPRISE, apresId });
    await recordAudit({
      actorId: user.id, action: "IMPORT", module: MODULE_JOURNAL_REPRISES, field: cle,
      oldValue: apresId, newValue: JSON.stringify({ apercu: false, suite, ...bilan }),
      summary: `Lot exécuté — ${reprise.titre} : ${resumeBilan(bilan)}${suite ? " (à suivre)" : " (terminé)"}`,
    });
    revalidatePath("/admin/refonte-donnees");
    return { ok: true, bilan, suite };
  } catch (e) {
    return { ok: false, error: `Lot en échec : ${(e as Error).message}` };
  }
}
