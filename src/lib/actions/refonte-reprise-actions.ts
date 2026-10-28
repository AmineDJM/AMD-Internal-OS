"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { repriseParCle, type BilanReprise } from "@/lib/referentiels/reprises";

/**
 * LES REPRISES DE LA REFONTE DES DONNÉES — l'action unique de l'écran Administration › Refonte des
 * données (contrat commun de la vague 2). Super Admin seul ; chaque exécution est auditée ; l'aperçu
 * n'écrit rien.
 */

export type IssueReprise = { ok: true; bilan: BilanReprise; suite?: string | null } | { ok: false; message: string };

const TAILLE_LOT = 200;

export async function apercuReprise(cle: string): Promise<IssueReprise> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, message: "Réservé au Super Admin." };
  const reprise = repriseParCle(cle);
  if (!reprise) return { ok: false, message: "Reprise inconnue." };
  try {
    return { ok: true, bilan: await reprise.apercu() };
  } catch (e) {
    return { ok: false, message: `Aperçu impossible : ${e instanceof Error ? e.message : "erreur"}` };
  }
}

export async function executerReprise(cle: string, apresId: string | null): Promise<IssueReprise> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, message: "Réservé au Super Admin." };
  const reprise = repriseParCle(cle);
  if (!reprise) return { ok: false, message: "Reprise inconnue." };
  try {
    const { suite, ...bilan } = await reprise.executer({ taille: TAILLE_LOT, apresId });
    await recordAudit({
      actorId: user.id, action: "IMPORT", module: "Refonte des données",
      summary: `Reprise « ${reprise.titre} » — lot : ${bilan.lues} lues, ${bilan.creees} créées, ${bilan.liees} liées, ${bilan.doublonsProposes} doublons proposés, ${bilan.ignorees} ignorées${suite ? "" : " (terminée)"}.`,
    });
    revalidatePath("/admin/refonte-donnees");
    return { ok: true, bilan, suite };
  } catch (e) {
    return { ok: false, message: `Lot interrompu : ${e instanceof Error ? e.message : "erreur"}` };
  }
}
