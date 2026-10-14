"use server";

import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { CHEMIN_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { persistUploadedDocument } from "@/lib/documents";
import { validateDocumentUpload } from "@/lib/storage";
import { createExpenseOrder } from "@/lib/expense-orders";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { aiguillerBC, porteDuBC } from "@/lib/bons-de-commande/aiguillage";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { canCancel } from "@/lib/legal/lifecycle";
import { canSendToSettlement, cleEnvoiAuReglement, ordreClos } from "@/lib/finances/settlement";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { getAppSettings } from "@/lib/settings";
import { enSerie } from "@/lib/refs";
import { annuaireDeLecture, consignerConfirmation, exigerLectureConfirmee, proposerLecture, RefusLecture, type ConfirmationPrete } from "@/lib/pieces-lues/service";
import { empreinteDe } from "@/lib/pieces-lues/lecture-fichier";
import { lignesProposeesFacturePromo, preremplirFacturePromo, type PrerempliFacturePromo } from "@/lib/pieces-lues/prerempli-facture-promo";
import { fdCase } from "@/lib/actions/types";
import { reviserDocumentDrive } from "@/platform/in-process/artifact/factory";
import { genererLesBonsDeCommande, apercuDuBcPromo, type ApercuBcPromo } from "@/lib/promo-automatismes";
import { cloreLeDossierPromoSiSolde } from "@/lib/promo-cloture";
import { brouillonPromoEnJson, lireBrouillonPromo, type BrouillonBcPromo } from "@/lib/promo-material/bc-brouillon-promo";
import { peutValiderLeBrouillon, REFUS_VALIDATION_BROUILLON } from "@/lib/bons-de-commande/brouillon";
import { memeNumero } from "@/lib/bons-de-commande/numero-reference";
import { saisieEffective } from "@/lib/references/registre";
import { MODES_PAIEMENT } from "@/lib/artifact/factory/commercial";
import { devisDuDossier, devisLu } from "@/lib/queries/promo-circuit";
import { formatDzd } from "@/lib/promo-material/devis";
import { piloteLExecution } from "@/lib/promo-material/circuit";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import {
  ecartTotalImprime, ecartsAuBC, lignesDuBC, lignesProposees, natureDeReception, peutReceptionner, phraseEcart,
  totauxFacture, validerLignesFacture, validerReception, verdictPaiementDetaille, type FamillePromo,
} from "@/lib/promo-material/achats";
import { articleDemandeLu, ligneFactureLue, SELECT_ARTICLE_DEMANDE, SELECT_LIGNE_FACTURE } from "@/lib/queries/promo-achats";
import { gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { notifyUser } from "@/lib/notify";
import { familleAValidite, familleQuantifiee } from "@/lib/promo/catalogue";
import { libelleArticleStock, lireDateJour, parseQuantity } from "@/lib/promo/stock";
import { annulerMouvementEcrit, entrerLot, sousVerrou, trouverOuCreerArticle } from "@/lib/promo/stock-ecriture";

/**
 * L'EXÉCUTION DU MATÉRIEL PROMOTIONNEL — bons de commande, factures, paiements, visas (§118.152).
 *
 * « Une fois les validations obtenues, le demandeur génère un ou plusieurs bons de commande
 * automatiquement, selon ce qu'il a validé — le bon de commande est généré par la plateforme
 * elle-même. Il peut supprimer ou modifier un bon de commande généré. Il envoie le bon de
 * commande, et il se doit d'uploader la facture pour demander un paiement, c'est obligatoire —
 * la ou les factures, associées chacune à son bon de commande. Et à chaque paiement, la demande
 * de visa publicitaire, ou la déclaration au ministère, part chez l'information médicale. »
 *
 * ── LES QUATRE RÈGLES QUE CES GESTES PARTAGENT ────────────────────────────────────────────
 *
 * 1. QUI : le demandeur, l'assistante de direction, la Direction — la règle de `canDrive` de la
 *    fiche et de `completePromoTrack`. Le demandeur n'a pas le module Legal : ce qui l'autorise à
 *    faire émettre ses BC, ce sont les VALIDATIONS obtenues sur son dossier, vérifiées ici et
 *    NOMMÉES à la fabrique (`delegation`, que l'audit reprend). Il ne compose rien : les lignes
 *    viennent du choix validé, jamais d'un formulaire — sans quoi la délégation deviendrait une
 *    porte pour émettre n'importe quel BC au nom de la société.
 * 2. UN BC PAR DEVIS RETENU, tagué au dossier (`source`) : c'est ce qui l'envoie au centre de
 *    validation Ad & Pro au-dessus du seuil (§118.148/149), puis à la signature des Finances.
 * 3. UN BC SIGNÉ AVANT TOUT : on n'envoie pas, on ne facture pas un BC que les Finances n'ont
 *    pas signé — il n'engage pas encore la société (§118.149).
 * 4. LE MÊME DINAR NE SORT PAS DEUX FOIS : les factures d'un BC ne dépassent pas son montant, et
 *    le paiement passe par la porte commune (`canSendToSettlement` → `createExpenseOrder` → centre
 *    de paiement, §118.148).
 */

const PATH = "/promo-material";
const chemin = (id: string) => `${PATH}/${id}`;

type Dossier = {
  id: string; reference: string; title: string; status: string; circuitVersion: number; circuitState: string | null;
  requesterId: string | null; companyId: string | null;
};

async function chargerDossier(id: string | null): Promise<Dossier | null> {
  if (!id) return null;
  return prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, status: true, circuitVersion: true, circuitState: true, requesterId: true, companyId: true },
  });
}

/** Ceux qui PILOTENT l'exécution — la règle du module pur, lue aussi par la fiche et la clôture des chantiers. */
function pilote(user: SessionUser, pm: Dossier): boolean {
  return piloteLExecution({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) }, pm);
}

/** Le refus commun : ni pilote, ni circuit 2, ni validations obtenues. `null` = on peut agir. */
function refusExecution(user: SessionUser, pm: Dossier | null): string | null {
  if (!pm) return "Dossier introuvable.";
  if (pm.circuitVersion !== 2) return "Ce dossier suit l'ancien circuit : ses bons de commande se créent depuis « Pièces liées ».";
  if (!pilote(user, pm)) return "Seuls le demandeur, l'assistante de direction et la Direction pilotent l'exécution de ce dossier.";
  if (pm.circuitState !== "IN_EXECUTION") {
    // UN DOSSIER CLOS SE DIT CLOS : annulé ou refusé, « une fois les validations obtenues » promettait
    // une suite qui n'existe plus.
    if (pm.status === "CANCELLED") return "Ce dossier a été annulé : plus rien ne s'y génère ni ne s'y facture.";
    if (pm.circuitState === "REFUSED") return "Ce dossier a été refusé : plus rien ne s'y génère ni ne s'y facture.";
    return pm.circuitState === "COMPLETED"
      ? "Ce dossier est terminé."
      : "Les bons de commande se génèrent une fois TOUTES les validations obtenues (demandeur, Direction Marketing, et Directeur Général au-dessus du seuil).";
  }
  return null;
}

async function audit(user: SessionUser, id: string, summary: string) {
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id, summary });
}

/** Le devis de ce dossier, et son BC s'il en a un d'actif. */
async function devisEtBC(pm: Dossier, quoteId: string | null) {
  if (!quoteId) return null;
  const devis = await prisma.promoQuote.findFirst({
    where: { id: quoteId, promoMaterialId: pm.id },
    select: { id: true, supplierId: true, supplierName: true, purchaseOrderId: true, purchaseOrderSentAt: true },
  });
  if (!devis) return null;
  const etat = devis.purchaseOrderId ? await etatDuBC(devis.purchaseOrderId) : null;
  return { devis, bc: etat && !etat.annule ? etat : null };
}

/**
 * LA TAXE SUPPLÉMENTAIRE saisie sur le formulaire — « Taxe Pub 2 % », calculée sur le HT et hors base de TVA.
 * Trois issues, et la différence compte : `undefined` = le formulaire n'en dit RIEN (la valeur d'origine reste, §118.152c) ;
 * `null` = « 0 » : aucune taxe, explicitement ; sinon la taxe. Un taux hors de 0–100 est refusé en le nommant.
 */
function lireTaxeSupplementaire(formData: FormData): { ok: true; taxe: { libelle: string; taux: number } | null | undefined; libelleSaisi: string | undefined } | { ok: false; error: string } {
  const libelleSaisi = fdStr(formData, "extraTaxLabel") ?? undefined;
  const brut = (fdStr(formData, "extraTaxRate") ?? "").replace(",", ".").trim();
  if (brut === "") return { ok: true, taxe: undefined, libelleSaisi };
  const pourcent = Number(brut);
  if (!Number.isFinite(pourcent) || pourcent < 0 || pourcent > 100) {
    return { ok: false, error: `La taxe supplémentaire s'exprime en pour cent, entre 0 et 100 (« ${brut} » ne se lit pas) — 0 pour n'en mettre aucune, vide pour garder celle du devis.` };
  }
  if (pourcent === 0) return { ok: true, taxe: null, libelleSaisi };
  return { ok: true, taxe: { libelle: libelleSaisi ?? "Taxe additionnelle", taux: pourcent / 100 }, libelleSaisi };
}

// ───────────────────────── 1. Générer les bons de commande ─────────────────────────

/**
 * GÉNÉRER LES BONS DE COMMANDE — le REPLI (§118.204). La génération part d'elle-même quand la dernière
 * validation du choix tombe (`validatePromoStep` → `genererLesBonsDeCommande`) ; ce geste reste pour
 * ce qu'elle n'a pas pu émettre (un fournisseur sans identité, une société que le validateur ne voit pas),
 * et pour régler la livraison ou la taxe avant d'émettre. Le cœur est UN (`lib/promo-automatismes.ts`) : deux
 * générations finiraient par composer deux BC différents du même devis (§118.5).
 */
export async function genererBonsDeCommandePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const livraison = { adresse: fdStr(formData, "livraisonAdresse"), delai: fdStr(formData, "livraisonDelai") };
  const notes = fdStr(formData, "notes");
  // LA CASE « TAXE SUPPLÉMENTAIRE » (Direction, 10/2026) : vide = celle de chaque devis ; « 0 » = aucune ; sinon pour tous les BC générés.
  const taxeSaisie = lireTaxeSupplementaire(formData);
  if (!taxeSaisie.ok) return { ok: false, error: taxeSaisie.error };
  const r = await genererLesBonsDeCommande(user, pm.id, { livraison, notes, taxe: taxeSaisie.taxe, automatique: false });
  // LES APERÇUS PRÉPARÉS PAR UN AUTRE (l'assistante, la Direction) : le demandeur, qui les valide, en est prévenu.
  if (r.ok && r.apercus > 0 && pm.requesterId && pm.requesterId !== user.id) {
    await notifyUser({
      userId: pm.requesterId, type: "VALIDATION_REQUIRED", title: "Bons de commande à vérifier et valider",
      body: `${pm.reference} — ${pm.title}`, link: chemin(pm.id),
    });
  }
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
}

// ───────────────────────── 1 bis. L'aperçu du BC, à valider par le demandeur ─────────────────────────

/** Le devis et son aperçu, lus pour l'un des gestes de l'aperçu — après la porte commune de l'exécution. */
async function devisAvecApercu(pm: Dossier, quoteId: string | null) {
  if (!quoteId) return null;
  const devis = await prisma.promoQuote.findFirst({
    where: { id: quoteId, promoMaterialId: pm.id },
    select: { id: true, supplierName: true, purchaseOrderId: true, bcBrouillon: true },
  });
  if (!devis) return null;
  return { devis, brouillon: lireBrouillonPromo(devis.bcBrouillon) };
}

export type ApercuBcPromoResultat = ApercuBcPromo | { ok: false; error: string };

/**
 * L'APERÇU DU BC D'UN DEVIS (Direction, 10/2026) — le PDF tel qu'il sera imprimé, numéro « À attribuer à la validation » :
 * rien n'est numéroté ni envoyé. Lisible par qui pilote l'exécution (le demandeur, qui le valide ; l'assistante qui le prépare).
 */
export async function apercuBcPromo(formData: FormData): Promise<ApercuBcPromoResultat> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const quoteId = fdStr(formData, "quoteId");
  if (!quoteId) return { ok: false, error: "Devis non précisé." };
  return apercuDuBcPromo(user, pm.id, quoteId);
}

/**
 * CORRIGER L'APERÇU — Référence, contact, modalités de paiement, livraison (lieu, date, délai), notes, taxe supplémentaire,
 * numéro proposé. Un champ vide revient à ce que le devis donne. Les LIGNES ne se corrigent pas : ce sont les lignes
 * retenues et validées. Rien n'est numéroté : on relit l'aperçu autant de fois qu'il le faut.
 */
export async function modifierApercuBcPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisAvecApercu(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.brouillon) return { ok: false, error: "Ce devis n'a plus d'aperçu de bon de commande : rechargez la fiche." };
  const mode = fdStr(formData, "modePaiement");
  if (mode && !(MODES_PAIEMENT as readonly string[]).includes(mode)) return { ok: false, error: "Mode de paiement inconnu." };
  const dateLivraison = fdStr(formData, "livraisonDate");
  if (dateLivraison && !/^\d{4}-\d{2}-\d{2}$/.test(dateLivraison)) return { ok: false, error: "La date de livraison s'écrit AAAA-MM-JJ." };
  const taxeSaisie = lireTaxeSupplementaire(formData);
  if (!taxeSaisie.ok) return { ok: false, error: taxeSaisie.error };
  const adresse = fdStr(formData, "livraisonAdresse");
  const delai = fdStr(formData, "livraisonDelai");
  const contactNom = fdStr(formData, "contactNom");
  const contactTelephone = fdStr(formData, "contactTelephone");
  const apres: BrouillonBcPromo = {
    ...lu.brouillon,
    objet: fdStr(formData, "objet"),
    notes: fdStr(formData, "notes"),
    contact: contactNom || contactTelephone ? { nom: contactNom, telephone: contactTelephone } : null,
    modePaiement: (mode as BrouillonBcPromo["modePaiement"]) ?? null,
    conditionsPaiement: fdStr(formData, "conditionsPaiement"),
    livraison: adresse || dateLivraison || delai ? { adresse, date: dateLivraison, delai } : null,
    // Le numéro prérempli (le prochain) n'est pas un choix : laissé tel quel, le prochain libre est attribué à la validation.
    numeroChoisi: saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere")),
    taxe: taxeSaisie.taxe,
    modifieLe: new Date().toISOString(), modifiePar: user.id,
  };
  const r = await prisma.promoQuote.updateMany({
    where: { id: lu.devis.id, purchaseOrderId: lu.devis.purchaseOrderId, promoMaterial: { circuitVersion: 2, circuitState: "IN_EXECUTION" } },
    data: { bcBrouillon: brouillonPromoEnJson(apres) as Prisma.InputJsonValue },
  });
  if (r.count === 0) return { ok: false, error: "Ce devis vient de changer : rechargez la fiche." };
  await audit(user, pm.id, `Aperçu du bon de commande de ${lu.devis.supplierName} corrigé — aucun numéro attribué.`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: "Aperçu mis à jour." };
}

/** RETIRER L'APERÇU — il disparaît ; aucun numéro n'avait été attribué, la série reste continue. */
export async function annulerApercuBcPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisAvecApercu(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.brouillon) return { ok: true, message: "Il n'y avait plus d'aperçu sur ce devis." };
  await prisma.promoQuote.updateMany({ where: { id: lu.devis.id, purchaseOrderId: lu.devis.purchaseOrderId }, data: { bcBrouillon: Prisma.DbNull } });
  await audit(user, pm.id, `Aperçu du bon de commande de ${lu.devis.supplierName} retiré — aucun numéro n'avait été attribué.`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: "Aperçu retiré : aucun numéro de bon de commande n'a été consommé." };
}

/**
 * VALIDER L'APERÇU ET L'ENVOYER AUX FINANCES — le DEMANDEUR (ou le Super Admin), pas l'assistante qui l'a préparé. C'est ici,
 * et seulement ici, que le numéro NNN/DG/AAAA est attribué (celui proposé, ou le suivant), que le BC est émis (Word, PDF,
 * registre) et qu'il part dans sa marche : centre de validation au-dessus du seuil, puis signature des Finances.
 */
export async function validerEtEnvoyerBcPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  if (!peutValiderLeBrouillon({ userId: user.id, role: user.role, demandeurId: pm.requesterId })) return { ok: false, error: REFUS_VALIDATION_BROUILLON };
  const lu = await devisAvecApercu(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.brouillon) return { ok: false, error: "Ce devis n'a pas d'aperçu de bon de commande à valider : rechargez la fiche." };
  // LE NUMÉRO PROPOSÉ au dernier moment (« Numéro du BC à valider ») : écrit sur l'aperçu, que l'émission lit.
  if (formData.has("numeroChoisi")) {
    const numero = saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere"));
    if (numero !== lu.brouillon.numeroChoisi) {
      await prisma.promoQuote.updateMany({
        where: { id: lu.devis.id, purchaseOrderId: lu.devis.purchaseOrderId },
        data: { bcBrouillon: brouillonPromoEnJson({ ...lu.brouillon, numeroChoisi: numero }) as Prisma.InputJsonValue },
      });
    }
  }
  const r = await genererLesBonsDeCommande(user, pm.id, {
    livraison: { adresse: null, delai: null }, notes: null, taxe: undefined, automatique: false, mode: "VALIDER", quoteIds: [lu.devis.id],
  });
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
}

// ───────────────────────── 2. Modifier, supprimer, envoyer un BC ─────────────────────────

/**
 * MODIFIER UN BON DE COMMANDE GÉNÉRÉ — livraison, délai, interlocuteur, notes, taxe supplémentaire.
 *
 * Même numéro, nouvelle version du même fichier (la fabrique). Les LIGNES ne se modifient pas ici :
 * elles sont ce qui a été validé, et un BC qui s'en écarterait engagerait la société sur ce que
 * personne n'a validé. Une révision retire la signature des Finances (§118.149) : ce n'est plus la
 * pièce qu'elles ont signée — et la version envoyée au fournisseur n'est plus la bonne, donc
 * l'envoi est à refaire.
 */
export async function modifierBonDeCommandePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisEtBC(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.bc) return { ok: false, error: "Ce devis n'a pas de bon de commande actif à modifier." };
  // « Une facture découle déjà de ce bon de commande » : la règle vit chez l'écrivain, la fabrique, pour
  // tous ses appelants (§118.194) — une seconde copie ici aurait fini par en dire une autre.

  // UN CHAMP LAISSÉ VIDE GARDE SA VALEUR. Le formulaire n'est pas pré-rempli, et Adam ne nomme
  // que ce qui change : écrire `null` pour chaque champ absent effaçait l'adresse de livraison de
  // qui ne changeait que le délai — une pièce révisée partie sans elle, sans un mot (§118.152).
  const saisi = (k: string): string | undefined => fdStr(formData, k) ?? undefined;
  const adresse = saisi("livraisonAdresse");
  const delai = saisi("livraisonDelai");
  const contactNom = saisi("contactNom");
  const contactTelephone = saisi("contactTelephone");
  const notes = saisi("notes");
  const numeroRevise = saisi("numeroRevise");
  // LA TAXE SUPPLÉMENTAIRE se corrige aussi : un taux la change, « 0 » la retire, vide la garde — et sans libellé
  // nouveau, le libellé de la pièce reste (« Taxe Pub » ne devient pas « Taxe additionnelle » parce qu'on change le taux).
  const taxeSaisie = lireTaxeSupplementaire(formData);
  if (!taxeSaisie.ok) return { ok: false, error: taxeSaisie.error };
  let taxes: { libelle: string; taux: number }[] | undefined;
  if (taxeSaisie.taxe === null) taxes = [];
  else if (taxeSaisie.taxe) {
    let libelle = taxeSaisie.taxe.libelle;
    if (taxeSaisie.libelleSaisi === undefined) {
      const piece = await prisma.legalDocument.findUnique({ where: { id: lu.bc.id }, select: { custom: true } });
      const anciennes = (piece?.custom as { fabrique?: { spec?: { taxes?: { libelle?: string }[] | null } } } | null)?.fabrique?.spec?.taxes;
      if (anciennes?.[0]?.libelle) libelle = anciennes[0].libelle;
    }
    taxes = [{ libelle, taux: taxeSaisie.taxe.taux }];
  }
  const modifications = {
    ...(adresse !== undefined || delai !== undefined
      ? { livraison: { ...(adresse !== undefined ? { adresse } : {}), ...(delai !== undefined ? { delai } : {}) } }
      : {}),
    ...(contactNom !== undefined || contactTelephone !== undefined
      ? { contact: { ...(contactNom !== undefined ? { nom: contactNom } : {}), ...(contactTelephone !== undefined ? { telephone: contactTelephone } : {}) } }
      : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(taxes !== undefined ? { taxes } : {}),
    // LE N° DE RÉFÉRENCE (Direction, 14/10/2026) : prérempli du numéro actuel ; changé, la fabrique le juge (unique dans sa
    // série, compteur jamais en arrière) et le trace.
    ...(numeroRevise && !memeNumero(numeroRevise, fdStr(formData, "numeroActuel") ?? lu.bc.reference) ? { numero: numeroRevise } : {}),
  };
  if (Object.keys(modifications).length === 0) {
    return { ok: false, error: "Rien à modifier : renseignez au moins un champ — ceux laissés vides gardent leur valeur." };
  }

  const r = await reviserDocumentDrive(user, {
    legalDocumentId: lu.bc.id,
    modifications,
    motif: fdStr(formData, "motif") ?? "modification par le demandeur",
  }, { delegation: `${pm.reference} — bon de commande du dossier, modifié par ses pilotes (livraison, contact, notes, taxe supplémentaire)` });
  if (!r.ok) return { ok: false, error: r.motif };
  if (r.numeroSeul) {
    // SEUL LE NUMÉRO A CHANGÉ (Direction, 14/10/2026) : le BC garde son état — signature, centre, et son envoi au fournisseur.
    await audit(user, pm.id, `Bon de commande ${r.reference} : numéro seul modifié (v${r.version}) — circuit et signature conservés`);
    revalidatePath(chemin(pm.id));
    return { ok: true, message: `Bon de commande ${r.reference} : seul le numéro a changé (version ${r.version}) — son circuit et sa signature sont conservés.` };
  }
  await prisma.promoQuote.update({ where: { id: lu.devis.id }, data: { purchaseOrderSentAt: null, purchaseOrderSentById: null } });
  await audit(user, pm.id, `Bon de commande ${r.reference} modifié (v${r.version})`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: `Bon de commande ${r.reference} modifié (version ${r.version}).${r.reserveBonDeCommande ? ` ${r.reserveBonDeCommande}` : ""}` };
}

/**
 * SUPPRIMER UN BON DE COMMANDE GÉNÉRÉ — il est ANNULÉ au registre (jamais effacé : son numéro a
 * été attribué, et un trou dans la numérotation se lit comme une pièce perdue), sa porte en
 * attente quitte le centre, et le devis redevient « à générer ».
 */
export async function annulerBonDeCommandePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisEtBC(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.bc) return { ok: false, error: "Ce devis n'a pas de bon de commande actif." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi ce bon de commande est supprimé : son numéro reste au registre, avec ce motif." };
  const factures = await prisma.legalDocument.count({ where: { kind: "INVOICE", chainFromId: lu.bc.id, status: { not: "CANCELLED" } } });
  if (factures > 0) return { ok: false, error: "Une facture découle de ce bon de commande : annulez-la d'abord, sans quoi elle se rattacherait à une commande qui n'existe plus." };
  const doc = await prisma.legalDocument.findUnique({ where: { id: lu.bc.id }, select: { status: true } });
  if (!doc || !canCancel(doc.status)) return { ok: false, error: "Ce bon de commande ne peut plus être annulé." };

  await prisma.legalDocument.update({
    where: { id: lu.bc.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: motif, updatedById: user.id },
  });
  // Un BC annulé n'a plus rien à faire valider : sa porte en attente quitte le centre.
  await aiguillerBC(lu.bc.id, { acteurId: user.id });
  await prisma.promoQuote.update({ where: { id: lu.devis.id }, data: { purchaseOrderId: null, purchaseOrderSentAt: null, purchaseOrderSentById: null } });
  await audit(user, pm.id, `Bon de commande ${lu.bc.reference ?? ""} supprimé (annulé au registre) — ${motif.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  revalidatePath(CHEMIN_BONS_DE_COMMANDE);
  return { ok: true, message: `Bon de commande ${lu.bc.reference ?? ""} annulé — le devis de ${lu.devis.supplierName} peut en recevoir un nouveau.` };
}

/** LE BC EST PARTI CHEZ LE FOURNISSEUR — seulement signé : avant, il n'engage pas la société. */
export async function marquerBonDeCommandeEnvoye(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisEtBC(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.bc) return { ok: false, error: "Ce devis n'a pas de bon de commande actif." };
  if (lu.bc.etape !== "SIGNE") {
    return { ok: false, error: `Le bon de commande ${lu.bc.reference ?? ""} n'est pas encore signé par les Finances : il ne part pas chez le fournisseur avant (§ bons de commande à signer).` };
  }
  if (lu.devis.purchaseOrderSentAt) return { ok: true, message: "Ce bon de commande est déjà marqué envoyé." };
  await prisma.promoQuote.update({ where: { id: lu.devis.id }, data: { purchaseOrderSentAt: new Date(), purchaseOrderSentById: user.id } });
  await audit(user, pm.id, `Bon de commande ${lu.bc.reference ?? ""} envoyé à ${lu.devis.supplierName}`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: `Bon de commande ${lu.bc.reference ?? ""} marqué envoyé à ${lu.devis.supplierName}.` };
}

// ───────────────────────── 3. Factures, paiements, visas ─────────────────────────

/** « 4 800 », « 4 800,5 » → nombre ; vide → 0 (la ligne n'est pas sur cette facture) ; illisible → null. */
function lireNombreSaisi(brut: unknown): number | null {
  const s = String(brut ?? "").trim();
  if (s === "") return 0;
  return parseQuantity(s);
}

/**
 * DÉPOSER LA FACTURE D'UN BON DE COMMANDE — détaillée ligne à ligne, obligatoire pour demander un
 * paiement (§118.152, §118.165).
 *
 * « La facture doit renseigner exactement le matériel reçu en stock. » Ses lignes sont celles du BC,
 * PRÉ-REMPLIES avec ce qui reste à facturer ; la quantité et le prix se corrigent pour coller au
 * papier, et les écarts avec le BC sont DITS. On ne facture pas plus que ce qui reste sur une ligne.
 * Le TOTAL se calcule (§118.59) ; le total IMPRIMÉ (« amount ») se saisit pour contrôler la saisie, et
 * un écart de plus d'un dinar la refuse. Les taxes sont celles du BC, corrigeables.
 *
 * Sans lignes saisies (un appel qui ne les détaille pas), la facture reprend ce qui reste à facturer
 * sur chaque ligne du BC, à son prix — et le contrôle du total imprimé dit si c'était faux.
 *
 * La facture devient une pièce Legal CHAÎNÉE à son BC (`chainFromId`) et rattachée au dossier — c'est
 * ce lien qui la fait compter dans le chantier des paiements, et qui applique au paiement la porte du
 * BC. Le FICHIER est obligatoire : une facture sans pièce ne se contrôle pas. Et les factures d'un BC
 * ne dépassent pas son montant : payer plus que la commande validée, c'est engager la société sur ce
 * que personne n'a validé.
 */
/**
 * LIRE UNE FACTURE AVANT DE LA DÉPOSER (lot D2-F, §118.200) — par Luna quand la pièce peut sortir,
 * jamais un OCR externe. Les MÊMES portes que le dépôt (pilote de l'exécution, BC signé) : lire la
 * facture d'un BC qu'on ne pourra pas facturer serait un geste offert puis retiré. Rien n'est écrit
 * ici : la lecture PROPOSE, la personne compare au papier, et le dépôt exige la confirmation.
 */
export async function lireFacturePromo(formData: FormData): Promise<ActionResult & { lecture?: { lectureId: string; noteMethode: string; sansLignes: string | null; prerempli: PrerempliFacturePromo } }> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisEtBC(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.bc) return { ok: false, error: "Ce devis n'a pas de bon de commande : la facture se rattache à un BC." };
  if (lu.bc.etape !== "SIGNE") return { ok: false, error: `Le bon de commande ${lu.bc.reference ?? ""} n'est pas signé par les Finances : aucune facture ne peut encore en découler.` };
  const fichier = formData.get("file");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, error: "Choisissez le fichier de la facture à lire." };
  const invalide = validateDocumentUpload(fichier.name, fichier.size, (await getAppSettings()).maxUploadMb);
  if (invalide) return { ok: false, error: `Fichier « ${fichier.name} » : ${invalide}` };

  const { annuaireVisible, groupe } = await annuaireDeLecture(user.id);
  const r = await proposerLecture({
    user, octets: Buffer.from(await fichier.arrayBuffer()), nomFichier: fichier.name,
    contexte: { cible: "PROMO_FACTURE", sortieCloudPermise: true, annuaireVisible, groupe },
  });
  if (!r.ok) return { ok: false, error: r.error };
  const brut = (await devisDuDossier(pm.id)).find((d) => d.id === lu.devis.id);
  const facturees = await prisma.promoFactureLigne.findMany({
    where: { facture: { legalDocument: { kind: "INVOICE", chainFromId: lu.bc.id, status: { not: "CANCELLED" } } } },
    select: { quoteLineId: true, quantite: true },
  });
  const lignesBC = brut ? lignesDuBC(devisLu(brut), facturees.map((f) => ({ quoteLineId: f.quoteLineId, quantite: Number(f.quantite) }))) : [];
  const prerempli = preremplirFacturePromo(r.proposition.piece, r.proposition.entetes, r.proposition.controle, lignesBC);
  const n = prerempli.lignes.filter((l) => l.quoteLineId).length;
  return {
    ok: true,
    lecture: { lectureId: r.proposition.lectureId, noteMethode: r.proposition.noteMethode, sansLignes: r.proposition.sansLignes, prerempli },
    message: n > 0
      ? `Facture lue : ${n} ligne${n > 1 ? "s" : ""} appariée${n > 1 ? "s" : ""} au BC — comparez chacune au papier, puis cochez-la.`
      : `Facture lue : ${r.proposition.sansLignes ?? "aucune ligne appariée au BC ; saisissez-les depuis le papier."}`,
  };
}

export async function deposerFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const lu = await devisEtBC(pm, fdStr(formData, "quoteId"));
  if (!lu) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  if (!lu.bc) return { ok: false, error: "Ce devis n'a pas de bon de commande : la facture se rattache à un BC." };
  if (lu.bc.etape !== "SIGNE") return { ok: false, error: `Le bon de commande ${lu.bc.reference ?? ""} n'est pas signé par les Finances : aucune facture ne peut encore en découler.` };

  const reference = fdStr(formData, "reference");
  const montant = fdNum(formData, "amount");
  const fichier = formData.get("file");
  const manques = [
    ...(!reference ? ["le numéro de la facture"] : []),
    ...(!(montant != null && montant > 0) ? ["son total TTC imprimé"] : []),
    ...(!(fichier instanceof File && fichier.size > 0) ? ["le fichier de la facture (obligatoire)"] : []),
  ];
  if (manques.length) return { ok: false, error: `Il manque ${manques.join(", ")}.` };
  const file = fichier as File;
  const invalide = validateDocumentUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (invalide) return { ok: false, error: `Fichier « ${file.name} » : ${invalide}` };

  // LA LECTURE CONFIRMÉE (lot D2-F) : préremplie depuis la facture, elle exige chaque ligne lue cochée
  // « vérifiée » et le total coché, contre CE fichier — AVANT toute écriture (P7).
  const lectureId = fdStr(formData, "lectureId");
  let confirmation: ConfirmationPrete | null = null;
  if (lectureId !== null) {
    const rangs = formData.getAll("ligneLue").map((x) => String(x));
    const verifiees = formData.getAll("ligneVerifiee").map((x) => String(x));
    const ids = formData.getAll("ligneQuoteLineId").map((x) => String(x));
    const qtes = formData.getAll("ligneQuantite"); const prixs = formData.getAll("lignePrix");
    const designations = formData.getAll("ligneDesignation").map((x) => String(x));
    const exigee = await exigerLectureConfirmee({
      lectureId,
      empreinte: empreinteDe(Buffer.from(await file.arrayBuffer())),
      totalVerifie: fdCase(formData, "totalVerifie") === true,
      soumises: ids.map((id, i) => ({
        lue: rangs[i] ? Number(rangs[i]) : null, verifiee: verifiees[i] === "1", designation: designations[i] ?? id,
        quantite: lireNombreSaisi(qtes[i]) ?? 0, prixUnitaire: lireNombreSaisi(prixs[i]) ?? 0,
      })).filter((x) => x.quantite > 0 || x.lue !== null),
      proposees: lignesProposeesFacturePromo,
    });
    if (!exigee.ok) return { ok: false, error: exigee.error };
    confirmation = exigee.confirmation;
  }

  // LES TAXES : celles du BC (son devis), sauf saisie explicite — une facture à 9 % pour un BC à
  // 19 % se paie au montant facturé ; le plafond du BC tient de toute façon.
  const taxesDuDevis = await prisma.promoQuote.findUnique({ where: { id: lu.devis.id }, select: { tvaRate: true, extraTaxLabel: true, extraTaxRate: true } });
  const brutTva = fdStr(formData, "tvaRate");
  // Jamais de 19 de repli : le taux est celui saisi, ou celui du devis — et sans TVA indiquée, il n'y a pas de TVA (0).
  const tvaDuDevis = taxesDuDevis?.tvaRate != null ? Number(taxesDuDevis.tvaRate) : 0;
  const tvaRate = brutTva != null && brutTva.trim() !== "" ? parseQuantity(brutTva) : tvaDuDevis;
  if (tvaRate == null || !(tvaRate >= 0 && tvaRate <= 100)) return { ok: false, error: "Le taux de TVA s'exprime en pour cent, entre 0 et 100." };
  const taxeSaisie = formData.has("extraTaxRate");
  const brutTaxe = taxeSaisie ? fdStr(formData, "extraTaxRate") : null;
  const extraTaxRate = taxeSaisie
    ? (brutTaxe ? parseQuantity(brutTaxe) : null)
    : (taxesDuDevis?.extraTaxRate != null ? Number(taxesDuDevis.extraTaxRate) : null);
  if (taxeSaisie && brutTaxe && (extraTaxRate == null || !(extraTaxRate > 0 && extraTaxRate <= 100))) {
    return { ok: false, error: "La taxe additionnelle s'exprime en pour cent, entre 0 et 100 (laissez vide s'il n'y en a pas)." };
  }
  const extraTaxLabel = extraTaxRate != null ? (fdStr(formData, "extraTaxLabel") ?? taxesDuDevis?.extraTaxLabel ?? "Taxe additionnelle") : null;

  // SÉRIALISÉ PAR BC, du plafond à la création : deux dépôts simultanés liraient le même cumul et
  // passeraient tous deux sous le montant du BC — ensemble, ils le dépasseraient (§118.148).
  const bcId = lu.bc.id;
  const bcMontant = lu.bc.montant;
  const bcReference = lu.bc.reference;
  return enSerie(`promo-facture:${bcId}`, async (): Promise<ActionResult> => {
    // LES LIGNES DU BC, avec ce que les factures ACTIVES en ont déjà facturé — relues sous la file.
    const brut = (await devisDuDossier(pm.id)).find((d) => d.id === lu.devis.id);
    if (!brut) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
    const facturees = await prisma.promoFactureLigne.findMany({
      where: { facture: { legalDocument: { kind: "INVOICE", chainFromId: bcId, status: { not: "CANCELLED" } } } },
      select: { quoteLineId: true, quantite: true },
    });
    const lignesBC = lignesDuBC(devisLu(brut), facturees.map((f) => ({ quoteLineId: f.quoteLineId, quantite: Number(f.quantite) })));
    const ids = formData.getAll("ligneQuoteLineId").map((x) => String(x));
    const qtes = formData.getAll("ligneQuantite");
    const prix = formData.getAll("lignePrix");
    const saisies = ids.length
      ? ids.map((id, i) => ({ quoteLineId: id, quantite: lireNombreSaisi(qtes[i]), prixUnitaire: lireNombreSaisi(prix[i]) }))
      : lignesProposees(lignesBC);
    const v = validerLignesFacture(saisies, lignesBC);
    if (!v.ok) return { ok: false, error: v.error };
    const totaux = totauxFacture({ tvaRate, extraTaxRate }, v.lignes);
    const ecartImprime = ecartTotalImprime(totaux.ttc, montant as number);
    if (ecartImprime) {
      return {
        ok: false,
        error: `Les lignes font ${formatDzd(totaux.ttc)} TTC (HT ${formatDzd(totaux.ht)}, TVA ${tvaRate} %${extraTaxRate ? `, ${extraTaxLabel} ${extraTaxRate} %` : ""}), la facture annonce ${formatDzd(montant as number)} : vérifiez les quantités, les prix et les taxes saisis.`,
      };
    }
    const deja = await prisma.legalDocument.aggregate({ where: { kind: "INVOICE", chainFromId: bcId, status: { not: "CANCELLED" } }, _sum: { amount: true } });
    const cumul = Number(deja._sum.amount ?? 0) + (montant as number);
    if (bcMontant != null && cumul > bcMontant + 1) {
      return { ok: false, error: `Les factures de ce bon de commande feraient ${formatDzd(cumul)}, pour un BC de ${formatDzd(bcMontant)} : on ne paie pas plus que la commande validée. Vérifiez le montant, ou faites réviser le BC.` };
    }
    const bc = await prisma.legalDocument.findUnique({ where: { id: bcId }, select: { companyId: true } });
    const facture = await prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.create({
        data: {
          companyId: bc?.companyId ?? pm.companyId,
          kind: "INVOICE",
          reference,
          title: `Facture ${reference} — ${lu.devis.supplierName} (${pm.reference})`,
          counterparty: lu.devis.supplierName,
          counterpartyIds: lu.devis.supplierId ? [lu.devis.supplierId] : [],
          startDate: fdDate(formData, "invoiceDate") ?? new Date(),
          amount: new Prisma.Decimal(montant as number),
          chainFromId: bcId,
          sourceType: "PROMO_MATERIAL",
          sourceId: pm.id,
          createdById: user.id, updatedById: user.id,
        },
        select: { id: true },
      });
      await tx.promoFacture.create({
        data: {
          legalDocumentId: doc.id, quoteId: lu.devis.id,
          tvaRate: new Prisma.Decimal(tvaRate), extraTaxLabel, extraTaxRate: extraTaxRate != null ? new Prisma.Decimal(extraTaxRate) : null,
          totalImprime: new Prisma.Decimal(montant as number), createdById: user.id,
          lignes: {
            create: v.lignes.map((l, i) => ({
              position: i, designation: l.designation, action: l.action, unite: l.unite,
              quantite: new Prisma.Decimal(l.quantite), prixUnitaire: new Prisma.Decimal(l.prixUnitaire),
              quoteLineId: l.quoteLineId, requestItemId: l.requestItemId,
            })),
          },
        },
      });
      if (confirmation) await consignerConfirmation(tx, { confirmation, cibleType: "PROMO_FACTURE", cibleId: doc.id, confirmeeParId: user.id });
      return doc;
    }).catch((e) => { if (e instanceof RefusLecture) return { refus: e.message } as const; throw e; });
    if ("refus" in facture) return { ok: false, error: facture.refus };
    const piece = await persistUploadedDocument(user.id, {
      entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: "facture", file,
    });
    if (!piece.ok) {
      // Une facture sans son fichier ne se contrôle pas : on ne la garde pas (son détail part avec elle).
      await prisma.legalDocument.delete({ where: { id: facture.id } }).catch(() => undefined);
      return { ok: false, error: `Fichier « ${file.name} » : ${piece.error ?? "téléversement impossible"}` };
    }
    const ecarts = ecartsAuBC(v.lignes, lignesBC);
    await audit(user, pm.id, `Facture ${reference} déposée pour le BC ${bcReference ?? ""} (${lu.devis.supplierName}) — ${v.lignes.length} ligne(s), ${formatDzd(montant as number)} TTC${ecarts.length ? ` ; écarts au BC : ${ecarts.map(phraseEcart).join(" ; ")}` : ""}`);
    revalidatePath(chemin(pm.id));
    return {
      ok: true, id: facture.id,
      message: `Facture ${reference} enregistrée (${v.lignes.length} ligne${v.lignes.length > 1 ? "s" : ""}, ${formatDzd(montant as number)} TTC). `
        + (ecarts.length ? `Écarts avec le BC : ${ecarts.map(phraseEcart).join(" ; ")}. ` : "")
        + "Cochez la réception de chaque ligne à l'arrivée du matériel : c'est ce qui entre au stock, et ce qu'on paie.",
    };
  });
}

/** La ligne de facture d'un dossier, avec sa facture — `null` si elle n'est pas à ce dossier. */
async function ligneDuDossier(pm: Dossier, ligneId: string | null) {
  if (!ligneId) return null;
  return prisma.promoFactureLigne.findFirst({
    where: { id: ligneId, facture: { legalDocument: { kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm.id, status: { not: "CANCELLED" } } } },
    select: {
      ...SELECT_LIGNE_FACTURE,
      facture: { select: { legalDocument: { select: { id: true, reference: true, companyId: true, expenseOrderId: true, paidDate: true, counterparty: true } } } },
    },
  });
}

/** Le refus commun de la réception ; `null` = on peut cocher. */
function refusReception(user: SessionUser, pm: Dossier | null): string | null {
  if (!pm) return "Dossier introuvable.";
  if (pm.circuitVersion !== 2) return "Ce dossier suit l'ancien circuit : il n'a pas de réception ligne à ligne.";
  if (!peutReceptionner({ id: user.id, role: user.role }, pm)) {
    return "La réception se coche par le demandeur du dossier (le Super Admin en suppléance) : c'est lui qui atteste ce qui est arrivé.";
  }
  if (pm.circuitState !== "IN_EXECUTION") return pm.circuitState === "COMPLETED" ? "Ce dossier est terminé." : "La réception vient après les bons de commande et leurs factures.";
  return null;
}

const quantiteLue = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

/**
 * RÉCEPTIONNER UNE LIGNE DE FACTURE — « le demandeur coche, sur la facture décomposée en tableau,
 * les références et quantités reçues : elles entrent au stock général » (§118.165).
 *
 * Ce que la ligne PRODUIT (impression, fabrication, achat) entre au MAGASIN CENTRAL de la société
 * qui a commandé, en un LOT au coût de la facture (origine ACHAT) — par l'écrivain unique du stock,
 * sous le verrou de l'article, et dans la MÊME transaction que la coche : deux clics ne font pas
 * deux lots, et une coche ne survit pas à une entrée qui a échoué. Une prestation (conception,
 * livraison…) est cochée « faite ». Un support NUMÉRIQUE reçoit son lien et sa validité, sans
 * quantité. L'article de stock est celui de l'article DEMANDÉ (catalogue + produits) ; une ligne
 * « en plus » le choisit ici.
 *
 * C'est une ATTESTATION (« c'est arrivé ») : le demandeur, le Super Admin en suppléance — jamais
 * Adam (EXCLUDED). Et elle se clôt quand le paiement est demandé : on ne coche plus ce qu'on a payé.
 */
export async function receptionnerLigneFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusReception(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const brut = await ligneDuDossier(pm, fdStr(formData, "ligneId"));
  if (!brut) return { ok: false, error: "Cette ligne n'appartient pas à une facture de ce dossier." };
  const facture = brut.facture.legalDocument;
  if (await paiementEnCours(facture)) return { ok: false, error: "Le paiement de cette facture est déjà demandé : sa réception est close." };
  const ligne = ligneFactureLue(brut);
  const brutQ = fdStr(formData, "quantiteRecue");
  const q = brutQ ? parseQuantity(brutQ) : null;
  if (brutQ && q == null) return { ok: false, error: "Quantité reçue illisible." };
  const v = validerReception(ligne, q);
  if (!v.ok) return { ok: false, error: v.error };

  const articleDemande = ligne.requestItemId
    ? await prisma.promoRequestItem.findUnique({ where: { id: ligne.requestItemId }, select: SELECT_ARTICLE_DEMANDE })
    : null;
  const nature = natureDeReception(ligne, articleDemande ? articleDemandeLu(articleDemande) : null);

  // L'ARTICLE DU CATALOGUE QUI REÇOIT — celui de l'article demandé, ou choisi ici.
  let catalogueId: string | null = null;
  let produitIds: string[] = [];
  if (nature.type === "STOCK") {
    catalogueId = nature.catalogueId;
    produitIds = nature.produitIds;
  } else if (nature.type === "A_CHOISIR") {
    catalogueId = fdStr(formData, "catalogueId");
    produitIds = formData.getAll("produitIds").map(String).filter(Boolean);
    if (!catalogueId && nature.obligatoire) {
      return { ok: false, error: "Cette ligne n'était pas demandée : choisissez l'article du catalogue qui reçoit ces unités (et ses produits)." };
    }
  }
  const maintenant = new Date();
  const libelleFacture = `facture ${facture.reference ?? "sans numéro"}${facture.counterparty ? ` (${facture.counterparty})` : ""}`;

  // UNE PRESTATION — cochée « faite », rien n'entre au stock.
  if (!catalogueId) {
    const r = await prisma.promoFactureLigne.updateMany({
      where: { id: ligne.id, quantiteRecue: null, renonce: false },
      data: { quantiteRecue: new Prisma.Decimal(v.quantite), recueLe: maintenant, recueParId: user.id },
    });
    if (r.count === 0) return { ok: false, error: `« ${ligne.designation} » vient d'être réceptionnée.` };
    await audit(user, pm.id, `Réception cochée — « ${ligne.designation} » (${libelleFacture}) : prestation faite${user.id !== pm.requesterId ? " (en suppléance du demandeur)" : ""}`);
    revalidatePath(chemin(pm.id));
    return { ok: true, message: `« ${ligne.designation} » cochée faite — c'est une prestation : rien n'entre au stock.` };
  }

  const catalogue = await prisma.promoCatalogueArticle.findUnique({
    where: { id: catalogueId },
    select: { id: true, reference: true, nom: true, famille: true, unite: true, materialType: true, exigeProduit: true, actif: true },
  });
  if (!catalogue) return { ok: false, error: "Article du catalogue introuvable." };
  if (nature.type === "A_CHOISIR") {
    if (!catalogue.actif) return { ok: false, error: `${catalogue.reference} est archivé : choisissez un article actif du catalogue.` };
    if (catalogue.exigeProduit && produitIds.length === 0) return { ok: false, error: `${catalogue.nom} n'existe que pour un produit : choisissez le ou les produits concernés.` };
  }
  const nomsProduits = produitIds.length
    ? await prisma.product.findMany({ where: { id: { in: produitIds } }, select: { canonicalName: true } })
    : [];
  if (nomsProduits.length !== new Set(produitIds).size) return { ok: false, error: "Un des produits choisis est introuvable." };
  const libelle = libelleArticleStock(catalogue.nom, nomsProduits.map((p) => p.canonicalName));
  const famille = catalogue.famille as FamillePromo;
  const companyId = facture.companyId ?? pm.companyId;
  const article = await trouverOuCreerArticle({
    companyId, catalogueId: catalogue.id, produitIds, nom: libelle, unite: catalogue.unite,
    materialType: catalogue.materialType, auteurId: user.id,
  });

  // UN SUPPORT NUMÉRIQUE — son lien et sa validité, pas de quantité.
  if (!familleQuantifiee(famille)) {
    const lien = fdStr(formData, "lien");
    const brutValidite = fdStr(formData, "valableJusquau");
    const validite = lireDateJour(brutValidite);
    if (brutValidite && !validite) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
    const fait = await prisma.$transaction(async (tx) => {
      const r = await tx.promoFactureLigne.updateMany({
        where: { id: ligne.id, quantiteRecue: null, renonce: false },
        data: { quantiteRecue: new Prisma.Decimal(ligne.quantite), recueLe: maintenant, recueParId: user.id, stockItemId: article.id },
      });
      if (r.count === 0) return false;
      if (lien || validite) {
        await tx.promoStockItem.update({ where: { id: article.id }, data: { ...(lien ? { lien } : {}), ...(validite ? { valableJusquau: validite } : {}), updatedById: user.id } });
      }
      return true;
    });
    if (!fait) return { ok: false, error: `« ${ligne.designation} » vient d'être réceptionnée.` };
    await audit(user, pm.id, `Réception cochée — « ${ligne.designation} » (${libelleFacture}) : support numérique ${libelle} livré`);
    revalidatePath(chemin(pm.id));
    revalidatePath(CHEMIN_STOCK_PROMO);
    return { ok: true, message: `${libelle} livré${lien ? " — son lien est enregistré au stock" : ""}.` };
  }

  // DES UNITÉS — un lot au magasin central, au coût de la facture.
  const brutValidite = fdStr(formData, "valableJusquau");
  const valableJusquau = lireDateJour(brutValidite);
  if (brutValidite && !valableJusquau) return { ok: false, error: "Date de fin de validité illisible (format attendu : AAAA-MM-JJ)." };
  if (valableJusquau && !familleAValidite(famille)) return { ok: false, error: "Un article durable ne périme pas : laissez la fin de validité vide." };
  const r = await sousVerrou(article.id, async (tx) => {
    const maj = await tx.promoFactureLigne.updateMany({
      where: { id: ligne.id, quantiteRecue: null, renonce: false },
      data: { quantiteRecue: new Prisma.Decimal(v.quantite), recueLe: maintenant, recueParId: user.id },
    });
    if (maj.count === 0) return { refus: `« ${ligne.designation} » vient d'être réceptionnée.` };
    const lot = await entrerLot(tx, article.id, {
      holderId: null, quantite: v.quantite, kind: "RECEIPT", origine: "ACHAT",
      coutUnitaire: ligne.prixUnitaire, valableJusquau,
      libelle: `Achat ${pm.reference} — ${libelleFacture}`,
      motif: `Réception de la ${libelleFacture} (${pm.reference})`, recuLe: maintenant, auteurId: user.id,
    });
    await tx.promoFactureLigne.update({ where: { id: ligne.id }, data: { stockItemId: article.id, stockLotId: lot.lotId } });
    return lot;
  });
  if ("refus" in r) return { ok: false, error: r.refus };
  await audit(user, pm.id, `Réception cochée — « ${ligne.designation} » (${libelleFacture}) : +${quantiteLue(v.quantite)} ${libelle} au magasin central (lot ${r.numero})${user.id !== pm.requesterId ? " — en suppléance du demandeur" : ""}`);
  // LA GESTIONNAIRE DU MAGASIN APPREND CE QUI ENTRE : c'est elle qui dote ensuite les délégués.
  const gestionnaires = await gestionnairesDuMagasin();
  for (const userId of new Set(gestionnaires)) {
    if (userId === user.id) continue;
    await notifyUser({ userId, type: "GENERIC", title: "Entrée au magasin — achat reçu", body: `+${quantiteLue(v.quantite)} ${libelle} (${pm.reference}, ${libelleFacture})`, link: CHEMIN_STOCK_PROMO });
  }
  revalidatePath(chemin(pm.id));
  revalidatePath(CHEMIN_STOCK_PROMO);
  return {
    ok: true,
    message: `+${quantiteLue(v.quantite)} ${libelle} entrés au magasin central (lot ${r.numero})`
      + (v.quantite < ligne.quantite ? ` — ${quantiteLue(ligne.quantite - v.quantite)} facturées ne sont pas arrivées : au paiement, vous direz si vous y renoncez.` : "."),
  };
}

/**
 * ANNULER UNE RÉCEPTION — une coche erronée se défait, tant que le paiement n'est pas demandé.
 *
 * Le lot entré au magasin est CONTRE-PASSÉ par l'écrivain unique (son exact inverse) — refusé si une
 * partie en est déjà sortie : annuler l'entrée de 5 000 fiches dont 300 sont chez des délégués
 * laisserait le magasin à −300. Rien ne se supprime ; la ligne redevient « à réceptionner ».
 */
export async function annulerReceptionLigneFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusReception(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const brut = await ligneDuDossier(pm, fdStr(formData, "ligneId"));
  if (!brut) return { ok: false, error: "Cette ligne n'appartient pas à une facture de ce dossier." };
  const facture = brut.facture.legalDocument;
  if (await paiementEnCours(facture)) return { ok: false, error: "Le paiement de cette facture est déjà demandé : sa réception ne se défait plus." };
  if (brut.quantiteRecue == null) return { ok: false, error: `« ${brut.designation} » n'est pas réceptionnée.` };
  // DÉFAIRE UNE RÉCEPTION DIT POURQUOI (audit 360°, R17) : son entrée au magasin est contre-passée, et le
  // journal doit dire si c'était une erreur de saisie ou une marchandise renvoyée.
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi cette réception est annulée : erreur de saisie, marchandise renvoyée…" };
  const remise = { quantiteRecue: null, recueLe: null, recueParId: null, stockItemId: null, stockLotId: null };

  if (brut.stockLotId && brut.stockItemId) {
    const entree = await prisma.promoStockMovement.findFirst({ where: { lotId: brut.stockLotId, kind: "RECEIPT" }, select: { id: true } });
    if (!entree) return { ok: false, error: "L'entrée au stock de cette ligne est introuvable." };
    const lotId = brut.stockLotId;
    const r = await sousVerrou(brut.stockItemId, async (tx) => {
      const a = await annulerMouvementEcrit(tx, entree.id, user.id, motif);
      if (!a.ok) return { refus: a.refus };
      const maj = await tx.promoFactureLigne.updateMany({ where: { id: brut.id, stockLotId: lotId }, data: remise });
      if (maj.count === 0) throw new Error("La ligne a changé pendant l'annulation.");
      return { ok: true as const };
    });
    if ("refus" in r) return { ok: false, error: r.refus };
  } else {
    await prisma.promoFactureLigne.update({ where: { id: brut.id }, data: remise });
  }
  await audit(user, pm.id, `Réception annulée — « ${brut.designation} » (facture ${facture.reference ?? ""}) — ${motif.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true, message: `Réception de « ${brut.designation} » annulée${brut.stockLotId ? " — son entrée au magasin est contre-passée" : ""}.` };
}

/**
 * ANNULER UNE FACTURE — un doublon, une facture fausse, une facture dont rien n'est arrivé.
 *
 * Elle reste au registre, ANNULÉE (jamais effacée), avec son motif. Refusée quand le paiement est
 * demandé (il est parti au centre de paiement), et quand une ligne est réceptionnée : ce qui est
 * entré au stock y est physiquement — on défait d'abord la réception, en connaissance de cause.
 */
export async function annulerFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const facture = await factureDuDossier(pm, fdStr(formData, "invoiceId"));
  if (!facture) return { ok: false, error: "Cette facture n'appartient pas à ce dossier." };
  if (await paiementEnCours(facture)) return { ok: false, error: "Le paiement de cette facture est déjà demandé : elle ne s'annule plus d'ici." };
  const recues = await prisma.promoFactureLigne.count({ where: { facture: { legalDocumentId: facture.id }, quantiteRecue: { not: null } } });
  if (recues > 0) return { ok: false, error: `${recues} ligne(s) de cette facture sont réceptionnées : annulez d'abord leur réception (ce qui est entré au stock y est physiquement).` };
  const doc = await prisma.legalDocument.findUnique({ where: { id: facture.id }, select: { status: true } });
  if (!doc || !canCancel(doc.status)) return { ok: false, error: "Cette facture ne peut plus être annulée." };
  // Le motif APRÈS les refus ci-dessus : on ne demande pas pourquoi annuler une facture qui ne
  // s'annule pas d'ici (§118.18).
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi cette facture est annulée : elle reste au registre, avec ce motif." };
  // Un ordre REFUSÉ par le centre reste « en attente » côté statut : il se ferme avec sa facture.
  if (facture.expenseOrderId) {
    const fermeture = await annulerOrdreNonRegle(facture.expenseOrderId, { acteurId: user.id, motif: `facture ${facture.reference ?? ""} annulée — ${motif.slice(0, 120)}` });
    if (!fermeture.ok) return { ok: false, error: fermeture.error };
  }
  await prisma.legalDocument.update({
    where: { id: facture.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: motif, updatedById: user.id },
  });
  await audit(user, pm.id, `Facture ${facture.reference ?? ""} annulée — ${motif.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: `Facture ${facture.reference ?? ""} annulée — ses lignes redeviennent à facturer sur le BC.` };
}

const FORMALITES = ["AD_VISA", "MIP"] as const;
type Formalite = (typeof FORMALITES)[number];
const LIBELLE_FORMALITE: Record<Formalite, string> = { AD_VISA: "demande de visa publicitaire", MIP: "déclaration au ministère" };

/**
 * LE PAIEMENT DE CETTE FACTURE EST-IL EN COURS ? Réglée en direct, ou partie au circuit sur un ordre
 * qui peut encore payer. Un ordre REFUSÉ par le centre ou ANNULÉ ne paiera jamais (§118.185, audit
 * 360° I8) : la facture redevient corrigeable, annulable et renvoyable — sinon elle restait figée.
 */
async function paiementEnCours(facture: { expenseOrderId: string | null; paidDate: Date | null }): Promise<boolean> {
  if (facture.paidDate) return true;
  if (!facture.expenseOrderId) return false;
  const ordre = await prisma.expenseOrder.findUnique({ where: { id: facture.expenseOrderId }, select: { status: true, centralStatus: true } });
  return !ordreClos(ordre);
}

/** La facture de CE dossier, et le BC dont elle découle. */
async function factureDuDossier(pm: Dossier, invoiceId: string | null) {
  if (!invoiceId) return null;
  return prisma.legalDocument.findFirst({
    where: { id: invoiceId, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm.id, status: { not: "CANCELLED" } },
    select: {
      id: true, reference: true, title: true, kind: true, amount: true, counterparty: true, endDate: true,
      paidDate: true, expenseOrderId: true, chainFrom: { select: { id: true, reference: true } },
    },
  });
}

/**
 * DEMANDER LE PAIEMENT D'UNE FACTURE — et, avec lui, la demande à l'information médicale.
 *
 * Le paiement passe par la porte commune : `canSendToSettlement` (pas deux fois, pas sans montant,
 * pas sur un BC que son centre n'a pas validé), puis `createExpenseOrder`, qui le fait naître en
 * attente du CENTRE DE PAIEMENT (§118.148). La demande de visa publicitaire — ou la déclaration au
 * ministère — part AVEC le paiement, une par paiement : c'est ce que la Direction a demandé, et le
 * PRIM instruit en parallèle du règlement au lieu de l'attendre. Elle ne porte AUCUN montant :
 * l'information médicale n'émet pas d'ordre pour elle, sans quoi le même matériel serait payé deux
 * fois (§118.151).
 */
export async function demanderPaiementFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const formalite = fdStr(formData, "formalite") as Formalite | null;
  if (!formalite || !FORMALITES.includes(formalite)) {
    return { ok: false, error: "Choisissez la formalité qui accompagne ce paiement : demande de visa publicitaire, ou déclaration au ministère." };
  }
  const invoiceId = fdStr(formData, "invoiceId");
  // SÉRIALISÉ PAR FACTURE : deux clics simultanés liraient tous deux « aucun ordre » et feraient
  // naître deux ordres de dépense pour la même facture — le même dinar demandé deux fois.
  // La clé est celle de la fiche Legal, qui envoie la MÊME pièce par l'autre porte (§118.185).
  return enSerie(cleEnvoiAuReglement(invoiceId), async (): Promise<ActionResult> => {
    const facture = await factureDuDossier(pm, invoiceId);
    if (!facture) return { ok: false, error: "Cette facture n'appartient pas à ce dossier." };
    const bc = facture.chainFrom ? await etatDuBC(facture.chainFrom.id) : null;
    if (!bc || bc.annule) return { ok: false, error: "Cette facture ne découle d'aucun bon de commande actif du dossier." };
    if (bc.etape !== "SIGNE") return { ok: false, error: `Le bon de commande ${bc.reference ?? ""} n'est pas signé par les Finances : sa facture ne se paie pas encore.` };

    // LA RÉCEPTION D'ABORD (§118.165) : une facture DÉTAILLÉE se paie pour ce qui est REÇU. Une
    // ligne qui attend bloque le paiement — sauf renoncement CONFIRMÉ, définitif (« un paiement
    // pour cette ligne ne pourra pas être fait ultérieurement »). Une facture d'avant le détail
    // ligne à ligne garde le comportement d'avant : son montant, sans réception.
    const detail = await prisma.promoFacture.findUnique({
      where: { legalDocumentId: facture.id },
      select: { tvaRate: true, extraTaxRate: true, totalImprime: true, lignes: { orderBy: { position: "asc" }, select: SELECT_LIGNE_FACTURE } },
    });
    let montant = facture.amount != null ? Number(facture.amount) : 0;
    let renoncer: string[] = [];
    let partiel = false;
    if (detail) {
      const v = verdictPaiementDetaille(
        { tvaRate: Number(detail.tvaRate), extraTaxRate: detail.extraTaxRate != null ? Number(detail.extraTaxRate) : null, totalImprime: detail.totalImprime != null ? Number(detail.totalImprime) : null },
        detail.lignes.map(ligneFactureLue),
        formData.get("confirmeRenoncement") === "1",
      );
      if (!v.ok) return { ok: false, error: v.error };
      montant = v.montant;
      renoncer = v.renoncer;
      partiel = !v.complet;
    }
    // L'ORDRE DÉJÀ LIÉ (§118.185, audit 360° I8) : refusé par le centre ou annulé, il ne paiera
    // jamais — la facture repart, et l'ancien ordre est fermé pour qu'aucune décision tardive du
    // centre ne rende payables deux ordres pour la même facture.
    const ordreLie = facture.expenseOrderId
      ? await prisma.expenseOrder.findUnique({ where: { id: facture.expenseOrderId }, select: { status: true, centralStatus: true } })
      : null;
    const envoi = canSendToSettlement({
      kind: facture.kind, amount: montant || null, paidDate: facture.paidDate, expenseOrderId: facture.expenseOrderId,
      bc: { porte: await porteDuBC(bc.id), reference: bc.reference }, ordreLie,
    });
    if (!envoi.ok) return { ok: false, error: envoi.error };
    // RENONCER EST DÉFINITIF (« un paiement pour cette ligne ne pourra pas être fait ultérieurement ») :
    // il dit pourquoi (audit 360°, R17) — APRÈS les refus ci-dessus (on ne demande pas pourquoi renoncer
    // pour une facture qui ne partira pas, §118.18) et AVANT tout effet. `=== null` : un paiement complet
    // n'a rien à expliquer, et la dérivation ne doit pas rendre le motif obligatoire pour lui (§118.138).
    const motifRenoncement = fdStr(formData, "motifRenoncement");
    if (renoncer.length > 0 && motifRenoncement === null) {
      return { ok: false, error: "Dites pourquoi vous renoncez aux lignes non reçues : ce renoncement est définitif." };
    }
    if (ordreLie) {
      const fermeture = await annulerOrdreNonRegle(facture.expenseOrderId, { acteurId: user.id, motif: `remplacé par un nouvel envoi de la facture ${facture.reference ?? ""}` });
      if (!fermeture.ok) return { ok: false, error: fermeture.error };
    }
    if (renoncer.length) {
      // Écrit AVANT l'ordre : un renoncement confirmé ne dépend pas de la suite. Conditionnel : une
      // ligne déjà renoncée ne l'est pas deux fois (la date et l'auteur restent ceux du premier geste).
      await prisma.promoFactureLigne.updateMany({
        where: { id: { in: renoncer }, renonce: false },
        data: { renonce: true, renonceMotif: motifRenoncement, renonceLe: new Date(), renonceParId: user.id },
      });
    }

    const ordre = await createExpenseOrder({
      label: `${facture.reference ? `${facture.reference} — ` : ""}${facture.title}${partiel ? " — part reçue" : ""}`,
      amount: montant,
      category: "FOURNISSEUR",
      beneficiary: facture.counterparty,
      sourceType: "LEGAL_DOCUMENT",
      sourceId: facture.id,
      requestedById: user.id,
      dueDate: facture.endDate,
    });
    await prisma.legalDocument.update({ where: { id: facture.id }, data: { expenseOrderId: ordre.id, updatedById: user.id } });
    // LA DEMANDE À L'INFORMATION MÉDICALE part avec le paiement. Si elle échoue, le paiement, lui,
    // est PARTI : le taire en rendant une erreur ferait recliquer — et `canSendToSettlement`
    // refuserait alors un paiement déjà demandé, sans dire que la seule chose qui manque est la
    // demande de visa. On le DIT, avec le geste qui la rattrape.
    const declaration = await createMedicalInfoDeclaration({
      sourceType: "LEGAL_DOCUMENT",
      sourceId: facture.id,
      label: `Matériel promotionnel ${pm.reference} — ${pm.title} — ${facture.counterparty ?? "fournisseur"}, facture ${facture.reference ?? ""}`.trim(),
      beneficiary: facture.counterparty,
      amount: null,
      requesterId: pm.requesterId,
      declarationKind: formalite,
    }).catch(() => null);
    await audit(user, pm.id, `Paiement demandé — facture ${facture.reference ?? ""} (${formatDzd(montant)}${partiel ? ", part reçue" : ""}, ordre ${ordre.reference})${renoncer.length ? ` ; ${renoncer.length} ligne(s) non livrée(s) — renoncement confirmé, elles ne se paieront pas` : ""} ; ${declaration ? `${LIBELLE_FORMALITE[formalite]} ${declaration.reference} adressée à l'information médicale` : `${LIBELLE_FORMALITE[formalite]} NON adressée (échec) — à rattraper`}`);
    revalidatePath(chemin(pm.id));
    revalidatePath("/information-medicale");
    const formaliteLue = `${LIBELLE_FORMALITE[formalite][0].toUpperCase()}${LIBELLE_FORMALITE[formalite].slice(1)}`;
    return {
      ok: true,
      message: `Paiement demandé (ordre ${ordre.reference}, ${formatDzd(montant)}${partiel ? " — la part reçue" : ""}) : il attend le centre de paiement. `
        + (renoncer.length ? `${renoncer.length} ligne${renoncer.length > 1 ? "s" : ""} non livrée${renoncer.length > 1 ? "s" : ""} : renoncement enregistré, elle${renoncer.length > 1 ? "s" : ""} ne se paiera${renoncer.length > 1 ? "ont" : ""} pas. ` : "")
        + (declaration
          ? `${formaliteLue} ${declaration.reference} adressée à l'information médicale.`
          : `${formaliteLue} : elle n'a PAS pu partir — utilisez « Adresser à l'information médicale » sur cette facture.`),
    };
  });
}

/**
 * ADRESSER LA DEMANDE À L'INFORMATION MÉDICALE pour un paiement qui n'en a pas — le rattrapage.
 *
 * Une facture du dossier peut partir au règlement par un autre chemin (sa fiche Legal), ou la
 * demande avoir échoué après le paiement : le chantier « visa ou déclaration » le NOMME, et ce
 * geste le répare. Idempotent : une demande déjà adressée est rendue telle quelle.
 */
export async function adresserInfoMedicaleFacturePromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  const refus = refusExecution(user, pm);
  if (refus || !pm) return { ok: false, error: refus ?? "Dossier introuvable." };
  const formalite = fdStr(formData, "formalite") as Formalite | null;
  if (!formalite || !FORMALITES.includes(formalite)) {
    return { ok: false, error: "Choisissez la formalité : demande de visa publicitaire, ou déclaration au ministère." };
  }
  const facture = await factureDuDossier(pm, fdStr(formData, "invoiceId"));
  if (!facture) return { ok: false, error: "Cette facture n'appartient pas à ce dossier." };
  if (!facture.expenseOrderId && !facture.paidDate) {
    return { ok: false, error: "Aucun paiement n'est encore demandé pour cette facture : la demande part avec le paiement." };
  }
  const existante = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: "LEGAL_DOCUMENT", sourceId: facture.id } },
    select: { reference: true },
  });
  if (existante) return { ok: true, message: `La demande ${existante.reference} est déjà adressée à l'information médicale.` };
  const declaration = await createMedicalInfoDeclaration({
    sourceType: "LEGAL_DOCUMENT",
    sourceId: facture.id,
    label: `Matériel promotionnel ${pm.reference} — ${pm.title} — ${facture.counterparty ?? "fournisseur"}, facture ${facture.reference ?? ""}`.trim(),
    beneficiary: facture.counterparty,
    amount: null,
    requesterId: pm.requesterId,
    declarationKind: formalite,
  });
  await audit(user, pm.id, `${LIBELLE_FORMALITE[formalite]} ${declaration.reference} adressée à l'information médicale (facture ${facture.reference ?? ""})`);
  // LA DERNIÈRE PIÈCE PEUT ÊTRE CELLE-CI (un paiement déjà réglé dont la demande avait échoué) : le dossier se clôt seul.
  const clos = await cloreLeDossierPromoSiSolde(pm.id, user.id);
  revalidatePath(chemin(pm.id));
  revalidatePath("/information-medicale");
  return { ok: true, message: `${LIBELLE_FORMALITE[formalite][0].toUpperCase()}${LIBELLE_FORMALITE[formalite].slice(1)} ${declaration.reference} adressée à l'information médicale.${clos ? " Tout est reçu, payé et visé : le dossier est terminé." : ""}` };
}
