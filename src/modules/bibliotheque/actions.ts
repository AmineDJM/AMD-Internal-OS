"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";
import { rattraper, relancerFiche, traiterFile } from "@/modules/bibliotheque/api";

/**
 * LES GESTES DU SUPER ADMIN SUR LA BIBLIOTHÈQUE (J1) — vérifier à la main, sans attendre la tâche de fond.
 * Lecture seule pour le métier : ces gestes ne modifient aucune pièce, ils (re)lisent et indexent. Audités.
 */

const CHEMIN = "/bibliotheque";

/** Un passage de rattrapage puis de lecture, tout de suite (au lieu du prochain battement). */
export async function lancerPassageBibliotheque(): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const r = await rattraper({ lot: 25 });
  const b = await traiterFile({ max: 20 });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Bibliothèque",
    summary: `Passage manuel : ${r.inscrites} inscrite(s), ${b.faites} lue(s), ${b.ignorees} ignorée(s), ${b.echecs} en échec, ${b.vectorises} passage(s) vectorisé(s)`,
  });
  revalidatePath(CHEMIN);
  return { ok: true, message: `${r.inscrites} pièce(s) inscrite(s), ${b.faites} lue(s), ${b.echecs} en échec.` };
}

/** Remet une pièce en file (lecteur corrigé, pièce en ÉCHEC). */
export async function relancerFicheBibliotheque(pieceId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  if (typeof pieceId !== "string" || !pieceId.startsWith("piece_")) return { ok: false, error: "Pièce inconnue." };
  if (!(await relancerFiche(pieceId))) return { ok: false, error: "Cette pièce n'est pas dans la bibliothèque, ou déjà en file." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Bibliothèque", entityId: pieceId, summary: "Pièce remise en file de lecture" });
  revalidatePath(CHEMIN);
  return { ok: true, message: "Remise en file : elle sera relue au prochain passage." };
}
