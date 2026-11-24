import { randomBytes } from "node:crypto";
import type { DocumentCategory, EntityType, FinanceCategory, PaymentDeadlineNature, PaymentPieceKind, PaymentRequestStatus } from "@prisma/client";
import { createWithRetry, enSerie, referenceDeSerie } from "@/lib/refs";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { initialCentralStatus } from "../domaine/authorization";
import { categorieDeNature, KINDS_JUSTIFIANTS, type NatureJustificatif } from "../domaine/justificatif";
import { lireJustificatifs, type IndiceDeJustificatif } from "./justificatif";
import { annoncerAuCentre, demanderLeJustificatif } from "./relance-destinataires";
import { persistUploadedDocument } from "@/lib/documents";
import { deadlineNatureOf } from "../domaine/deadline-nature";
import { lienOrdreAPayer } from "@/lib/chemins/finances";
import {
  needsCompanionDossier, companionPayee, companionStatusForOrder,
} from "../domaine/dossier-auto";
import { prisma } from "@/lib/prisma";
import { notifyRoles } from "@/lib/notify";

export async function nextExpenseRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "ExpenseOrder", prefixe: "OD", annee: year,
    existantes: async () => (await prisma.expenseOrder.findMany({ where: { reference: { startsWith: `OD-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

async function nextPaymentRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "PaymentRequest", prefixe: "PAY", annee: year,
    existantes: async () => (await prisma.paymentRequest.findMany({ where: { reference: { startsWith: `PAY-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

/**
 * LES DEUX SÉRIES QUE NUMÉROTE CE MODULE — une file par série dans ce processus (`enSerie`), et un
 * nouvel essai sous collision entre processus (`createWithRetry`). Mesuré par la suite complète
 * (§118.182) : la création de l'ORDRE n'avait ni l'une ni l'autre — deux décaissements demandés à la
 * même seconde lisaient le même maximum, et le second échouait sur la contrainte d'unicité, c'est-à-dire
 * une demande de paiement qui ne part pas, après le clic. Le cliquet des filets ne pouvait pas le voir :
 * il juge par FICHIER, et ce fichier en portait un — sur le dossier compagnon. La série PAY est partagée
 * avec la création d'une demande de paiement (`payment-request-actions.ts`) : deux files pour une série
 * n'en protégeraient que la moitié.
 */
export const SERIE_ORDRES = "OD";
export const SERIE_DEMANDES_PAIEMENT = "PAY";

interface CreateExpenseOrderInput {
  label: string;
  amount: number;
  category: FinanceCategory;
  beneficiary?: string | null;
  sourceType?: EntityType;
  sourceId?: string;
  requestedById?: string | null;
  notes?: string | null;
  dueDate?: Date | null;
  /**
   * CE QUE L'ÉCHÉANCE PÈSE, déclaré par le demandeur — `FIXED`, `IMPORTANT`, `MODERATE`.
   * Elle voyage avec l'ordre : le centre arbitre et les Finances classent leur file dessus, et
   * aucun des deux n'a à rouvrir la demande d'origine pour l'apprendre.
   */
  deadlineNature?: string | null;
  /** (Sous-)catégorie budgétaire choisie par la Direction — attribution au règlement. */
  budgetCategoryId?: string | null;
  /**
   * L'ENTITÉ, quand l'ordre n'a pas de source qui la porte (§118.176) — la remise d'une caisse
   * d'avance engage la société du DÉPARTEMENT qui la reçoit, pas celle de la personne qui clique.
   * Sans elle, le repli sur la fiche du demandeur rattacherait la remise à la mauvaise société,
   * et un Directeur Général cloisonné sur la bonne ne la verrait pas au centre.
   */
  companyId?: string | null;
  /**
   * LA FACTURE EST-ELLE EXIGÉE AVANT LE RÈGLEMENT ? Absent = la règle d'avant (les dépenses
   * événementielles l'exigent). Posé par l'appelant qui SAIT que la pièce attendue est autre : le
   * versement d'un sponsoring DIRECT à l'association se justifie par la pro forma ou la lettre de
   * demande, pas par une facture (Direction, 05/10). Un seul champ, lu partout où la règle se
   * juge : le règlement, la colonne « Facture » des règlements à effectuer, et le signal
   * « justificatif manquant » de l'intelligence financière.
   */
  requiresInvoice?: boolean;
  /**
   * LE JUSTIFICATIF, QUAND L'APPELANT LE TIENT (justificatif obligatoire, 24/11/2026). Sans pièce reconnue par la table
   * (`domaine/justificatif.ts`), l'ordre naît « en attente du justificatif » et n'entre pas au centre. La plupart des
   * circuits n'ont rien à passer : leur pièce est déjà sur la fiche d'origine, le dossier ou le registre. Deux cas le
   * passent : un FICHIER joint au geste qui émet (état de paie, bon de remise…), rangé sur l'ordre ; un INDICE vers ce
   * qui le porte avant que le lien vers l'ordre soit posé (la déclaration validée, le PDF du devis retenu).
   */
  justificatif?: { fichier: File; nature: NatureJustificatif } | IndiceDeJustificatif;
}

// Dépenses « événementielles » : une facture est obligatoire avant le règlement.
const INVOICE_REQUIRED_SOURCES: EntityType[] = ["SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "PROMO_MATERIAL"];

/**
 * Emit an "ordre de dépense" for the accountant when the Direction (or RH) validates
 * a spend. Best-effort notification to the comptable role. Returns the created order.
 * Les dépenses événementielles (sponsoring, congrès, matériel promo) exigent une
 * facture jointe avant règlement.
 */
/**
 * OÙ L'ENTITÉ D'UN ORDRE SE LIT — une source, une lecture, et la liste est EXHAUSTIVE.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Cette table était une cascade de quatre ternaires : SPONSORING, les deux congrès, le matériel
 * promo. Tout le reste tombait dans le `null` final — **y compris `PAYMENT_REQUEST`**, devenu
 * depuis la source la plus fréquente puisque le centre de paiement est le guichet unique. Les
 * ordres nés d'une demande de paiement naissaient donc SANS entité dès que le demandeur n'avait
 * pas de fiche salarié rattachée.
 *
 * Un ordre sans entité n'est pas seulement mal classé : il devient **invisible** à quiconque est
 * cloisonné sur une société — le filtre d'entité vaut `companyId = X`, et `NULL` n'est pas `X`.
 * Le Super Admin (vue groupe, aucun filtre) voyait la file entière ; le Directeur Général, lui,
 * ouvrait un centre de paiement vide. Exactement le défaut du pharmacien responsable, à un autre
 * endroit du code.
 *
 * ── POURQUOI UNE TABLE ET NON UNE CASCADE ───────────────────────────────────────────────────
 *
 * Parce qu'une cascade se complète en l'oubliant. Toutes les sources d'un ordre de dépense
 * portent un `companyId` : la table les nomme TOUTES, et `expense-orders.test.ts` échoue si un
 * `sourceType` réellement utilisé par le code n'y figure pas. Ajouter un circuit sans ajouter sa
 * ligne ne compilera pas en silence — il tombera au test.
 */
const COMPANY_OF_SOURCE: Partial<Record<EntityType, (id: string) => Promise<{ companyId: string | null } | null>>> = {
  PAYMENT_REQUEST: (id) => prisma.paymentRequest.findUnique({ where: { id }, select: { companyId: true } }),
  ADMIN_REQUEST: (id) => prisma.administrativeRequest.findUnique({ where: { id }, select: { companyId: true } }),
  MEDICAL_INFO_DECLARATION: (id) => prisma.medicalInfoDeclaration.findUnique({ where: { id }, select: { companyId: true } }),
  LEGAL_DOCUMENT: (id) => prisma.legalDocument.findUnique({ where: { id }, select: { companyId: true } }),
  SPONSORING: (id) => prisma.sponsoringRequest.findUnique({ where: { id }, select: { companyId: true } }),
  CONGRESS_NATIONAL: (id) => prisma.congressNational.findUnique({ where: { id }, select: { companyId: true } }),
  CONGRESS_INTERNATIONAL: (id) => prisma.congressInternational.findUnique({ where: { id }, select: { companyId: true } }),
  PROMO_MATERIAL: (id) => prisma.promoMaterial.findUnique({ where: { id }, select: { companyId: true } }),
  CONSULTING_CONTRACT: (id) => prisma.consultingContract.findUnique({ where: { id }, select: { companyId: true } }),
  EVENT: (id) => prisma.event.findUnique({ where: { id }, select: { companyId: true } }),
  // LA DEMANDE AD & PRO « AUTRE » : ses postes émettent leurs ordres avec elle pour source (`actions-postes-paiement.ts`,
  // `owner.parent`). Sans cette ligne, l'ordre retombait sur la société du demandeur — invisible à un siège cloisonné.
  AD_PRO_OTHER: (id) => prisma.adProOtherRequest.findUnique({ where: { id }, select: { companyId: true } }),
  REGULATORY_PRODUCT: (id) => prisma.regulatoryProduct.findUnique({ where: { id }, select: { companyId: true } }),
  // LA PAIE D'UNE ENTITÉ (§118.176) : le virement porte l'entité dont on vire les salaires.
  PAYROLL: (id) => prisma.payrollWire.findUnique({ where: { id }, select: { companyId: true } }),
  // UNE ÉCHÉANCE DE CHARGE FIXE DES LOCAUX (24/11/2026) : la société qui loue, ou qui reçoit la facture.
  FIXED_CHARGE: (id) => prisma.echeanceChargeFixe.findUnique({ where: { id }, select: { companyId: true } }),
};

/**
 * `SALARY_ADVANCE` n'y figure pas, et c'est CORRECT : une avance sur salaire ne porte pas
 * d'entité — elle appartient à un salarié, et le repli sur la société de sa fiche donne la bonne
 * réponse. L'absence est donc une décision, pas un oubli ; le test la nomme explicitement.
 */

/** Les sources couvertes — lues par le test qui vérifie qu'aucun circuit n'a été oublié. */
export const EXPENSE_SOURCE_TYPES = Object.keys(COMPANY_OF_SOURCE) as EntityType[];

/**
 * L'entité d'un ordre de dépense se déduit de sa SOURCE — la demande qui l'a fait naître —
 * et non de la portée du navigateur : c'est la demande qui engage une société, pas l'écran
 * depuis lequel on valide. À défaut de source exploitable, on retombe sur la société
 * d'appartenance du demandeur ; à défaut encore, sur rien (l'ordre restera à rattacher).
 */
async function companyOfExpense(input: CreateExpenseOrderInput): Promise<string | null> {
  // L'entité DÉCLARÉE par l'appelant l'emporte : il la tient de l'objet qui engage la dépense.
  if (input.companyId) return input.companyId;
  try {
    if (input.sourceId && input.sourceType) {
      const lire = COMPANY_OF_SOURCE[input.sourceType];
      const src = lire ? await lire(input.sourceId) : null;
      if (src?.companyId) return src.companyId;
    }
    if (input.requestedById) {
      const emp = await prisma.employee.findFirst({ where: { userId: input.requestedById }, select: { companyId: true } });
      if (emp?.companyId) return emp.companyId;
    }
  } catch (e) {
    // Le rattachement ne doit jamais empêcher l'émission de l'ordre : l'argent prime.
    console.error("[expense-orders] entité indéterminable", e);
  }
  return null;
}

/** La route du dossier d'une demande de paiement — une seule définition, partout. */
export function paymentDossierHref(requestId: string): string {
  return `/validations/paiements/${requestId}`;
}

/**
 * LE DOSSIER DE CHAQUE ORDRE, EN UN SEUL ALLER — c'est lui qui rend le libellé cliquable.
 *
 * `expenseOrderId` porte le lien dans les deux sens de l'histoire : une demande de paiement le
 * pose une fois son ordre créé, un dossier compagnon naît avec. Une seule requête indexée suffit
 * donc pour trois cents lignes, au lieu d'un test de `sourceType` qui ne reconnaissait qu'un
 * circuit sur treize.
 */
export async function dossierHrefByOrder(orderIds: readonly string[]): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.paymentRequest.findMany({
    where: { expenseOrderId: { in: [...orderIds] } },
    select: { id: true, expenseOrderId: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) if (r.expenseOrderId) out.set(r.expenseOrderId, paymentDossierHref(r.id));
  return out;
}

/**
 * LE DOSSIER COMPAGNON — ouvert AVEC l'ordre, sans que personne le demande.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Un ordre né d'une demande de paiement portait un dossier : ses pièces, son fil, et un libellé
 * CLIQUABLE dans la file du décaissement. Un ordre né d'ailleurs — matériel promotionnel, bon de
 * versement, sponsoring, congrès, dossier réglementaire, secrétariat — n'en portait aucun. Même
 * écran, même argent, et la moitié des lignes étaient du texte mort : pour joindre une facture à
 * celles-là, il fallait retrouver le module d'origine, y avoir accès, et savoir que c'était là.
 *
 * ── POURQUOI ICI, ET NULLE PART AILLEURS ────────────────────────────────────────────────────
 *
 * Treize circuits appellent `createExpenseOrder`. Poser la règle dans chacun d'eux, c'est
 * l'oublier dans le quatorzième — et la retrouver six mois plus tard sous la forme d'un libellé
 * qui ne s'ouvre pas. Le seul endroit par lequel TOUT ordre passe est celui-ci : c'est ici que la
 * règle tient, et c'est le code qui la tient, pas une consigne.
 *
 * ── CE QUE LE COMPAGNON N'EST PAS ───────────────────────────────────────────────────────────
 *
 * Une seconde décision. L'ordre existe parce que son circuit d'origine a validé la dépense, et
 * c'est le CENTRE DE PAIEMENT qui autorise la sortie. `origin = EXPENSE_ORDER` le dit à l'écran,
 * qui retire le « bon à payer » : sans cette marque, le même paiement se déciderait à deux
 * endroits et « qui a autorisé ? » n'aurait plus de réponse unique.
 *
 * BEST-EFFORT, comme le rattachement d'entité : un dossier qui ne s'ouvre pas ne doit jamais
 * empêcher un ordre de naître. L'argent prime ; le dossier se rouvre, l'ordre perdu ne se
 * retrouve pas.
 */
async function openCompanionDossier(
  order: { id: string; label: string; amount: unknown; beneficiary: string | null; companyId: string | null; dueDate: Date | null; deadlineNature: string | null; status: string; notes: string | null },
  input: CreateExpenseOrderInput,
): Promise<string | null> {
  const requesterId = input.requestedById;
  // SANS DEMANDEUR, PAS DE DOSSIER — et c'est une décision, pas un oubli. `requesterId` n'est pas
  // nullable, et inscrire à sa place le premier Super Admin venu porterait à l'audit le nom de
  // quelqu'un qui n'a rien demandé. Ces ordres-là gardent un libellé non cliquable : une lacune
  // HONNÊTE vaut mieux qu'une attribution fausse.
  if (!needsCompanionDossier(input.sourceType) || !requesterId) return null;
  try {
    // LA FILE, ET CE QUI LA PROUVE — mesuré (§118.182). Retirée seule, la rafale de douze décaissements
    // simultanés tombe une fois sur deux (3 sur 6) : les ordres passent déjà un par un (`SERIE_ORDRES`),
    // donc leurs dossiers naissent décalés — mais pas toujours assez pour que six essais suffisent, et un
    // dossier perdu l'est EN SILENCE (best-effort). Une rafale qui ne voit la garde qu'une fois sur deux
    // n'est pas son témoin (§118.65) : le témoin déterministe est la règle qui exige cette file à ce point
    // d'appel (`refs-filet.test.ts`). La série se partage avec les demandes de paiement déposées à la main ;
    // leur banc de dépôts simultanés exerce la même file par l'AUTRE créateur.
    const dossier = await enSerie(SERIE_DEMANDES_PAIEMENT, () => createWithRetry(async () =>
      prisma.paymentRequest.create({
        data: {
          reference: await nextPaymentRef(),
          title: order.label,
          description: order.notes,
          amount: input.amount,
          payee: companionPayee(order.beneficiary, order.label),
          companyId: order.companyId,
          dueDate: order.dueDate,
          deadlineNature: deadlineNatureOf(order.deadlineNature) as PaymentDeadlineNature,
          // Le moyen de paiement n'a pas été déclaré sur ces circuits : l'affirmer serait une
          // attestation fausse, portée au nom du demandeur (§118-15).
          paymentMethodStated: false,
          status: companionStatusForOrder(order.status) as PaymentRequestStatus,
          submittedAt: new Date(),
          requesterId,
          // LE RATTACHEMENT À L'ORIGINE : c'est lui qui rend la demande d'origine ouvrable
          // depuis le dossier, et le dossier lisible depuis la file du décaissement.
          entityType: input.sourceType ?? null,
          entityId: input.sourceId ?? null,
          expenseOrderId: order.id,
          origin: "EXPENSE_ORDER",
        },
        select: { id: true },
      }),
    ));
    // Le fil ne s'ouvre pas vide : un historique blanc laisse croire qu'il ne s'est rien passé.
    await prisma.paymentRequestEvent.create({
      data: {
        requestId: dossier.id, actorId: requesterId, kind: "SUBMIT",
        message: "Dossier ouvert automatiquement avec l'ordre de dépense — le circuit d'origine avait déjà validé la dépense.",
      },
    });
    return dossier.id;
  } catch (e) {
    console.error("[expense-orders] dossier compagnon non ouvert", e);
    return null;
  }
}

/**
 * LE FICHIER JOINT AU GESTE QUI ÉMET — rangé sur l'ordre AVANT sa création (l'identifiant est choisi d'avance) : l'ordre
 * naît alors justifié, et entre au centre d'emblée. Un fichier qui ne s'enregistre pas fait ÉCHOUER l'émission — l'appelant
 * le dit (« rien n'est parti ») plutôt qu'un ordre qui naîtrait justifié sur une pièce absente.
 */
async function rangerLeFichierJoint(
  input: CreateExpenseOrderInput, ordreId: string,
): Promise<{ documentId: string; nature: NatureJustificatif } | null> {
  const j = input.justificatif;
  if (!j || !("fichier" in j) || !(j.fichier instanceof File) || j.fichier.size === 0 || !input.requestedById) return null;
  const doc = await persistUploadedDocument(input.requestedById, {
    entityType: "EXPENSE_ORDER", entityId: ordreId, category: categorieDeNature(j.nature) as DocumentCategory,
    confidentiality: "INTERNAL", stepKey: null, file: j.fichier,
  });
  if (!doc.ok || !doc.documentId) throw new Error(doc.error ?? "Le justificatif n'a pas pu être enregistré.");
  return { documentId: doc.documentId, nature: j.nature };
}

export async function createExpenseOrder(input: CreateExpenseOrderInput) {
  const requiresInvoice = input.requiresInvoice
    ?? ((input.sourceType ? INVOICE_REQUIRED_SOURCES.includes(input.sourceType) : false) || input.category === "EVENEMENT");

  // LE CENTRE DE PAIEMENT SE DÉCIDE ICI, à la naissance de l'ordre — le seul endroit par lequel
  // TOUT décaissement passe. Tout ordre part « en attente » et n'arrive pas aux Finances tant que
  // le PDG, le DG ou le Super Admin ne l'a pas autorisé : plus de seuil, plus d'exemption de module. Le
  // seuil survit comme MARQUEUR (`isHighValue`) pour trier la file du centre, jamais comme filtre.
  const sourceModule = input.sourceType ? ENTITY_MODULE[input.sourceType] : null;
  // LE JUSTIFICATIF D'ABORD (24/11/2026) : le fichier joint au geste se range sur l'ordre à naître ; sinon on lit ce que
  // la table attend pour cette origine (fiche, dossier, registre, ou l'indice de l'appelant).
  // L'identifiant est choisi d'avance — au FORMAT de Prisma (cuid : « c » + 24 caractères), que des lecteurs reconnaissent.
  const ordreId = `c${randomBytes(12).toString("hex")}`;
  const joint = await rangerLeFichierJoint(input, ordreId);
  const indice = input.justificatif && !("fichier" in input.justificatif) ? input.justificatif : {};
  const justifie = joint !== null || (await lireJustificatifs(
    [{ id: ordreId, sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null }], new Map([[ordreId, indice]]),
  )).get(ordreId)?.present === true;
  const centralStatus = initialCentralStatus({ amount: input.amount, module: sourceModule, justifie });

  // L'ENTITÉ se lit UNE fois, hors de l'essai : seule la RÉFÉRENCE se recalcule sous collision.
  const companyId = await companyOfExpense(input);
  const order = await enSerie(SERIE_ORDRES, () => createWithRetry(async () => prisma.expenseOrder.create({
    data: {
      // L'ordre NÉ SOUS LA RÈGLE : son justificatif lui sera redemandé au règlement s'il venait à disparaître.
      id: ordreId,
      justificatifExige: true,
      reference: await nextExpenseRef(),
      companyId,
      label: input.label,
      amount: input.amount,
      category: input.category,
      beneficiary: input.beneficiary ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      requestedById: input.requestedById ?? null,
      notes: input.notes ?? null,
      dueDate: input.dueDate ?? null,
      deadlineNature: input.deadlineNature ?? null,
      budgetCategoryId: input.budgetCategoryId ?? null,
      requiresInvoice,
      centralStatus,
    },
  }))).catch(async (e: unknown) => {
    // L'ordre n'est pas né : le fichier rangé pour lui n'a plus de raison d'être.
    if (joint) await prisma.document.delete({ where: { id: joint.documentId } }).catch(() => undefined);
    throw e;
  });

  // UN ORDRE, UN DOSSIER — quelle que soit sa provenance. Voir `openCompanionDossier`.
  const dossierId = await openCompanionDossier(order, input);
  // Le fichier joint se lit AUSSI comme une pièce du dossier, sous sa vraie nature (« état de paie », « bon de remise ») :
  // c'est là que le centre et les Finances ouvrent le justificatif. Best-effort : l'ordre est déjà justifié par le fichier.
  if (joint && dossierId && KINDS_JUSTIFIANTS.includes(joint.nature)) {
    await prisma.paymentPiece.create({
      data: { requestId: dossierId, documentId: joint.documentId, kind: joint.nature as PaymentPieceKind, position: 0, createdById: input.requestedById as string },
    }).catch((e) => console.error("[expense-orders] pièce du dossier non posée", e));
  }

  const money = `${input.amount.toLocaleString("fr-FR")} DZD`;
  if (centralStatus === "AWAITING_PROOF") {
    // NI LE CENTRE NI LES FINANCES : le service qui détient la pièce, et lui seul (sa ligne « Aujourd'hui » le rappelle).
    const lien = input.sourceType === "PAYMENT_REQUEST" && input.sourceId ? paymentDossierHref(input.sourceId) : dossierId ? paymentDossierHref(dossierId) : "/validations/paiements";
    await demanderLeJustificatif({
      reference: order.reference, label: input.label, sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null,
      requestedById: input.requestedById ?? null, lien,
    });
  } else if (centralStatus === "AWAITING") {
    // On alerte LE CENTRE, pas les Finances : elles ne doivent rien voir tant que l'autorisation
    // n'est pas donnée. Les montants importants le DISENT dans le corps du message.
    await annoncerAuCentre({ reference: order.reference, label: input.label, amount: input.amount, companyId });
  } else {
    // Chemin HISTORIQUE : plus aucun ordre ne naît hors du centre. Il reste pour que la fonction
    // ne dépende pas d'une invariante qu'un futur changement de règle pourrait rompre en silence.
    await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], {
      type: "VALIDATION_REQUIRED",
      title: "Nouvel ordre de dépense",
      body: `${order.reference} — ${input.label} (${money})`,
      link: lienOrdreAPayer(order.id),
    });
  }
  return order;
}
