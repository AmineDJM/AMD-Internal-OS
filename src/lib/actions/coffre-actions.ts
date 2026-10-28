"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getAppSettings } from "@/lib/settings";
import { chargerCles, ErreurCleCoffre } from "@/lib/coffre/cle";
import type { ActionResult } from "@/lib/actions/types";

/**
 * LES INTERRUPTEURS DU COFFRE (refonte V2-E) — Super Admin seul, chaque bascule auditée.
 *
 *  - `coffreEcriture` : chaque écriture d'une colonne sensible écrit aussi sa copie chiffrée. Ne s'ouvre
 *    que si la clé `COFFRE_KEY` se charge (en production, pas de clé de développement).
 *  - `coffreLecture` : écrans, exports et pièces lisent par le coffre, avec journal. Ne s'ouvre que si
 *    l'écriture double l'est déjà — sinon les copies divergeraient des colonnes dès la première saisie.
 *    Fermer l'écriture referme donc aussi la lecture.
 *
 * Revenir en arrière = refermer : les colonnes en clair n'ont jamais cessé d'être écrites.
 */

const CHEMINS = ["/admin/refonte-donnees", "/admin/acces-donnees-sensibles"];

export async function basculerCoffre(bascule: "coffreEcriture" | "coffreLecture", actif: boolean): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  if (bascule !== "coffreEcriture" && bascule !== "coffreLecture") return { ok: false, error: "Interrupteur inconnu." };

  if (actif) {
    try {
      chargerCles();
    } catch (e) {
      if (e instanceof ErreurCleCoffre) return { ok: false, error: e.message };
      throw e;
    }
    if (bascule === "coffreLecture" && !(await getAppSettings()).coffreEcriture) {
      return { ok: false, error: "Ouvrir d'abord la double écriture, puis rejouer la reprise « coffre » jusqu'au bout." };
    }
  }
  const data = bascule === "coffreEcriture" && !actif ? { coffreEcriture: false, coffreLecture: false } : { [bascule]: actif };
  await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", ...data, updatedById: user.id }, update: { ...data, updatedById: user.id } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Refonte des données", field: bascule,
    newValue: String(actif),
    summary: `Coffre — ${bascule === "coffreEcriture" ? "double écriture" : "double lecture"} ${actif ? "OUVERTE" : "FERMÉE"}${data.coffreLecture === false && bascule === "coffreEcriture" ? " (et la double lecture avec)" : ""}`,
  });
  for (const c of CHEMINS) revalidatePath(c);
  return { ok: true, message: `Interrupteur ${actif ? "ouvert" : "fermé"}.` };
}
