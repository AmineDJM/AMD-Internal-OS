"use server";

import type { EntityType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { montantPourLeVisa, seuilAdProEnVigueur, demandeurDuVisa, peutResoumettreAuCentre, demandeAttendLeCentre } from "@/modules/ad-pro/api";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import { siegeAuCentreAdPro, REFUS_CENTRE_AD_PRO, AD_PRO_ENTITY_TYPE, AD_PRO_KINDS, type AdProKind } from "@/modules/ad-pro/partage";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { signalerSiASigner } from "@/lib/bons-de-commande/etat";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCISION DU CENTRE DE VALIDATION AD & PRO — sur les natures qui passent par un VISA.
 *
 * Les cinq natures qui portent une étape de circuit se décident par l'action de LEUR circuit,
 * depuis leur fiche : le centre les liste et y renvoie. Ce n'est pas une facilité, c'est la
 * règle §104.7 — arbitrer 1,2 M DZD depuis une ligne de liste, sans les pièces, sans la
 * catégorie budgétaire, sans le fil des avis, c'est valider en regardant autre chose. Le centre
 * dit CE QUI attend et POURQUOI ; la décision se prend devant le dossier.
 *
 * Ici on tranche le VISA, et lui seul : pour le consulting et les « autres demandes », le visa
 * EST la porte — il n'y a pas d'étape de circuit à franchir ailleurs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** entityType → nature, dérivé du registre canonique (une table à la main divergerait, §118.73). */
const NATURE_PAR_ENTITE = new Map<string, AdProKind>(
  (Object.entries(AD_PRO_ENTITY_TYPE) as [AdProKind, EntityType][]).map(([k, e]) => [e, k]),
);
const HREF = new Map<AdProKind, string>(AD_PRO_KINDS.map((k) => [k.kind, k.href]));

export async function deciderVisaCentreAdPro(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!siegeAuCentreAdPro(user)) return { ok: false, error: REFUS_CENTRE_AD_PRO };

    const entityType = fdStr(formData, "entityType") as EntityType | "";
    const entityId = fdStr(formData, "entityId");
    const note = fdStr(formData, "note");
    if (!entityType || !entityId) return { ok: false, error: "Demande introuvable." };
    // TROIS ISSUES (audit 360°, R07/R10) : valider, RENVOYER pour correction, refuser. `approve`
    // reste lu pour les appelants d'avant (l'opération d'Adam, en pause) : 1 valide, sinon refuse.
    const brute = fdStr(formData, "decision");
    const decision = brute === "VALIDER" ? "APPROVED"
      : brute === "RENVOYER" ? "CHANGES_REQUESTED"
        : brute === "REFUSER" ? "REFUSED"
          : brute === null ? (fdStr(formData, "approve") === "1" ? "APPROVED" : "REFUSED")
            : null;
    if (!decision) return { ok: false, error: "Décision inconnue." };
    const approuve = decision === "APPROVED";
    const renvoi = decision === "CHANGES_REQUESTED";

    const visa = await prisma.adProGateVisa.findUnique({
      where: { entityType_entityId: { entityType: entityType as EntityType, entityId } },
    });
    if (!visa) return { ok: false, error: "Cette demande n'attend pas l'arbitrage du centre." };
    // Une décision déjà prise ne se rejoue pas : un second clic ne doit pas transformer un refus
    // en accord, et deux arbitrages sur le même dossier n'ont aucune façon de se départager.
    if (visa.status !== "PENDING") {
      return { ok: false, error: "Cette demande a déjà été tranchée par le centre." };
    }
    // UNE DEMANDE MORTE NE SE TRANCHE PAS (audit 360°, lot C3) : un contrat annulé pendant qu'il
    // attendait le centre n'a plus rien à faire arbitrer — la lentille ne le montre plus, et une
    // requête forgée n'y gagnerait qu'une notification pour rien.
    if (!(await demandeAttendLeCentre(entityType as EntityType, entityId))) {
      return { ok: false, error: "Cette demande n'attend plus de décision (close, annulée ou passée aux RH) : il n'y a plus rien à arbitrer." };
    }
    // UN REFUS OU UN RENVOI SANS MOTIF EST UNE IMPASSE pour le demandeur : il apprend que c'est non,
    // ou qu'il faut corriger, et n'a rien à quoi se tenir. L'accord, lui, n'a rien à expliquer.
    if (!approuve && !note) {
      return { ok: false, error: renvoi
        ? "Indiquez ce qu'il faut corriger : sans cela, le demandeur ne sait pas quoi changer avant de resoumettre."
        : "Indiquez le motif du refus : sans lui, le demandeur ne sait pas quoi corriger." };
    }

    // CONDITIONNELLE (audit 360°, lot C3) : deux sièges qui tranchent à la même seconde lisaient tous
    // deux « en attente » ; le second écrasait le premier — un refus pouvait devenir un accord sans que
    // personne l'ait vu. Seule l'écriture qui trouve encore le visa en attente compte.
    const ecrite = await prisma.adProGateVisa.updateMany({
      where: { id: visa.id, status: "PENDING" },
      data: { status: decision, decidedById: user.id, decidedAt: new Date(), note },
    });
    if (ecrite.count === 0) {
      return { ok: false, error: "Cette demande vient d'être tranchée par un autre siège du centre : rouvrez le centre pour voir sa décision." };
    }

    // UN BON DE COMMANDE (§118.148) passe par le même visa et la même action : sa ligne vit dans
    // le registre Legal, et c'est là que le demandeur retrouve la décision.
    const estBC = entityType === "LEGAL_DOCUMENT";
    const kind = NATURE_PAR_ENTITE.get(entityType);
    const lien = estBC ? `/legal/${entityId}` : kind ? `${HREF.get(kind) ?? "/ad-pro"}/${entityId}` : "/ad-pro";
    const montant = visa.amount == null ? "montant non renseigné" : `${Number(visa.amount).toLocaleString("fr-FR")} DZD`;
    const verbe = approuve ? (estBC ? "VALIDÉ" : "AUTORISÉE au-delà du seuil") : renvoi ? (estBC ? "RENVOYÉ pour correction" : "RENVOYÉE pour correction") : (estBC ? "REFUSÉ" : "REFUSÉE au-delà du seuil");

    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Centre de validation Ad & Pro",
      entityType: entityType as EntityType, entityId,
      summary: `Centre Ad & Pro : ${estBC ? "bon de commande" : "demande"} ${verbe} (${montant})${note ? ` — ${note}` : ""}`,
    });

    // LE DEMANDEUR EST PRÉVENU — sans quoi son dossier repart ou s'arrête sans qu'il sache
    // pourquoi. `requesterId` se relit sur la nature : le visa ne le porte pas, et l'y recopier
    // ferait une seconde vérité sur qui a demandé (§118.5).
    const demandeur = await demandeurDuVisa(entityType as EntityType, entityId);
    if (demandeur) {
      const objet = estBC ? "votre bon de commande" : "votre demande";
      await notifyUser({
        userId: demandeur,
        // `SPONSORING_VALIDATION` est le type du vocabulaire canonique qui désigne une décision
        // Ad & Pro (l'enum ne porte pas d'APPROVED/REJECTED distincts, et en ajouter deux pour
        // une nuance que le TITRE porte déjà serait une migration d'enum pour rien).
        type: "SPONSORING_VALIDATION",
        title: approuve
          ? `Centre Ad & Pro : ${objet} est ${estBC ? "validé" : "autorisée"}`
          : renvoi ? `Centre Ad & Pro : ${objet} est à corriger` : `Centre Ad & Pro : ${objet} est ${estBC ? "refusé" : "refusée"}`,
        body: approuve
          ? (estBC
            ? `Validé : il passe à la signature des Finances (${MENU_BONS_DE_COMMANDE}). Il pourra partir chez le fournisseur une fois signé.`
            : "Le centre de validation a autorisé le dépassement du seuil. Le circuit reprend son cours.")
          : renvoi
            ? (estBC
              ? `À corriger : ${note}. Modifiez le bon de commande dans Legal — sa modification le renvoie au centre.`
              : `À corriger : ${note}. Sur sa fiche, « Resoumettre au centre » : dites ce qui change et, s'il le faut, corrigez le montant.`)
            : `Motif : ${note}`,
        link: lien,
      });
    }

    // UN BC VALIDÉ PASSE À LA SIGNATURE DES FINANCES (§118.149) : elles en sont prévenues.
    if (estBC && approuve) {
      await signalerSiASigner(entityId).catch(sansBloquer("ad-pro-centre-actions.deciderVisaCentreAdPro.signalerSiASigner"));
      revalidatePath(CHEMIN_BC_A_SIGNER);
    }

    revalidatePath("/centre-ad-pro");
    revalidatePath(lien);
    return { ok: true, id: entityId };
  } catch (err) {
    console.error("[centre-ad-pro] deciderVisaCentreAdPro failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/**
 * RÉEXAMINER UN REFUS — par un siège du centre, motif à l'appui (audit 360°, R07).
 *
 * `poserVisaAdPro` annonçait « c'est au centre de la revoir » et rien ne le permettait : un visa
 * refusé était une impasse définitive. Tant que rien n'a quitté l'ERP, une décision terminale se
 * ROUVRE par un geste motivé (la règle commune des circuits) : le visa repasse en attente, la
 * décision d'hier reste au journal, et le demandeur est prévenu.
 */
export async function reexaminerVisaCentreAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!siegeAuCentreAdPro(user)) return { ok: false, error: REFUS_CENTRE_AD_PRO };
  const entityType = fdStr(formData, "entityType") as EntityType | "";
  const entityId = fdStr(formData, "entityId");
  const note = fdStr(formData, "note");
  if (!entityType || !entityId) return { ok: false, error: "Demande introuvable." };
  if (!note) return { ok: false, error: "Dites pourquoi le centre réexamine : la décision d'hier reste au journal, la raison de la reprise aussi." };
  // CE QUE « RÉEXAMINER » REND ATTEIGNABLE (§118.80) : sans cette garde, un refus réexaminé sur une
  // demande annulée la ferait revenir dans la file du centre, pour une demande que plus personne ne porte.
  if (!(await demandeAttendLeCentre(entityType as EntityType, entityId))) {
    return { ok: false, error: "Cette demande n'attend plus de décision (close, annulée ou passée aux RH) : il n'y a plus rien à réexaminer." };
  }
  const r = await prisma.adProGateVisa.updateMany({
    where: { entityType: entityType as EntityType, entityId, status: "REFUSED" },
    data: { status: "PENDING", decidedById: null, decidedAt: null, note: `Réexamen : ${note}` },
  });
  if (r.count === 0) return { ok: false, error: "Seul un refus du centre se réexamine — celui-ci a déjà changé." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Centre de validation Ad & Pro", entityType: entityType as EntityType, entityId,
    summary: `Centre Ad & Pro : refus RÉEXAMINÉ — la demande repasse en attente (${note})`,
  });
  const demandeur = await demandeurDuVisa(entityType as EntityType, entityId);
  if (demandeur && demandeur !== user.id) {
    await notifyUser({
      userId: demandeur, type: "SPONSORING_VALIDATION",
      title: "Centre Ad & Pro : votre demande est réexaminée",
      body: `Le centre reprend sa décision : ${note}. Vous serez prévenu de la nouvelle décision.`,
      link: lienDe(entityType as EntityType, entityId),
    }).catch(sansBloquer("ad-pro-centre-actions.reexaminerVisaCentreAdPro.notifyUser"));
  }
  revalidatePath("/centre-ad-pro");
  revalidatePath(lienDe(entityType as EntityType, entityId));
  return { ok: true, id: entityId, message: "La demande repasse en attente au centre." };
}

/**
 * RESOUMETTRE AU CENTRE une demande renvoyée pour correction (audit 360°, R07/R10) — consulting et
 * « autres demandes », dont le visa EST la porte. Le demandeur (ou qui peut modifier la fiche) dit
 * ce qu'il a corrigé ; le centre la revoit avec le montant RELU sur la fiche. Corrigée sous le seuil,
 * la porte n'a plus d'objet : elle est retirée, et la demande poursuit son circuit (la même règle
 * que `poserVisaAdPro` à la soumission).
 *
 * LA CORRECTION SE FAIT ICI. Ces deux natures n'ont pas d'écran d'édition (le contrat de consulting
 * en recevra un au lot C4, R11) : sans ce champ, « corrigez puis resoumettez » aurait nommé un geste
 * impossible (§118.128), et la seule correction que le centre demande vraiment — le MONTANT, puisque
 * c'est le montant qui l'a saisi — n'aurait eu aucun chemin. Vide ou absent, le montant reste ce qu'il
 * était : une correction n'efface pas une rémunération convenue.
 *
 * Seule une demande qui ATTEND encore sa décision se resoumet : un contrat annulé pendant qu'il était
 * « à corriger » n'a plus rien à faire arbitrer. Le visa et la fiche s'écrivent dans la MÊME
 * transaction : si la fiche a changé d'état entre-temps, rien n'est écrit — ni le montant, ni le visa.
 *
 * Un BON DE COMMANDE renvoyé ne passe pas par ici : il se lève en MODIFIANT le BC dans Legal, et sa
 * modification le renvoie au centre (`gesteAiguillage`, cas A_REVOIR) — le resoumettre sans le
 * corriger contournerait ce que le centre a demandé.
 */
export async function resoumettreAuCentreAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") as EntityType | "";
  const entityId = fdStr(formData, "entityId");
  const note = fdStr(formData, "note");
  if (!entityType || !entityId) return { ok: false, error: "Demande introuvable." };
  if (entityType !== "CONSULTING_CONTRACT" && entityType !== "AD_PRO_OTHER") {
    return { ok: false, error: "Un bon de commande renvoyé se corrige dans Legal : sa modification le renvoie au centre." };
  }
  if (!note) return { ok: false, error: "Dites ce que vous avez corrigé : c'est ce que le centre lira en premier." };
  const montantSaisi = formData.has("amount") ? fdNum(formData, "amount") : null;
  if (montantSaisi !== null && !(montantSaisi > 0)) return { ok: false, error: "Le montant corrigé doit être un nombre positif." };
  if (!(await peutResoumettreAuCentre(user, entityType, entityId))) {
    return { ok: false, error: "Seul le demandeur — ou qui peut modifier la fiche — resoumet cette demande au centre." };
  }
  const visa = await prisma.adProGateVisa.findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { id: true, status: true, note: true } });
  if (!visa || visa.status !== "CHANGES_REQUESTED") {
    return { ok: false, error: "Cette demande n'est pas à corriger pour le centre." };
  }
  const montantAvant = await montantPourLeVisa(entityType, entityId);
  const montant = montantSaisi ?? montantAvant;
  const seuil = await seuilAdProEnVigueur();
  const garde = porteDgRequise(montant, seuil);
  const lisible = (m: number | null) => (m == null ? "non renseigné" : `${m.toLocaleString("fr-FR")} DZD`);
  const historique = [
    `Corrigée par le demandeur : « ${note} » (renvoyée pour : « ${visa.note ?? "sans motif"} »).`,
    montantSaisi !== null && montantSaisi !== montantAvant ? `Montant : ${lisible(montantAvant)} → ${lisible(montantSaisi)}.` : null,
  ].filter(Boolean).join(" ");

  // UNE TRANSACTION, deux écritures conditionnelles. La fiche n'est touchée que si elle attend encore
  // sa décision ; sinon on annule TOUT, visa compris (le lancer d'une erreur fait reculer la transaction).
  let issue: "OK" | "VISA_CHANGE" | "FICHE_CLOSE";
  try {
    issue = await prisma.$transaction(async (tx) => {
      const v = garde
        ? await tx.adProGateVisa.updateMany({
            where: { id: visa.id, status: "CHANGES_REQUESTED" },
            data: { status: "PENDING", decidedById: null, decidedAt: null, note: historique, amount: montant != null && montant > 0 ? montant : null },
          })
        // Corrigée SOUS le seuil : la porte n'a plus d'objet — on la retire, sous la même condition.
        : await tx.adProGateVisa.deleteMany({ where: { id: visa.id, status: "CHANGES_REQUESTED" } });
      if (v.count === 0) return "VISA_CHANGE" as const;
      const data = { updatedById: user.id, ...(montantSaisi !== null ? { amount: montantSaisi } : {}) };
      const f = entityType === "CONSULTING_CONTRACT"
        ? await tx.consultingContract.updateMany({ where: { id: entityId, status: "AWAITING_VALIDATION" }, data })
        : await tx.adProOtherRequest.updateMany({ where: { id: entityId, status: "AWAITING_DECISION" }, data });
      if (f.count === 0) throw new FicheClose();
      return "OK" as const;
    });
  } catch (e) {
    if (!(e instanceof FicheClose)) throw e;
    issue = "FICHE_CLOSE";
  }
  if (issue === "VISA_CHANGE") return { ok: false, error: "Cette demande vient de changer : rouvrez-la pour voir où elle en est." };
  if (issue === "FICHE_CLOSE") return { ok: false, error: "Cette demande n'attend plus de décision : il n'y a plus rien à faire arbitrer au centre." };

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Centre de validation Ad & Pro", entityType, entityId,
    summary: garde ? `Resoumise au centre après correction. ${historique}` : `Resoumise sous le seuil — la porte du centre est retirée. ${historique}`,
  });
  revalidatePath("/centre-ad-pro");
  revalidatePath(lienDe(entityType, entityId));
  if (!garde) {
    return { ok: true, id: entityId, message: "Corrigée sous le seuil : elle ne passe plus par le centre et poursuit son circuit." };
  }
  await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro : demande resoumise après correction",
    body: historique, link: lienLigneCentreAdPro(entityId),
  }).catch(sansBloquer("ad-pro-centre-actions.resoumettreAuCentreAdPro.notifyRoles"));
  return { ok: true, id: entityId, message: "Resoumise au centre : elle sera revue avec sa correction." };
}

/** La fiche a quitté son attente de décision pendant la resoumission : on recule tout. */
class FicheClose extends Error {}

function lienDe(entityType: EntityType, entityId: string): string {
  if (entityType === "LEGAL_DOCUMENT") return `/legal/${entityId}`;
  const kind = NATURE_PAR_ENTITE.get(entityType);
  return kind ? `${HREF.get(kind) ?? "/ad-pro"}/${entityId}` : "/ad-pro";
}
