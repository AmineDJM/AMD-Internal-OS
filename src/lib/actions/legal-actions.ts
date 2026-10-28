"use server";

import { revalidatePath } from "next/cache";
import { refusMaillonAmont, REFUS_CHAINE_FACTURE_PROMO } from "@/lib/legal/chaine";
import { refusPieceARanger, rangerPiece } from "@/lib/legal/adoption";
import type { EntityType, LegalDocKind, LegalDocStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { resolveParties, findPartyByName } from "@/lib/queries/company-contacts";
import { refusAnnulationFacture } from "@/lib/queries/legal-annulation";
import { recordAudit } from "@/lib/audit";
import { companyIdForNew } from "@/lib/company";
import { canRenew, canCancel, canRestore, statutRetabli, validateDates, proposeRenewalDates } from "@/lib/legal/lifecycle";
import { canAccessEntity } from "@/lib/entity-access";
import { lecteursDeLaSuite } from "@/lib/lecteurs/legal";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { attachFormFiles } from "@/lib/documents";
import { verifierFacturesAvantDepot, marquerDoublonPossible } from "@/lib/factures/connues";
import { createExpenseOrder, syncInvoiceSettlement, annulerOrdreNonRegle } from "@/modules/finances/api";
import { normalizeReaderIds, canManageLegalReaders } from "@/lib/lecteurs/legal";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { PHRASE_PREVALIDATION } from "@/lib/bons-de-commande/prevalidation";
import { libererPrevalidation, retenueOrpheline } from "@/lib/bons-de-commande/retenue-bc";
import { legalWriteAllowed } from "@/lib/legal/invoices";
import { invoiceDirection, canSendToSettlement, canMarkPaidDirectly, cleEnvoiAuReglement, dateDeReglementAEcrire } from "@/modules/finances/partage";
import { enSerie } from "@/lib/refs";
import { champsDuFichierChanges, pieceEmise, refusChampsDuFichier } from "@/lib/legal/piece-emise";
import type { CurrentUser } from "@/lib/session";
import { aiguillerBC, retirerPortesEnAttente, porteDuBC, CHEMIN_BC_A_SIGNER, type ResultatAiguillage } from "@/lib/bons-de-commande/aiguillage";
import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { memeNumero, nettoyerNumero, resumeChangementNumero } from "@/lib/bons-de-commande/numero-reference";
import { champsDifferents, MENTION_NUMERO_SEUL } from "@/lib/bons-de-commande/numero-seul";
import { inscrireNumeroBcDepose, refusNumeroBcDepose } from "@/lib/bons-de-commande/numero-depose";
import { budgetPromoDeLaPiece } from "@/lib/queries/promo-budget";
import {
  reserveBC, reserveSansPorte, reserveEtapeBC, PHRASE_SIGNATURE_RETIREE,
  LIBELLE_CENTRE_BC, LIBELLE_ETAT_BC, CHEMIN_CENTRE_BC,
} from "@/lib/bons-de-commande/regle";
import { sansBloquer } from "@/lib/journal";

/**
 * LES ENGAGEMENTS DE LA SOCIÉTÉ — écriture.
 *
 * Deux principes tiennent tout ce fichier :
 *   • le FICHIER n'est jamais copié. Rattacher un document du Drive écrit une RÉFÉRENCE
 *     (`driveNodeId`) : il continue de vivre, de se versionner et de se renommer dans le Drive,
 *     et Legal en montre toujours la version courante. Une copie aurait divergé dès la première
 *     correction, et l'on n'aurait plus su laquelle fait foi.
 *   • un renouvellement N'ÉCRASE RIEN. Il crée un nouveau document qui pointe vers l'ancien, et
 *     l'ancien passe en « renouvelé ». L'historique des engagements est justement ce qu'on vient
 *     chercher dans un module Legal.
 */

// AMENDMENT n'y figure pas, et c'est délibéré : un avenant naît de SON contrat (`amendsId`), pas
// d'un formulaire libre — un avenant orphelin ne modifierait rien et fausserait la valeur du marché.
// CREDIT_NOTE non plus, pour la même raison : un avoir naît de SA facture, par la fabrique (§118.195), qui reprend son
// calcul et vérifie ce qui reste à créditer. Saisi ici et chaîné par « Fait suite à », il serait retiré du règlement de
// la facture sans être passé par ce plafond — un crédit que personne n'a borné.
const KINDS: LegalDocKind[] = ["CONTRACT", "QUOTE", "PURCHASE_ORDER", "INVOICE", "AGREEMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "OTHER"];
const parseKind = (v: string | null): LegalDocKind =>
  v && KINDS.includes(v as LegalDocKind) ? (v as LegalDocKind) : "CONTRACT";

/**
 * LA PORTE D'ÉCRITURE DU REGISTRE.
 *
 * Legal tient tout le registre ; la COMPTABILITÉ ne tient que les factures. La règle est un
 * module pur partagé avec l'écran et avec les actions du vocabulaire « facture » — trois copies
 * d'un contrôle d'accès finissent par diverger, et la divergence s'appelle une faille.
 */
function peutEcrire(user: CurrentUser, verb: "CREATE" | "UPDATE" | "DELETE", kind: string): boolean {
  return legalWriteAllowed({
    onLegal: userCan(user, "LEGAL", verb),
    onFinances: userCan(user, "FINANCES", verb),
    kind,
  });
}

/** Champs communs à la création et à la modification. */
function readFields(formData: FormData, natureImposee?: LegalDocKind) {
  // LA NATURE D'UNE PIÈCE ÉMISE est celle de son fichier (§118.194) : son formulaire ne la porte plus, et la
  // déduire d'un champ absent lisait « contrat » — la date de règlement d'une facture émise était alors
  // ignorée, et l'enregistrement l'effaçait, sans un mot.
  const kind = natureImposee ?? parseKind(fdStr(formData, "kind"));
  const estFacture = kind === "INVOICE";
  return {
    title: fdStr(formData, "title"),
    reference: fdStr(formData, "reference"),
    kind,
    // LA PARTIE VIENT DE L'ANNUAIRE. `counterparty` reste la colonne d'AFFICHAGE (recherche,
    // exports, briefs, outils d'Adam la lisent telle quelle) : le serveur la DÉDUIT de la
    // sélection, plus bas. La lire aussi du formulaire rouvrirait la porte du texte libre.
    counterpartyIds: formData.getAll("counterpartyIds").map(String).filter(Boolean),
    startDate: fdDate(formData, "startDate"),
    endDate: fdDate(formData, "endDate"),
    notes: fdStr(formData, "notes"),
    amount: fdStr(formData, "amount") ? Number(fdStr(formData, "amount")) : null,
    // CE QU'UNE FACTURE AJOUTE, et rien d'autre. Sur un bail, ces deux champs restent vides :
    // les remplir ferait apparaître un « sens de l'argent » sur une pièce qui n'en a pas, et le
    // registre des règlements compterait des documents qui ne se paient pas.
    direction: estFacture ? invoiceDirection(fdStr(formData, "direction")) : null,
    paidDate: estFacture ? fdDate(formData, "paidDate") : null,
    // DOSSIER DE CLASSEMENT. Vide = « non classé », et c'est un état normal : un engagement se
    // dépose vite, il se range ensuite. Le dossier ne change RIEN à qui peut le lire.
    folderId: fdStr(formData, "folderId"),
    // LA CHAÎNE : la pièce dont CELLE-CI découle (le BC de son devis, la facture de son BC).
    // Vide = pièce isolée — un bail ne suit rien.
    chainFromId: fdStr(formData, "chainFromId"),
  };
}

/**
 * CE QUE LA PHRASE DE L'ÉCRAN DIT D'UN BC QU'ON VIENT D'ÉCRIRE (§118.32).
 *
 * « Document créé » sur un bon de commande que personne n'a encore validé le ferait partir chez
 * le fournisseur : il s'ouvre, il porte un numéro. La phrase dit où il attend, et se tait quand
 * rien n'a bougé. Un aiguillage qui n'a trouvé AUCUN siège se dit aussi — une pièce sans porte ne
 * doit pas avoir l'air validée.
 */
function phraseAiguillage(r: ResultatAiguillage): string | null {
  const sansPorte = reserveSansPorte(r);
  if (sansPorte) return sansPorte;
  // La pièce n'est plus un BC (re-qualifiée ou annulée) : seule la porte retirée se dit.
  if (r.geste === "RETIREE") return "Sa validation en attente a été retirée du centre.";

  let tete: string | null = null;
  if (r.geste === "POSEE" || r.geste === "TRANSFEREE" || r.geste === "ROUVERTE") {
    const centre = r.porte ? LIBELLE_CENTRE_BC[r.porte.centre] : "centre de validation";
    const verbe = r.geste === "TRANSFEREE" ? "transféré au" : r.geste === "ROUVERTE" ? "renvoyé au" : "adressé au";
    tete = `Bon de commande ${verbe} ${centre}.`;
  } else if (r.geste === "SOUS_SEUIL") {
    tete = "Sa validation en attente est retirée du centre.";
  }
  // Rien n'a bougé : la phrase se tait (§118.32). Ce qui BOUGE sans geste de porte — l'entrée dans
  // la file des Finances, une signature retirée — se dit comme un geste.
  if (!tete && !r.signatureRetiree && !r.versLesFinances) return null;
  const reserve = r.etape ? reserveEtapeBC(r.etape, r.porte, r.seuil) : reserveBC(r.porte);
  return [r.signatureRetiree ? PHRASE_SIGNATURE_RETIREE : null, tete, reserve].filter(Boolean).join(" ");
}

/**
 * UNE PARTIE DONNÉE PAR SON NOM — pour l'appelant qui n'a que cela (Adam), résolue contre
 * l'annuaire exactement comme `attachDriveNodeToLegal` le fait déjà (§118.148).
 *
 * La création et la modification exigent une partie de l'ANNUAIRE ; le chemin conversationnel,
 * lui, envoyait un nom en texte (`counterparty`) que ces actions ne lisent plus : toute création
 * d'Adam était refusée APRÈS le clic de confirmation, sur une partie que la personne venait de
 * nommer. Le nom n'est jamais écrit tel quel : introuvable ou ambigu, le refus le dit. Un modèle
 * propose un nom ; il n'ouvre pas une porte au texte libre.
 */
async function avecPartieNommee(
  userId: string, formData: FormData, ids: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const nom = fdStr(formData, "counterpartyName");
  if (!nom) return { ok: true, ids };
  const trouvee = await findPartyByName(userId, nom);
  if (!trouvee.ok) return { ok: false, error: trouvee.error };
  return { ok: true, ids: [...new Set([...ids, trouvee.id])] };
}

/**
 * LE DOCUMENT ARRIVE-T-IL AVEC SA PIÈCE ? — un fichier joint au formulaire, un fichier déjà déposé
 * sur la fiche d'origine qu'on range (`pieceExistanteId`, §118.161), ou un fichier du Drive. Les
 * clés sont LITTÉRALES : la dérivation des contrats ne lit pas une clé passée par une variable.
 */
function aUnePieceJointe(formData: FormData): boolean {
  const fichier = formData.getAll("attachment").some((v) => v instanceof File && v.size > 0);
  return fichier || Boolean(fdStr(formData, "pieceExistanteId")) || Boolean(fdStr(formData, "driveNodeId"));
}

/** Le maillon amont existe-t-il ? La règle vit dans `legal/chaine.ts`, partagée avec les factures. */
const checkChainFrom = refusMaillonAmont;

export async function createLegalDocument(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const { title, ...f } = readFields(formData);
  if (!peutEcrire(user, "CREATE", f.kind)) return { ok: false, error: "Non autorisé." };
  // LA DATE DE RÈGLEMENT SE POSE PAR QUI RÈGLE AUX FINANCES (audit Assistante de direction, 10/2026).
  const datation = dateDeReglementAEcrire({ avant: null, demandee: f.paidDate, champEnvoye: true, financesModifier: userCan(user, "FINANCES", "UPDATE") });
  if (!datation.ok) return { ok: false, error: datation.error };

  if (!title) return { ok: false, error: "Le titre exact du document est obligatoire." };
  // LE SENS QUE LA PIÈCE NE PROUVE PAS SE CHOISIT (saisie préremplie depuis sa pièce, `prerempli-document-legal.ts`) :
  // aucun défaut — « reçue » posé d'office sur une facture qu'on a émise est une écriture à l'envers.
  if (f.kind === "INVOICE" && fdStr(formData, "sensExige") === "1" && !fdStr(formData, "direction")) {
    return { ok: false, error: "Choisissez le sens de l'argent : la pièce ne permet pas de dire qui a émis cette facture." };
  }
  const dates = validateDates(f.startDate, f.endDate);
  if (!dates.ok) return { ok: false, error: dates.error };
  const chainErr = await checkChainFrom(f.chainFromId);
  if (chainErr) return { ok: false, error: chainErr };

  // AU MOINS UNE PARTIE, CHOISIE DANS L'ANNUAIRE. Un engagement sans partie identifiée est un
  // engagement qu'on ne peut ni rattacher au contrat précédent, ni relancer : c'est le défaut
  // qu'on ferme ici. Le sélecteur permet de créer le contact sans quitter la saisie — l'exigence
  // n'enferme donc personne.
  const { counterpartyIds, ...reste } = f;
  const demandees = await avecPartieNommee(user.id, formData, counterpartyIds);
  if (!demandees.ok) return { ok: false, error: demandees.error };
  const parties = await resolveParties(user.id, demandees.ids);
  if (!parties.ok) return { ok: false, error: parties.error };
  // UN DEVIS : seuls le TITRE et la PIÈCE JOINTE sont obligatoires (§118.175) — « dans l'upload des
  // devis, à part le titre du devis et la PJ, rien n'est obligatoire » (Direction, 01/10). Le
  // fournisseur se lit sur le PDF ; l'exiger avant d'enregistrer faisait créer des contacts à la
  // hâte pour un devis qu'on comparait à deux autres. Ce que la pièce jointe, elle, ne remplace pas :
  // un devis sans son PDF n'est qu'un titre, que personne ne peut vérifier.
  const devis = f.kind === "QUOTE";
  if (parties.ids.length === 0 && !devis) {
    return { ok: false, error: "Choisissez au moins une partie dans l'annuaire de l'entreprise (« Créer un contact » l'y ajoute si elle en est absente)." };
  }
  if (devis && !aUnePieceJointe(formData)) {
    return { ok: false, error: "Un devis s'enregistre avec sa pièce jointe : joignez le PDF du devis (ou choisissez le fichier dans le Drive)." };
  }

  // LE NŒUD DU DRIVE EST VÉRIFIÉ AVANT D'ÊTRE ÉCRIT. L'identifiant vient d'un champ de
  // formulaire : sans contrôle, on référencerait un fichier corbeillé, inexistant, ou qu'on n'a
  // pas le droit de lire — et la fiche montrerait un lien mort ou, pire, une pièce d'ailleurs.
  const driveNodeId = fdStr(formData, "driveNodeId");
  if (driveNodeId) {
    const node = await prisma.driveNode.findUnique({ where: { id: driveNodeId }, select: { isTrashed: true } });
    if (!node || node.isTrashed) return { ok: false, error: "Le dossier / fichier choisi n'existe plus dans le Drive." };
    if (!canViewDrive(await resolveDriveAccess(user, driveNodeId))) {
      return { ok: false, error: "Vous n'avez pas accès à ce dossier / fichier du Drive." };
    }
  }

  // « CRÉER SA FICHE » (§118.161) : le fichier déjà déposé sur la demande est RANGÉ dans la pièce
  // créée. Vérifié AVANT d'écrire : refuser après laisserait une fiche sans son fichier.
  const source = { type: (fdStr(formData, "sourceType") as EntityType | null) ?? null, id: fdStr(formData, "sourceId") };
  const pieceExistanteId = fdStr(formData, "pieceExistanteId");
  const refusRangement = await refusPieceARanger(user, pieceExistanteId, source);
  if (refusRangement) return { ok: false, error: refusRangement };

  // UNE FACTURE REÇUE DÉJÀ CONNUE AILLEURS NE S'ENREGISTRE PAS UNE SECONDE FOIS (Direction, 14/10) — même fichier, ou
  // même fournisseur et même numéro lus par Luna. Jugé AVANT d'écrire ; un doublon seulement probable passe, marqué.
  const fichiersFacture = f.kind === "INVOICE" && f.direction !== "IN"
    ? formData.getAll("attachment").filter((v): v is File => v instanceof File && v.size > 0).slice(0, 1)
    : [];
  const garde = await verifierFacturesAvantDepot(user, await Promise.all(fichiersFacture.map(async (fi) => ({
    octets: Buffer.from(await fi.arrayBuffer()), nom: fi.name, saisie: { numero: f.reference, fournisseur: parties.text, ttc: f.amount },
  }))), { instances: source.type && source.id ? [`FICHE:${source.type}:${source.id}`, ...(source.type === "AD_PRO_ITEM" ? [`POSTE:${source.id}`] : [])] : [] });
  if (!garde.ok) return { ok: false, error: garde.error, factureConnue: garde.factureConnue };

  const companyId = await companyIdForNew(user.id);
  // LE NUMÉRO D'UN BC DÉPOSÉ, ÉCRIT À LA MAIN (Direction, 14/10/2026) : unique parmi les BC de la société (et au registre).
  if (f.kind === "PURCHASE_ORDER") {
    const refusNumero = await refusNumeroBcDepose({ companyId, reference: f.reference, exclure: null });
    if (refusNumero) return { ok: false, error: refusNumero };
  }
  const created = await prisma.legalDocument.create({
    data: {
      ...reste, title,
      counterpartyIds: parties.ids, counterparty: parties.text,
      companyId,
      // Le fichier du Drive est RÉFÉRENCÉ, jamais recopié.
      driveNodeId,
      sourceType: source.type,
      sourceId: source.id,
      // Déposé depuis « Demandes de validations » : le BC naît EN PRÉ-VALIDATION — l'aiguillage ci-dessous ne l'adresse
      // à aucun centre tant que le demandeur n'a pas demandé la validation finale (`bons-de-commande/prevalidation.ts`).
      ...(f.kind === "PURCHASE_ORDER" && fdStr(formData, "prevalidation") === "1" ? { bcPrevalidationAt: new Date() } : {}),
      createdById: user.id,
      updatedById: user.id,
    },
    select: { id: true },
  });
  // Un numéro NNN/DG/AAAA d'une société au registre y entre : le compteur commun ne repassera jamais en dessous.
  if (f.kind === "PURCHASE_ORDER" && f.reference) await inscrireNumeroBcDepose({ companyId, reference: f.reference, legalDocumentId: created.id, userId: user.id }).catch(sansBloquer("legal-actions.createLegalDocument.inscrireNumeroBcDepose"));
  // LES LECTEURS DÉSIGNÉS. Aucun nom = document visible de tout le module (le cas d'une police
  // d'assurance courante). Un ou plusieurs noms = personne d'autre ne le voit, ni dans la liste
  // ni par son lien — le déposant gardant sa propre porte, on le retire de la liste.
  const readerIds = normalizeReaderIds(formData.getAll("readerId").map((v) => String(v)), user.id);
  if (readerIds.length > 0) {
    const known = await prisma.user.findMany({
      where: { id: { in: readerIds }, isActive: true },
      select: { id: true },
    });
    await prisma.legalDocumentReader.createMany({
      data: known.map((u) => ({ documentId: created.id, userId: u.id, grantedById: user.id })),
      skipDuplicates: true,
    });
  }

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: created.id,
    summary: `Document légal « ${title} »${readerIds.length ? ` — restreint à ${readerIds.length} lecteur(s)` : ""}`,
  });

  // UNE FACTURE DÉJÀ RÉGLÉE, saisie a posteriori, inscrit son mouvement aussitôt : tout paiement
  // de la plateforme passe par les Finances, y compris celui qu'on enregistre après coup.
  await syncInvoiceSettlement(created.id, user.id);

  // TOUT BON DE COMMANDE PASSE PAR UN CENTRE DE VALIDATION — Ad & Pro si la fiche d'où il naît
  // en vient, le centre de validations sinon (§118.148). La porte naît avec la pièce.
  const aiguillage = f.kind === "PURCHASE_ORDER" ? phraseAiguillage(await aiguillerBC(created.id, { acteurId: user.id })) : null;

  // Les pièces jointes du formulaire, rattachées au document qui vient de naître. Un échec de
  // fichier ne défait PAS la création : l'engagement est enregistré, on dit ce qui n'a pas suivi.
  const files = await attachFormFiles(user.id, "LEGAL_DOCUMENT", created.id, formData);
  const range = pieceExistanteId ? await rangerPiece(user, pieceExistanteId, source, created.id) : null;

  revalidatePath("/legal");
  const fichiers = files.failed.length
    ? `Document créé. ${files.attached} pièce(s) jointe(s) ; échec sur : ${files.failed.map((x) => x.name).join(", ")}.`
    : null;
  // LE RANGEMENT SE DIT, dans les deux sens : un fichier qui n'a pas suivi (déplacé ou supprimé
  // entre la vérification et l'écriture) ne doit pas se lire comme rangé.
  const rangement = pieceExistanteId
    ? (range ? `« ${range} » est rangé dans la fiche.` : "Le fichier n'a pas pu être rangé : il n'était plus sur la fiche d'origine.")
    : null;
  for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, legalDocumentId: created.id, acteurId: user.id });
  const avertissement = garde.probables.map((p) => p.phrase).join(" ") || null;
  const message = [fichiers ?? (aiguillage || rangement || avertissement ? "Document créé." : null), rangement, aiguillage, avertissement].filter(Boolean).join(" ");
  return { ok: true, id: created.id, message: message || undefined, ...(avertissement ? { avertissement } : {}) };
}

export async function updateLegalDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };

  // LA NATURE ACTUELLE COMPTE AUTANT QUE LA DEMANDÉE : sans elle, la comptabilité pourrait
  // rebaptiser un bail en « facture » pour s'ouvrir le droit de le modifier.
  const avant = await prisma.legalDocument.findUnique({
    where: { id },
    select: {
      kind: true, expenseOrderId: true, counterparty: true, counterpartyIds: true, amount: true, chainFromId: true, promoFacture: { select: { id: true } },
      custom: true, reference: true, startDate: true, endDate: true, direction: true, paidDate: true, companyId: true, title: true, notes: true, folderId: true,
    },
  });
  if (!avant) return { ok: false, error: "Document introuvable." };
  const emise = pieceEmise(avant.custom);
  const { title, ...f } = readFields(formData, emise ? avant.kind : undefined);
  // UNE PIÈCE ÉMISE PAR LA PLATEFORME (§118.194 — audit 360°, R15) : son montant, sa partie, son numéro, sa
  // nature, ses dates et son sens viennent de son FICHIER. Ce formulaire les réécrivait sans régénérer le
  // fichier : la fiche disait un montant, la pièce envoyée en disait un autre — et c'est la fiche qui part au
  // règlement. Ce que le formulaire ne porte pas garde sa valeur ; ce qu'il porte doit être identique ; une
  // vraie correction passe par la révision, qui réécrit les deux ensemble.
  if (emise) {
    const fichier = {
      amount: avant.amount !== null ? Number(avant.amount) : null, reference: avant.reference, kind: String(avant.kind),
      startDate: avant.startDate, endDate: avant.endDate, direction: avant.direction, counterpartyIds: avant.counterpartyIds,
    };
    // LA NATURE DEMANDÉE se lit telle qu'envoyée : la lecture qui ÉCRIT impose celle du fichier, et comparer avec
    // elle laisserait passer en silence une nature qu'on n'écrira pas. Le reste se compare à cette lecture-là —
    // le sens de l'argent ne se lit que sur une facture, et c'est la nature du FICHIER qui dit si c'en est une.
    const demandees = { ...f, kind: String(readFields(formData).kind) };
    // Des clés LITTÉRALES : une lecture par variable rendrait l'action illisible à la dérivation (§118.79b).
    const porte = {
      amount: formData.has("amount"), reference: formData.has("reference"), kind: formData.has("kind"),
      startDate: formData.has("startDate"), endDate: formData.has("endDate"), direction: formData.has("direction"),
      counterpartyIds: formData.has("counterpartyIds"),
    };
    const changes = champsDuFichierChanges(fichier, demandees, (champ) => porte[champ]);
    if (changes.length > 0) return { ok: false, error: refusChampsDuFichier(emise, changes) };
  }
  // Sur une pièce émise, la nature et les dates sont celles du fichier — même absentes du formulaire.
  const kind = emise ? avant.kind : f.kind;
  const startDate = emise ? avant.startDate : f.startDate;
  const endDate = emise ? avant.endDate : f.endDate;
  if (!peutEcrire(user, "UPDATE", avant.kind) || !peutEcrire(user, "UPDATE", kind)) {
    return { ok: false, error: "Non autorisé." };
  }

  if (!title) return { ok: false, error: "Le titre exact du document est obligatoire." };
  const dates = validateDates(startDate, endDate);
  if (!dates.ok) return { ok: false, error: dates.error };
  const chainErr = await checkChainFrom(f.chainFromId, id);
  if (chainErr) return { ok: false, error: chainErr };
  // UNE FACTURE SAISIE LIGNE À LIGNE SUR UN DOSSIER PROMOTIONNEL RESTE CHAÎNÉE À SON BC (§118.168).
  // Ses lignes découlent de celles de CE bon de commande. La rattacher ailleurs — ou la détacher —
  // la ferait sortir du cumul qui empêche de payer plus que la commande et de l'écran du dossier
  // (qui la trouve par la chaîne), pendant que sa réception (qui la trouve par sa source) la verrait
  // encore : deux lectures du même fait qui ne s'accordent plus. Le geste qui corrige une facture
  // déposée sur le mauvais BC existe, et le refus le nomme.
  if (avant.promoFacture && (f.chainFromId ?? null) !== (avant.chainFromId ?? null)) {
    return { ok: false, error: REFUS_CHAINE_FACTURE_PROMO };
  }
  // LA DATE DE RÈGLEMENT SE POSE PAR QUI RÈGLE AUX FINANCES (audit Assistante de direction, 10/2026) — absente du
  // formulaire (masquée à qui ne règle pas), elle garde sa valeur au lieu de s'effacer.
  const datation = dateDeReglementAEcrire({
    avant: avant.paidDate, demandee: f.paidDate, champEnvoye: kind !== "INVOICE" || formData.has("paidDate"),
    financesModifier: userCan(user, "FINANCES", "UPDATE"),
  });
  if (!datation.ok) return { ok: false, error: datation.error };
  f.paidDate = datation.paidDate;
  // Le circuit de règlement possède la date de paiement des factures qu'il porte.
  const reglement = canMarkPaidDirectly({ paidDate: f.paidDate, expenseOrderId: avant.expenseOrderId });
  if (!reglement.ok) return { ok: false, error: reglement.error };

  // LES PARTIES, ET LA TOLÉRANCE QUE L'HISTORIQUE EXIGE.
  //
  // Exiger une partie d'annuaire sur une pièce déposée AVANT que ce champ existe la rendrait
  // impossible à corriger : on ne pourrait plus rectifier une date sans d'abord retrouver le
  // prestataire de 2023. Une pièce qui portait déjà un nom en texte garde donc le droit d'être
  // enregistrée telle quelle — et le formulaire, lui, invite à la rattacher.
  const { counterpartyIds, ...reste } = f;
  // La partie d'une pièce émise est le tiers de son fichier : elle ne se choisit pas ici (voir plus haut).
  const demandees = emise ? { ok: true as const, ids: avant.counterpartyIds } : await avecPartieNommee(user.id, formData, counterpartyIds);
  if (!demandees.ok) return { ok: false, error: demandees.error };
  const parties = emise ? { ok: true as const, ids: avant.counterpartyIds, text: avant.counterparty ?? "" } : await resolveParties(user.id, demandees.ids);
  if (!parties.ok) return { ok: false, error: parties.error };
  const heritage = avant.counterpartyIds.length === 0 && Boolean(avant.counterparty?.trim());
  // Un DEVIS s'enregistre sans partie (§118.175) : le corriger ensuite ne doit pas en exiger une —
  // sinon on ne pourrait plus rectifier sa date sans inventer un fournisseur.
  if (parties.ids.length === 0 && !heritage && kind !== "QUOTE") {
    return { ok: false, error: "Choisissez au moins une partie dans l'annuaire de l'entreprise (« Créer un contact » l'y ajoute si elle en est absente)." };
  }
  // LE NUMÉRO D'UN BC DÉPOSÉ, MODIFIÉ (Direction, 14/10/2026) : unique parmi les BC de la société (et au registre), tracé.
  // (Celui d'un BC ÉMIS se modifie par sa révision, qui réécrit le Word et le PDF avec lui.)
  const numeroChange = !emise && kind === "PURCHASE_ORDER" && formData.has("reference") && nettoyerNumero(f.reference) !== nettoyerNumero(avant.reference) && !memeNumero(f.reference, avant.reference);
  if (numeroChange) {
    const refusNumero = await refusNumeroBcDepose({ companyId: avant.companyId, reference: f.reference, exclure: id });
    if (refusNumero) return { ok: false, error: refusNumero };
  }
  // SEUL LE NUMÉRO CHANGE (Direction, 14/10/2026) — jugé ici en comparant la fiche enregistrée et la saisie : le BC garde son
  // état (aucun réaiguillage, signature et étapes conservées). Le moindre autre champ, ou un fichier joint : la règle d'avant.
  const jour = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
  const numeroSeul = numeroChange
    && !formData.getAll("attachment").some((v) => v instanceof File && v.size > 0)
    && champsDifferents(
      { title: avant.title, kind: avant.kind, amount: avant.amount == null ? null : Number(avant.amount), startDate: jour(avant.startDate), endDate: jour(avant.endDate), notes: avant.notes, parties: [...avant.counterpartyIds].sort(), folderId: avant.folderId, chainFromId: avant.chainFromId, paidDate: jour(avant.paidDate), direction: avant.direction },
      { title, kind, amount: f.amount, startDate: jour(startDate), endDate: jour(endDate), notes: f.notes, parties: [...parties.ids].sort(), folderId: f.folderId, chainFromId: f.chainFromId, paidDate: jour(f.paidDate), direction: f.direction },
      ["title", "kind", "amount", "startDate", "endDate", "notes", "parties", "folderId", "chainFromId", "paidDate", "direction"],
    ).length === 0;

  await prisma.legalDocument.update({
    where: { id },
    data: {
      ...reste, title,
      // Ce que le fichier d'une pièce émise porte garde sa valeur (voir plus haut).
      ...(emise ? { amount: avant.amount, reference: avant.reference, kind: avant.kind, startDate, endDate, direction: avant.direction } : {}),
      counterpartyIds: parties.ids,
      // Sans sélection ET avec un nom hérité, on ne l'EFFACE pas : perdre le seul renseignement
      // qu'on avait sur la partie serait plus grave que de le garder imparfait.
      counterparty: parties.ids.length > 0 ? parties.text : avant.counterparty,
      // Changer les dates rouvre la surveillance : on efface le dernier rappel pour que la
      // nouvelle échéance soit annoncée à son tour.
      lastRemindedAt: null,
      updatedById: user.id,
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Document légal « ${title} » mis à jour`,
  });
  if (numeroChange) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: id, field: "numero",
      oldValue: avant.reference, newValue: f.reference,
      summary: `Bon de commande : ${resumeChangementNumero(avant.reference ?? "(sans numéro)", f.reference ?? "(sans numéro)")} par ${user.name?.trim() || "un utilisateur"}${numeroSeul ? ` (${MENTION_NUMERO_SEUL})` : ""}`,
    });
    if (f.reference) await inscrireNumeroBcDepose({ companyId: avant.companyId, reference: f.reference, legalDocumentId: id, userId: user.id }).catch(sansBloquer("legal-actions.updateLegalDocument.inscrireNumeroBcDepose"));
  }
  // Une date de règlement posée ou retirée depuis le formulaire ORDINAIRE fait bouger l'argent
  // exactement comme depuis la ligne du tableau : c'est le même document, donc la même règle.
  await syncInvoiceSettlement(id, user.id);
  // LE FICHIER D'UNE PIÈCE DÉPOSÉE se remplace depuis la même fiche (Direction, 10/2026 — « modifiable de A à Z ») : la
  // nouvelle version rejoint les pièces jointes. Une pièce ÉMISE n'en reçoit pas ici — son fichier est celui de la
  // fabrique, que seule la révision réécrit (le Word et le PDF ne diraient plus la même chose que la pièce jointe).
  const fichiers = emise ? { attached: 0, failed: [] as { name: string }[] } : await attachFormFiles(user.id, "LEGAL_DOCUMENT", id, formData);
  // UN BC MODIFIÉ SE RÉAIGUILLE : devenu BC, il reçoit sa porte ; ayant cessé de l'être, il la
  // perd ; montant RELEVÉ après validation ou correction demandée par le centre, il y retourne.
  // `montantAvant` est lu AVANT l'écriture — c'est ce qui permet de savoir qu'il a été relevé.
  const aiguillage = numeroSeul
    ? "Seul le numéro a changé : le bon de commande garde son état — circuit et signature conservés."
    : avant.kind === "PURCHASE_ORDER" || kind === "PURCHASE_ORDER"
    ? phraseAiguillage(await aiguillerBC(id, {
        acteurId: user.id, modifie: true,
        montantAvant: avant.amount == null ? null : Number(avant.amount),
        // UN AUTRE FOURNISSEUR n'est plus le BC signé : la signature des Finances tombe (§118.149). Un NOUVEAU FICHIER
        // non plus : ce n'est plus la pièce que les Finances ont signée.
        pieceRevisee: fichiers.attached > 0
          || (parties.ids.length > 0 && [...avant.counterpartyIds].sort().join("|") !== [...parties.ids].sort().join("|")),
      }))
    : null;
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  const phraseFichiers = fichiers.failed.length
    ? `${fichiers.attached} fichier(s) ajouté(s) ; échec sur : ${fichiers.failed.map((x) => x.name).join(", ")}.`
    : fichiers.attached > 0 ? `${fichiers.attached} fichier(s) ajouté(s) aux pièces jointes — retirez l'ancien s'il est remplacé.` : null;
  const message = [phraseFichiers, aiguillage].filter(Boolean).join(" ");
  return { ok: true, message: message || undefined };
}

/**
 * MODIFIER depuis la FICHE du document.
 *
 * Même règle métier que `updateLegalDocument`, mais l'identifiant est LIÉ côté serveur
 * (`editLegalDocument.bind(null, id)`) au lieu d'être posé dans un champ caché : un champ caché se
 * réécrit dans le navigateur, et l'on modifierait alors l'engagement de quelqu'un d'autre.
 */
export async function editLegalDocument(
  id: string,
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) fd.append(k, v);
  fd.set("id", id);
  return updateLegalDocument(fd);
}

/**
 * RATTACHER UN DOCUMENT DU DRIVE À LEGAL — sans copie.
 *
 * C'est le geste attendu : on a déjà le contrat dans le Drive, on veut juste le déclarer comme
 * engagement et lui donner ses dates. Le fichier ne bouge pas, ne se duplique pas ; Legal pointe
 * dessus. Supprimer la fiche Legal ne supprime donc jamais le fichier.
 */
export async function attachDriveNodeToLegal(input: {
  driveNodeId: string; title?: string; kind?: string;
  /** Les parties, choisies dans l'annuaire — jamais un nom tapé à la main. */
  counterpartyIds?: string[];
  /**
   * Le NOM d'une partie, pour les appelants qui n'ont que cela (Adam). Il est RÉSOLU contre
   * l'annuaire, sans ambiguïté possible : introuvable ou multiple, l'action est refusée en le
   * disant. Un modèle propose un nom ; il n'ouvre pas une porte au texte libre.
   */
  counterpartyName?: string;
  startDate?: string; endDate?: string; reference?: string; notes?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "CREATE")) return { ok: false, error: "Non autorisé à alimenter Legal." };

  // MÊME EXIGENCE QUE LE FORMULAIRE DU MODULE. Une seconde porte plus permissive redeviendrait
  // celle qu'on emprunte — et le texte libre serait revenu par la fenêtre.
  const parNom = input.counterpartyName?.trim()
    ? await findPartyByName(user.id, input.counterpartyName)
    : null;
  if (parNom && !parNom.ok) return { ok: false, error: parNom.error };
  const idsDemandes = [...(input.counterpartyIds ?? []), ...(parNom?.ok ? [parNom.id] : [])];
  const parties = await resolveParties(user.id, idsDemandes);
  if (!parties.ok) return { ok: false, error: parties.error };
  if (parties.ids.length === 0) {
    return { ok: false, error: "Choisissez au moins une partie dans l'annuaire de l'entreprise." };
  }

  const node = await prisma.driveNode.findUnique({
    where: { id: input.driveNodeId },
    select: { id: true, name: true, type: true, isTrashed: true },
  });
  if (!node || node.isTrashed) return { ok: false, error: "Fichier introuvable dans le Drive." };
  if (node.type !== "FILE") return { ok: false, error: "Seul un fichier peut devenir un document légal." };

  // Déjà rattaché : on ne crée pas une deuxième fiche pour le même fichier — c'est exactement le
  // doublon qu'on cherche à éviter.
  const already = await prisma.legalDocument.findFirst({
    where: { driveNodeId: node.id }, select: { id: true },
  });
  if (already) return { ok: false, error: "Ce fichier figure déjà dans Legal.", id: already.id };

  const start = input.startDate ? new Date(input.startDate) : null;
  const end = input.endDate ? new Date(input.endDate) : null;
  const dates = validateDates(start, end);
  if (!dates.ok) return { ok: false, error: dates.error };

  const companyId = await companyIdForNew(user.id);
  const created = await prisma.legalDocument.create({
    data: {
      // Le nom du fichier fait un titre par défaut acceptable ; on laisse le corriger.
      title: (input.title ?? "").trim() || node.name,
      reference: input.reference?.trim() || null,
      kind: parseKind(input.kind ?? null),
      counterpartyIds: parties.ids, counterparty: parties.text,
      startDate: start, endDate: end,
      notes: input.notes?.trim() || null,
      driveNodeId: node.id,
      companyId, createdById: user.id, updatedById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: created.id,
    summary: `Document du Drive rattaché à Legal — « ${node.name} » (le fichier reste dans le Drive)`,
  });
  // Déclarer un BC depuis le Drive est une porte d'entrée comme une autre : il passe au centre.
  const aiguillage = parseKind(input.kind ?? null) === "PURCHASE_ORDER"
    ? phraseAiguillage(await aiguillerBC(created.id, { acteurId: user.id }))
    : null;
  revalidatePath("/legal");
  revalidatePath("/drive");
  return { ok: true, id: created.id, message: aiguillage ?? undefined };
}

/**
 * RENOUVELER — un nouveau document qui prend la suite, l'ancien passe en « renouvelé ».
 *
 * Les dates proposées viennent du module pur : lendemain du terme, même durée. On les laisse
 * corrigeables — une reconduction change souvent de durée.
 */
export async function renewLegalDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };

  // LA PORTE DU DOCUMENT (audit 360°, S7) : le droit de créer dans le module ne suffisait pas — un
  // identifiant permettait de renouveler, donc de LIRE en le recopiant, un document restreint ou d'une
  // autre société. Hors de cette porte, il est introuvable.
  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", id, "UPDATE"))) return { ok: false, error: "Document introuvable." };
  const previous = await prisma.legalDocument.findUnique({ where: { id }, include: { readers: { select: { userId: true } } } });
  if (!previous) return { ok: false, error: "Document introuvable." };
  // LA MÊME PORTE QUE LA CRÉATION (audit 360°, R16) : renouveler, c'est créer la suite. Le droit de
  // créer dans Legal seul refusait aux Finances le renouvellement d'un bon de commande qu'elles
  // écrivent par ailleurs — le bouton s'affichait, l'action refusait.
  if (!peutEcrire(user, "CREATE", previous.kind)) return { ok: false, error: "Non autorisé." };
  if (!canRenew(previous.status)) {
    return { ok: false, error: "Ce document ne peut plus être renouvelé (déjà renouvelé ou annulé)." };
  }

  const proposed = proposeRenewalDates({ startDate: previous.startDate, endDate: previous.endDate });
  const startDate = fdDate(formData, "startDate") ?? proposed.startDate;
  const endDate = fdDate(formData, "endDate") ?? proposed.endDate;
  const dates = validateDates(startDate, endDate);
  if (!dates.ok) return { ok: false, error: dates.error };

  const created = await prisma.$transaction(async (tx) => {
    const next = await tx.legalDocument.create({
      data: {
        title: fdStr(formData, "title") ?? previous.title,
        reference: fdStr(formData, "reference") ?? previous.reference,
        kind: previous.kind,
        counterparty: previous.counterparty, counterpartyIds: previous.counterpartyIds,
        startDate, endDate,
        amount: previous.amount,
        notes: fdStr(formData, "notes"),
        // Le renouvellement pointe vers le même fichier tant qu'on n'en a pas déposé un autre.
        driveNodeId: fdStr(formData, "driveNodeId") ?? previous.driveNodeId,
        sourceType: previous.sourceType, sourceId: previous.sourceId,
        companyId: previous.companyId,
        renewedFromId: previous.id,
        createdById: user.id, updatedById: user.id,
        // UN DOCUMENT RESTREINT LE RESTE (audit 360°, S7) : la suite naissait SANS lecteurs désignés,
        // donc visible de tout le module. Elle hérite des lecteurs de l'original, et son auteur
        // d'origine en devient un — il perdrait sinon le contrat qu'il a lui-même enregistré.
        readers: { create: lecteursDeLaSuite(previous.readers.map((r) => r.userId), previous.createdById, user.id).map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    // L'ancien SORT DU JEU sans disparaître : plus de rappel, mais il reste consultable.
    await tx.legalDocument.update({
      where: { id: previous.id },
      data: { status: "RENEWED", updatedById: user.id },
    });
    return next;
  });

  // Le renouvellement s'inscrit AU JOURNAL DES DEUX : sur l'ancien, parce que c'est là qu'on
  // cherchera ce qu'il est devenu ; sur le nouveau, parce que c'est là qu'on cherchera d'où il vient.
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: previous.id,
    summary: `Renouvelé — la suite est « ${fdStr(formData, "title") ?? previous.title} »`,
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: created.id,
    summary: `Renouvellement de « ${previous.title} »`,
  });
  // UN BC RENOUVELÉ EST UN NOUVEL ENGAGEMENT : il repasse au centre. Hériter de la validation de
  // l'ancien engagerait la société une seconde fois sur une décision prise pour la première.
  const aiguillage = previous.kind === "PURCHASE_ORDER"
    ? phraseAiguillage(await aiguillerBC(created.id, { acteurId: user.id }))
    : null;
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  return { ok: true, id: created.id, message: aiguillage ?? undefined };
}

/** ANNULER avant terme — le document reste, avec son motif ; il ne rappelle plus. */
export async function cancelLegalDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", id, "UPDATE"))) return { ok: false, error: "Document introuvable." };

  // LA FILE DE L'ENVOI AU RÈGLEMENT (reste de DONNEES-05) ; entre deux processus, les écritures conditionnelles tiennent.
  return enSerie(cleEnvoiAuReglement(id), async (): Promise<ActionResult> => {
    const doc = await prisma.legalDocument.findUnique({ where: { id }, select: { title: true, status: true, kind: true, expenseOrderId: true } });
    if (!doc) return { ok: false, error: "Document introuvable." };
    // ANNULER UNE PIÈCE, C'EST LA MODIFIER (audit 360°, R16) — et la porte de la fiche, juste au-dessus, EST
    // cette règle : `accesAuxPiecesLegal` juge UPDATE par `legalWriteAllowed`, donc les Finances qui écrivent
    // factures et bons de commande passent, et un contrat leur reste fermé. Le droit Legal seul, qu'on lisait
    // ici, les refusait sous un bouton offert ; un second contrôle redirait la porte (§118.5).
    if (!canCancel(doc.status)) return { ok: false, error: "Ce document ne peut plus être annulé." };

    // Une facture réceptionnée au stock promotionnel, ou créditée par des avoirs, ne s'annule pas d'ici.
    const refusFacture = doc.kind === "INVOICE" ? await refusAnnulationFacture(id) : null; if (refusFacture) return { ok: false, error: refusFacture };
    // UN MOTIF, toujours (audit 360°, L04) : l'annulation partait sans, et même sur le bouton « Annuler »
    // de la boîte qui le demandait. Un contrat annulé ne rappelle plus son échéance — on doit savoir pourquoi.
    // Demandé APRÈS les refus ci-dessus et AVANT tout effet : on ne demande pas pourquoi annuler une pièce
    // qui ne s'annule pas d'ici (§118.18).
    const reason = fdStr(formData, "reason");
    if (!reason) return { ok: false, error: "Le motif de l'annulation est obligatoire." };
    // UNE FACTURE PARTIE AU RÈGLEMENT EMPORTE SON ORDRE (§118.185, audit 360° I7) : l'annuler en
    // laissant l'ordre ouvert, c'était une facture « annulée » au-dessus d'un paiement qui part quand
    // même. L'ordre non réglé est annulé d'abord ; réglé, la facture ne s'annule pas — rien n'est touché.
    let ordreAnnule: string | null = null;
    if (doc.kind === "INVOICE" && doc.expenseOrderId) {
      const annulation = await annulerOrdreNonRegle(doc.expenseOrderId, { acteurId: user.id, motif: `facture « ${doc.title} » annulée — ${reason}` });
      if (!annulation.ok) return { ok: false, error: annulation.error };
      if (annulation.annule) ordreAnnule = annulation.reference;
    }

    // SUR CE QUI A ÉTÉ LU (reste de DONNEES-05) : un envoi au règlement qui a lié un ordre entre la lecture et cette
    // écriture fait échouer l'annulation — sinon la facture passait « annulée » au-dessus d'un paiement qui part.
    const annulee = await prisma.legalDocument.updateMany({
      where: { id, status: doc.status, expenseOrderId: doc.expenseOrderId },
      data: {
        status: "CANCELLED" satisfies LegalDocStatus,
        cancelledAt: new Date(),
        cancelReason: reason,
        updatedById: user.id,
      },
    });
    if (annulee.count === 0) return { ok: false, error: "Cette pièce vient de changer (envoyée au règlement, ou modifiée) : rouvrez-la avant de l'annuler." };
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Legal",
      entityType: "LEGAL_DOCUMENT", entityId: id,
      field: "status", oldValue: doc.status, newValue: "CANCELLED",
      summary: `Annulation de « ${doc.title} » — motif : ${reason}`,
    });
    // Un BC annulé n'a plus rien à faire valider : sa porte en attente quitte le centre.
    if (doc.kind === "PURCHASE_ORDER") await aiguillerBC(id, { acteurId: user.id });
    revalidatePath("/legal");
    revalidatePath(`/legal/${id}`);
    return ordreAnnule
      ? { ok: true, message: `Facture annulée — l'ordre de dépense ${ordreAnnule} est annulé avec elle : il ne sera pas payé.` }
      : { ok: true };
  });
}

/**
 * RÉTABLIR un document annulé (audit 360°, L04) — l'annulation n'avait aucun retour. Le document reprend
 * l'état que sa date de fin lui donne, ses rappels reprennent, et le motif de l'annulation reste au
 * journal (on ne réécrit pas l'histoire, on la complète).
 */
export async function restoreLegalDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", id, "UPDATE"))) return { ok: false, error: "Document introuvable." };
  const doc = await prisma.legalDocument.findUnique({ where: { id }, select: { title: true, status: true, kind: true, endDate: true, cancelReason: true } });
  if (!doc) return { ok: false, error: "Document introuvable." };
  // La porte de l'annulation, à l'envers (audit 360°, R16) : qui peut annuler cette pièce la rétablit — la
  // porte de la fiche ci-dessus est la règle d'écriture, Finances comprises.
  if (!canRestore(doc.status)) return { ok: false, error: "Seul un document annulé se rétablit." };
  const statut = statutRetabli(doc.endDate);
  // Écriture CONDITIONNELLE : deux clics simultanés ne rétablissent pas deux fois.
  const fait = await prisma.legalDocument.updateMany({
    where: { id, status: "CANCELLED" },
    data: { status: statut, cancelledAt: null, cancelReason: null, lastRemindedAt: null, updatedById: user.id },
  });
  if (fait.count === 0) return { ok: false, error: "Ce document a déjà été rétabli." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: id,
    field: "status", oldValue: "CANCELLED", newValue: statut,
    summary: `Rétablissement de « ${doc.title} »${doc.cancelReason ? ` — il avait été annulé pour : ${doc.cancelReason}` : ""}`,
  });
  // Un BC rétabli redevient un engagement : il repasse par la règle des centres.
  if (doc.kind === "PURCHASE_ORDER") await aiguillerBC(id, { acteurId: user.id });
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  return { ok: true };
}

/** Supprimer la FICHE — jamais le fichier du Drive, qui ne nous appartient pas. */
export async function deleteLegalDocument(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  const doc = await prisma.legalDocument.findUnique({ where: { id }, select: { title: true, kind: true } });
  if (!doc) return { ok: false, error: "Document introuvable." };
  if (!peutEcrire(user, "DELETE", doc.kind)) return { ok: false, error: "Non autorisé." };

  // AVANT la suppression : une validation qui attend au centre sur une pièce qui n'existe plus
  // serait un arbitrage à rendre sur rien, et le clic échouerait après coup.
  if (doc.kind === "PURCHASE_ORDER") await retirerPortesEnAttente(id, user.id);
  await prisma.legalDocument.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Fiche légale « ${doc.title} » supprimée (le fichier reste dans le Drive)`,
  });
  revalidatePath("/legal");
  return { ok: true };
}

/**
 * REVOIR LES LECTEURS d'un document légal — la liste envoyée REMPLACE la précédente.
 *
 * Qui peut : le DÉPOSANT et le Super Admin, personne d'autre. Le droit d'écriture sur le module
 * ne suffit pas : pouvoir corriger une date d'échéance n'est pas pouvoir s'ouvrir un document
 * qu'on ne devrait pas lire — ce serait la porte dérobée exacte que la restriction ferme.
 *
 * Une liste vide rouvre le document à tout le module. C'est une décision, et elle est tracée
 * comme telle : on saura qui a levé la restriction, et quand.
 */
export async function setLegalReaders(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };

  const doc = await prisma.legalDocument.findUnique({
    where: { id },
    select: { title: true, createdById: true, readers: { select: { userId: true } } },
  });
  if (!doc) return { ok: false, error: "Document introuvable." };

  // LA MÊME RÈGLE QUE L'ÉCRAN, et elle vit dans le module : le droit d'écriture sur Legal ne
  // suffit pas — sinon il suffirait de s'ajouter soi-même à la liste pour lire n'importe quoi.
  if (!canManageLegalReaders({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" }, doc)) {
    return { ok: false, error: "Seul le déposant du document, ou un Super Admin, peut en revoir les accès." };
  }

  const wanted = normalizeReaderIds(formData.getAll("readerId").map((v) => String(v)), doc.createdById);
  const known = wanted.length
    ? (await prisma.user.findMany({ where: { id: { in: wanted }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];

  await prisma.$transaction([
    prisma.legalDocumentReader.deleteMany({ where: { documentId: id, userId: { notIn: known } } }),
    ...known.map((userId) =>
      prisma.legalDocumentReader.upsert({
        where: { documentId_userId: { documentId: id, userId } },
        create: { documentId: id, userId, grantedById: user.id },
        update: {},
      }),
    ),
  ]);

  const before = doc.readers.length;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: id, field: "readers",
    oldValue: String(before), newValue: String(known.length),
    summary: known.length
      ? `« ${doc.title} » — restreint à ${known.length} lecteur(s) désigné(s)`
      : `« ${doc.title} » — restriction levée : visible de tout le module Legal`,
  });
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  return { ok: true, message: known.length ? `${known.length} lecteur(s) autorisé(s).` : "Restriction levée." };
}

/**
 * ENVOYER UNE FACTURE AU RÈGLEMENT — le dernier maillon de la chaîne d'achat.
 *
 * La facture de Legal devient un ordre de dépense par la porte commune (`createExpenseOrder`),
 * qui applique la règle du CENTRE DE PAIEMENT : TOUT paiement y est autorisé avant que les
 * Finances ne l'exécutent, quel que soit son montant. La fiche garde le lien (`expenseOrderId`) —
 * c'est lui qui permet d'afficher l'état du règlement au bout de la chaîne, et il empêche
 * d'envoyer deux fois la même facture au paiement.
 *
 * Et la facture qui DÉCOULE d'un bon de commande (`chainFromId`) attend que ce BC ait été validé
 * par son centre (§118.148) : payer l'exécution d'une commande que la société n'a pas engagée est
 * le contournement exact que la porte du BC existe pour fermer.
 */
export async function sendLegalInvoiceToSettlement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "LEGAL", "UPDATE") && !userCan(user, "FINANCES", "CREATE")) {
    return { ok: false, error: "Non autorisé." };
  }
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Document introuvable." };
  // LA PORTE DE LA PIÈCE (§118.185, trouvé en réparant I8) : le droit de module suffisait — un
  // identifiant envoyait au paiement la facture d'une autre société, ou une pièce restreinte à
  // ses lecteurs désignés. Hors de la porte, elle est introuvable, comme si elle n'existait pas.
  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", id, "VIEW"))) return { ok: false, error: "Document introuvable." };

  // UN ENVOI À LA FOIS PAR FACTURE — la même clé que le dossier du matériel promotionnel, qui envoie
  // la même pièce par l'autre porte : deux clics, ou deux écrans, ne font pas deux ordres.
  return enSerie(cleEnvoiAuReglement(id), async (): Promise<ActionResult> => {
    const doc = await prisma.legalDocument.findUnique({
      where: { id },
      select: {
        id: true, title: true, reference: true, kind: true, amount: true, counterparty: true,
        endDate: true, expenseOrderId: true, paidDate: true, direction: true, sourceType: true, sourceId: true, chainFromId: true, status: true,
        chainFrom: { select: { id: true, kind: true, reference: true } },
      },
    });
    if (!doc) return { ok: false, error: "Document introuvable." };
    const amount = doc.amount ? Number(doc.amount) : 0;
    // LE BC AMONT, s'il y en a un : sa porte est lue par le même lecteur que la fiche et le centre.
    const bcAmont = doc.chainFrom?.kind === "PURCHASE_ORDER"
      ? { porte: await porteDuBC(doc.chainFrom.id), reference: doc.chainFrom.reference }
      : null;
    // L'ORDRE DÉJÀ LIÉ : refusé par le centre ou annulé, il ne paiera jamais — la facture repart (I8).
    const ordreLie = doc.expenseOrderId
      ? await prisma.expenseOrder.findUnique({ where: { id: doc.expenseOrderId }, select: { status: true, centralStatus: true, reference: true } })
      : null;
    // LE MÊME DINAR NE SORT PAS DEUX FOIS : une facture déjà soldée en direct n'a plus rien à
    // envoyer au centre de paiement. La règle est un module pur, partagé avec l'écriture directe.
    // LA FACTURE D'UN POSTE Ad & Pro se paie par son poste, jamais d'ici (ADPRO-01).
    const lienPoste = await prisma.adProItemPiece.findFirst({ where: { legalDocumentId: doc.id, nature: "FACTURE" }, select: { item: { select: { label: true } } } });
    const envoi = canSendToSettlement({
      kind: doc.kind, amount: amount || null, paidDate: doc.paidDate, expenseOrderId: doc.expenseOrderId,
      bc: bcAmont, ordreLie, direction: doc.direction, status: doc.status, posteAdPro: lienPoste?.item ?? null,
    });
    if (!envoi.ok) return { ok: false, error: envoi.error };
    // Un ordre REFUSÉ reste « en attente » côté statut : on le ferme avant d'en ouvrir un second, pour
    // qu'aucune décision tardive du centre ne puisse rendre payables deux ordres pour une facture.
    if (ordreLie) {
      const fermeture = await annulerOrdreNonRegle(doc.expenseOrderId, { acteurId: user.id, motif: `remplacé par un nouvel envoi de la facture « ${doc.title} »` });
      if (!fermeture.ok) return { ok: false, error: fermeture.error };
    }

    const order = await createExpenseOrder({
      label: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}`,
      amount,
      category: "FOURNISSEUR",
      beneficiary: doc.counterparty,
      sourceType: "LEGAL_DOCUMENT",
      sourceId: doc.id,
      requestedById: user.id,
      dueDate: doc.endDate,
      // La facture d'un matériel promotionnel imputé porte son budget (point 21) — par cette porte comme par le dossier.
      budgetCategoryId: await budgetPromoDeLaPiece(doc),
    });
    // LE LIEN SE POSE SUR CE QUI A ÉTÉ LU (reste de DONNEES-05) : une facture annulée — ou envoyée par l'autre porte —
    // pendant l'émission ne reçoit pas l'ordre ; il est annulé aussitôt au lieu de rester payable sans facture.
    const lie = await prisma.legalDocument.updateMany({
      where: { id, status: { not: "CANCELLED" }, expenseOrderId: doc.expenseOrderId },
      data: { expenseOrderId: order.id, updatedById: user.id },
    });
    if (lie.count === 0) {
      await annulerOrdreNonRegle(order.id, { acteurId: user.id, motif: `facture « ${doc.title} » annulée ou envoyée pendant l'émission` });
      return { ok: false, error: "Cette facture vient de changer (annulée, ou déjà envoyée) : l'ordre émis est annulé. Rouvrez-la." };
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Legal",
      entityType: "LEGAL_DOCUMENT", entityId: id,
      summary: ordreLie
        ? `Facture « ${doc.title} » renvoyée au règlement (${amount.toLocaleString("fr-FR")} DZD) — l'ordre ${ordreLie.reference} ne paiera pas`
        : `Facture « ${doc.title} » envoyée au règlement (${amount.toLocaleString("fr-FR")} DZD)`,
    });
    revalidatePath(`/legal/${id}`);
    return {
      ok: true,
      message: ordreLie
        ? `Facture renvoyée au règlement — l'ordre ${ordreLie.reference} ne paiera pas ; le nouveau suit le circuit du centre de paiement.`
        : "Facture envoyée au règlement — elle suit désormais le circuit du centre de paiement.",
    };
  });
}

/**
 * ADRESSER UN BON DE COMMANDE À SON CENTRE — le rattrapage d'une pièce SANS porte (§118.148).
 *
 * Tout BC au-dessus du seuil des bons de commande (§118.149 — 0 par défaut, donc tous) passe par un
 * centre de validation : celui d'Ad & Pro s'il vient d'Ad & Pro, le centre de validations sinon. Les écrivains du registre posent la porte d'eux-mêmes ; ce geste existe
 * pour les deux cas où elle manque — un BC enregistré AVANT la règle, et un aiguillage qui a
 * échoué (la pièce a été écrite, sa porte non). Sans lui, une pièce sans porte resterait
 * invisible à tout centre, et le chantier « bon de commande » d'un dossier ne pourrait jamais
 * se clore (`chantierBCClos` le refuse en NOMMANT ce geste — un refus qui renvoie vers une
 * action absente serait une impasse déguisée en explication, §118.63).
 *
 * Il ne re-juge rien : un BC qui a déjà sa porte, validée ou en attente, n'est pas adressé une
 * seconde fois — `aiguillerBC` est idempotent, et la phrase le DIT au lieu d'annoncer un envoi
 * qui n'a pas eu lieu.
 */
export async function adresserBCAuCentre(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Bon de commande introuvable." };

  const doc = await prisma.legalDocument.findUnique({ where: { id }, select: { kind: true, status: true, bcPrevalidationAt: true, bcPrevalidationRequestId: true } });
  if (!doc) return { ok: false, error: "Bon de commande introuvable." };
  if (!peutEcrire(user, "UPDATE", doc.kind)) return { ok: false, error: "Non autorisé." };
  if (doc.kind !== "PURCHASE_ORDER") {
    return { ok: false, error: "Seul un bon de commande passe par un centre de validation." };
  }
  if (doc.status === "CANCELLED") {
    return { ok: false, error: "Ce bon de commande est annulé : il n'a plus rien à faire valider." };
  }

  // EN PRÉ-VALIDATION : la validation finale se demande depuis la demande de validation, pas d'ici — sinon ce bouton
  // serait la porte dérobée qui envoie au centre un BC dont on recueille encore les avis. Une retenue ORPHELINE (BC
  // composé puis abandonné, demande retirée) se lève ici : personne d'autre ne la lèverait.
  let r: Awaited<ReturnType<typeof aiguillerBC>>;
  if (doc.bcPrevalidationAt) {
    if (!(await retenueOrpheline(doc))) {
      return { ok: false, error: `${PHRASE_PREVALIDATION} La validation finale se demande depuis « Demandes de validations ».` };
    }
    const libere = await libererPrevalidation(id, doc.bcPrevalidationRequestId, user.id, "pré-validation sans demande en cours — adressé au centre depuis sa fiche.");
    r = libere.aiguillage ?? await aiguillerBC(id, { acteurId: user.id });
  } else {
    r = await aiguillerBC(id, { acteurId: user.id });
  }
  if (r.sansSiege) return { ok: false, error: phraseAiguillage(r) ?? "Aucun siège au centre de validations." };
  if (r.enEchec) {
    return { ok: false, error: "Le bon de commande n'a pas pu être adressé au centre. Réessayez ; si l'échec persiste, signalez-le à un administrateur." };
  }
  revalidatePath(`/legal/${id}`);
  revalidatePath(CHEMIN_BC_A_SIGNER);
  // SOUS LE SEUIL (§118.149) : aucun centre n'a à le voir — c'est un SUCCÈS, et la phrase dit où
  // il est parti. Le refuser ferait croire que la règle bloque un BC qu'elle laisse passer.
  // RENVOYÉ À SON ÉMETTEUR (audit 360°, R09) : ce n'est pas un centre qui l'attend, c'est sa correction.
  if (r.etape === "A_CORRIGER") {
    return { ok: false, error: reserveEtapeBC("A_CORRIGER", r.porte, r.seuil) ?? "Ce bon de commande a été renvoyé à son émetteur : modifiez-le." };
  }
  if (!r.porte) {
    if (r.etape === "A_SIGNER" || r.etape === "SIGNE") {
      return {
        ok: true, id,
        message: phraseAiguillage(r)
          ?? (r.etape === "SIGNE"
            ? "Ce bon de commande est déjà signé par les Finances : il n'a rien à faire valider."
            : reserveEtapeBC(r.etape, null, r.seuil) ?? undefined),
      };
    }
    return { ok: false, error: "Le bon de commande n'a pas pu être adressé au centre. Réessayez ; si l'échec persiste, signalez-le à un administrateur." };
  }
  revalidatePath(CHEMIN_CENTRE_BC[r.porte.centre]);
  return {
    ok: true,
    id,
    message: phraseAiguillage(r)
      ?? [
        `Ce bon de commande est déjà au ${LIBELLE_CENTRE_BC[r.porte.centre]} — ${LIBELLE_ETAT_BC[r.porte.etat].toLowerCase()}. Rien n'a été renvoyé.`,
        r.etape === "A_SIGNER" ? `Il attend la signature des Finances (${MENU_BONS_DE_COMMANDE}).` : null,
      ].filter(Boolean).join(" "),
  };
}
