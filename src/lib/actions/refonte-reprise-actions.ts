"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { trouverReprise, MODULE_JOURNAL_REFONTE } from "@/modules/referentiels/api";
import type { BilanReprise } from "@/modules/referentiels/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES REPRISES DE LA REFONTE — l'action serveur UNIQUE derrière Administration › Refonte des données.
 *
 * Super Admin SEUL. `apercuReprise` n'écrit rien. `executerReprise` traite UN lot et rend le curseur du
 * suivant : l'écran relance tant qu'il en reste, et chaque lot laisse une ligne au journal d'audit
 * (module « Refonte des données », champ = la clé de la reprise) — c'est le journal que l'écran relit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Lignes par lot : assez pour avancer, assez peu pour qu'un lot tienne largement dans une requête. */
const TAILLE_LOT = 200;

export type ResultatReprise =
  | { ok: true; bilan: BilanReprise & { suite?: string | null } }
  | { ok: false; error: string };

async function superAdmin() {
  const user = await requireUser();
  return user.role === "SUPER_ADMIN" ? user : null;
}

const resume = (b: BilanReprise) =>
  `${b.lues} lue(s) · ${b.creees} créée(s) · ${b.liees} liée(s) · ${b.doublonsProposes} doublon(s) proposé(s) · ${b.ignorees} ignorée(s)`
  + (b.erreurs.length ? ` · ${b.erreurs.length} erreur(s)` : "");

export async function apercuReprise(cle: string): Promise<ResultatReprise> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  const reprise = trouverReprise(cle);
  if (!reprise) return { ok: false, error: "Reprise inconnue." };
  try {
    return { ok: true, bilan: await reprise.apercu() };
  } catch (e) {
    console.error(`[refonte] aperçu ${cle} :`, e);
    return { ok: false, error: "L'aperçu a échoué : voir les journaux du serveur." };
  }
}

export async function executerReprise(cle: string, apresId: string | null): Promise<ResultatReprise> {
  const user = await superAdmin();
  if (!user) return { ok: false, error: "Réservé au Super Admin." };
  const reprise = trouverReprise(cle);
  if (!reprise) return { ok: false, error: "Reprise inconnue." };
  let bilan: BilanReprise & { suite: string | null };
  try {
    bilan = await reprise.executer({ taille: TAILLE_LOT, apresId });
  } catch (e) {
    console.error(`[refonte] lot ${cle} après ${apresId ?? "le début"} :`, e);
    return { ok: false, error: e instanceof Error ? e.message : "Le lot a échoué." };
  }
  await recordAudit({
    actorId: user.id, action: "IMPORT", module: MODULE_JOURNAL_REFONTE, field: cle,
    oldValue: apresId, newValue: JSON.stringify(bilan),
    summary: `${reprise.titre} — lot : ${resume(bilan)}${bilan.suite ? "" : " (terminé)"}`,
  });
  revalidatePath("/admin/refonte-donnees");
  return { ok: true, bilan };
}
