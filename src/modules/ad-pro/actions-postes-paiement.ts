"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { moneyEntityOf } from "@/lib/company";
import { createExpenseOrder } from "@/lib/expense-orders";
import { canEmitOrder, ITEM_KIND_LABELS, PARENT_ENTITE, VERSEMENT_SANS_BC, LIBELLE_JUSTIFICATIF_DIRECT, facturePourPayer, etatDuPaiement, phrasePaiementBloque, nomComplet, beneficiaireDuPaiement, gesteVisaPoste } from "@/modules/ad-pro/partage";
import { enSerie } from "@/lib/refs";
import { fdStr, fdNum, fdCase, type ActionResult } from "@/lib/actions/types";
import { refusSiPorteDgFermee, rattacherPieceAuPoste, piecesDesPostes, devisDesPostes, empreintesDesDevis, refusPlafondDuPoste, lireFactureDuPoste } from "@/modules/ad-pro/api";
import { getAppSettings } from "@/lib/settings";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { refusArgentSurPosteStock } from "@/lib/promo/reservations";
import { Prisma } from "@prisma/client";
import { validateAttachments } from "@/lib/attach-files";
import { createHash } from "node:crypto";
import { ingererDevisDuPoste, phraseDeLecture } from "@/lib/pieces-lues/devis-poste-lecture";
import { refusDeLaSaisie } from "@/lib/bons-de-commande/saisie-composeur";
import { attachFormFiles, persistUploadedDocument } from "@/lib/documents";
import { controlerFacture, refusDemandePaiementBC, type ControleFacture } from "@/lib/bons-de-commande/copie-signee";
import { verifierFacturesAvantDepot, marquerDoublonPossible } from "@/lib/factures/connues";
import type { FactureDejaConnue } from "@/lib/factures/blocage-vue";
import { apercuPourEcran, estRevisionDeNumeroSeul, previsualiserRevision, reviserDocumentDrive, type ApercuPiece } from "@/platform/in-process/artifact/factory";
import { sansBloquer } from "@/lib/journal";
import { type ParentInfo, PARENTS, revalidate, canEditItems, canAllocate, audit, refusDemandeFermee, loadItem, REFUS_HISTORIQUE, etatBcDe, appliquerGesteVisa, lireModificationsDuBc, chargerVoyageur, filePoste, validerAutomatiquementLesLignesLues } from "./infra/postes/commun";

/**
 * POSTES AD & PRO — LE DEVIS, LE PAIEMENT, LA FACTURE : joindre et retirer un devis, demander le paiement
 * d'un poste, déposer la facture contrôlée contre le BC signé, modifier le BC d'un poste ; le devis d'un voyageur (il EST un devis du poste :
 * `ajouterDevisVoyageur` passe son formulaire à `ajouterDevisPoste`, d'où leur voisinage).
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

// ───────────────────────────── Paiement ─────────────────────────────

/**
 * LES PIÈCES D'ACHAT D'UN POSTE (§118.204) — devis ou facture pro forma, puis bon de commande, puis
 * facture. Chaque pièce vit au registre Legal (une seule vérité, §17) et se RATTACHE au poste
 * (`AdProItemPiece`) ; un même devis peut couvrir deux, trois ou quatre postes de la même demande.
 * Ces pièces ne passent plus par le bloc « Pièces liées » de la fiche : elles sont SUR le poste.
 */

/**
 * LE REFUS « PAIEMENT DÉJÀ DEMANDÉ », AVEC L'ÉTAT RÉEL DE L'ORDRE (audit Ad & Pro, 14/10) : un ordre refusé par le centre
 * ou annulé ailleurs ne se « redemande » pas tant que le poste le porte — la phrase nomme le geste qui le libère.
 */
async function refusPaiementDejaDemande(expenseOrderId: string): Promise<string> {
  const o = await prisma.expenseOrder.findUnique({ where: { id: expenseOrderId }, select: { reference: true, status: true, centralStatus: true } });
  const bloque = o
    ? phrasePaiementBloque(etatDuPaiement({ expenseOrderId, expenseOrderStatus: o.status, expenseOrderCentral: o.centralStatus }), o.reference)
    : null;
  return bloque ?? "Le paiement de ce poste a déjà été demandé.";
}

/** Charge plusieurs postes de la MÊME demande, sous la porte de la fiche ; `null` dès qu'un seul manque. */
async function postesDeLaMemeDemande(ids: readonly string[], user: SessionUser) {
  const charges = [];
  for (const pid of [...new Set(ids)]) {
    const f = await loadItem(pid, user);
    if (!f) return { error: "Un des postes est introuvable." } as const;
    if (f.historique) return { error: REFUS_HISTORIQUE } as const;
    charges.push(f);
  }
  const o = charges[0]?.owner;
  if (!o || charges.some((c) => c.owner.parent !== o.parent || c.owner.id !== o.id)) {
    return { error: "Un devis commun ne couvre que des postes de la même demande." } as const;
  }
  return { charges, owner: o } as const;
}

/**
 * DÉPOSER UN DEVIS (ou une facture pro forma) SUR UN OU PLUSIEURS POSTES. Le fichier est exigé : un
 * devis sans son document est un titre que personne ne peut vérifier. La pièce se juge AVANT d'écrire
 * quoi que ce soit (§118.196d) : un fichier refusé ne laisse pas un devis vide au registre.
 */
export async function ajouterDevisPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ids = [fdStr(formData, "id"), ...formData.getAll("autresPostes").map(String)].filter((x): x is string => Boolean(x));
  if (ids.length === 0) return { ok: false, error: "Poste non précisé." };
  const lot = await postesDeLaMemeDemande(ids, user);
  if ("error" in lot) return { ok: false, error: lot.error };
  const { charges, owner } = lot;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  for (const { item } of charges) {
    const refusStock = refusArgentSurPosteStock(item.kind, "un devis");
    if (refusStock) return { ok: false, error: refusStock };
    if (item.status === "REJECTED") return { ok: false, error: `Le poste « ${item.label} » est refusé : il ne reçoit plus de devis.` };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };

  const fichiers = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Joignez le devis (PDF, Word ou scan)." };
  const refusFichier = await validateAttachments(fichiers);
  if (refusFichier) return { ok: false, error: refusFichier };
  const montant = fdNum(formData, "montant");
  if (montant !== null && !(montant > 0)) return { ok: false, error: "Le montant du devis doit être positif." };
  const proforma = formData.get("proforma") === "on";
  const nature = proforma ? "Facture pro forma" : "Devis";
  const libelles = charges.map(({ item }) => item.label);
  // PLUSIEURS DEVIS EN UN GESTE (audit Ad & Pro, 14/10 — « qu'on puisse mettre plusieurs devis, qu'ils soient TOUS
  // transformés en natif »). Jusqu'ici, plusieurs fichiers joints d'un coup devenaient UN seul devis au registre, et
  // seul le PREMIER était lu : les autres restaient des fichiers sans lignes, invisibles du contrôle et du BC. Avec
  // « un devis par fichier » (la carte le coche d'office dès qu'on joint plusieurs fichiers), chaque fichier devient
  // SON devis, lu, contrôlé et validable à part. Sans la case, les fichiers sont les pages d'UN devis (le premier est lu,
  // et la phrase le dit).
  const unParFichier = fichiers.length > 1 && formData.get("unDevisParFichier") === "on";
  if (unParFichier && (montant !== null || fdStr(formData, "reference"))) {
    return { ok: false, error: "Plusieurs devis d'un coup : le montant et la référence se lisent sur chacun — laissez ces deux champs vides, ou déposez les devis un par un." };
  }
  const companyId = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
  const fournisseurSaisi = fdStr(formData, "fournisseur") ?? charges[0].item.supplier ?? null;
  const lots: File[][] = unParFichier ? fichiers.map((f) => [f]) : [fichiers];

  const deposes: string[] = [];
  const phrases: string[] = [];
  const echecs: string[] = [];
  for (const [rang, lot] of lots.entries()) {
    const doc = await prisma.legalDocument.create({
      data: {
        title: `${nature}${unParFichier ? ` ${rang + 1}/${lots.length}` : ""} — ${libelles.join(", ")} (${info.ref})`,
        kind: "QUOTE",
        reference: unParFichier ? null : fdStr(formData, "reference"),
        amount: unParFichier ? null : montant,
        // Un devis par fichier : chacun a SON émetteur, lu sur le papier ; le fournisseur saisi ne comble qu'un vide (plus bas).
        counterparty: unParFichier ? null : fournisseurSaisi,
        companyId,
        sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
        createdById: user.id, updatedById: user.id,
        notes: `${nature} déposé${proforma ? "e" : ""} sur ${charges.length > 1 ? "les postes" : "le poste"} ${libelles.map((l) => `« ${l} »`).join(", ")}${unParFichier ? ` — fichier « ${lot[0].name} »` : ""}.`,
      },
      select: { id: true },
    });
    deposes.push(doc.id);
    let joints: { attached: number; failed: { name: string; error: string }[] };
    if (unParFichier) {
      const seul = new FormData();
      seul.append("attachment", lot[0]);
      joints = await attachFormFiles(user.id, "LEGAL_DOCUMENT", doc.id, seul);
    } else {
      joints = await attachFormFiles(user.id, "LEGAL_DOCUMENT", doc.id, formData);
    }
    echecs.push(...joints.failed.map((x) => x.name));
    for (const { item } of charges) {
      await rattacherPieceAuPoste({ itemId: item.id, legalDocumentId: doc.id, nature: "DEVIS", acteurId: user.id });
    }
    // LA LECTURE À L'UPLOAD (§118.206) : « Luna doit directement, lors de l'ingestion des devis, les rendre
    // mangeables et consommables par la plateforme ». Le devis est déjà au poste : une lecture qui échoue ne fait
    // JAMAIS échouer le dépôt, mais elle se DIT (une absence de lignes sans cause se lirait comme un devis vide).
    const premier = lot[0];
    const nom = unParFichier ? `« ${premier.name} » : ` : "";
    let lecture = "";
    if (premier && joints.failed.length < lot.length) {
      const ing = await ingererDevisDuPoste({ userId: user.id, legalDocumentId: doc.id, octets: Buffer.from(await premier.arrayBuffer()), nomFichier: premier.name });
      lecture = ing.ok ? phraseDeLecture(ing) : `Lecture du devis impossible (${ing.raison}) — saisissez ses lignes depuis la carte du poste.`;
      // UN SEUL POSTE : les lignes bien lues sont validées d'office (voir la fonction). Un devis commun à
      // plusieurs postes se répartit à la main — on ne devine pas à quel poste va chaque ligne. Un DOUTE du contrôle
      // des totaux (TTC imprimé que les lignes ne font pas, TVA non imprimée…) laisse les lignes à valider à la main.
      if (ing.ok && charges.length === 1 && ing.doutes.length === 0) {
        const nb = await validerAutomatiquementLesLignesLues(user.id, charges[0].item.id, doc.id).catch(sansBloquer("ad-pro-item-actions.ajouterDevisPoste.validerAutomatiquementLesLignesLues", 0));
        if (nb > 0) lecture = `Devis lu : ${nb} ligne${nb > 1 ? "s" : ""} validée${nb > 1 ? "s" : ""} automatiquement.`;
      }
      if (!unParFichier && lot.length > 1) {
        lecture += ` Seul le premier fichier (« ${premier.name} ») a été lu : les ${lot.length - 1} autre(s) sont jointes comme pages du même devis — leurs lignes se saisissent depuis la carte.`;
      }
    }
    if (unParFichier && fournisseurSaisi) {
      await prisma.legalDocument.updateMany({ where: { id: doc.id, OR: [{ counterparty: null }, { counterparty: "" }] }, data: { counterparty: fournisseurSaisi } });
    }
    if (lecture) phrases.push(`${nom}${lecture}`);
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `${unParFichier ? `${lots.length} ${nature.toLowerCase()}s déposés` : `${nature} déposé`} sur ${libelles.map((l) => `« ${l} »`).join(", ")}${montant ? ` — ${montant.toLocaleString("fr-FR")} DZD` : ""}.`);
  revalidate(owner.parent, owner.id);
  const echec = echecs.length ? ` Échec sur : ${echecs.join(", ")}.` : "";
  const entete = unParFichier
    ? `${lots.length} ${proforma ? "factures pro forma déposées" : "devis déposés"}, un par fichier`
    : `${nature} déposé${proforma ? "e" : ""}`;
  return {
    ok: true, id: deposes[0],
    message: `${entete}${charges.length > 1 ? ` — commun${unParFichier ? "s" : ""} à ${charges.length} postes` : ""}.${echec}${phrases.length ? ` ${phrases.join(" ")}` : ""}`,
  };
}

/**
 * RETIRER UN DEVIS D'UN POSTE — il a été déposé au mauvais endroit. Le lien part ; une pièce qui ne
 * couvre plus AUCUN poste est annulée au registre (sans quoi elle resterait « devis » d'une demande pour
 * rien). Refusé quand un bon de commande ou une facture en découle : la chaîne ne se défait pas d'ici.
 */
export async function retirerDevisDuPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const pieceId = fdStr(formData, "pieceId");
  if (!id || !pieceId) return { ok: false, error: "Poste ou pièce non précisés." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const lien = await prisma.adProItemPiece.findFirst({ where: { itemId: id, legalDocumentId: pieceId, nature: "DEVIS" }, select: { id: true } });
  if (!lien) return { ok: false, error: "Ce devis n'est pas rattaché à ce poste." };
  const aval = await prisma.legalDocument.count({ where: { chainFromId: pieceId, status: { not: "CANCELLED" } } });
  if (aval > 0) return { ok: false, error: "Un bon de commande ou une facture découle de ce devis : il ne se retire plus du poste." };
  await prisma.adProItemPiece.delete({ where: { id: lien.id } });
  // LES LIGNES VALIDÉES POUR CE POSTE (§118.206) ne le restent pas : un devis qui ne couvre plus le poste ne fait
  // plus rien commander pour lui — la validation d'une ligne tient au lien du devis avec le poste.
  await prisma.adProDevisLigne.updateMany({
    where: { devis: { legalDocumentId: pieceId }, validatedItemId: id },
    data: { validatedItemId: null, validatedAt: null, validatedById: null },
  });
  const restants = await prisma.adProItemPiece.count({ where: { legalDocumentId: pieceId } });
  if (restants === 0) {
    await prisma.legalDocument.updateMany({ where: { id: pieceId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", updatedById: user.id } });
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis retiré du poste « ${item.label} »${restants === 0 ? " — il ne couvrait plus aucun poste, il est annulé au registre" : ""}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: restants === 0 ? "Devis retiré et annulé (il ne couvrait plus aucun poste)." : "Devis retiré de ce poste." };
}

/**
 * DÉPOSER LA FACTURE ET DEMANDER LE PAIEMENT D'UN POSTE (§118.204). « Ils doivent uploader les
 * factures pour demander un paiement. Obligatoirement facture. » La facture est exigée, avec son
 * montant ; elle ne dépasse pas le montant accordé. Un poste avec bon de commande attend que les
 * Finances l'aient SIGNÉ ; un sponsoring direct (aide versée à l'association) n'a pas de BC.
 *
 * Remplace « Émettre le bon de commande » des Finances, qui créait un ordre de dépense et rien
 * d'autre : le paiement part maintenant de la FACTURE, rattachée à son BC, et passe par le centre de
 * paiement (§118.148).
 */
export async function demanderPaiementPoste(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil et sans sa validation, rien ne s'engage.
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "une facture");
  if (refusStock) return { ok: false, error: refusStock };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };

  // L'ÉTAT D'ABORD (§118.18) — puis la facture.
  if (item.orderStage === "ISSUED" || item.expenseOrderId) {
    return { ok: false, error: item.expenseOrderId ? await refusPaiementDejaDemande(item.expenseOrderId) : "Une demande de paiement est déjà en cours pour ce poste : rouvrez la fiche." };
  }
  const montantAccorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  const check = canEmitOrder({ amountGranted: montantAccorde, expenseOrderId: item.expenseOrderId, status: item.status }, info.decided);
  if (!check.ok) return { ok: false, error: check.reason ?? "Paiement impossible." };
  if (!item.budgetCategoryId) return { ok: false, error: "La Direction Marketing n'a pas encore choisi le budget de ce poste." };
  const direct = VERSEMENT_SANS_BC.includes(item.kind);
  // UN POSTE À BON DE COMMANDE (Direction, 06/10) : la facture DÉPOSÉE et contrôlée par Luna contre le(s) BC signé(s)
  // fait la demande — une facture jointe ici est d'abord déposée, et passe le même contrôle.
  if (!direct) {
    // PLUSIEURS PIÈCES POUR UNE FACTURE (audit Ad & Pro, 14/10) : la première est la facture (lue, contrôlée), les
    // suivantes ses annexes (bon de livraison, PV de réception, relevé…) — toutes gardées, aucune jetée en silence.
    const joints = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
    const fichier = joints[0] ?? null;
    return payerLesFacturesDuPoste({
      user, item, owner, info, montantAccorde, fichier, annexes: joints.slice(1),
      montantSaisi: fdNum(formData, "montant"), reference: fdStr(formData, "reference"),
      bcIds: formData.getAll("bcId").map(String).filter(Boolean),
      argumentation: fdStr(formData, "argumentation"), confirme: fdCase(formData, "confirme") === true,
    });
  }
  const pieces = (await piecesDesPostes([id])).get(id);
  const bc = pieces?.bc ?? null;
  if (!direct) {
    if (!bc) return { ok: false, error: "Le bon de commande de ce poste n'est pas encore établi : la facture se dépose après lui." };
    if (bc.etape !== "SIGNE") return { ok: false, error: "Le bon de commande n'est pas encore signé par les Finances : la facture se dépose après la signature." };
  }

  const fichiers = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  // LA PIÈCE QU'ON EXIGE DÉPEND DE LA NATURE DU POSTE (Direction, 05/10) : un sponsoring INDIRECT
  // (devis → BC → facture) exige la facture ; un sponsoring DIRECT à l'association exige la
  // « Proforma / lettre de demande de sponsoring », et la facture n'est qu'une pièce de plus qu'on peut
  // joindre. La pro forma ou la lettre peut aussi être DÉJÀ sur le poste (déposée dans sa case) : elle
  // compte, il n'y a alors rien à rejoindre.
  const justificatifDejaLa = direct && (pieces?.devis ?? []).some((d) => !d.annulee && d.fichiers > 0);
  if (fichiers.length === 0 && !justificatifDejaLa) {
    return {
      ok: false,
      error: direct
        ? `Joignez la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} : elle est exigée pour demander le paiement d'un sponsoring direct (la facture, elle, est facultative).`
        : "Joignez la facture : elle est obligatoire pour demander le paiement.",
    };
  }
  const facturesFacultatives = direct ? formData.getAll("facture").filter((v): v is File => v instanceof File && v.size > 0) : [];
  const refusFichier = await validateAttachments([...fichiers, ...facturesFacultatives]);
  if (refusFichier) return { ok: false, error: refusFichier };
  const montant = fdNum(formData, "montant");
  const piece = direct ? LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr") : "facture";
  if (montant === null || !(montant > 0)) return { ok: false, error: `Indiquez le montant de la ${piece}.` };
  if (montantAccorde !== null && montant > montantAccorde) {
    return { ok: false, error: `La ${piece} (${montant.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
  }

  // LE DERNIER REMPART (§118.187) : ce qui part ne dépasse jamais ce que le centre a vu. Le montant ou
  // le prestataire ont pu changer par un chemin que rien n'a surveillé : on compare à l'empreinte du
  // visa, on rouvre le visa si elle est dépassée, et on refuse en disant pourquoi.
  if (item.orderStage === "DIRECTION_OK") {
    const apres = { montant: montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    if (geste.geste === "ROUVRIR") {
      const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info.ref });
      return { ok: false, error: `Paiement refusé — ${phrase ?? geste.motif}` };
    }
  }

  // LA FACTURE DÉJÀ CONNUE AILLEURS (Direction, 14/10) — jugée avant la prise et avant toute écriture.
  const gardeFactures = await verifierFacturesAvantDepot(user, await Promise.all(facturesFacultatives.map(async (f) => ({
    octets: Buffer.from(await f.arrayBuffer()), nom: f.name, saisie: { ttc: montant, fournisseur: item.supplier ?? info.beneficiary },
  }))), { instances: [`POSTE:${id}`] });
  if (!gardeFactures.ok) return { ok: false, error: gardeFactures.error, factureConnue: gardeFactures.factureConnue };

  // LA PRISE (§118.187) : un poste à la fois — deux clics ne déposent pas deux factures.
  const etapeLue = item.orderStage;
  const prise = await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: null, status: "APPROVED", orderStage: etapeLue },
    data: { orderStage: "ISSUED", updatedById: user.id },
  });
  if (prise.count === 0) return { ok: false, error: "Ce poste vient de changer (paiement déjà demandé, ou sa décision a été revue) : rouvrez la fiche." };

  const piecesCreees: string[] = [];
  let factureId: string | null = null;
  let ordreNe = false;
  try {
    const amont = bc?.id ?? (pieces?.devis.filter((d) => !d.annulee).length === 1 ? pieces.devis.find((d) => !d.annulee)!.id : null);
    const companyId = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    let amontDeLaFacture = amont;
    // UN SPONSORING DIRECT : la pièce exigée est la pro forma / lettre de demande — un DEVIS au registre,
    // rattaché au poste dans la case des devis. Rien n'est créé quand elle est déjà sur le poste.
    if (direct && fichiers.length > 0) {
      const justificatif = await prisma.legalDocument.create({
        data: {
          title: `${LIBELLE_JUSTIFICATIF_DIRECT} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${info.ref})`,
          kind: "QUOTE",
          reference: fdStr(formData, "reference"),
          amount: montant,
          counterparty: item.supplier ?? info.beneficiary,
          companyId,
          sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
          createdById: user.id, updatedById: user.id,
          notes: `${LIBELLE_JUSTIFICATIF_DIRECT} du poste « ${item.label} » de ${info.ref}.`,
        },
        select: { id: true },
      });
      piecesCreees.push(justificatif.id);
      await attachFormFiles(user.id, "LEGAL_DOCUMENT", justificatif.id, formData);
      await rattacherPieceAuPoste({ itemId: id, legalDocumentId: justificatif.id, nature: "DEVIS", acteurId: user.id });
      amontDeLaFacture = justificatif.id;
    }
    // LA FACTURE : exigée pour tout poste qui n'est pas un versement à l'association ; facultative pour lui
    // (elle se joint si on l'a, sous le champ « facture »).
    if (!direct || facturesFacultatives.length > 0) {
      const facture = await prisma.legalDocument.create({
        data: {
          title: `Facture — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${info.ref})`,
          kind: "INVOICE", direction: "OUT",
          reference: direct ? null : fdStr(formData, "reference"),
          amount: montant,
          counterparty: item.supplier ?? info.beneficiary,
          companyId,
          sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
          chainFromId: amontDeLaFacture,
          createdById: user.id, updatedById: user.id,
          notes: `Facture du poste « ${item.label} » de ${info.ref}.`,
        },
        select: { id: true },
      });
      factureId = facture.id;
      piecesCreees.push(facture.id);
      await attachFormFiles(user.id, "LEGAL_DOCUMENT", facture.id, formData, direct ? "facture" : "attachment");
      await rattacherPieceAuPoste({ itemId: id, legalDocumentId: facture.id, nature: "FACTURE", acteurId: user.id });
    }

    const order = await createExpenseOrder({
      label: `${info.ref} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label}`,
      amount: montant,
      category: "EVENEMENT",
      beneficiary: item.supplier ?? info.beneficiary,
      sourceType: owner.parent === "EVENT" ? "EVENT" : owner.parent,
      sourceId: info.id,
      requestedById: user.id,
      budgetCategoryId: item.budgetCategoryId ?? null,
      // La facture n'est exigée avant le règlement que là où elle est la pièce du paiement.
      requiresInvoice: facturePourPayer(item.kind),
      notes: `Poste de l'opération ${info.ref} — ${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} jointe${factureId ? " ; facture jointe" : ""}` : "facture jointe"}.`,
    });
    ordreNe = true;
    await prisma.adProItem.update({ where: { id }, data: { expenseOrderId: order.id, orderStage: "ISSUED", updatedById: user.id } });
    if (factureId) await prisma.legalDocument.update({ where: { id: factureId }, data: { expenseOrderId: order.id } });
    for (const p of gardeFactures.probables) await marquerDoublonPossible({ marque: p.marque, legalDocumentId: factureId, ordreIds: [order.id], acteurId: user.id });
    await audit(user, owner.parent, owner.id, "UPDATE",
      `${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT} jointe` : "Facture déposée"} et paiement demandé pour le poste « ${item.label} » — ${montant.toLocaleString("fr-FR")} DZD (ordre ${order.reference}, au centre de paiement).`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/finances/paiements-a-faire");
    const avertissement = gardeFactures.probables.map((p) => p.phrase).join(" ");
    return {
      ok: true, id: order.id,
      message: `${direct ? `${LIBELLE_JUSTIFICATIF_DIRECT} jointe` : "Facture déposée"} — paiement de ${montant.toLocaleString("fr-FR")} DZD demandé au centre de paiement (${order.reference}).${avertissement ? ` ${avertissement}` : ""}`,
      ...(avertissement ? { avertissement } : {}),
    };
  } catch (err) {
    console.error("[ad-pro-item] demande de paiement impossible", err);
    if (!ordreNe) {
      await prisma.adProItem.updateMany({ where: { id, expenseOrderId: null, orderStage: "ISSUED" }, data: { orderStage: etapeLue } }).catch(sansBloquer("ad-pro-item-actions.demanderPaiementPoste.adProItem"));
      if (piecesCreees.length > 0) await prisma.legalDocument.updateMany({ where: { id: { in: piecesCreees } }, data: { status: "CANCELLED" } }).catch(sansBloquer("ad-pro-item-actions.demanderPaiementPoste.legalDocument"));
    }
    return { ok: false, error: "La demande de paiement n'a pas pu être enregistrée." };
  }
}

// ───────────────────────────── Le BC signé, la facture contrôlée, le paiement (Direction, 06/10) ─────────────────────────────

type PosteAvecOperation = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

/**
 * DÉPOSER LA FACTURE D'UN OU PLUSIEURS BC SIGNÉS — « une fois la facture reçue, Luna vérifie uniquement la cohérence avec
 * le bon de commande ». La facture se lit (Luna, sinon le moteur local), se compare aux BC qu'elle couvre
 * (`controlerFacture`), et le contrôle reste SUR la facture : la case paiement le relit. Un poste à plusieurs BC dépose
 * une facture par BC — ou une seule pour plusieurs, en les cochant.
 */
async function deposerFactureSurPoste(a: {
  user: SessionUser; poste: PosteAvecOperation; info: ParentInfo; fichier: File; montantSaisi: number | null; reference: string | null; bcIds: string[];
  /** Les AUTRES pièces jointes à la facture (annexes, pages, bon de livraison) : gardées avec elle, jamais lues comme facture. */
  annexes?: File[];
}): Promise<{ ok: true; factureId: string; controle: ControleFacture; annexesEchouees: string[]; avertissement: string | null } | { ok: false; error: string; factureConnue?: FactureDejaConnue }> {
  const { item, owner } = a.poste;
  const pieces = (await piecesDesPostes([item.id])).get(item.id);
  const bcs = pieces?.bcs ?? [];
  const couverts = new Set((pieces?.factures ?? []).filter((f) => !f.annulee).flatMap((f) => f.controle?.bcIds ?? []));
  const libres = bcs.filter((b) => b.etape === "SIGNE" && !couverts.has(b.id));
  const choisis = a.bcIds.length > 0 ? bcs.filter((b) => a.bcIds.includes(b.id)) : libres.length === 1 ? libres : [];
  if (bcs.length === 0) return { ok: false, error: "Ce poste n'a pas encore de bon de commande : la facture se dépose après lui." };
  if (choisis.length === 0) {
    return { ok: false, error: libres.length === 0 ? "Aucun bon de commande signé n'attend sa facture sur ce poste." : "Cochez le(s) bon(s) de commande que cette facture couvre." };
  }
  if (a.bcIds.length > 0 && choisis.length !== a.bcIds.length) return { ok: false, error: "Un bon de commande coché n'appartient pas à ce poste." };
  const nonSigne = choisis.find((b) => b.etape !== "SIGNE");
  if (nonSigne) return { ok: false, error: `Le bon de commande ${nonSigne.reference ?? nonSigne.titre} n'est pas encore signé : sa facture se dépose après la signature.` };
  const dejaFacture = choisis.find((b) => couverts.has(b.id));
  if (dejaFacture) return { ok: false, error: `Le bon de commande ${dejaFacture.reference ?? dejaFacture.titre} a déjà sa facture : annulez-la dans Legal pour en déposer une autre.` };
  const annexes = (a.annexes ?? []).filter((f) => f.size > 0);
  // Toutes les pièces se jugent AVANT d'écrire quoi que ce soit (§118.196d) : une annexe refusée ne laisse pas une facture à moitié.
  const refusFichier = await validateAttachments([a.fichier, ...annexes]);
  if (refusFichier) return { ok: false, error: refusFichier };

  const octets = Buffer.from(await a.fichier.arrayBuffer());
  // UNE FACTURE DÉJÀ CONNUE AILLEURS NE SE DÉPOSE PAS UNE SECONDE FOIS (Direction, 14/10) — dans les deux sens : déjà
  // dans une demande de paiement, au registre, sur un autre poste. Jugé avant d'écrire ; les factures de CE poste sont
  // hors de la comparaison (le BC déjà facturé est refusé plus haut).
  const garde = await verifierFacturesAvantDepot(a.user, [{
    octets, nom: a.fichier.name, saisie: { numero: a.reference, ttc: a.montantSaisi, fournisseur: item.supplier },
  }], { instances: [`POSTE:${item.id}`, ...(item.expenseOrderId ? [`ORDRE:${item.expenseOrderId}`] : [])] });
  if (!garde.ok) return { ok: false, error: garde.error, factureConnue: garde.factureConnue };
  const lu = await lireFactureDuPoste({ userId: a.user.id, octets, nomFichier: a.fichier.name, montantSaisi: a.montantSaisi });
  const docs = await prisma.legalDocument.findMany({ where: { id: { in: choisis.map((b) => b.id) } }, select: { id: true, reference: true, amount: true, counterparty: true } });
  const controle = controlerFacture(lu, choisis.map((b) => {
    const d = docs.find((x) => x.id === b.id);
    return { id: b.id, reference: d?.reference ?? b.reference, montantTtc: d?.amount != null ? toNumber(d.amount) : b.montant, fournisseur: d?.counterparty ?? null };
  }));
  const companyId = a.info.companyId ?? (await moneyEntityOf(a.info.requesterId ?? a.user.id));
  const facture = await prisma.legalDocument.create({
    data: {
      title: `Facture — ${ITEM_KIND_LABELS[item.kind]} : ${item.label} (${a.info.ref})`,
      kind: "INVOICE", direction: "OUT",
      reference: a.reference,
      amount: controle.montant,
      counterparty: docs[0]?.counterparty ?? item.supplier ?? a.info.beneficiary,
      companyId,
      sourceType: PARENT_ENTITE[owner.parent], sourceId: owner.id,
      chainFromId: choisis[0].id,
      custom: { facturePoste: { controle } } as unknown as Prisma.InputJsonValue,
      createdById: a.user.id, updatedById: a.user.id,
      notes: `Facture du poste « ${item.label} » de ${a.info.ref} — couvre ${choisis.map((b) => b.reference ?? b.titre).join(", ")}.`,
    },
    select: { id: true },
  });
  const depot = await persistUploadedDocument(a.user.id, {
    entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: a.fichier, buffer: octets,
  }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "Dépôt impossible.", documentId: undefined }));
  if (!depot.ok) {
    await prisma.legalDocument.update({ where: { id: facture.id }, data: { status: "CANCELLED" } }).catch(sansBloquer("ad-pro-item-actions.deposerFactureSurPoste.legalDocument"));
    return { ok: false, error: `La facture n'a pas pu être enregistrée (${depot.error ?? "erreur"}).` };
  }
  // LES ANNEXES : chacune sur la MÊME pièce du registre, après la facture (qui reste la première : c'est elle qu'on ouvre).
  const annexesEchouees: string[] = [];
  for (const f of annexes) {
    const r = await persistUploadedDocument(a.user.id, {
      entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: f,
    }).catch(sansBloquer("ad-pro-item-actions.deposerFactureSurPoste.persistUploadedDocument", { ok: false as const }));
    if (!r.ok) annexesEchouees.push(f.name);
  }
  await rattacherPieceAuPoste({ itemId: item.id, legalDocumentId: facture.id, nature: "FACTURE", acteurId: a.user.id });
  for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, legalDocumentId: facture.id, acteurId: a.user.id });
  return { ok: true, factureId: facture.id, controle, annexesEchouees, avertissement: garde.probables.map((p) => p.phrase).join(" ") || null };
}

/** La phrase des annexes d'une facture — dite seulement quand il y en a. */
function phraseAnnexes(n: number, echouees: readonly string[]): string {
  if (n === 0) return "";
  const gardees = n - echouees.length;
  return (gardees > 0 ? ` ${gardees} pièce${gardees > 1 ? "s" : ""} jointe${gardees > 1 ? "s" : ""} à la facture.` : "")
    + (echouees.length > 0 ? ` Non enregistrée${echouees.length > 1 ? "s" : ""} : ${echouees.join(", ")}.` : "");
}

/** La phrase qui rend le contrôle d'une facture — cohérente, ou ses écarts et le geste qui reste. */
function phraseControleFacture(c: ControleFacture): string {
  return c.coherente
    ? `Luna la trouve cohérente avec le bon de commande${c.montant != null ? ` (${c.montant.toLocaleString("fr-FR")} DZD)` : ""} : la demande de paiement peut partir.`
    : `Incohérences avec le bon de commande : ${c.ecarts.join(" ")} Pour demander tout de même le paiement, argumentez et confirmez.`;
}

/**
 * DÉPOSER LA FACTURE D'UN POSTE À BON DE COMMANDE (Direction, 06/10) — la case « Facture » se débloque à la signature du
 * BC ; le fichier est lu, contrôlé contre le(s) BC, et le contrôle est dit. Le paiement se demande ensuite, depuis la
 * case paiement (`demanderPaiementPoste`).
 */
export async function deposerFacturePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent) && !canAllocate(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (VERSEMENT_SANS_BC.includes(item.kind)) return { ok: false, error: "Un sponsoring direct n'a pas de bon de commande : sa pièce se joint à la demande de paiement." };
  if (item.expenseOrderId) return { ok: false, error: await refusPaiementDejaDemande(item.expenseOrderId) };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  // PLUSIEURS PIÈCES (audit Ad & Pro, 14/10) : la première est la facture, lue et contrôlée ; les suivantes ses annexes.
  // Seule la première était gardée — les autres disparaissaient sans un mot.
  const joints = formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0);
  const fichier = joints[0] ?? null;
  if (!fichier) return { ok: false, error: "Joignez la facture." };
  const r = await enSerie(filePoste(id), () => deposerFactureSurPoste({
    user, poste: found, info, fichier, annexes: joints.slice(1), montantSaisi: fdNum(formData, "montant"), reference: fdStr(formData, "reference"),
    bcIds: formData.getAll("bcId").map(String).filter(Boolean),
  }));
  if (!r.ok) return r;
  await audit(user, owner.parent, owner.id, "UPDATE", `Facture déposée pour le poste « ${item.label} »${joints.length > 1 ? ` (${joints.length} pièces)` : ""} — ${r.controle.coherente ? "cohérente avec le bon de commande" : `écarts : ${r.controle.ecarts.join(" ")}`}`);
  revalidate(owner.parent, owner.id);
  return {
    ok: true, id: r.factureId,
    message: `Facture déposée.${phraseAnnexes(joints.length - 1, r.annexesEchouees)} ${phraseControleFacture(r.controle)}${r.avertissement ? ` ${r.avertissement}` : ""}`,
    ...(r.avertissement ? { avertissement: r.avertissement } : {}),
  };
}

/**
 * LA DEMANDE DE PAIEMENT D'UN POSTE À BC, SUR SES FACTURES DÉPOSÉES. Tous les BC vivants signés et couverts ; une facture
 * incohérente exige l'argumentation ET la confirmation (`refusDemandePaiementBC`) ; le montant est celui des factures, et
 * ne dépasse jamais l'accordé.
 */
async function payerLesFacturesDuPoste(a: {
  user: SessionUser; item: PosteAvecOperation["item"]; owner: PosteAvecOperation["owner"]; info: ParentInfo; montantAccorde: number | null;
  fichier: File | null; montantSaisi: number | null; reference: string | null; bcIds: string[]; argumentation: string | null; confirme: boolean;
  /** Les autres pièces jointes avec la facture (annexes) — gardées avec elle. */
  annexes?: File[];
}): Promise<ActionResult> {
  const { user, item, owner, info } = a;
  const id = item.id;
  let deposee: string | null = null;
  const avant = (await piecesDesPostes([id])).get(id);
  // SANS FACTURE DÉPOSÉE, la facture se joint ICI — et ce qui la refuserait se dit AVANT de déposer quoi que ce soit
  // (§118.18) : un refus ne laisse ni facture ni ordre derrière lui.
  if (!(avant?.factures ?? []).some((f) => !f.annulee) || a.fichier) {
    if (!avant?.bc) return { ok: false, error: "Le bon de commande de ce poste n'est pas encore établi : la facture se dépose après lui." };
    if (avant.bc.etape !== "SIGNE") return { ok: false, error: "Le bon de commande n'est pas encore signé par les Finances : la facture se dépose après la signature." };
    if (!a.fichier) return { ok: false, error: "Joignez la facture : elle est obligatoire pour demander le paiement." };
    if (a.montantSaisi === null || !(a.montantSaisi > 0)) return { ok: false, error: "Indiquez le montant de la facture." };
    if (a.montantAccorde !== null && a.montantSaisi > a.montantAccorde) {
      return { ok: false, error: `La facture (${a.montantSaisi.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${a.montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` };
    }
  }

  // L'ÉTAT D'ABORD, PUIS LA FACTURE (§118.18, §118.187). Le dernier rempart et la prise ne dépendent pas de la facture :
  // ils se jugent AVANT de la déposer. Régression de a0794039 (06/10, « facture contrôlée avant paiement ») : ce chemin
  // déposait la facture d'abord — un visa rouvert laissait une facture rattachée à un poste dont le paiement était refusé,
  // et de deux clics simultanés le perdant était refusé par le dépôt (« a déjà sa facture »), non par la prise, donc pas
  // entre deux processus. Le chemin du sponsoring direct (`demanderPaiementPoste`) a toujours suivi cet ordre.
  // LE DERNIER REMPART (§118.187) : ce qui part ne dépasse jamais ce que le centre a vu.
  if (item.orderStage === "DIRECTION_OK") {
    const apres = { montant: a.montantAccorde, fournisseur: item.supplier };
    const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
    if (geste.geste === "ROUVRIR") {
      const phrase = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info.ref });
      return { ok: false, error: `Paiement refusé — ${phrase ?? geste.motif}` };
    }
  }
  // LA PRISE (§118.187) : un poste à la fois — deux clics ne déposent pas deux factures et ne demandent pas deux paiements.
  const etapeLue = item.orderStage;
  const prise = await prisma.adProItem.updateMany({
    where: { id, expenseOrderId: null, status: "APPROVED", orderStage: etapeLue },
    data: { orderStage: "ISSUED", updatedById: user.id },
  });
  if (prise.count === 0) return { ok: false, error: "Ce poste vient de changer (paiement déjà demandé, ou sa décision a été revue) : rouvrez la fiche." };
  // Tout refus qui suit RELÂCHE la prise (la facture déposée, elle, reste : elle s'argumente ensuite).
  const relacher = () => prisma.adProItem.updateMany({ where: { id, expenseOrderId: null, orderStage: "ISSUED" }, data: { orderStage: etapeLue } }).catch(sansBloquer("ad-pro-item-actions.relacher.adProItem"));
  const refuser = async (r: ActionResult): Promise<ActionResult> => { await relacher(); return r; };

  if (a.fichier) {
    // Jointe à la demande, la facture couvre ce qui attend encore la sienne : tous les BC signés sans facture.
    const couverts = new Set((avant?.factures ?? []).filter((f) => !f.annulee).flatMap((f) => f.controle?.bcIds ?? []));
    const bcIds = a.bcIds.length > 0 ? a.bcIds : (avant?.bcs ?? []).filter((b) => b.etape === "SIGNE" && !couverts.has(b.id)).map((b) => b.id);
    const r = await enSerie(filePoste(id), () => deposerFactureSurPoste({
      user, poste: { item, owner } as PosteAvecOperation, info, fichier: a.fichier as File, annexes: a.annexes, montantSaisi: a.montantSaisi, reference: a.reference, bcIds,
    })).catch((err: unknown) => {
      console.error("[ad-pro-item] dépôt de la facture impossible", err);
      return { ok: false as const, error: "La facture n'a pas pu être enregistrée." };
    });
    if (!r.ok) return refuser(r);
    deposee = `Facture déposée.${phraseAnnexes((a.annexes ?? []).length, r.annexesEchouees)} ${phraseControleFacture(r.controle)}${r.avertissement ? ` ${r.avertissement}` : ""}`;
  }
  const pieces = (await piecesDesPostes([id])).get(id);
  const factures = (pieces?.factures ?? []).filter((f) => !f.annulee);
  const refus = refusDemandePaiementBC({
    bcs: (pieces?.bcs ?? []).map((b) => ({ id: b.id, reference: b.reference, signe: b.etape === "SIGNE" })),
    factures, argumentation: a.argumentation, confirme: a.confirme,
  });
  if (refus) return refuser({ ok: false, error: deposee ? `${deposee} ${refus}` : refus });
  const montants = factures.map((f) => f.controle?.montant ?? f.montant);
  const montant = montants.every((m): m is number => m != null) ? Math.round(montants.reduce((s, m) => s + m * 100, 0)) / 100 : a.montantSaisi;
  if (montant === null || !(montant > 0)) return refuser({ ok: false, error: "Le montant de la facture ne se lit pas : indiquez-le." });
  if (a.montantAccorde !== null && montant > a.montantAccorde) {
    return refuser({ ok: false, error: `La facture (${montant.toLocaleString("fr-FR")} DZD) dépasse le montant accordé (${a.montantAccorde.toLocaleString("fr-FR")} DZD) : demandez une révision du poste.` });
  }
  const ecarts = factures.flatMap((f) => (f.controle && !f.controle.coherente ? f.controle.ecarts : []));
  const argument = ecarts.length > 0 ? a.argumentation?.trim() ?? null : null;
  // À QUI PART L'ARGENT (audit Ad & Pro, 14/10) : au fournisseur que les factures NOMMENT (celui du BC signé), pas au texte
  // libre « prestataire » du poste — souvent vide, et alors l'ordre partait au nom de l'OPÉRATION (le congrès « ESMO 2026 »,
  // l'institution d'un sponsoring) alors que la facture était celle de l'hôtel. Un seul fournisseur sur toutes les factures,
  // sinon le prestataire du poste, sinon le bénéficiaire de l'opération, comme avant.
  const tiersFactures = factures.length > 0
    ? await prisma.legalDocument.findMany({ where: { id: { in: factures.map((f) => f.id) } }, select: { counterparty: true } })
    : [];
  const beneficiaire = beneficiaireDuPaiement(tiersFactures.map((t) => t.counterparty), item.supplier, info.beneficiary);
  let ordreNe = false;
  try {
    const order = await createExpenseOrder({
      label: `${info.ref} — ${ITEM_KIND_LABELS[item.kind]} : ${item.label}`,
      amount: montant,
      category: "EVENEMENT",
      beneficiary: beneficiaire,
      sourceType: owner.parent === "EVENT" ? "EVENT" : owner.parent,
      sourceId: info.id,
      requestedById: user.id,
      budgetCategoryId: item.budgetCategoryId ?? null,
      requiresInvoice: facturePourPayer(item.kind),
      notes: `Poste de l'opération ${info.ref} — ${factures.length > 1 ? `${factures.length} factures jointes` : "facture jointe"}, contrôlée${factures.length > 1 ? "s" : ""} contre le bon de commande.`
        + (argument ? ` ÉCART ASSUMÉ par le demandeur : ${ecarts.join(" ")} Argumentation : « ${argument} ».` : ""),
    });
    ordreNe = true;
    await prisma.adProItem.update({ where: { id }, data: { expenseOrderId: order.id, orderStage: "ISSUED", updatedById: user.id } });
    await prisma.legalDocument.updateMany({ where: { id: { in: factures.map((f) => f.id) } }, data: { expenseOrderId: order.id } });
    await audit(user, owner.parent, owner.id, "UPDATE",
      `Paiement demandé pour le poste « ${item.label} » — ${montant.toLocaleString("fr-FR")} DZD (ordre ${order.reference}, au centre de paiement)${argument ? ` malgré l'écart avec le bon de commande — « ${argument} »` : ""}.`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/finances/paiements-a-faire");
    return {
      ok: true, id: order.id,
      message: `${deposee ? `${deposee} ` : ""}Paiement de ${montant.toLocaleString("fr-FR")} DZD demandé au centre de paiement (${order.reference}).`,
    };
  } catch (err) {
    console.error("[ad-pro-item] demande de paiement impossible", err);
    if (!ordreNe) await prisma.adProItem.updateMany({ where: { id, expenseOrderId: null, orderStage: "ISSUED" }, data: { orderStage: etapeLue } }).catch(sansBloquer("ad-pro-item-actions.payerLesFacturesDuPoste.adProItem"));
    return { ok: false, error: "La demande de paiement n'a pas pu être enregistrée." };
  }
}

/**
 * LE BC D'UN POSTE QU'ON PEUT MODIFIER — la porte de « Modifier le BC » et de son aperçu, une seule fois : le poste existe et
 * s'édite, son paiement n'est pas demandé, le BC lui est rattaché et n'est PAS SIGNÉ (un BC signé ne se modifie plus depuis
 * le poste : il se remplace avec les Finances).
 */
async function bcModifiableDuPoste(user: Awaited<ReturnType<typeof requireUser>>, formData: FormData): Promise<
  | { ok: true; item: NonNullable<Awaited<ReturnType<typeof loadItem>>>["item"]; owner: NonNullable<Awaited<ReturnType<typeof loadItem>>>["owner"]; info: { ref: string }; legalDocumentId: string }
  | { ok: false; error: string }
> {
  const id = fdStr(formData, "id");
  const legalDocumentId = fdStr(formData, "legalDocumentId") ?? fdStr(formData, "revisionDe");
  if (!id || !legalDocumentId) return { ok: false, error: "Bon de commande non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (item.expenseOrderId) return { ok: false, error: "Le paiement de ce poste est déjà demandé : son bon de commande ne se modifie plus." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const lien = await prisma.adProItemPiece.findFirst({ where: { itemId: id, legalDocumentId, nature: "BON_DE_COMMANDE" }, select: { legalDocument: { select: { signedAt: true, reference: true } } } });
  if (!lien) return { ok: false, error: "Ce bon de commande n'est pas rattaché à ce poste." };
  // SIGNÉ, SEUL SON NUMÉRO SE MODIFIE ENCORE (Direction, 14/10/2026) — jugé au serveur en comparant la pièce et la saisie : le
  // BC garde alors son état et sa signature. Toute autre modification se fait avec les Finances.
  if (lien.legalDocument.signedAt && !(await estRevisionDeNumeroSeul(user, legalDocumentId, lireModificationsDuBc(formData)))) {
    return { ok: false, error: `Le bon de commande ${lien.legalDocument.reference ?? ""} est signé : il ne se modifie plus (seul son numéro de référence peut encore changer). Voyez avec les Finances pour le remplacer.` };
  }
  return { ok: true, item, owner, info, legalDocumentId };
}

/**
 * L'APERÇU DU BC MODIFIÉ, depuis le poste — la même composition que la modification (`previsualiserRevision`, à blanc),
 * sous la délégation du poste : le demandeur voit les totaux de SON bon de commande sans droit Legal. Rien n'est écrit.
 */
export async function previsualiserBcDuPoste(formData: FormData): Promise<ApercuPiece | { ok: false; error: string }> {
  const user = await requireUser();
  const lu = await bcModifiableDuPoste(user, formData);
  if (!lu.ok) return { ok: false, error: lu.error };
  const modifications = lireModificationsDuBc(formData);
  const r = await previsualiserRevision(user, { legalDocumentId: lu.legalDocumentId, modifications }, {
    delegation: `${lu.info.ref} — poste « ${lu.item.label} » : aperçu de son bon de commande par le demandeur du poste`,
  });
  if (!r.ok) return { ok: false, error: r.motif };
  return apercuPourEcran(r, true);
}

/**
 * MODIFIER LE BON DE COMMANDE GÉNÉRÉ, EN NATIF ET SANS LIMITE (Direction, 06/10) — tant qu'il n'est pas signé. Chaque
 * modification est une nouvelle VERSION du même BC (même numéro) : le Word et le PDF sont régénérés, la fiche suit, et le
 * BC se réaiguille (un montant relevé le renvoie à son centre). Le demandeur du poste le fait sans droit d'écriture
 * Legal : le poste qu'il porte est la délégation, nommée au journal.
 */
export async function modifierBcDuPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lu = await bcModifiableDuPoste(user, formData);
  if (!lu.ok) return { ok: false, error: lu.error };
  const { item, owner, info, legalDocumentId } = lu;
  // TOUT SE MODIFIE (Direction, 10/2026 — « chaque écriture et détail ») : le formulaire est celui du composeur de pièces,
  // lu champ par champ — ce qu'il ne porte pas garde sa valeur (§118.152).
  const modifications = lireModificationsDuBc(formData);
  if (Object.keys(modifications).length === 0) return { ok: false, error: "Rien à modifier : changez une ligne, le fournisseur, une date, une condition, la livraison, le contact, les notes ou les mentions." };
  const refusSaisie = refusDeLaSaisie(modifications);
  if (refusSaisie) return { ok: false, error: refusSaisie };
  const champ = (cle: string): string | null => { const v = fdStr(formData, cle); return v && v.trim() ? v.trim() : null; };
  const accorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  const delegation = `${info.ref} — poste « ${item.label} » : son bon de commande, modifié par le demandeur du poste`;
  // LE PLAFOND DE L'ACCORDÉ, LE MÊME QU'À LA GÉNÉRATION (audit M-03) : le TTC que la fabrique composera pour CE BC révisé —
  // remises, TVA, taxes comprises — prend la place des lignes de son devis, et l'accordé s'entend TTC. Le HT seul laissait passer
  // un BC de 440 000 HT (523 600 TTC) pour 450 000 accordés, que la génération aurait refusé.
  if (accorde !== null) {
    const essai = await previsualiserRevision(user, { legalDocumentId, modifications }, { delegation });
    if (essai.ok && essai.totaux) {
      const tous = ((await devisDesPostes([item.id])).get(item.id) ?? []).filter((d) => !d.annule);
      const source = tous.find((d) => d.bc?.id === legalDocumentId);
      const posteDuBC = { item: { id: item.id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: accorde }, ref: info.ref, societe: "" };
      const depasse = refusPlafondDuPoste(posteDuBC, tous, accorde, {
        totaux: new Map([[source?.pieceId ?? legalDocumentId, { ht: essai.totaux.totalHt, ttc: essai.totaux.totalTtc }]]),
      });
      if (depasse) return { ok: false, error: depasse };
    }
  }
  const vue = fdNum(formData, "versionVue");
  const r = await reviserDocumentDrive(user, {
    legalDocumentId, modifications, motif: champ("motif") ?? "Modifié depuis le poste Ad & Pro.",
    versionVue: vue !== null && Number.isInteger(vue) ? vue : null,
  }, { delegation });
  if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande ${r.reference} du poste « ${item.label} » modifié — version ${r.version}, ${r.totaux.totalTtc.toLocaleString("fr-FR")} DZD TTC.`);
  revalidate(owner.parent, owner.id);
  revalidatePath(`/legal/${legalDocumentId}`);
  revalidatePath(CHEMIN_BC_A_SIGNER);
  return {
    ok: true, id: legalDocumentId,
    message: r.numeroSeul
      ? `Bon de commande ${r.reference} : seul le numéro a changé (version ${r.version}, Word et PDF régénérés) — son circuit et sa signature sont conservés.`
      : `Bon de commande ${r.reference} modifié : version ${r.version}, Word et PDF régénérés.${r.reserveBonDeCommande ? ` ${r.reserveBonDeCommande}` : ""}`,
  };
}

/**
 * DÉPOSER LE DEVIS OU LA PRO FORMA DE L'AGENCE POUR UN VOYAGEUR. Délègue à `ajouterDevisPoste` (le même
 * fichier exigé, les mêmes refus, la pièce au registre Legal), sans devis commun : celui-ci ne couvre que
 * son poste. Puis le lien « pour ce voyageur ». Si le voyageur a été retiré entre-temps, le devis reste
 * un devis du poste, et la phrase le dit.
 */
export async function ajouterDevisVoyageur(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const voyageurId = fdStr(formData, "voyageurId");
  if (!voyageurId) return { ok: false, error: "Voyageur non précisé." };
  const found = await chargerVoyageur(voyageurId, user);
  if (!found) return { ok: false, error: "Voyageur introuvable." };
  const { voyageur: v, item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  formData.delete("autresPostes");
  // La proposition d'UN voyageur est un devis : ses fichiers en sont les pages (le lien « pour ce voyageur » porte sur un devis).
  formData.delete("unDevisParFichier");
  formData.set("id", item.id);
  // LA MÊME PIÈCE NE SE DÉPOSE PAS DEUX FOIS (Direction, 10/2026) : la pro forma de l'agence couvre souvent TOUS les voyageurs.
  // La redéposer pour chacun créait autant de devis, chacun lu et validé d'office, et la carte du BC les additionnait
  // (5 × 117 250 DZD pour une seule pièce). Le même fichier rejoint ce voyageur s'il n'est à personne ; sinon, il n'est
  // pas dupliqué, et la phrase le dit.
  const fichiers = formData.getAll("attachment").filter((x): x is File => x instanceof File && x.size > 0);
  const deja = await devisDuMemeFichier(item.id, fichiers);
  if (deja) {
    if (deja.voyageur?.id === voyageurId) {
      return { ok: true, id: deja.legalDocumentId, message: `Cette pièce est déjà déposée pour ${nomComplet(v)} (« ${deja.nom} ») : rien n'a été ajouté.` };
    }
    if (!deja.voyageur) {
      const lie = await prisma.adProVoyageurDevis.create({ data: { voyageurId, pieceId: deja.itemPieceId, createdById: user.id }, select: { id: true } }).catch(sansBloquer("ad-pro-item-actions.ajouterDevisVoyageur.adProVoyageurDevis", null));
      if (lie) {
        await audit(user, owner.parent, owner.id, "UPDATE", `Devis « ${deja.nom} » du poste « ${item.label} » rattaché au voyageur « ${nomComplet(v)} » (même fichier, non dupliqué).`);
        revalidate(owner.parent, owner.id);
        return { ok: true, id: deja.legalDocumentId, message: `Cette pièce est déjà sur le poste (« ${deja.nom} ») : elle est rattachée à ${nomComplet(v)}, sans être enregistrée une seconde fois.` };
      }
    }
    return {
      ok: true, id: deja.legalDocumentId,
      message: `Cette pièce est déjà déposée sur le poste${deja.voyageur ? ` pour ${deja.voyageur.nom}` : ""} (« ${deja.nom} ») : elle n'est pas enregistrée une seconde fois — `
        + "une même pro forma de l'agence vaut pour tous les voyageurs qu'elle couvre, et le bon de commande se génère d'après ses lignes (case « Bon de commande »).",
    };
  }
  const depose = await ajouterDevisPoste(undefined, formData);
  if (!depose.ok || !depose.id) return depose;
  const piece = await prisma.adProItemPiece.findUnique({
    where: { itemId_legalDocumentId: { itemId: item.id, legalDocumentId: depose.id } }, select: { id: true },
  });
  const lie = piece
    ? await prisma.adProVoyageurDevis.create({ data: { voyageurId, pieceId: piece.id, createdById: user.id }, select: { id: true } }).catch(sansBloquer("ad-pro-item-actions.ajouterDevisVoyageur.adProVoyageurDevis", null))
    : null;
  revalidate(owner.parent, owner.id);
  if (!lie) {
    return { ok: false, error: `Le devis est déposé sur le poste, mais ${nomComplet(v)} vient d'être retiré des voyageurs : il reste un devis du poste.` };
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Devis déposé pour le voyageur « ${nomComplet(v)} » du poste « ${item.label} ».`);
  return { ok: true, id: depose.id, message: `${depose.message ?? "Devis déposé."} Pour ${nomComplet(v)} — validez-le quand il convient.` };
}

/**
 * LE FICHIER DÉJÀ DÉPOSÉ SUR CE POSTE — la même pièce (mêmes octets) qu'un devis vivant du poste, et pour quel voyageur.
 * C'est ce qui faisait naître une pro forma par voyageur : la pièce de l'agence, déposée pour chacun, devenait N devis.
 */
async function devisDuMemeFichier(itemId: string, fichiers: readonly File[]) {
  if (fichiers.length === 0) return null;
  const voulues = new Set(await Promise.all(fichiers.map(async (f) => createHash("sha256").update(Buffer.from(await f.arrayBuffer())).digest("hex"))));
  const liens = await prisma.adProItemPiece.findMany({
    where: { itemId, nature: "DEVIS", legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, legalDocumentId: true, legalDocument: { select: { title: true, reference: true } },
      voyageur: { select: { voyageurId: true, voyageur: { select: { nom: true, prenom: true } } } },
    },
  });
  if (liens.length === 0) return null;
  const empreintes = await empreintesDesDevis(liens.map((l) => l.legalDocumentId));
  const meme = liens.find((l) => (empreintes.get(l.legalDocumentId) ?? []).some((e) => voulues.has(e)));
  if (!meme) return null;
  return {
    itemPieceId: meme.id, legalDocumentId: meme.legalDocumentId, nom: meme.legalDocument.reference?.trim() || meme.legalDocument.title,
    voyageur: meme.voyageur ? { id: meme.voyageur.voyageurId, nom: nomComplet(meme.voyageur.voyageur) } : null,
  };
}
