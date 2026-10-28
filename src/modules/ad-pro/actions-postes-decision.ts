"use server";

import { deposerLettreDevis, phraseDepotLettre, societeDeLaLettre } from "@/lib/demande-devis-depot";
import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { revalidatePath } from "next/cache";
import type { AdProItemOrderStage, AdProItemStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { ITEM_KIND_LABELS, REFUS_INDIRECT_NON_REPARTI, type AdProParent, lireRepartition, ecrireRepartition, STATUTS_EDITABLES, gesteVisaPoste, tempsEnAttente, opsFranchiALaSoumission, libelleTemps } from "@/modules/ad-pro/partage";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { annulerDemandesPiecesDuPoste, annulerBcNonSigne, bcEtablisDuPoste, bcVivantsDesPostes, refusAnnulationBcDuPoste, refusBcEtabli, refusCategoriePourLaDemande } from "@/modules/ad-pro/api";
import { getAppSettings } from "@/lib/settings";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { rendreAuMagasin, reserverPourEvenement, sousVerrous, type Tx } from "@/lib/promo/stock-ecriture";
import { refusArgentSurPosteStock, refusReservation } from "@/lib/promo/reservations";
import { saisieEffective, type ReferenceProchaine } from "@/lib/references/registre";
import { etatDuRegistre } from "@/lib/references/registre-serveur";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { sansBloquer } from "@/lib/journal";
import { PARENTS, revalidate, canEditItems, canAllocate, demandeurDe, peutTrancherSur, prevenirLeTemps, audit, refusSiClos, reprojeterMontantDemande, loadItem, REFUS_HISTORIQUE, etatBcDe, FINANCES_BC, appliquerGesteVisa, cloreDemandesAuBureau, resumeRepartition, postesRepartis, recordDecision, envoyerDemandeBC, libellesArticles, signalerAuSujet } from "./infra/postes/commun";

/**
 * POSTES AD & PRO — DÉCIDER, RÉPARTIR, CORRIGER : la décision de la Direction sur un poste, la répartition d'un
 * sponsoring indirect (§118.175), la lettre de demande de devis, et la correction du bon de commande d'un poste
 * (retirer ou modifier la demande, annuler l'ordre, demander la révision — §118.187).
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

/**
 * CLORE LES DEMANDES OUVERTES AU SECRÉTARIAT pour ce poste (audit 360°, R10) — devis, facture, « BC à
 * établir ». Elles survivaient au poste refusé, et à la demande de BC retirée : l'assistante continuait
 * de chercher un devis pour une dépense qui n'existait plus. (Un poste RETIRÉ, lui, les emporte dans
 * son lot de corbeille et les rend avec lui : les clore d'abord ferait revenir un poste dont la demande
 * de BC vit encore, avec un « BC à établir » annulé.) Chaque demande close porte son
 * motif dans sa discussion, et la personne qui la tenait est prévenue (à défaut, le bureau). Écriture
 * CONDITIONNELLE : une demande terminée entre-temps n'est pas rouverte en « annulée ».
 */
async function cloreDemandesSecretariat(
  itemId: string, motif: string, user: SessionUser, portee: "TOUTES" | "BC_A_ETABLIR",
): Promise<number> {
  const { closes } = await cloreDemandesAuBureau(itemId, motif, user, portee);
  // LA DEMANDE DE PIÈCE ENVOYÉE À L'ASSISTANTE (§118.204) suit le même sort : sans cela, elle déposerait
  // un BC pour un poste refusé ou une demande retirée. Elle est prévenue, motif à l'appui.
  const pieces = await annulerDemandesPiecesDuPoste(itemId, portee === "BC_A_ETABLIR" ? "BC" : "TOUTES");
  for (const p of pieces) {
    await notifyUser({ userId: p.askedToId, type: "GENERIC", title: "Demande de pièce annulée", body: motif, link: `/pieces/${p.id}` }).catch(sansBloquer("ad-pro-item-actions.cloreDemandesSecretariat.notifyUser"));
  }
  if (pieces.length > 0) revalidatePath("/pieces");
  return closes + pieces.length;
}

/** « 2 demandes au secrétariat closes » — la phrase, une fois ; rien quand il n'y en avait pas. */
function phraseDemandesCloses(n: number): string {
  return n === 0 ? "" : ` ${n} demande${n > 1 ? "s" : ""} à l'assistante de direction ${n > 1 ? "closes" : "close"}, elle est prévenue.`;
}

/**
 * RÉPARTIR PAR NATURE le poste « sponsoring indirect » créé avec la demande (§118.175).
 *
 * Tant qu'il n'est ni soumis ni accordé : la Direction ne s'est pas encore prononcée sur sa forme.
 * Une fois soumis, le répartir changerait sous ses yeux ce qu'elle est en train de décider. Et rien
 * ne se répartit quand un bon de commande ou un ordre de dépense est déjà parti : l'argent engagé
 * l'a été sur ce poste-là, tel qu'il était.
 */
export async function repartirPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.kind !== "INDIRECT_SUPPORT") return { ok: false, error: "Seul un sponsoring indirect se répartit par nature." };
  if (!STATUTS_EDITABLES.includes(item.status)) {
    return { ok: false, error: "Ce poste est déjà soumis ou accordé : sa forme ne change plus — la Direction s'est prononcée (ou se prononce) sur lui tel qu'il est." };
  }
  if (item.expenseOrderId || item.orderStage !== "NONE") {
    return { ok: false, error: "Un bon de commande ou un ordre de dépense est déjà parti sur ce poste : il ne se répartit plus." };
  }

  const lue = lireRepartition(fdStr(formData, "repartition"));
  if (!lue.ok) return { ok: false, error: lue.error };

  const avant = await prisma.adProItem.findUnique({ where: { id }, select: { label: true, notes: true, budgetKind: true, addedAfterDecision: true } });
  if (!avant) return { ok: false, error: "Poste introuvable." };
  try {
    await prisma.$transaction((tx) => ecrireRepartition(tx, {
      rattachement: { [PARENTS[owner.parent].column]: owner.id }, lignes: postesRepartis(lue.lignes), premierId: id, userId: user.id,
      base: { label: avant.label, notes: avant.notes, budgetKind: avant.budgetKind, addedAfterDecision: avant.addedAfterDecision },
    }));
  } catch (err) {
    console.error("[ad-pro-item] répartition impossible", err);
    return { ok: false, error: "La répartition n'a pas pu être enregistrée : rien n'a changé. Réessayez dans un instant." };
  }
  const estime = item.amountEstimated != null ? toNumber(item.amountEstimated) : null;
  // L'ÉCART SE DIT, il ne se refuse pas : le délégué peut avoir ajusté en répartissant. Le taire
  // laisserait croire que le total n'a pas bougé.
  const ecart = estime != null && Math.round(estime * 100) !== Math.round(lue.total * 100)
    ? ` Le poste d'origine portait ${estime.toLocaleString("fr-FR")} DZD.`
    : "";
  await audit(user, owner.parent, owner.id, "UPDATE",
    `« ${avant.label} » réparti en ${lue.lignes.length} poste(s) — ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.${ecart}`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Réparti en ${lue.lignes.length} poste(s) : ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.${ecart}` };
}

/**
 * DÉCISION de la Direction sur UN poste : accorder, refuser, ou demander à revoir le budget.
 * La révision n'est pas une fin : elle rend la main au demandeur, qui corrige et resoumet — le
 * va-et-vient peut se répéter, chaque tour restant dans l'historique.
 */
export async function decideAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || !decision) return { ok: false, error: "Décision incomplète." };
  if (!["APPROVED", "REJECTED", "REVISION"].includes(decision)) return { ok: false, error: "Décision inconnue." };

  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // QUI TRANCHE (27/10/2026) : un poste d'ARGENT est accepté par la Direction Marketing, qui fixe le
  // montant et choisit le budget — un seul temps. Le matériel du stock garde sa décision unique (il
  // n'engage pas d'argent, §118.167).
  const argent = item.kind !== "STOCK_MATERIAL";
  const droits = argent ? await peutTrancherSur(user, owner) : null;
  const temps = argent ? tempsEnAttente(item) : null;
  // Refuser un brouillon reste possible (une demande refusée fait le ménage de ses postes) : seul
  // l'ACCORD exige une soumission.
  if (argent && temps === null && decision === "APPROVED" && (item.status === "DRAFT" || item.status === "REVISION")) {
    return { ok: false, error: "Ce poste n'est pas soumis à la validation : le demandeur le soumet d'abord." };
  }
  if (!argent) {
    if (!canAllocate(user, owner.parent)) return { ok: false, error: "Seule la Direction décide d'un poste." };
  } else if (!droits!.marketing) {
    return {
      ok: false,
      error: temps === "MARKETING"
        ? `Ce poste attend la décision de ${libelleTemps("MARKETING", droits!.demandeur)}.`
        : `Seule ${libelleTemps("MARKETING", droits!.demandeur)} revoit la décision d'un poste.`,
    };
  }
  // Refuser ou renvoyer un poste d'une demande refusée reste possible : ces gestes ne paient rien.
  const clos = await refusSiClos(owner.parent, owner.id, { partir: decision === "APPROVED" });
  if (clos) return { ok: false, error: clos };
  // ÉMIS : la décision ne change plus — mais le refus nomme le geste qui la rouvre (§118.30) : l'ordre
  // s'annule tant qu'il n'est pas réglé, et la décision se revoit ensuite.
  if (item.status === "APPROVED" && (item.orderStage === "ISSUED" || item.expenseOrderId)) {
    return { ok: false, error: "Un ordre de dépense a été émis pour ce poste : annulez-le d'abord (« Annuler l'ordre émis »), puis revoyez la décision." };
  }
  // UN SPONSORING INDIRECT NON RÉPARTI NE S'ACCORDE PAS (§118.175). L'accorder d'un seul tenant
  // ouvrirait UN bon de commande, à UN fournisseur, pour l'imprimerie ET l'hôtellerie — exactement
  // ce que la répartition existe pour empêcher. Le refuser ou le renvoyer en révision reste
  // possible : ces gestes ne paient rien, et la révision est le chemin qui rouvre la répartition.
  if (item.kind === "INDIRECT_SUPPORT" && decision === "APPROVED") return { ok: false, error: REFUS_INDIRECT_NON_REPARTI };

  const note = fdStr(formData, "note");
  // UN REFUS OU UN RENVOI SANS MOTIF EST UNE IMPASSE (audit 360°, R24–R36) : le demandeur ne sait pas
  // quoi corriger. `=== null` et non `!note` : la dérivation des contrats lit `if (!v)` comme « champ
  // OBLIGATOIRE » pour toute l'action, et l'accord sans note deviendrait inappelable (§118.138).
  if (decision !== "APPROVED" && note === null) {
    return { ok: false, error: "Indiquez le motif : sans lui, le demandeur ne sait pas quoi corriger." };
  }
  // En accordant, la Direction peut arrêter le montant du poste (c'est le geste naturel :
  // « d'accord, mais pour 120 000 »). Sans montant saisi, l'estimation fait foi.
  const granted = fdNum(formData, "amountGranted");
  if (granted != null && granted < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const status = decision as AdProItemStatus;

  // ── ACCORD DE LA DIRECTION MARKETING : le BUDGET est exigé (« elle sélectionne le budget »). Le choisir plus
  // tard était un geste à part qu'on oubliait : le poste restait accordé et impayable.
  let budgetCategoryId: string | null = item.budgetCategoryId;
  if (argent && status === "APPROVED") {
    const choisi = fdStr(formData, "budgetCategoryId");
    budgetCategoryId = choisi ?? item.budgetCategoryId;
    if (!budgetCategoryId) return { ok: false, error: "Choisissez le budget qui portera ce poste : la validation de la Direction Marketing le fixe en même temps que le montant." };
    // LA CATÉGORIE CONVIENT À LA DEMANDE (point 9, 27/10) : sa nature, son exercice, sa Business Unit.
    if (choisi) {
      const refusCat = await refusCategoriePourLaDemande(choisi, owner.parent, owner.id);
      if (refusCat) return { ok: false, error: refusCat };
    }
  }

  // REVOIR UNE DÉCISION QUI AVAIT OUVERT UN BON DE COMMANDE (§118.187, audit R05/R12). Le poste quitte
  // l'accord : sa demande de BC — en attente au centre, ou visée — n'a plus d'objet et se retire avec
  // la décision. Sauf si un BC a DÉJÀ été établi dans Legal : il lit sa validation sur ce poste, et
  // le retirer le laisserait sans porte ; le refus le nomme.
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  const quitteLAccord = item.status === "APPROVED" && status !== "APPROVED";
  if (quitteLAccord && bcEnCours) {
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: refusBcEtabli(bcs, "revoyez la décision du poste") };
  }
  const montantAccorde = status === "APPROVED" && item.kind !== "STOCK_MATERIAL"
    ? (granted ?? (item.amountGranted != null ? toNumber(item.amountGranted) : null) ?? (item.amountEstimated != null ? toNumber(item.amountEstimated) : null))
    : null;
  if (argent && status === "APPROVED" && !(montantAccorde != null && montantAccorde > 0)) {
    return { ok: false, error: "Indiquez le montant accordé à ce poste." };
  }

  // `tx` et non un autre nom : la dérivation des contrats lit `prisma.X` et `tx.X` pour dire ce que
  // l'action écrit (§118.137) — un paramètre nommé autrement faisait disparaître le poste de la
  // carte de confirmation, et `id` ne désignait plus rien pour le chemin générique.
  //
  // CONDITIONNELLE (§118.187) : une émission qui passe entre la lecture et l'écriture ne se fait pas
  // défaire par une décision prise sur l'état d'avant — l'émission, elle, exige un poste accordé.
  const ecrireDecision = (tx: Tx | typeof prisma) => tx.adProItem.updateMany({
    // Le temps LU est exigé : une décision ne s'applique pas à un poste qui a changé de temps entre
    // la lecture et l'écriture (§118.204). Revoir une décision prise ne lit, lui, aucun temps.
    where: {
      id, expenseOrderId: null, orderStage: { not: "ISSUED" },
      ...(temps ? { status: "PENDING" as const } : {}),
    },
    data: {
      status,
      decidedAt: new Date(),
      decidedById: user.id,
      decisionNote: note,
      ...(status === "APPROVED" && item.kind !== "STOCK_MATERIAL" ? { amountGranted: montantAccorde, budgetCategoryId } : {}),
      ...(quitteLAccord && bcEnCours
        ? {
            orderStage: "NONE" as const, orderDirectionAt: null, orderDirectionById: null,
            // La note du centre s'efface : elle s'afficherait, sous un accord futur, comme une parole
            // du centre sur une demande qui n'existe plus. Le motif vit à l'historique et à l'audit.
            orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null,
          }
        : {}),
      updatedById: user.id,
    },
  });
  if (item.kind === "STOCK_MATERIAL") {
    // LE MATÉRIEL DU STOCK SE RÉSERVE À L'ACCORD (§118.167) — dans la MÊME transaction que la
    // décision : un poste « accordé » dont le matériel n'a pas pu être réservé promettrait au
    // demandeur des kakémonos que le magasin n'a pas. Un refus ou une révision rend au magasin ce
    // qu'un accord précédent avait réservé.
    const r = await deciderMaterielStock(id, status, user.id, ecrireDecision);
    if (!r.ok) return { ok: false, error: r.error };
  } else {
    const r = await ecrireDecision(prisma);
    if (r.count === 0) return { ok: false, error: "Ce poste vient de changer (ordre émis, ou décision déjà prise) : rouvrez la fiche." };
  }
  await recordDecision(id, status, note, granted ?? (item.amountGranted != null ? toNumber(item.amountGranted) : null), user.id);
  // LA DEMANDE SUIT : une rallonge accordée (ou retirée) change le montant de l'opération.
  await reprojeterMontantDemande(owner.parent, owner.id);

  const info = await PARENTS[owner.parent].load(owner.id);
  const label = status === "APPROVED" ? "accordé" : status === "REJECTED" ? "refusé" : "à revoir (budget)";
  // CE QUE LA DÉCISION EMPORTE (audit 360°, R10) — un poste refusé ne garde pas l'assistante au
  // travail sur ses devis et factures ; un poste qui quitte l'accord retire son « BC à établir ». Le
  // sujet de réservation d'une billetterie apprend la décision : c'est là que l'assistante réserve.
  let suite = "";
  if (status === "REJECTED") {
    suite += phraseDemandesCloses(await cloreDemandesSecretariat(id, `le poste « ${item.label} » a été refusé par la Direction — ${note}`, user, "TOUTES"));
  } else if (quitteLAccord && bcEnCours) {
    suite += phraseDemandesCloses(await cloreDemandesSecretariat(id, `la décision du poste « ${item.label} » a été revue — la demande de bon de commande est retirée`, user, "BC_A_ETABLIR"));
  }
  if (status !== "APPROVED" && item.reservationDossierId) {
    suite += await signalerAuSujet(item, user.id, `poste ${label} par la Direction${note ? ` (« ${note} »)` : ""} : la réservation attend la suite.`);
  }
  // UN ACCORD REDONNÉ À UN AUTRE MONTANT, BC en cours : le visa ne couvre que ce qu'il a vu.
  if (status === "APPROVED" && bcEnCours && montantAccorde != null) {
    const apres = { montant: montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info?.ref ?? null });
    if (phrase) suite += ` ${phrase}`;
  }
  if (info?.requesterId && info.requesterId !== user.id) {
    await notifyUser({
      userId: info.requesterId,
      type: "GENERIC",
      title: `Poste ${label}`,
      body: `${info.ref} — « ${item.label} »${note ? ` : ${note}` : ""}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro-item-actions.decideAdProItem.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » ${label}${note ? ` — ${note}` : ""}${quitteLAccord && bcEnCours ? " — demande de bon de commande retirée" : ""}.`);
  revalidate(owner.parent, owner.id);
  return suite ? { ok: true, id, message: `Poste ${label}.${suite}` } : { ok: true, id };
}

/**
 * GÉNÉRER LA LETTRE DE DEMANDE DE DEVIS D'UN POSTE (Direction, 07/10) — sans passer par le secrétariat : le demandeur
 * l'envoie lui-même à ses agences. Rédigée par Luna, sur le papier en-tête de la société de l'opération, en PDF et Word,
 * déposée sous l'étape « Demande de devis » du poste. La précision saisie (`note`) guide la rédaction.
 */
export async function genererDemandeDevisPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const note = fdStr(formData, "note");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un devis, un bon de commande ou une facture");
  if (refusStock) return { ok: false, error: refusStock };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const r = await deposerLettreDevis(user, [{ entityType: "AD_PRO_ITEM", entityId: item.id }], {
    titre: item.label, brief: null, reference: info.ref, societeId: info.companyId ?? null,
    // La référence NNN/DG/AAAA (registre commun) : préremplie avec le prochain numéro ; modifiée, elle est vérifiée puis attribuée.
    referenceChoisie: saisieEffective(fdStr(formData, "reference"), fdStr(formData, "referenceSuggeree")),
    articles: [{ designation: `${ITEM_KIND_LABELS[item.kind]} — ${item.label}`, quantite: null, unite: null, prestations: [], precision: note ?? null, produits: [] }],
  });
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de devis${r.referenceRegistre ? ` N° ${r.referenceRegistre}` : ""} générée pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, message: phraseDepotLettre(r) };
}

/**
 * LA RÉFÉRENCE QUE PORTERA LA LETTRE DE DEMANDE DE DEVIS D'UN POSTE (registre commun NNN/DG/AAAA, Direction 10/2026) — ce que
 * le champ « Référence » du formulaire préremplit : la société de l'opération (sinon celle du rédacteur, comme la lettre), si
 * elle tient le registre, et son prochain numéro — PRÉVU, rien n'est réservé. Lecture seule.
 */
export async function referenceDemandeDevisPoste(formData: FormData): Promise<ReferenceProchaine> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const info = await PARENTS[found.owner.parent].load(found.owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  return etatDuRegistre(await societeDeLaLettre(user, info.companyId ?? null));
}

// ───────────────────── Corriger le bon de commande d'un poste (§118.187, audit R06, R12) ─────────────────────

/** Un refus levé DANS une transaction pour l'annuler entière, rattrapé à sa sortie pour devenir une phrase. */
class RefusPoste extends Error {}

/** Qui touche à la demande de BC d'un poste : qui décrit les postes, ou qui les arbitre. */
function peutToucherDemandeBC(user: SessionUser, parent: AdProParent): boolean {
  return canEditItems(user, parent) || canAllocate(user, parent);
}

/**
 * RETIRER LA DEMANDE D'ÉMISSION DU BON DE COMMANDE — en attente au centre, ou visée, tant qu'aucun
 * ordre n'est parti. Une demande envoyée ne se retirait pas : la seule issue était de supprimer le
 * poste (audit R06). Le « BC à établir » de l'assistante se clôt avec elle, motif à l'appui.
 */
export async function retirerDemandeBC(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!peutToucherDemandeBC(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.orderStage === "ISSUED" || item.expenseOrderId) {
    return { ok: false, error: "Le bon de commande a déjà été émis : annulez l'ordre de dépense (« Annuler l'ordre émis ») tant qu'il n'est pas réglé." };
  }
  if (item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK") {
    return { ok: false, error: "Aucune demande de bon de commande n'est en cours sur ce poste." };
  }
  // UN GESTE UNIQUE (audit du 04/10, constat 36) : le BC établi par l'assistante mais NON signé n'engage
  // encore personne — il s'annule au registre AVEC la demande. Signé par les Finances, ou suivi d'une
  // facture, la demande est exécutée : le refus le nomme (la même règle que la carte, §118.83). Tout ce
  // qui refuse passe AVANT le motif (§118.18).
  const bcs = (await bcVivantsDesPostes([id])).get(id) ?? [];
  const refusBc = refusAnnulationBcDuPoste(bcs);
  if (refusBc) return { ok: false, error: refusBc };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi vous annulez la demande : le motif reste à l'historique, et l'assistante le lit." };

  // TOUT OU RIEN, SOUS CONDITION : chaque BC n'est annulé que s'il n'a pas été signé (ni touché) depuis la
  // lecture — la signature des Finances écrit sur `updatedAt` lu, et cette annulation le change : des deux
  // gestes simultanés, un seul passe. Le poste revient sans demande de BC dans la même transaction.
  const changee = "Cette demande vient de changer (visée, émise, signée ou déjà annulée) : rouvrez la fiche.";
  const annules: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      for (const bc of bcs) {
        const annule = await annulerBcNonSigne(tx, bc.id, `demande de bon de commande du poste « ${item.label} » annulée — ${motif}`, user.id);
        if (!annule) throw new RefusPoste(changee);
        annules.push(bc.nom);
      }
      const r = await tx.adProItem.updateMany({
        where: { id, orderStage: { in: ["REQUESTED", "DIRECTION_OK"] }, expenseOrderId: null },
        data: {
          orderStage: "NONE", orderDirectionAt: null, orderDirectionById: null,
          orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null, updatedById: user.id,
        },
      });
      if (r.count === 0) throw new RefusPoste(changee);
    });
  } catch (e) {
    if (e instanceof RefusPoste) return { ok: false, error: e.message };
    throw e;
  }
  // Un BC annulé n'a plus rien à faire valider : sa porte en attente quitte le centre — et son journal le dit.
  for (const bc of bcs) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: bc.id,
      field: "status", newValue: "CANCELLED", summary: `Bon de commande ${bc.nom} annulé avec la demande du poste « ${item.label} » — ${motif}`,
    });
    await aiguillerBC(bc.id, { acteurId: user.id }).catch(sansBloquer("ad-pro-item-actions.retirerDemandeBC.aiguillerBC"));
  }
  if (bcs.length > 0) { revalidatePath("/legal"); revalidatePath(CHEMIN_BC_A_SIGNER); }

  const info = await PARENTS[owner.parent].load(owner.id);
  const closes = await cloreDemandesSecretariat(id, `la demande de bon de commande du poste « ${item.label} » a été annulée — ${motif}`, user, "BC_A_ETABLIR");
  // Les Finances avaient reçu « à émettre » : sans ce message, elles chercheraient un BC qui n'existe plus.
  if (item.orderStage === "DIRECTION_OK") {
    await notifyRoles(FINANCES_BC, {
      type: "GENERIC", title: "Bon de commande retiré — ne pas l'émettre",
      body: `${info?.ref ?? ""} — « ${item.label} » : ${motif}`, link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro-item-actions.retirerDemandeBC.notifyRoles"));
  }
  // LE DEMANDEUR, quand c'est quelqu'un d'autre qui annule (qui tranche) : c'est sa demande qui s'arrête.
  if (item.orderRequestedById && item.orderRequestedById !== user.id) {
    await notifyUser({
      userId: item.orderRequestedById, type: "GENERIC", title: "Demande de bon de commande annulée",
      body: `${info?.ref ?? ""} — « ${item.label} »${annules.length ? ` (BC ${annules.join(", ")} annulé)` : ""} : ${motif}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro-item-actions.retirerDemandeBC.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande ANNULÉE pour le poste « ${item.label} »${annules.length ? ` — BC ${annules.join(", ")} annulé au registre` : ""} — ${motif}`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/centre-ad-pro");
  return { ok: true, id, message: `Demande de bon de commande annulée${annules.length ? ` — le bon de commande ${annules.join(", ")}, non signé, est annulé au registre` : ""}.${phraseDemandesCloses(closes)}` };
}

/**
 * MODIFIER LA DEMANDE D'ÉMISSION — son message : références, quantités, coordonnées du fournisseur
 * (audit R06 : « impossible de retirer ou d'ajouter des références »). Le message ne change pas ce que
 * le centre a visé — le montant et le prestataire, eux, passent par la règle du visa. Le « BC à
 * établir » de l'assistante reçoit le nouveau message, et elle est prévenue.
 */
export async function modifierDemandeBC(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const note = fdStr(formData, "note");
  if (!note) return { ok: false, error: "Écrivez le contenu de la demande : références, quantités, coordonnées du fournisseur." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!peutToucherDemandeBC(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.orderStage !== "REQUESTED" && item.orderStage !== "DIRECTION_OK") {
    return { ok: false, error: item.orderStage === "ISSUED" ? "Le bon de commande a déjà été émis : son message ne se modifie plus." : "Aucune demande de bon de commande n'est en cours sur ce poste." };
  }
  const r = await prisma.adProItem.updateMany({
    where: { id, orderStage: { in: ["REQUESTED", "DIRECTION_OK"] } },
    data: { orderNote: note, updatedById: user.id },
  });
  if (r.count === 0) return { ok: false, error: "Cette demande vient de changer (émise ou retirée) : rouvrez la fiche." };

  const info = await PARENTS[owner.parent].load(owner.id);
  const montant = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  // LA DEMANDE DE PIÈCE OUVERTE reçoit le nouveau message, chez la MÊME assistante (§118.204). Sans
  // demande ouverte (une pièce déjà déposée, ou une demande d'avant la règle), seul le poste change.
  const ouverte = await prisma.documentRequest.findFirst({
    where: { entityType: "AD_PRO_ITEM", entityId: id, kind: "PURCHASE_ORDER", status: { in: ["PENDING", "SUBMITTED", "DECLINED"] } },
    select: { askedToId: true, askedTo: { select: { name: true } } },
  });
  if (ouverte) {
    await envoyerDemandeBC({
      item, owner, ref: info?.ref ?? "", montant, assistante: { id: ouverte.askedToId, name: ouverte.askedTo?.name ?? "l'assistante" },
      demandeurId: item.orderRequestedById ?? user.id, note,
    });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande modifiée pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: ouverte ? "Demande de bon de commande mise à jour — l'assistante de direction est prévenue." : "Demande de bon de commande mise à jour." };
}

/**
 * ANNULER L'ORDRE ÉMIS, POUR LE RÉÉMETTRE — tant qu'il n'est pas réglé (audit R06). Un ordre parti au
 * mauvais prestataire ou au mauvais montant n'avait qu'une issue : supprimer le poste. L'annulation
 * passe par l'écrivain commun (`annulerOrdreNonRegle`, conditionnel : un règlement survenu entre-temps
 * ne se défait pas). Le poste revient à l'étape d'avant l'émission : visé s'il avait une demande de BC
 * — le visa tient pour ce qu'il a vu, et la règle du visa jugera la réémission —, sinon sans BC.
 */
export async function annulerOrdrePoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi l'ordre est annulé : le motif reste à l'historique de l'ordre et du poste." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // LE DEMANDEUR ANNULE SA DEMANDE DE PAIEMENT tant qu'elle n'est pas réglée (décision du 04/10 :
  // « on peut annuler sa demande tant qu'elle n'a pas été exécutée ») — les Finances et qui arbitre,
  // comme avant. Un ordre réglé ne se défait pas : l'écrivain commun le refuse.
  const isFinance = userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE");
  if (!isFinance && !canAllocate(user, owner.parent) && !canEditItems(user, owner.parent)) {
    return { ok: false, error: "Seuls le demandeur, les Finances, ou qui arbitre ce module, annulent une demande de paiement." };
  }
  if (!item.expenseOrderId) return { ok: false, error: "Aucun ordre de dépense n'a été émis pour ce poste." };

  const annulation = await annulerOrdreNonRegle(item.expenseOrderId, { acteurId: user.id, motif: `poste « ${item.label} » — ${motif}` });
  if (!annulation.ok) return { ok: false, error: annulation.error };
  // LA FACTURE QUI A DEMANDÉ CE PAIEMENT (§118.204) part avec lui : laissée active et liée à un ordre
  // annulé, la demande suivante en déposait une SECONDE, et le poste portait deux factures pour un
  // seul paiement. Elle reste lisible, annulée, sur le poste.
  const facturesAnnulees = await prisma.legalDocument.updateMany({
    where: { kind: "INVOICE", expenseOrderId: item.expenseOrderId, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", updatedById: user.id },
  });
  const etape: AdProItemOrderStage = item.orderRequestedAt ? "DIRECTION_OK" : "NONE";
  await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: item.expenseOrderId },
    data: { expenseOrderId: null, orderStage: etape, updatedById: user.id },
  });
  const info = await PARENTS[owner.parent].load(owner.id);
  const prevenir = item.orderRequestedById ?? info?.requesterId ?? null;
  if (prevenir && prevenir !== user.id) {
    await notifyUser({
      userId: prevenir, type: "GENERIC", title: "Ordre de dépense annulé",
      body: `${info?.ref ?? ""} — « ${item.label} »${annulation.reference ? ` (${annulation.reference})` : ""} : ${motif}`,
      link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro-item-actions.annulerOrdrePoste.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE",
    `Ordre de dépense ${annulation.reference ?? ""} ANNULÉ pour le poste « ${item.label} » — ${motif} (réémission possible).`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/finances/paiements-a-faire");
  return {
    ok: true, id,
    message: `Ordre ${annulation.reference ?? ""} annulé${facturesAnnulees.count > 0 ? ", sa facture aussi" : ""} — le paiement pourra être redemandé avec une facture${etape === "DIRECTION_OK" ? " ; le visa du centre tient pour le montant et le prestataire qu'il a vus" : ""}.`,
  };
}

/**
 * DEMANDER À REVOIR UN POSTE ACCORDÉ (audit R12) — le demandeur rend SON poste à la Direction, motif
 * à l'appui et, s'il le faut, une nouvelle estimation (« le montant accordé ne suffit pas »). C'est un
 * geste qui RÉDUIT : il retire l'accord de son propre poste et n'accorde rien ; la Direction re-décide,
 * l'accord d'hier reste à l'historique. Tant qu'aucun ordre n'est parti — et une demande de BC en
 * cours se retire avec lui, sauf BC déjà établi dans Legal.
 */
export async function demanderRevisionPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites à la Direction ce qui doit être revu : c'est ce qu'elle lira." };
  const estimation = fdNum(formData, "amountEstimated");
  if (estimation != null && estimation <= 0) return { ok: false, error: "La nouvelle estimation doit être un montant positif." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.status !== "APPROVED") {
    return { ok: false, error: "Seul un poste accordé se rend à la Direction : un poste en brouillon, refusé ou à revoir se modifie et se resoumet." };
  }
  if (item.expenseOrderId || item.orderStage === "ISSUED") {
    return { ok: false, error: "Un ordre de dépense a été émis pour ce poste : les Finances l'annulent d'abord (« Annuler l'ordre émis »), puis la révision se demande." };
  }
  if (item.kind === "STOCK_MATERIAL") {
    return { ok: false, error: "Le matériel du stock se revoit par la Direction (« Revoir la décision ») : sa réservation suit sa décision." };
  }
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  if (bcEnCours) {
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: refusBcEtabli(bcs, "demandez la révision") };
  }
  const r = await prisma.adProItem.updateMany({
    where: { id, status: "APPROVED", expenseOrderId: null, orderStage: { not: "ISSUED" } },
    data: {
      status: "PENDING", submittedAt: new Date(), decisionNote: null, amountGranted: null,
      // Rendu pour révision, le poste repasse par les DEUX temps : l'accord d'hier ne couvre pas la
      // nouvelle estimation (§118.204). Sauf demande de la Direction des opérations (franchi d'office).
      opsDecidedAt: opsFranchiALaSoumission(await demandeurDe((await PARENTS[owner.parent].load(owner.id))?.requesterId)) ? new Date() : null,
      opsDecidedById: null, opsDecisionNote: null,
      ...(estimation != null ? { amountEstimated: estimation } : {}),
      ...(bcEnCours
        ? { orderStage: "NONE" as const, orderDirectionAt: null, orderDirectionById: null, orderVisaAmount: null, orderVisaSupplier: null, orderDecisionNote: null }
        : {}),
      updatedById: user.id,
    },
  });
  if (r.count === 0) return { ok: false, error: "Ce poste vient de changer (émis, ou sa décision a été revue) : rouvrez la fiche." };
  const ancien = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  await recordDecision(id, "PENDING", `Révision demandée par le demandeur : ${motif}`, estimation ?? ancien, user.id);
  await reprojeterMontantDemande(owner.parent, owner.id);
  const closes = bcEnCours
    ? await cloreDemandesSecretariat(id, `le poste « ${item.label} » est rendu à la Direction pour révision — la demande de bon de commande est retirée`, user, "BC_A_ETABLIR")
    : 0;
  const info = await PARENTS[owner.parent].load(owner.id);
  const demandeur = await demandeurDe(info?.requesterId);
  await prevenirLeTemps(
    opsFranchiALaSoumission(demandeur) ? "MARKETING" : "OPERATIONS", demandeur, "Poste accordé — révision demandée",
    `${info?.ref ?? "Opération"} — « ${item.label} »${estimation != null ? ` (nouvelle estimation : ${estimation.toLocaleString("fr-FR")} DZD)` : ""} : ${motif}`,
    lienPosteAdPro(owner.parent, owner.id, item.id),
  );
  await audit(user, owner.parent, owner.id, "UPDATE",
    `Révision demandée sur le poste accordé « ${item.label} »${ancien != null ? ` (accordé ${ancien.toLocaleString("fr-FR")} DZD)` : ""} — ${motif}${bcEnCours ? " — demande de bon de commande retirée" : ""}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Poste rendu à la Direction pour révision.${phraseDemandesCloses(closes)}` };
}

/**
 * LA DÉCISION D'UN POSTE « MATÉRIEL DU STOCK » — la réservation (ou sa restitution) et la décision
 * s'écrivent ENSEMBLE, sous le verrou de chaque article. Au-delà de ce que le magasin a de
 * distribuable, l'accord est refusé en entier, ligne nommée : rien n'est accordé, rien n'est réservé.
 */
async function deciderMaterielStock(
  itemId: string,
  status: AdProItemStatus,
  auteurId: string,
  ecrireDecision: (client: Tx) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lignes = await prisma.adProStockLine.findMany({
    where: { itemId },
    select: { id: true, stockItemId: true, quantite: true, statut: true },
  });
  if (lignes.some((l) => l.statut === "CONFIRMEE")) {
    return { ok: false, error: "Le matériel de ce poste a déjà été confirmé après l'événement : sa décision ne peut plus changer." };
  }
  if (status === "APPROVED" && lignes.length === 0) {
    return { ok: false, error: "Ce poste ne liste aucun article du stock : il n'y a rien à accorder." };
  }
  const libelles = await libellesArticles(lignes.map((l) => l.stockItemId));
  const motif = "Réservé pour l'événement (poste « Matériel du stock » accordé)";
  class Refus extends Error {}
  try {
    await sousVerrous(lignes.map((l) => l.stockItemId), async (tx) => {
      // RELIRE SOUS LE VERROU : un autre accord du même poste a pu passer entre-temps.
      const actuelles = await tx.adProStockLine.findMany({ where: { itemId }, select: { id: true, stockItemId: true, quantite: true, statut: true } });
      if (status === "APPROVED") {
        for (const l of actuelles.filter((x) => x.statut === "DEMANDEE")) {
          const q = toNumber(l.quantite);
          const r = await reserverPourEvenement(tx, l.stockItemId, { ligneId: l.id, quantite: q, motif, auteurId, maintenant: new Date() });
          if (!r.ok) throw new Refus(refusReservation(libelles.get(l.stockItemId)?.libelle ?? "Article", q, r.refus));
          await tx.adProStockLine.update({ where: { id: l.id }, data: { statut: "RESERVEE", reserveeLe: new Date(), reserveeParId: auteurId } });
        }
      } else {
        for (const l of actuelles.filter((x) => x.statut === "RESERVEE")) {
          await rendreAuMagasin(tx, l.stockItemId, { ligneId: l.id, quantite: toNumber(l.quantite), motif: `Poste ${status === "REJECTED" ? "refusé" : "à revoir"} : la réservation revient au magasin`, auteurId });
          await tx.adProStockLine.update({ where: { id: l.id }, data: { statut: "DEMANDEE", reserveeLe: null, reserveeParId: null } });
        }
      }
      await ecrireDecision(tx);
    });
  } catch (e) {
    if (e instanceof Refus) return { ok: false, error: e.message };
    throw e;
  }
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true };
}
