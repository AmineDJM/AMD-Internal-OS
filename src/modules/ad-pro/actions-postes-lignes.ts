"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { moneyEntityOf } from "@/lib/company";
import { notifyRoles } from "@/lib/notify";
import { type AdProParent, VERSEMENT_SANS_BC, noteApresCorrection, refusChangementDeValidation, refusEditionDesLignes, refusGenerationBC, refusTauxDuDevis, type LigneDevisPoste } from "@/modules/ad-pro/partage";
import { enSerie } from "@/lib/refs";
import { fdStr, fdCase, type ActionResult } from "@/lib/actions/types";
import { refusSiPorteDgFermee, lireLaMarcheDuBC, notificationDuCentreBC, REFUS_MARCHE_PRISE, demandesBCDesPostes, devisDesPostes, genererLesBCsDuPoste, phraseBilanGeneration, refusPlafondDuPoste, tiersDuDevis, apercuDuBC, composerApercuDuBC, lignesDuBCDuDevis, composerBrouillonExcel, type ApercuDuBC, type PosteAGenerer } from "@/modules/ad-pro/api";
import { motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { CHEMIN_BC_A_SIGNER, aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { refusArgentSurPosteStock } from "@/lib/promo/reservations";
import { Prisma } from "@prisma/client";
import { readFileByKey } from "@/lib/storage";
import { resolveParties } from "@/lib/queries/company-contacts";
import { ingererDevisDuPoste, phraseDeLecture } from "@/lib/pieces-lues/devis-poste-lecture";
import { ETAPE_BROUILLON_EXCEL, ETIQUETTE_BROUILLON, REFUS_VALIDATION_BROUILLON, brouillonCorrige, brouillonNeuf, correctionsDuBrouillon, lireBrouillon, peutValiderLeBrouillon, type BrouillonBc } from "@/lib/bons-de-commande/brouillon";
import { refusDeLaSaisie } from "@/lib/bons-de-commande/saisie-composeur";
import { papeterieDeLaSociete } from "@/lib/queries/letterheads";
import { saisieEffective } from "@/lib/references/registre";
import { apercuPourEcran, type ApercuPiece } from "@/platform/ia/artifact/factory";
import { sansBloquer } from "@/lib/journal";
import { PARENTS, revalidate, canEditItems, canAllocate, audit, refusDemandeFermee, loadItem, REFUS_HISTORIQUE, lireModificationsDuBc, filePoste, devisDuPoste } from "./infra/postes/commun";
import type { AdProItemKind } from "@prisma/client";
import { notifyUser } from "@/lib/notify";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { persistUploadedDocument } from "@/lib/documents";
import { validateAttachments } from "@/lib/attach-files";
import { devisNonRetenus, notificationBrouillonPret, refusDepotVersionSignee } from "@/lib/bons-de-commande/version-signee";
import { ETAPE_COPIE_SIGNEE, FORMATS_COPIE_SIGNEE, phraseVerdictSignature, refusCopieSignee } from "@/lib/bons-de-commande/copie-signee";
import { verifierSignatureParLuna } from "@/lib/bons-de-commande/signature-luna";
import { marquerNonRetenus } from "@/lib/bons-de-commande/non-retenus";

/**
 * POSTES AD & PRO — LES LIGNES DES DEVIS ET LE BC GÉNÉRÉ (§118.206) : lire, corriger et valider les lignes
 * d'un devis, générer le bon de commande d'après elles, et son APERÇU relu, corrigé, imprimé ou annulé
 * par le demandeur avant d'être validé.
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

const fileDevis = (pieceId: string) => `ad-pro-devis:${pieceId}`;

/** Passe le poste, puis le devis, une personne à la fois — toujours dans cet ordre (jamais d'interblocage). */
const chez = <T,>(itemId: string, pieceId: string, fn: () => Promise<T>): Promise<T> =>
  enSerie(filePoste(itemId), () => enSerie(fileDevis(pieceId), fn));

class RefusLignes extends Error {}

const peutTraiterLesDevis = (user: SessionUser, parent: AdProParent): boolean => canEditItems(user, parent) || canAllocate(user, parent);

/** Ce que tout geste sur les lignes d'un devis vérifie d'abord — le poste, la porte, l'argent, la demande. */
async function cadreDesLignes(user: SessionUser, formData: FormData) {
  const id = fdStr(formData, "id");
  const pieceId = fdStr(formData, "pieceId");
  if (!id || !pieceId) return { error: "Poste ou devis non précisé." } as const;
  const found = await loadItem(id, user);
  if (!found) return { error: "Poste introuvable." } as const;
  if (found.historique) return { error: REFUS_HISTORIQUE } as const;
  const { item, owner } = found;
  if (!peutTraiterLesDevis(user, owner.parent)) return { error: "Non autorisé." } as const;
  const refusStock = refusArgentSurPosteStock(item.kind, "des lignes de devis");
  if (refusStock) return { error: refusStock } as const;
  if (item.status === "REJECTED") return { error: `Le poste « ${item.label} » est refusé : ses devis ne se traitent plus.` } as const;
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { error: "Un sponsoring direct n'a pas de bon de commande : la facture suffit — ses devis ne se valident pas ligne à ligne." } as const;
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { error: "Opération introuvable." } as const;
  const fermee = refusDemandeFermee(info);
  if (fermee) return { error: fermee } as const;
  return { id, pieceId, item, owner, info } as const;
}

/**
 * VALIDER LES LIGNES D'UN DEVIS POUR CE POSTE — l'ensemble REMPLACE le précédent : les lignes envoyées sont validées,
 * les autres ne le sont plus (décocher une ligne la retire). Une ligne se valide COMPLÈTE (quantité, prix lisibles) et
 * pour UN seul poste ; une ligne lue par la machine demande l'attestation « j'ai comparé au devis ».
 */
export async function validerLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner, info } = cadre;
  const demandees = new Set(formData.getAll("ligneId").map((x) => String(x).trim()).filter(Boolean));
  const compare = fdCase(formData, "compare") === true;
  const r = await chez(id, pieceId, async (): Promise<ActionResult> => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    if (!devis.structure) return { ok: false, error: "Ce devis n'a pas encore de lignes : faites-le lire, ou saisissez ses lignes, avant d'en valider." };
    // L'ÉTAT D'ABORD (§118.18) : un BC signé ou facturé fige les lignes validées de ce devis.
    const gel = refusChangementDeValidation(devis.bc);
    if (gel) return { ok: false, error: gel };
    const parId = new Map(devis.lignes.map((l) => [l.id, l]));
    if ([...demandees].some((l) => !parId.has(l))) return { ok: false, error: "Une des lignes n'appartient pas à ce devis : rechargez la fiche." };
    const aValider = [...demandees].filter((l) => !parId.get(l)!.validee);
    const aRetirer = devis.lignes.filter((l) => l.validee && !demandees.has(l.id)).map((l) => l.id);
    for (const lid of aValider) {
      const l = parId.get(lid)!;
      if (l.valideeAilleurs) return { ok: false, error: `« ${l.reference.slice(0, 60)} » est déjà validée pour le poste « ${l.valideeAilleurs} » : une ligne ne se commande qu'une fois — décochez-la là-bas d'abord.` };
      if (l.refusValidation) return { ok: false, error: l.refusValidation };
    }
    if (aValider.some((l) => parId.get(l)!.lue !== null) && compare !== true) {
      return { ok: false, error: "Cochez « J'ai comparé ces lignes au devis » : elles viennent de la lecture du fichier, et seule une personne qui les a vérifiées sur le papier peut les valider pour un bon de commande." };
    }
    if (aValider.length === 0 && aRetirer.length === 0) return { ok: true, id, message: "Rien n'a changé : les lignes validées sont celles que vous aviez déjà." };
    try {
      await prisma.$transaction(async (tx) => {
        if (aValider.length > 0) {
          const r = await tx.adProDevisLigne.updateMany({
            where: { id: { in: aValider }, devis: { legalDocumentId: pieceId }, OR: [{ validatedItemId: null }, { validatedItemId: id }] },
            data: { validatedItemId: id, validatedAt: new Date(), validatedById: user.id },
          });
          if (r.count !== aValider.length) throw new RefusLignes("Une ligne vient d'être validée pour un autre poste, ou retirée du devis : rechargez la fiche.");
        }
        if (aRetirer.length > 0) {
          await tx.adProDevisLigne.updateMany({
            where: { id: { in: aRetirer }, validatedItemId: id },
            data: { validatedItemId: null, validatedAt: null, validatedById: null },
          });
        }
      });
    } catch (e) {
      if (e instanceof RefusLignes) return { ok: false, error: e.message };
      throw e;
    }
    const apres = await devisDuPoste(id, pieceId);
    await audit(user, owner.parent, owner.id, "UPDATE",
      `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » : ${aValider.length} ligne${aValider.length > 1 ? "s" : ""} validée${aValider.length > 1 ? "s" : ""}, ${aRetirer.length} retirée${aRetirer.length > 1 ? "s" : ""}.`);
    revalidate(owner.parent, owner.id);
    const suite = apres?.etat === "A_REGENERER" ? " Le bon de commande de ce devis n'est plus à jour : régénérez-le." : "";
    return {
      ok: true, id,
      message: `${apres?.nbValidees ?? 0} ligne${(apres?.nbValidees ?? 0) > 1 ? "s" : ""} validée${(apres?.nbValidees ?? 0) > 1 ? "s" : ""} pour ce poste (${(apres?.entete.tvaRate === null ? (apres?.totalValideHt ?? 0) : (apres?.totalValideTtc ?? 0)).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DZD ${apres?.entete.tvaRate === null ? "HT, TVA non indiquée" : "TTC"}).${suite}`,
    };
  });
  // LE BROUILLON EXCEL NAÎT DE LA VALIDATION (Direction, 11/2026) — ou se refait, ou disparaît avec la dernière ligne décochée.
  if (!r.ok) return r;
  const brouillon = await preparerLesBrouillonsExcel(user, { item, owner }, info).catch((e) => {
    console.error("[ad-pro] brouillon Excel du BC", e);
    return "Le brouillon du bon de commande n'a pas pu être préparé : « Préparer le brouillon » le relance.";
  });
  if (brouillon) revalidate(owner.parent, owner.id);
  return brouillon ? { ...r, message: `${r.message ?? ""} ${brouillon}`.trim() } : r;
}

/** Un nombre saisi : « 4 800 », « 4 800,5 » ; vide → `null` ; illisible → `NaN`. */
function nombreSaisi(brut: string): number | null {
  const t = brut.replace(/\s/g, "").replace(",", ".");
  return t === "" ? null : Number(t);
}

/**
 * SAISIR OU CORRIGER LES LIGNES D'UN DEVIS — la retranscription à la main, ou la correction de ce que la lecture
 * a proposé. Une ligne qui garde son identifiant est modifiée en place ; une ligne dont le CONTENU change perd sa
 * validation (l'attestation portait sur l'ancien prix) ; une ligne absente est retirée. Refusé tant qu'un BC actif
 * porte une ligne de ce devis (§118.206 : régénérer, ou annuler le BC d'abord).
 */
export async function enregistrerLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner } = cadre;

  const ids = formData.getAll("ligneId").map((x) => String(x ?? "").trim());
  const refs = formData.getAll("ligneReference").map((x) => String(x ?? "").trim());
  const unites = formData.getAll("ligneUnite").map((x) => String(x ?? "").trim());
  const quantites = formData.getAll("ligneQuantite").map((x) => String(x ?? "").trim());
  const prix = formData.getAll("lignePrix").map((x) => String(x ?? "").trim());
  const n = Math.max(refs.length, quantites.length, prix.length);
  const lignes: { ligneId: string | null; reference: string; unit: string | null; quantity: number | null; unitPrice: number | null }[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = refs[i] ?? "";
    const q = quantites[i] ?? "";
    const p = prix[i] ?? "";
    if (!r && !q && !p) continue; // une rangée de saisie inutilisée
    if (!r) return { ok: false, error: `Ligne ${i + 1} : la référence (ou désignation) est obligatoire.` };
    const quantity = nombreSaisi(q);
    const unitPrice = nombreSaisi(p);
    if (quantity !== null && !(quantity > 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : la quantité doit être un nombre supérieur à zéro (vide si elle est illisible).` };
    if (unitPrice !== null && !(unitPrice >= 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : le prix unitaire doit être un nombre positif (vide s'il est illisible).` };
    lignes.push({ ligneId: ids[i] || null, reference: r, unit: (unites[i] ?? "") || null, quantity, unitPrice });
  }
  const tvaSaisie = nombreSaisi(fdStr(formData, "tvaRate") ?? "");
  if (tvaSaisie !== null && !(tvaSaisie >= 0 && tvaSaisie <= 100)) return { ok: false, error: "Le taux de TVA s'exprime en pour cent, entre 0 et 100." };
  if (tvaSaisie !== null) {
    const tauxRefuse = refusTauxDuDevis(tvaSaisie);
    if (tauxRefuse) return { ok: false, error: tauxRefuse };
  }
  const taxeSaisie = nombreSaisi(fdStr(formData, "extraTaxRate") ?? "");
  if (taxeSaisie !== null && !(taxeSaisie > 0 && taxeSaisie < 100)) return { ok: false, error: "La taxe additionnelle s'exprime en pour cent, au-dessus de 0 et sous 100 (laissez vide s'il n'y en a pas)." };
  const totalSaisi = nombreSaisi(fdStr(formData, "announcedTotal") ?? "");
  if (totalSaisi !== null && !(totalSaisi >= 0)) return { ok: false, error: "Le total annoncé sur le devis doit être un montant positif." };
  const supplierId = fdStr(formData, "supplierId");
  let fournisseur: string | null = null;
  if (supplierId) {
    const parties = await resolveParties(user.id, [supplierId]);
    if (!parties.ok) return { ok: false, error: parties.error };
    fournisseur = parties.text;
  }

  const r = await chez(id, pieceId, async (): Promise<ActionResult> => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    // Les BC ACTIFS qui portent une ligne : lus en base, jamais sur la parole de la vue (le `bcId` d'un BC annulé ne gèle rien).
    const portees = await prisma.adProDevisLigne.findMany({
      where: { devis: { legalDocumentId: pieceId }, bcId: { not: null }, bc: { status: { not: "CANCELLED" }, cancelledAt: null } },
      select: { id: true, bcId: true, bc: { select: { id: true, reference: true } } },
    });
    const gel = refusEditionDesLignes(
      portees.map((l): LigneDevisPoste => ({ id: l.id, position: 0, reference: "-", unit: null, quantity: 1, unitPrice: 0, lue: null, aVerifier: null, validatedItemId: null, bcId: l.bcId })),
      [...new Map(portees.filter((l) => l.bc).map((l) => [l.bc!.id, { id: l.bc!.id, reference: l.bc!.reference }])).values()],
    );
    if (gel) return { ok: false, error: gel };
    const existantes = await prisma.adProDevisLigne.findMany({
      where: { devis: { legalDocumentId: pieceId } },
      select: { id: true, reference: true, unit: true, quantity: true, unitPrice: true, validatedItemId: true },
    });
    const parId = new Map(existantes.map((l) => [l.id, l]));
    const inconnues = lignes.filter((l) => l.ligneId && !parId.has(l.ligneId));
    if (inconnues.length > 0) return { ok: false, error: "Une ligne n'appartient plus à ce devis : rechargez la fiche avant de l'enregistrer." };
    const gardees = new Set(lignes.map((l) => l.ligneId).filter((x): x is string => Boolean(x)));
    const doc = await prisma.legalDocument.findUnique({ where: { id: pieceId }, select: { reference: true } });
    const donnees = {
      // Un champ TVA VIDE efface la TVA (« le devis n'en porte pas ») : on ne remet jamais un 19 de repli.
      ...(formData.has("tvaRate") ? { tvaRate: tvaSaisie !== null ? new Prisma.Decimal(tvaSaisie) : null } : {}),
      ...(formData.has("extraTaxRate") ? { extraTaxRate: taxeSaisie !== null ? new Prisma.Decimal(taxeSaisie) : null, extraTaxLabel: taxeSaisie !== null ? (fdStr(formData, "extraTaxLabel") ?? "Taxe additionnelle") : null } : {}),
      ...(formData.has("announcedTotal") ? { announcedTotal: totalSaisi !== null ? new Prisma.Decimal(totalSaisi) : null } : {}),
      ...(supplierId ? { supplierId } : {}),
      // Les doutes de la lecture sont tranchés par cette correction, faite devant le papier : ils ne restent pas affichés.
      ...(devis.entete.lectureNote && noteApresCorrection(devis.entete.lectureNote) !== devis.entete.lectureNote
        ? { lectureNote: noteApresCorrection(devis.entete.lectureNote) }
        : {}),
    };
    const quand = fdStr(formData, "quoteDate");
    const date = quand && !Number.isNaN(Date.parse(quand)) ? new Date(`${quand.slice(0, 10)}T00:00:00.000Z`) : null;
    let perdues = 0;
    await prisma.$transaction(async (tx) => {
      const entete = await tx.adProDevis.upsert({
        where: { legalDocumentId: pieceId },
        create: { legalDocumentId: pieceId, createdById: user.id, ...donnees, ...(date ? { quoteDate: date } : {}) },
        update: { ...donnees, ...(date ? { quoteDate: date } : {}) },
        select: { id: true },
      });
      const aRetirer = existantes.filter((l) => !gardees.has(l.id));
      if (aRetirer.length > 0) await tx.adProDevisLigne.deleteMany({ where: { id: { in: aRetirer.map((l) => l.id) } } });
      for (const [i, l] of lignes.entries()) {
        const avant = l.ligneId ? parId.get(l.ligneId) : undefined;
        const valeurs = {
          position: i, reference: l.reference, unit: l.unit,
          quantity: l.quantity !== null ? new Prisma.Decimal(l.quantity) : null,
          unitPrice: l.unitPrice !== null ? new Prisma.Decimal(l.unitPrice) : null,
        };
        if (!avant) {
          await tx.adProDevisLigne.create({ data: { ...valeurs, devisId: entete.id } });
          continue;
        }
        const change = avant.reference !== l.reference || (avant.unit ?? null) !== l.unit
          || (avant.quantity != null ? Number(avant.quantity) : null) !== l.quantity
          || (avant.unitPrice != null ? Number(avant.unitPrice) : null) !== l.unitPrice;
        // L'ATTESTATION PORTAIT SUR L'ANCIEN CONTENU : une ligne corrigée n'est plus celle qu'on avait validée.
        if (change && avant.validatedItemId) perdues += 1;
        await tx.adProDevisLigne.update({
          where: { id: avant.id },
          data: { ...valeurs, ...(change ? { validatedItemId: null, validatedAt: null, validatedById: null, aVerifier: null } : {}) },
        });
      }
      const nouvelleRef = fdStr(formData, "reference");
      if (nouvelleRef !== null || fournisseur) {
        await tx.legalDocument.update({
          where: { id: pieceId },
          data: { ...(nouvelleRef !== null && nouvelleRef !== doc?.reference ? { reference: nouvelleRef } : {}), ...(fournisseur ? { counterparty: fournisseur } : {}), updatedById: user.id },
        });
      }
    });
    await audit(user, owner.parent, owner.id, "UPDATE", `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » : ${lignes.length} ligne${lignes.length > 1 ? "s" : ""} enregistrée${lignes.length > 1 ? "s" : ""}.`);
    revalidate(owner.parent, owner.id);
    return {
      ok: true, id,
      message: `${lignes.length} ligne${lignes.length > 1 ? "s" : ""} enregistrée${lignes.length > 1 ? "s" : ""}.`
        + (perdues > 0 ? ` ${perdues} ligne${perdues > 1 ? "s" : ""} corrigée${perdues > 1 ? "s" : ""} n'est plus validée : revalidez-la devant le papier.` : ""),
    };
  });
  // UNE CORRECTION (lignes, TVA, taxe) REFAIT LE BROUILLON EXCEL sous le même numéro — ou le retire s'il n'a plus de ligne validée.
  if (!r.ok) return r;
  const brouillon = await preparerLesBrouillonsExcel(user, { item, owner }, cadre.info).catch(() => null);
  if (brouillon) revalidate(owner.parent, owner.id);
  return brouillon ? { ...r, message: `${r.message ?? ""} ${brouillon}`.trim() } : r;
}

/**
 * RELIRE UN DEVIS DÉJÀ DÉPOSÉ — pour un devis d'avant la lecture, ou dont la première lecture a échoué. Le fichier est
 * relu en base, jamais renvoyé par le formulaire. Les lignes proposées REMPLACENT les précédentes : refusé dès qu'une
 * ligne est validée ou qu'un BC en porte une (on ne remplace pas ce qu'une personne a attesté sans le lui dire).
 */
export async function lireLesLignesDuDevis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { ok: false, error: cadre.error };
  const { id, pieceId, item, owner } = cadre;
  return chez(id, pieceId, async () => {
    const devis = await devisDuPoste(id, pieceId);
    if (!devis) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    if (devis.bc) return { ok: false, error: `Ce devis porte déjà un bon de commande (${devis.bc.reference}) : il ne se relit plus d'ici — annulez le bon de commande d'abord.` };
    if (devis.lignes.some((l) => l.validee || l.valideeAilleurs)) {
      return { ok: false, error: "Des lignes de ce devis sont déjà validées : une relecture les remplacerait. Décochez-les d'abord (ou corrigez les lignes à la main)." };
    }
    const fichier = await prisma.document.findFirst({
      where: { entityType: "LEGAL_DOCUMENT", entityId: pieceId }, orderBy: { createdAt: "asc" },
      select: { name: true, fileKey: true, confidentiality: true },
    });
    if (!fichier?.fileKey) return { ok: false, error: "Ce devis n'a pas de fichier à lire : joignez-le d'abord." };
    const octets = await readFileByKey(fichier.fileKey).catch(sansBloquer("ad-pro-item-actions.lireLesLignesDuDevis.readFileByKey", null));
    if (!octets) return { ok: false, error: "Le fichier de ce devis est introuvable dans le stockage." };
    const ing = await ingererDevisDuPoste({
      userId: user.id, legalDocumentId: pieceId, octets, nomFichier: fichier.name, remplacer: true,
      sortieCloudPermise: fichier.confidentiality === "INTERNAL",
    });
    if (!ing.ok) return { ok: false, error: ing.raison };
    await audit(user, owner.parent, owner.id, "UPDATE", `Devis « ${devis.reference ?? devis.titre} » du poste « ${item.label} » relu : ${ing.nbLignes} ligne${ing.nbLignes > 1 ? "s" : ""} proposée${ing.nbLignes > 1 ? "s" : ""}.`);
    // PLUS DE VALIDATION D'OFFICE (Direction, 11/2026) : les lignes bien lues arrivent cochées ; une personne valide.
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: phraseDeLecture(ing) };
  });
}

/**
 * GÉNÉRER LE OU LES BONS DE COMMANDE D'UN POSTE d'après les lignes VALIDÉES de ses devis — UN BC PAR DEVIS, avec
 * uniquement ses lignes validées. `pieceId` : un seul devis ; absent : tous ceux qui ont quelque chose à générer.
 *
 * L'APERÇU EST OBLIGATOIRE (Direction, 14/10/2026 — « Je veux l'aperçu obligatoire ») : ce geste ne fait JAMAIS de BC. Il dépose
 * l'aperçu (un brouillon, sans numéro) de chaque devis à générer ; l'écran l'ouvre aussitôt dans le composeur, pré-rempli et prêt
 * à relire ; le demandeur corrige ce qu'il veut, puis « Valider et envoyer » (`validerEtEnvoyerBcPoste`) — le SEUL chemin qui
 * numérote, produit le Word et le PDF et aiguille le BC. Il n'y a plus de geste « en un clic » qui émettrait sans aperçu.
 *
 * Mêmes portes que « demander le BC » : le poste est accordé, son budget choisi, la demande n'est pas close, et
 * aucune demande de BC n'est ouverte chez l'assistante (deux chemins pour le même BC feraient deux commandes).
 * Le poste prend la marche du BC à la validation comme pour une demande — au-dessus du seuil le centre Ad & Pro le vise, une
 * fois, en deçà il passe à la signature des Finances. Les BC émis lisent CETTE porte (`portesDesBC`, source « POSTE »).
 */
export async function genererBonDeCommandePoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id")) return { ok: false, error: "Poste non précisé." };
  fdStr(formData, "pieceId"); // facultatif : un seul devis ; absent, tous ceux qui ont quelque chose à générer
  return traiterLeBCDuPoste(formData, "APERCU");
}

/**
 * VALIDER L'APERÇU ET L'ENVOYER AUX FINANCES (Direction, 10/2026) — « il faut d'abord pré-valider le preview du BC par le
 * demandeur, avec modification possible ». C'est ICI, et seulement ici, que le numéro NNN/DG/AAAA est attribué (donc sans trou :
 * un brouillon abandonné ne consomme rien), que le Word et le PDF définitifs sont produits et que la marche du BC démarre
 * (centre Ad & Pro au-dessus du seuil, puis signature des Finances). Le DEMANDEUR de la demande — ou le Super Admin — valide ;
 * l'assistante ou le collègue qui a préparé l'aperçu ne le valide pas à sa place.
 *
 * Envoyé DEPUIS LE COMPOSEUR (il porte ses champs), ce que le composeur montre est d'abord écrit sur le brouillon — sous les
 * mêmes gardes que « Enregistrer le brouillon » (saisie, péremption, plafond TTC) —, puis émis : ce qu'on a vu est ce qui part.
 */
export async function validerEtEnvoyerBcPoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id")) return { ok: false, error: "Poste non précisé." };
  fdStr(formData, "pieceId"); // facultatif : un seul devis ; absent, tous ceux dont l'aperçu existe
  if (formData.has("ligneDesignation") || formData.has("tiersNom")) {
    const ecrit = await ecrireApercuBcPoste(formData);
    if (!ecrit.ok) return ecrit;
  }
  return traiterLeBCDuPoste(formData, "VALIDER");
}

async function traiterLeBCDuPoste(formData: FormData, mode: "APERCU" | "VALIDER"): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const pieceVoulue = fdStr(formData, "pieceId");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil et sans sa validation, rien ne s'engage.
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un bon de commande");
  if (refusStock) return { ok: false, error: refusStock };
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { ok: false, error: "Un sponsoring direct n'a pas de bon de commande : déposez la facture (et, si vous l'avez, la pro forma) puis demandez le paiement." };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };
  if (mode === "VALIDER" && !peutValiderLeBrouillon({ userId: user.id, role: user.role, demandeurId: info.requesterId })) {
    return { ok: false, error: REFUS_VALIDATION_BROUILLON };
  }

  return enSerie(filePoste(id), async () => {
    // L'ÉTAT D'ABORD (§118.18) : tout ce qui interdit de générer se lit AVANT de demander quoi que ce soit.
    const poste = await prisma.adProItem.findUnique({
      where: { id },
      select: { status: true, orderStage: true, expenseOrderId: true, amountGranted: true, budgetCategoryId: true, supplier: true },
    });
    if (!poste) return { ok: false, error: "Poste introuvable." };
    const montantAccorde = poste.amountGranted != null ? toNumber(poste.amountGranted) : null;
    const ouverte = (await demandesBCDesPostes([id])).get(id);
    const refus = refusGenerationBC({
      status: poste.status, amountGranted: montantAccorde, budgetCategoryId: poste.budgetCategoryId, orderStage: poste.orderStage,
      expenseOrderId: poste.expenseOrderId, demandeChez: ouverte?.assistante, demandeOuverte: Boolean(ouverte),
    });
    if (refus) return { ok: false, error: refus };

    const tous = ((await devisDesPostes([id])).get(id) ?? []).filter((d) => !d.annule);
    const visees = pieceVoulue ? tous.filter((d) => d.pieceId === pieceVoulue) : tous;
    if (pieceVoulue && visees.length === 0) return { ok: false, error: "Ce devis n'est pas rattaché à ce poste." };
    const aFaireTous = visees.filter((d) => d.etat === "A_GENERER" || d.etat === "A_REGENERER");
    if (aFaireTous.length === 0) {
      const bloque = visees.find((d) => d.etat === "FIGE" || d.etat === "A_ANNULER");
      if (bloque?.refus) return { ok: false, error: bloque.refus };
      if (visees.some((d) => d.etat === "A_JOUR")) return { ok: true, id, message: "Chaque devis validé a déjà son bon de commande, à jour : rien de nouveau à générer." };
      const aPart = visees.find((d) => d.etat === "MIS_A_PART" && d.miseAPart);
      if (aPart?.miseAPart) return { ok: false, error: `${aPart.reference ?? aPart.titre} : ${aPart.miseAPart.phrase}` };
      return { ok: false, error: "Aucune ligne n'est validée : cochez, dans un devis, les lignes à commander, puis générez le bon de commande." };
    }
    // L'APERÇU d'abord : un devis qui a déjà son brouillon le garde (ses corrections ne sont jamais écrasées par un clic) ;
    // la VALIDATION, elle, ne porte que sur les devis dont l'aperçu existe — jamais sur un devis que personne n'a relu.
    const sansBrouillon = aFaireTous.filter((d) => !d.brouillon);
    if (mode === "APERCU" && sansBrouillon.length === 0) {
      return { ok: true, id, message: `${ETIQUETTE_BROUILLON} : l'aperçu existe déjà — relisez-le, corrigez au besoin, puis « Valider et envoyer aux Finances ».` };
    }
    const aFaire = mode === "APERCU" ? sansBrouillon : aFaireTous.filter((d) => d.brouillon);
    if (aFaire.length === 0) {
      return { ok: false, error: "Aucun aperçu de bon de commande à valider : générez d'abord l'aperçu (« Générer le bon de commande »), relisez-le, puis validez-le." };
    }
    const perime = aFaire.find((d) => d.brouillon?.perime);
    if (mode === "VALIDER" && perime) {
      return { ok: false, error: `${perime.reference ?? perime.titre} : les lignes validées du devis ont changé depuis l'aperçu — retirez-le et générez-le de nouveau avant de valider.` };
    }
    // LE PLAFOND DE L'ACCORDÉ — UNE règle, en TTC, à la génération comme à la validation (audit M-03) : un devis dont l'aperçu
    // est corrigé pèse ce que son BC corrigé pèsera (`refusPlafondDuPoste`), les autres leurs lignes validées.
    const posteGen = { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: montantAccorde }, ref: info.ref, societe: "" };
    const depasse = refusPlafondDuPoste(posteGen, tous, montantAccorde);
    if (depasse) return { ok: false, error: depasse };
    for (const d of aFaire) {
      if (d.etat !== "A_GENERER") continue;
      const corrections = d.brouillon ? correctionsDuBrouillon(d.brouillon) : {};
      // Un taux de TVA que le BC ne peut pas porter se dit AVANT la marche : la fabrique le refuserait après. Une TVA par défaut
      // CHOISIE dans l'aperçu remplace celle du papier.
      const tauxRefuse = corrections.tvaDefaut === undefined ? refusTauxDuDevis(d.entete.tvaRate) : null;
      if (tauxRefuse) return { ok: false, error: `${d.reference ?? d.titre} : ${tauxRefuse}` };
      const t = await tiersDuDevis(d, poste.supplier);
      if (!t.ok && !corrections.tiers?.nom) return { ok: false, error: `${d.reference ?? d.titre} : ${t.error}` };
    }
    const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    if (!societe) {
      return { ok: false, error: "La société qui commande est introuvable : la demande n'en nomme aucune, et la fiche salarié de son demandeur non plus. Renseignez la société du demandeur (RH › fiche salarié), puis relancez." };
    }

    // ── L'APERÇU : un BROUILLON sur chaque devis, et RIEN d'autre — ni numéro, ni pièce, ni marche, ni Finances. ──
    if (mode === "APERCU") {
      const maintenant = new Date();
      for (const d of aFaire) {
        const b = brouillonNeuf({ itemId: id, par: user.id, parNom: user.name ?? null, maintenant });
        await prisma.adProDevis.updateMany({ where: { legalDocumentId: d.pieceId }, data: { bcBrouillon: b as unknown as Prisma.InputJsonValue } });
      }
      await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » préparé (${aFaire.length} devis) — à vérifier par le demandeur ; aucun numéro attribué.`);
      revalidate(owner.parent, owner.id);
      const qui = info.requesterId && info.requesterId !== user.id ? " Le demandeur de la demande le valide." : "";
      return {
        ok: true, id,
        message: `${ETIQUETTE_BROUILLON} — ${aFaire.length} aperçu${aFaire.length > 1 ? "s" : ""} prêt${aFaire.length > 1 ? "s" : ""} : relisez, corrigez au besoin, puis « Valider et envoyer aux Finances ». Le numéro n'est attribué qu'à la validation.${qui}`,
      };
    }

    // LA MARCHE DU POSTE, comme une demande de BC — puis la composition. Prise avant : les BC lisent cette porte en naissant.
    let marche: { sousLeSeuil: boolean; seuilBC: number } | null = null;
    const etapeAvant = poste.orderStage;
    if (poste.orderStage === "NONE" || poste.orderStage === "REFUSED") {
      const prise = await lireLaMarcheDuBC({
        itemId: id, montantAccorde: montantAccorde as number, userId: user.id, assistantId: null,
        note: "Bon de commande généré d'après les lignes validées des devis du poste, aperçu validé par le demandeur.",
      });
      const posee = await prisma.adProItem.updateMany({ where: prise.where, data: prise.data });
      if (posee.count === 0) return { ok: false, error: REFUS_MARCHE_PRISE };
      if (!prise.sousLeSeuil) {
        await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], notificationDuCentreBC({ id: item.id, ref: info.ref, label: item.label, montantAccorde: montantAccorde as number })).catch(sansBloquer("ad-pro-item-actions.traiterLeBCDuPoste.notifyRoles"));
      }
      marche = { sousLeSeuil: prise.sousLeSeuil, seuilBC: prise.seuilBC };
    }
    // LA RÉFÉRENCE CHOISIE À LA VALIDATION (registre NNN/DG/AAAA, Direction 10/2026) : le champ est prérempli avec le prochain
    // numéro ; laissé tel quel, il ne fige rien (le prochain libre est attribué) ; modifié, c'est ce numéro-là, vérifié par la fabrique.
    const numeroDuFormulaire = pieceVoulue && formData.has("numeroChoisi")
      ? saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere"))
      : undefined;
    // UN BROUILLON EXCEL A DÉJÀ RÉSERVÉ SON NUMÉRO (Direction, 11/2026) : le BC le reprend — jamais un second numéro pour la même commande.
    const reserve = (d: (typeof aFaire)[number]) => (d.brouillon?.excel && !d.brouillon.excelPerime ? d.brouillon.excel : null);
    const bilan = await genererLesBCsDuPoste(
      user, { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: montantAccorde }, ref: info.ref, societe },
      aFaire.map((d) => d.pieceId),
      new Map(aFaire.filter((d) => d.brouillon).map((d) => [
        d.pieceId,
        (d.pieceId === pieceVoulue && numeroDuFormulaire !== undefined
          ? { ...(d.brouillon as BrouillonBc), numeroChoisi: numeroDuFormulaire }
          : reserve(d) ? { ...(d.brouillon as BrouillonBc), numeroChoisi: reserve(d)!.numero } : d.brouillon) as BrouillonBc,
      ])),
      { reservations: new Map(aFaire.filter((d) => reserve(d)).map((d) => [d.pieceId, reserve(d)!.entreeRegistre])) },
    );
    // Le fichier Excel du brouillon a fait son œuvre : il quitte le poste avec lui.
    const consommes = aFaire.filter((d) => reserve(d) && bilan.bcs.some((b) => b.devisPieceId === d.pieceId)).map((d) => reserve(d)!.documentId);
    if (consommes.length > 0) await prisma.document.deleteMany({ where: { id: { in: consommes }, entityType: "AD_PRO_ITEM", entityId: id } });
    // Les brouillons VALIDÉS sont consommés : le BC existe, l'aperçu a fait son œuvre (un échec garde le sien).
    if (bilan.bcs.length > 0) {
      await prisma.adProDevis.updateMany({ where: { legalDocumentId: { in: bilan.bcs.map((b) => b.devisPieceId) } }, data: { bcBrouillon: Prisma.DbNull } });
    }
    // RIEN N'A PU ÊTRE COMPOSÉ : la marche prise pour rien est rendue — le poste ne reste pas « demandé » sans BC.
    if (bilan.bcs.length === 0 && marche) {
      await prisma.adProItem.updateMany({
        where: { id, orderStage: marche.sousLeSeuil ? "DIRECTION_OK" : "REQUESTED", orderRequestedById: user.id },
        data: { orderStage: etapeAvant, orderRequestedAt: null, orderRequestedById: null, orderNote: null, orderDecisionNote: null },
      });
    }
    if (bilan.bcs.length === 0) return { ok: false, error: `Aucun bon de commande n'a pu être généré — ${bilan.echecs.join(" ; ")}.` };
    await audit(user, owner.parent, owner.id, "UPDATE", `Bons de commande générés pour le poste « ${item.label} » d'après les lignes validées, aperçu validé par le demandeur : ${bilan.bcs.map((b) => `${b.reference}${b.regenere ? ` (révisé v${b.version})` : ""}`).join(", ")}.`);
    revalidate(owner.parent, owner.id);
    revalidatePath(CHEMIN_BC_A_SIGNER);
    if (marche && !marche.sousLeSeuil) revalidatePath("/centre-ad-pro");
    const suite = marche
      ? (marche.sousLeSeuil ? ` ${motifSousLeSeuil(marche.seuilBC)}` : " Le centre de validation Ad & Pro les vise avec le poste.")
      : "";
    return { ok: true, id, message: `${phraseBilanGeneration(bilan)}${suite}` };
  });
}

// ═══════════════ LE BROUILLON EXCEL, PUIS LA VERSION SIGNÉE (Direction, 11/2026) ═══════════════
//
// « Si un devis est validé, un bon de commande est généré automatiquement en format modifiable (Excel, brouillon — Direction : « en Excel, pas en Word »). La personne
// qui a ajouté le devis est notifiée ; elle l'imprime, le modifie ou le signe, puis le dépose : c'est cette version finale qui
// entre dans Legal, et la signature déposée suffit. » Le brouillon naît donc de la VALIDATION des lignes (aucun clic de plus),
// sur le poste, avec un numéro réservé ; le BC n'existe au registre qu'au dépôt de la version signée — déjà signé.

/** Un poste prêt pour son brouillon : ce que `traiterLeBCDuPoste` lit, sans la garde « éditer » (valider suffit). */
type PosteDuBrouillon = { item: { id: string; label: string; kind: AdProItemKind; supplier: string | null }; owner: { parent: AdProParent; id: string } };

/**
 * PRÉPARER LES BROUILLONS WORD DU POSTE — appelé après la validation des lignes (et par « Préparer le brouillon »). Pour chaque
 * devis qui a des lignes validées et pas de BC : le brouillon est composé, ou refait (même numéro) si ses lignes ont changé ; un
 * devis qui n'a plus de ligne validée perd le sien. La marche du poste (centre de validation Ad & Pro au-dessus du seuil) est
 * prise au premier brouillon. Rend la phrase à dire, ou `null` quand il n'y avait rien à faire. Ne lève jamais.
 */
async function preparerLesBrouillonsExcel(user: Awaited<ReturnType<typeof requireUser>>, p: PosteDuBrouillon, info: { ref: string; requesterId?: string | null; companyId?: string | null }): Promise<string | null> {
  const id = p.item.id;
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil et sans sa validation, rien ne s'engage — pas même un brouillon numéroté.
  const porteDg = await refusSiPorteDgFermee(p.owner.parent, p.owner.id);
  if (porteDg) return `Brouillon du bon de commande non préparé : ${porteDg}`;
  return enSerie(filePoste(id), async (): Promise<string | null> => {
    const poste = await prisma.adProItem.findUnique({
      where: { id },
      select: { status: true, orderStage: true, expenseOrderId: true, amountGranted: true, budgetCategoryId: true, supplier: true },
    });
    if (!poste) return null;
    const tous = ((await devisDesPostes([id])).get(id) ?? []).filter((d) => !d.annule);
    // UN DEVIS SANS LIGNE VALIDÉE NE GARDE PAS SON BROUILLON : le fichier quitte le poste (son numéro reste inemployé).
    for (const d of tous.filter((x) => x.brouillon?.excel && x.etat !== "A_GENERER")) {
      await prisma.document.deleteMany({ where: { id: d.brouillon!.excel!.documentId, entityType: "AD_PRO_ITEM", entityId: id } });
      await prisma.adProDevis.updateMany({ where: { legalDocumentId: d.pieceId }, data: { bcBrouillon: Prisma.DbNull } });
    }
    const aFaire = tous.filter((d) => d.etat === "A_GENERER" && (!d.brouillon?.excel || d.brouillon.excelPerime));
    if (aFaire.length === 0) return null;
    const montantAccorde = poste.amountGranted != null ? toNumber(poste.amountGranted) : null;
    const ouverte = (await demandesBCDesPostes([id])).get(id);
    const refus = refusGenerationBC({
      status: poste.status, amountGranted: montantAccorde, budgetCategoryId: poste.budgetCategoryId, orderStage: poste.orderStage,
      expenseOrderId: poste.expenseOrderId, demandeChez: ouverte?.assistante, demandeOuverte: Boolean(ouverte),
    });
    if (refus) return `Brouillon du bon de commande non préparé : ${refus}`;
    const posteGen: PosteAGenerer = { item: { id, label: p.item.label, kind: p.item.kind, supplier: p.item.supplier, amountGranted: montantAccorde }, ref: info.ref, societe: "" };
    const depasse = refusPlafondDuPoste(posteGen, tous, montantAccorde);
    if (depasse) return `Brouillon du bon de commande non préparé : ${depasse}`;
    const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    if (!societe) return "Brouillon du bon de commande non préparé : la société qui commande est introuvable (renseignez la société du demandeur, RH › fiche salarié).";
    posteGen.societe = societe;

    // LA MARCHE DU POSTE, prise au premier brouillon : au-dessus du seuil, le centre Ad & Pro vise pendant que la personne signe.
    let marche: { sousLeSeuil: boolean; seuilBC: number } | null = null;
    const etapeAvant = poste.orderStage;
    if (poste.orderStage === "NONE" || poste.orderStage === "REFUSED") {
      const prise = await lireLaMarcheDuBC({
        itemId: id, montantAccorde: montantAccorde as number, userId: user.id, assistantId: null,
        note: "Brouillon du bon de commande préparé d'après les lignes validées des devis du poste.",
      });
      const posee = await prisma.adProItem.updateMany({ where: prise.where, data: prise.data });
      if (posee.count === 0) return `Brouillon du bon de commande non préparé : ${REFUS_MARCHE_PRISE}`;
      marche = { sousLeSeuil: prise.sousLeSeuil, seuilBC: prise.seuilBC };
    }

    const prets: string[] = [];
    const echecs: string[] = [];
    for (const d of aFaire) {
      const nom = d.reference ?? d.titre;
      // Le brouillon PROPRE (la vue y ajoute péremption et lignes) — c'est lui qui est gardé en base.
      const brouillon = lireBrouillon(d.brouillon) ?? brouillonNeuf({ itemId: id, par: user.id, parNom: user.name ?? null });
      const tauxRefuse = correctionsDuBrouillon(brouillon).tvaDefaut === undefined ? refusTauxDuDevis(d.entete.tvaRate) : null;
      if (tauxRefuse) { echecs.push(`${nom} : ${tauxRefuse}`); continue; }
      const c = await composerBrouillonExcel(user, posteGen, d, brouillon).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "composition impossible" }));
      if (!c.ok) { echecs.push(`${nom} : ${c.error}`); continue; }
      const depot = await persistUploadedDocument(user.id, {
        entityType: "AD_PRO_ITEM", entityId: id, category: "PURCHASE_ORDER", confidentiality: "INTERNAL", stepKey: ETAPE_BROUILLON_EXCEL,
        file: new File([new Uint8Array(c.xlsx)], c.nomFichier.replace(/\.xlsx$/i, " — brouillon.xlsx"), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        buffer: c.xlsx,
      }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "dépôt impossible", documentId: undefined }));
      if (!depot.ok || !depot.documentId) { echecs.push(`${nom} : le fichier Excel n'a pas pu être enregistré (${depot.error ?? "erreur"})`); continue; }
      const ancien = d.brouillon?.excel?.documentId ?? null;
      await prisma.adProDevis.updateMany({
        where: { legalDocumentId: d.pieceId },
        data: {
          bcBrouillon: {
            ...brouillon,
            excel: { documentId: depot.documentId, numero: c.numero, entreeRegistre: c.entreeRegistre, signature: c.signature, totalTtc: c.totalTtc, le: new Date().toISOString(), par: user.id },
          } as unknown as Prisma.InputJsonValue,
        },
      });
      if (ancien) await prisma.document.deleteMany({ where: { id: ancien, entityType: "AD_PRO_ITEM", entityId: id } });
      prets.push(c.numero);
      // QUI A DÉPOSÉ LE DEVIS est prévenu : c'est lui qui imprime, fait signer et redépose.
      const depose = await prisma.adProItemPiece.findUnique({ where: { itemId_legalDocumentId: { itemId: id, legalDocumentId: d.pieceId } }, select: { createdById: true } });
      if (depose?.createdById && depose.createdById !== user.id) {
        const n = notificationBrouillonPret({ numero: c.numero, fournisseur: c.fournisseur || d.fournisseur, poste: p.item.label, ref: info.ref, misAJour: Boolean(ancien) });
        await notifyUser({ userId: depose.createdById, type: "GENERIC", ...n, link: lienPosteAdPro(p.owner.parent, p.owner.id, id) }).catch(() => undefined);
      }
    }
    // RIEN N'A PU ÊTRE COMPOSÉ : la marche prise pour rien est rendue — le poste ne reste pas « demandé » sans brouillon.
    if (prets.length === 0 && marche) {
      await prisma.adProItem.updateMany({
        where: { id, orderStage: marche.sousLeSeuil ? "DIRECTION_OK" : "REQUESTED", orderRequestedById: user.id },
        data: { orderStage: etapeAvant, orderRequestedAt: null, orderRequestedById: null, orderNote: null, orderDecisionNote: null },
      });
    }
    if (prets.length > 0 && marche && !marche.sousLeSeuil) {
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], notificationDuCentreBC({ id, ref: info.ref, label: p.item.label, montantAccorde: montantAccorde as number })).catch(() => undefined);
      revalidatePath("/centre-ad-pro");
    }
    if (prets.length > 0) {
      await audit(user, p.owner.parent, p.owner.id, "UPDATE", `Brouillon${prets.length > 1 ? "s" : ""} Excel du bon de commande du poste « ${p.item.label} » préparé${prets.length > 1 ? "s" : ""} : ${prets.join(", ")} (numéro réservé, rien au registre Legal).`);
    }
    const dit = prets.length > 0
      ? `Brouillon${prets.length > 1 ? "s" : ""} du bon de commande prêt${prets.length > 1 ? "s" : ""} (${prets.join(", ")}) : téléchargez le fichier Excel, faites-le signer, puis déposez la version signée.${marche && !marche.sousLeSeuil ? " Le centre de validation Ad & Pro le vise en attendant." : ""}`
      : "";
    return [dit, echecs.length > 0 ? `Non préparé — ${echecs.join(" ; ")}.` : ""].filter(Boolean).join(" ") || null;
  });
}

/** « PRÉPARER LE BROUILLON » — le même geste que la validation déclenche, rejoué à la main (un refus levé depuis, une panne). */
export async function preparerBrouillonExcelPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!peutTraiterLesDevis(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };
  const phrase = await preparerLesBrouillonsExcel(user, { item, owner }, info);
  revalidate(owner.parent, owner.id);
  if (!phrase) return { ok: true, id, message: "Chaque devis validé a déjà son brouillon, à jour." };
  return phrase.startsWith("Brouillon du bon de commande non préparé") || phrase.startsWith("Non préparé")
    ? { ok: false, error: phrase }
    : { ok: true, id, message: phrase };
}

/**
 * DÉPOSER LA VERSION SIGNÉE DU BON DE COMMANDE D'UN DEVIS DE POSTE (Direction, 11/2026). Luna lit la copie (signature repérée,
 * numéro du brouillon) AVANT que rien ne s'écrive ; puis le BC naît au registre Legal — composé par la fabrique d'après les
 * lignes validées, sous le numéro réservé par le brouillon, SIGNÉ dans la même écriture (il ne passe pas par la file des
 * Finances) — et la copie déposée devient sa pièce. Le brouillon quitte le poste ; les devis sans ligne validée sont marqués
 * « non retenus ». Qui peut : qui traite les devis du poste, comme pour les valider (aucun droit nouveau).
 */
export async function deposerBcSignePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const pieceId = fdStr(formData, "pieceId");
  if (!id || !pieceId) return { ok: false, error: "Poste ou devis non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!peutTraiterLesDevis(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(info);
  if (fermee) return { ok: false, error: fermee };
  const signataire = fdStr(formData, "signataire");
  const copie = formData.getAll("copieSignee").find((v): v is File => v instanceof File && v.size > 0) ?? null;

  return enSerie(filePoste(id), async (): Promise<ActionResult> => {
    // L'ÉTAT D'ABORD (§118.18), LES PIÈCES ENSUITE.
    const poste = await prisma.adProItem.findUnique({
      where: { id }, select: { orderStage: true, expenseOrderId: true, amountGranted: true, supplier: true },
    });
    if (!poste) return { ok: false, error: "Poste introuvable." };
    const tous = ((await devisDesPostes([id])).get(id) ?? []).filter((d) => !d.annule);
    const d = tous.find((x) => x.pieceId === pieceId);
    if (!d) return { ok: false, error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." };
    const excel = d.etat === "A_GENERER" ? d.brouillon?.excel ?? null : null;
    const refus = refusDepotVersionSignee({ orderStage: poste.orderStage, expenseOrderId: poste.expenseOrderId, excel, perime: Boolean(d.brouillon?.excelPerime) });
    if (refus || !excel || !d.brouillon) return { ok: false, error: refus ?? "Aucun brouillon de bon de commande pour ce devis." };

    if (!copie) return { ok: false, error: "Déposez le bon de commande SIGNÉ (scan ou photo de la page signée)." };
    const ext = (copie.name.split(".").pop() ?? "").toLowerCase();
    if (!(FORMATS_COPIE_SIGNEE as readonly string[]).includes(ext)) return { ok: false, error: `La version signée se dépose en PDF ou en image (${FORMATS_COPIE_SIGNEE.join(", ")}) — pas en .${ext || "?"}.` };
    const refusFichier = await validateAttachments([copie]);
    if (refusFichier) return { ok: false, error: refusFichier };
    if (!signataire) return { ok: false, error: "Indiquez qui a signé ce bon de commande." };
    const octets = Buffer.from(await copie.arrayBuffer());
    const verdict = await verifierSignatureParLuna(octets, ext);
    const refusCopie = refusCopieSignee(verdict, excel.numero);
    if (refusCopie) return { ok: false, error: refusCopie };

    // LE BC NAÎT SIGNÉ, sous le numéro du brouillon. Les lignes corrigées sur une autre base ne s'impriment pas (comme le brouillon).
    const montantAccorde = poste.amountGranted != null ? toNumber(poste.amountGranted) : null;
    const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
    if (!societe) return { ok: false, error: "La société qui commande est introuvable : renseignez la société du demandeur (RH › fiche salarié)." };
    const posteGen: PosteAGenerer = { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: montantAccorde }, ref: info.ref, societe };
    const propre = lireBrouillon(d.brouillon) ?? brouillonNeuf({ itemId: id, par: user.id, parNom: user.name ?? null });
    const brouillon: BrouillonBc = { ...propre, lignes: d.brouillon.perime ? null : propre.lignes, numeroChoisi: excel.numero };
    const bilan = await genererLesBCsDuPoste(user, posteGen, [pieceId], new Map([[pieceId, brouillon]]), {
      reservations: new Map([[pieceId, excel.entreeRegistre]]),
      signee: { parId: user.id, nom: signataire, verification: verdict },
    });
    const bc = bilan.bcs[0];
    if (!bc) return { ok: false, error: `Le bon de commande n'a pas pu être enregistré — ${bilan.echecs.join(" ; ") || "erreur inconnue"}.` };

    // LA COPIE SIGNÉE devient la pièce du BC. Sans elle, la signature ne tient pas : on la retire (il part alors à la signature).
    const depot = await persistUploadedDocument(user.id, {
      entityType: "LEGAL_DOCUMENT", entityId: bc.pieceId, category: "OTHER", confidentiality: "INTERNAL", stepKey: ETAPE_COPIE_SIGNEE, file: copie, buffer: octets,
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "Dépôt impossible.", documentId: undefined }));
    if (!depot.ok) {
      await prisma.legalDocument.update({ where: { id: bc.pieceId }, data: { signedAt: null, signedById: null, signedByName: null, signatureCheck: Prisma.DbNull } });
      await aiguillerBC(bc.pieceId, { acteurId: user.id }).catch(() => undefined);
      return { ok: false, error: `Le bon de commande ${bc.reference} est enregistré, mais sa copie signée n'a pas pu l'être (${depot.error ?? "erreur"}) : il attend la signature des Finances.` };
    }

    // LE BROUILLON A FAIT SON ŒUVRE : il quitte le poste. Les offres sans ligne validée sont marquées « non retenues ».
    await prisma.document.deleteMany({ where: { id: excel.documentId, entityType: "AD_PRO_ITEM", entityId: id } });
    await prisma.adProDevis.updateMany({ where: { legalDocumentId: pieceId }, data: { bcBrouillon: Prisma.DbNull } });
    const validateur = (await prisma.adProDevisLigne.findFirst({
      where: { devis: { legalDocumentId: pieceId }, validatedItemId: id }, orderBy: { validatedAt: "desc" }, select: { validatedById: true },
    }))?.validatedById ?? null;
    const ecartes = devisNonRetenus(tous.filter((x) => x.pieceId !== pieceId).map((x) => ({ pieceId: x.pieceId, nbValidees: x.nbValidees, annule: x.annule })));
    await marquerNonRetenus(id, ecartes, validateur);

    await audit(user, owner.parent, owner.id, "UPDATE",
      `Bon de commande ${bc.reference} du poste « ${item.label} » déposé SIGNÉ par ${signataire} (${bc.totalTtc.toLocaleString("fr-FR")} DZD TTC) — ${phraseVerdictSignature(verdict)}${ecartes.length ? ` ${ecartes.length} devis non retenu${ecartes.length > 1 ? "s" : ""}.` : ""}`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/legal");
    revalidatePath(`/legal/${bc.pieceId}`);
    return {
      ok: true, id,
      message: `Bon de commande ${bc.reference} enregistré dans Legal, signé par ${signataire}. ${phraseVerdictSignature(verdict)} La facture peut être déposée.${ecartes.length ? ` ${ecartes.length} devis non retenu${ecartes.length > 1 ? "s" : ""}.` : ""}`,
    };
  });
}

// ═══════════════ L'APERÇU DU BC — relu, corrigé, régénéré par le demandeur avant d'être validé ═══════════════

/** Le devis, son brouillon et le poste, lus sous la file du devis — ce que l'aperçu, sa correction et son retrait partagent. */
async function brouillonDuDevis(user: SessionUser, formData: FormData, ecriture: boolean) {
  const cadre = await cadreDesLignes(user, formData);
  if ("error" in cadre) return { error: cadre.error } as const;
  const { id, pieceId, item, owner, info } = cadre;
  if (ecriture && !canEditItems(user, owner.parent)) return { error: "Non autorisé." } as const;
  const devis = await devisDuPoste(id, pieceId);
  if (!devis) return { error: "Ce devis n'est plus rattaché à ce poste : rechargez la fiche." } as const;
  if (!devis.brouillon) return { error: "Il n'y a pas d'aperçu de bon de commande pour ce devis : générez-le d'abord (« Générer le bon de commande »)." } as const;
  const societe = info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id));
  if (!societe) return { error: "La société qui commande est introuvable : renseignez la société du demandeur (RH › fiche salarié)." } as const;
  const poste = { item: { id, label: item.label, kind: item.kind, supplier: item.supplier, amountGranted: item.amountGranted != null ? toNumber(item.amountGranted) : null }, ref: info.ref, societe };
  return { id, pieceId, item, owner, info, devis, brouillon: devis.brouillon as BrouillonBc, poste } as const;
}

export type ApercuBcPoste =
  | (ApercuDuBC & {
    /** La papeterie de la société qui commande (et celle commune au groupe) : le papier en-tête se choisit dans l'aperçu. */
    papeterie: { id: string; name: string; companyId: string | null; companyLabel: string | null }[];
    /** Le nom de la société qui commande, telle que le composeur l'affiche. */
    societeNom: string;
  })
  | { ok: false; error: string };

/**
 * L'APERÇU DU BC — le PDF tel qu'il sera imprimé, rendu à blanc, avec le numéro « À attribuer à la validation » : aucun numéro
 * consommé ; et le COMPOSEUR PRÉ-REMPLI de ce que le BC portera (devis + corrections). Lisible par qui voit les devis du poste
 * (le demandeur, qui arbitre).
 */
export async function apercuBcPoste(formData: FormData): Promise<ApercuBcPoste> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, false);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Le devis du poste n'a pas pu être lu : rien n'a été modifié." };
  const r = await apercuDuBC(user, lu.poste, lu.devis, lu.brouillon);
  if (!r.ok) return r;
  return { ...r, papeterie: await papeterieDeLaSociete(r.societeId), societeNom: r.ecran.societe.nom };
}

/** La saisie du composeur, posée sur le brouillon EN MÉMOIRE — rien n'est écrit (aperçu des totaux, aperçu avant impression). */
async function brouillonDeLaSaisie(formData: FormData) {
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, false);
  if ("error" in lu) return { ok: false as const, error: lu.error ?? "Le devis du poste n'a pas pu être lu : rien n'a été modifié." };
  const saisie = lireModificationsDuBc(formData);
  const refus = refusDeLaSaisie(saisie);
  if (refus) return { ok: false as const, error: refus };
  const brouillon = brouillonCorrige(lu.brouillon, saisie, { lignesDuDevis: lignesDuBCDuDevis(lu.devis, lu.id), par: user.id });
  return { ok: true as const, user, lu, brouillon };
}

/** LES TOTAUX DE L'APERÇU, à mesure que le demandeur corrige — la même composition que l'émission, à blanc (rien n'est écrit). */
export async function previsualiserApercuBcPoste(formData: FormData): Promise<ApercuPiece | { ok: false; error: string }> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const s = await brouillonDeLaSaisie(formData);
  if (!s.ok) return s;
  const c = await composerApercuDuBC(s.user, s.lu.poste, s.lu.devis, s.brouillon);
  if (!c.ok) return c;
  return apercuPourEcran(c.r, Boolean(s.lu.devis.bc));
}

/** L'APERÇU AVANT IMPRESSION du brouillon corrigé — le PDF, numéro « À attribuer à la validation », sans rien écrire. */
export async function imprimerApercuBcPoste(formData: FormData): Promise<{ ok: true; pdfBase64: string; pages: number; numeroProchain: string } | { ok: false; error: string }> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const s = await brouillonDeLaSaisie(formData);
  if (!s.ok) return s;
  const c = await composerApercuDuBC(s.user, s.lu.poste, s.lu.devis, s.brouillon, { avecPdf: true });
  if (!c.ok) return c;
  if (c.r.bloquants.length > 0) return { ok: false, error: `L'aperçu n'est pas possible : ${c.r.bloquants.slice(0, 3).join(" ; ")}` };
  if (!c.r.pdf) return { ok: false, error: c.r.pdfErreur ?? "Le rendu de l'aperçu n'a pas pu être produit." };
  return { ok: true, pdfBase64: c.r.pdf.octets.toString("base64"), pages: c.r.pdf.pages, numeroProchain: s.lu.devis.bc ? c.r.numeroProchain : "à attribuer à la validation" };
}

/**
 * CORRIGER L'APERÇU — « chaque détail peut être modifié dans le BC » (Direction, 14/10/2026) : le composeur envoie TOUT ce que la
 * révision d'un BC émis porte — fournisseur complet, lignes (désignation, unité, détails, section, quantité, PU, remise, TVA),
 * date, objet, devis amont et sa date, mode et conditions de paiement, TVA par défaut, remise globale, taxes, livraison (lieu,
 * date, délai), contact, notes, papier en-tête, coordonnées imprimées de l'émetteur, signataire, mentions — et TOUT est gardé sur
 * le brouillon. Rien n'est numéroté : on relit l'aperçu autant de fois qu'il le faut.
 *
 * Gardes : la saisie se lit (lignes nommées), le brouillon n'est pas périmé (les lignes validées du devis n'ont pas bougé depuis),
 * et le PLAFOND DE L'ACCORDÉ est celui de la génération, en TTC (audit M-03).
 */
export async function modifierApercuBcPoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  return ecrireApercuBcPoste(formData);
}

async function ecrireApercuBcPoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, true);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Le devis du poste n'a pas pu être lu : rien n'a été modifié." };
  const { id, pieceId, item, owner, devis, brouillon, poste } = lu;
  if (devis.brouillon?.perime) return { ok: false, error: "Les lignes validées du devis ont changé depuis vos corrections : retirez cet aperçu et générez-le de nouveau." };
  const saisie = lireModificationsDuBc(formData);
  const refus = refusDeLaSaisie(saisie);
  if (refus) return { ok: false, error: refus };
  // Le numéro PROPOSÉ ne se fige pas dans le brouillon : seul un numéro modifié y est gardé.
  const numero = formData.has("numeroChoisi") ? saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere")) : undefined;
  const apres: BrouillonBc = {
    ...brouillonCorrige(brouillon, saisie, { lignesDuDevis: lignesDuBCDuDevis(devis, id), par: user.id }),
    ...(numero !== undefined ? { numeroChoisi: numero } : {}),
  };
  return chez(id, pieceId, async () => {
    const tous = ((await devisDesPostes([id])).get(id) ?? []).filter((d) => !d.annule);
    const depasse = refusPlafondDuPoste(poste, tous, poste.item.amountGranted, { brouillon: { pieceId, brouillon: apres } });
    if (depasse) return { ok: false, error: depasse };
    const r = await prisma.adProDevis.updateMany({ where: { legalDocumentId: pieceId }, data: { bcBrouillon: apres as unknown as Prisma.InputJsonValue } });
    if (r.count === 0) return { ok: false, error: "Ce devis n'a plus d'aperçu : rechargez la fiche." };
    await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » corrigé (devis « ${devis.reference ?? devis.titre} ») — aucun numéro attribué.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: "Brouillon enregistré : relisez l'aperçu, puis « Valider et envoyer aux Finances »." };
  });
}

/** RETIRER L'APERÇU — le brouillon disparaît ; aucun numéro n'avait été attribué, la série reste continue. */
export async function annulerApercuBcPoste(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "id") || !fdStr(formData, "pieceId")) return { ok: false, error: "Poste ou devis non précisé." };
  const user = await requireUser();
  const lu = await brouillonDuDevis(user, formData, true);
  if ("error" in lu) return { ok: false, error: lu.error ?? "Le devis du poste n'a pas pu être lu : rien n'a été modifié." };
  const { id, pieceId, item, owner, devis } = lu;
  return chez(id, pieceId, async () => {
    await prisma.adProDevis.updateMany({ where: { legalDocumentId: pieceId }, data: { bcBrouillon: Prisma.DbNull } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Aperçu du bon de commande du poste « ${item.label} » retiré (devis « ${devis.reference ?? devis.titre} ») — aucun numéro n'avait été attribué.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id, message: "Aperçu retiré : aucun numéro de bon de commande n'a été consommé." };
  });
}
