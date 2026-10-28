"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { trouverReprise } from "@/lib/referentiels/reprises";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import type { ActionResult } from "@/lib/actions/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LANCER UNE REPRISE DE LA REFONTE DES DONNÉES — Administration › Refonte des données (vague 2).
 *
 * Deux gestes, une seule porte : le SUPER ADMIN, et lui seul (la reprise écrit dans les référentiels de toute
 * l'entreprise ; elle ne se délègue pas). Aucune reprise ne tourne au déploiement : c'est ici qu'elle commence.
 *
 *   apercuReprise(cle)            compte à blanc tout l'existant — rien n'est écrit ;
 *   executerReprise(cle, apresId) un LOT, repris au curseur `apresId` ; rend le curseur suivant (`null` = fini).
 *
 * Chaque geste est JOURNALISÉ (`AuditLog`, module « Refonte des données », champ = clé de la reprise) avec son
 * bilan, et le curseur du lot dans `newValue` : l'écran relit ce journal pour reprendre là où on s'était arrêté.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE = "Refonte des données";
const CHEMIN = "/admin/refonte-donnees";
/** Un lot = au plus ce nombre de fiches : assez pour avancer, assez peu pour tenir dans une requête web. */
const TAILLE_LOT = 500;

export type ResultatReprise = ActionResult & { bilan?: BilanReprise & { suite?: string | null } };

function resume(b: BilanReprise): string {
  return `${b.lues} lue(s), ${b.creees} créée(s), ${b.liees} liée(s), ${b.doublonsProposes} doublon(s) proposé(s), ${b.ignorees} ignorée(s), ${b.erreurs.length} cas à regarder`;
}

async function porte(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Les reprises de la refonte sont réservées au Super Admin." };
  return { ok: true, userId: user.id };
}

export async function apercuReprise(cle: string): Promise<ResultatReprise> {
  const g = await porte();
  if (!g.ok) return g;
  const reprise = trouverReprise(cle);
  if (!reprise) return { ok: false, error: `Reprise inconnue : « ${cle} ».` };
  try {
    const bilan = await reprise.apercu();
    await recordAudit({ actorId: g.userId, action: "EXPORT", module: MODULE, field: cle, summary: `Aperçu à blanc « ${reprise.titre} » — ${resume(bilan)}` });
    return { ok: true, bilan };
  } catch (e) {
    return { ok: false, error: `Aperçu impossible : ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function executerReprise(cle: string, apresId: string | null): Promise<ResultatReprise> {
  const g = await porte();
  if (!g.ok) return g;
  const reprise = trouverReprise(cle);
  if (!reprise) return { ok: false, error: `Reprise inconnue : « ${cle} ».` };
  try {
    const bilan = await reprise.executer({ taille: TAILLE_LOT, apresId: apresId || null });
    await recordAudit({
      actorId: g.userId, action: "IMPORT", module: MODULE, field: cle,
      oldValue: apresId || null, newValue: bilan.suite,
      summary: `Lot « ${reprise.titre} » — ${resume(bilan)}${bilan.suite ? "" : " · reprise terminée"}`,
    });
    revalidatePath(CHEMIN);
    return { ok: true, bilan };
  } catch (e) {
    return { ok: false, error: `Lot interrompu, rien n'est perdu (relancer reprend au même curseur) : ${e instanceof Error ? e.message : String(e)}` };
  }
}
