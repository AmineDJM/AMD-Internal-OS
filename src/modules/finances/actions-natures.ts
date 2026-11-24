"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { annulable } from "@/lib/effets/ecran";
import {
  estRegimeRetenue, isClosed, LIBELLE_REGIME_RETENUE, libelleNatureDepense, lireTauxSaisi, lireTauxRetenue, refusNatureDemande,
} from "@/modules/finances/api";
import { isRequester, revalidate, trace } from "./infra/demandes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA NATURE DE LA DÉPENSE ET LES TAUX DE RETENUE À LA SOURCE (Super Admin, 24/11/2026).
 *
 *   • `choisirNatureDemande` — la nature d'une demande qui n'a pas encore d'ordre (le brouillon d'avant la règle, qui ne
 *     se transmet plus sans elle). Une fois l'ordre né, la nature ne bouge plus ici : la rubrique, la ligne et la retenue
 *     ont été posées sur l'ordre que le centre a sous les yeux.
 *   • `reglerTauxRetenue` — le Super Admin règle le taux d'un régime de retenue, et dit s'il est CONFIRMÉ par le cabinet.
 *     Le taux s'applique aux ordres qui naissent ensuite ; un ordre déjà né garde le sien (figé sur sa retenue prévue).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le demandeur choisit la nature d'une demande sans ordre (brouillon, ou dossier d'avant la règle). */
export async function choisirNatureDemande(formData: FormData): Promise<ActionResult> { return annulable("finances-natures:choisirNatureDemande", "Choisir la nature d'une demande de paiement", async () => {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.paymentRequest.findUnique({ where: { id }, select: { id: true, reference: true, requesterId: true, status: true, entityType: true, expenseOrderId: true, natureDepense: true } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!isRequester(user, req)) return { ok: false, error: "Seul le demandeur choisit la nature de sa demande." };
  if (isClosed(req.status)) return { ok: false, error: "Ce dossier est clos." };
  if (req.expenseOrderId) return { ok: false, error: "Le paiement est déjà au centre de paiement : sa nature ne se change plus. Retirez la demande et refaites-la si elle est fausse." };
  const nature = fdStr(formData, "natureDepense");
  const refus = refusNatureDemande(nature, req.entityType);
  if (refus) return { ok: false, error: refus };
  if (nature === req.natureDepense) return { ok: true, id, message: "Rien n'a changé." };

  // Conditionnelle sur ce qui a été lu (§118.151) : un ordre né entre-temps fige la nature.
  const ecrit = await prisma.paymentRequest.updateMany({ where: { id, expenseOrderId: null, natureDepense: req.natureDepense }, data: { natureDepense: nature } });
  if (ecrit.count === 0) return { ok: false, error: "Ce dossier vient de changer (transmis ou modifié) : rechargez la page." };
  const phrase = `Nature de la dépense : ${libelleNatureDepense(nature)}${req.natureDepense ? ` (avant : ${libelleNatureDepense(req.natureDepense)})` : ""}.`;
  await trace(id, user.id, "COMMENT", phrase);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Demandes de paiement", entityType: "PAYMENT_REQUEST", entityId: id,
    field: "natureDepense", oldValue: req.natureDepense, newValue: nature, summary: `${req.reference} — ${phrase}`,
  });
  revalidate(id);
  return { ok: true, id, message: phrase };
}); }

/** Le Super Admin règle le taux d'un régime de retenue à la source (et s'il est confirmé par le cabinet). */
export async function reglerTauxRetenue(formData: FormData): Promise<ActionResult> { return annulable("finances-natures:reglerTauxRetenue", "Régler un taux de retenue à la source", async () => {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin (Administration › Réglages & diffusion)." };
  const regime = fdStr(formData, "regime");
  if (!estRegimeRetenue(regime)) return { ok: false, error: "Régime de retenue inconnu." };
  const lu = lireTauxSaisi(fdStr(formData, "taux"));
  if (!lu.ok) return { ok: false, error: lu.error };
  const confirme = ["on", "1", "true"].includes(fdStr(formData, "confirmeParCabinet") ?? "");

  const avant = (await lireTauxRetenue())[regime];
  if (avant.taux === lu.taux && avant.confirmeParCabinet === confirme) return { ok: true, message: "Rien n'a changé." };
  await prisma.tauxRetenueSource.upsert({
    where: { regime },
    create: { regime, taux: lu.taux, confirmeParCabinet: confirme, updatedById: user.id },
    update: { taux: lu.taux, confirmeParCabinet: confirme, updatedById: user.id },
  });
  const libelle = LIBELLE_REGIME_RETENUE[regime];
  const etat = (t: number, c: boolean) => `${t.toLocaleString("fr-FR")} %${c ? " (confirmé par le cabinet)" : " (à confirmer par le cabinet)"}`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", field: `tauxRetenueSource.${regime}`,
    oldValue: etat(avant.taux, avant.confirmeParCabinet), newValue: etat(lu.taux, confirme),
    summary: `Retenue à la source — ${libelle} : ${etat(avant.taux, avant.confirmeParCabinet)} → ${etat(lu.taux, confirme)}`,
  });
  revalidatePath("/admin/settings");
  revalidatePath("/validations/paiements");
  return { ok: true, message: `${libelle} : ${etat(lu.taux, confirme)} — s'applique aux paiements demandés à partir de maintenant.` };
}); }
