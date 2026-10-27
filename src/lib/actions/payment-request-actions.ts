"use server";

import type {
  EntityType, PaymentDeadlineNature, PaymentPieceKind, PaymentPieceStatus,
  PaymentRequestStatus, PaymentUrgency,
} from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { bonDeVersementRattache } from "@/lib/medical-info";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { buildRef, createWithRetry, enSerie } from "@/lib/refs";
import { moneyEntityOf, getMyCompanies, adventumCompanyId } from "@/lib/company";
import { resolveMoneyEntity, checkMoneyEntity } from "@/lib/finance/money-entity";
import { persistUploadedDocument } from "@/lib/documents";
import { createExpenseOrder, SERIE_DEMANDES_PAIEMENT } from "@/lib/expense-orders";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";
import { reviserOrdreNonRegle, apresRevisionOrdre, type ResultatRevision } from "@/lib/payments/revision-ordre";
import {
  refusDeCorrection, refusDeRetrait, refusDuChamp, ecartsDeCorrection, phraseDeCorrection, type ValeursDemande,
} from "@/lib/finance/correction-demande";
import { toNumber } from "@/lib/utils";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import {
  nextPaymentStatus, statusFromPieces, canApprove, canResubmit, isClosed, isWithFinance,
  needsReplacement, refusDeRemplacement, type PaymentMove,
} from "@/lib/finance/payment-request";
import { canSubmitDossier } from "@/lib/finance/payment-dossier";
import { canNudge, nudgeKindOf, nudgeMessage, NUDGE_LABEL, isCompanionDossier, canDecideFromDossier } from "@/lib/finance/dossier-auto";
import { deadlineNatureOf, deadlineNatureLabel } from "@/lib/finance/deadline-nature";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { etatDuPaiement } from "@/lib/finance/relance-paiement";
import { prevenirQuiALaMain } from "@/lib/payments/relance-destinataires";
import { verifierFacturesAvantDepot, marquerDoublonPossible, ttcDesFacturesStockees, type FichierDepose } from "@/lib/factures/connues";
import {
  confronterMontantAuxFactures, refusEcartMontant, noteEcartAssume, phraseEcartMontant, PHRASE_MONTANT_NON_LU,
  type LectureMontant,
} from "@/lib/finance/montant-facture";
import { PAYMENT_URGENCY } from "@/lib/labels";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { peutSupprimerUneDemandePaiement } from "@/lib/queries/demande-paiement-suppression";
import { ROLES_CENTRE_DE_PAIEMENT } from "@/lib/payments/authorization";

const PATH = "/validations/paiements";

/**
 * LA DEMANDE DE PAIEMENT — le dossier qui part aux Finances, et qui revient.
 *
 * Ce qui distingue ce circuit d'une validation ordinaire : **la discussion se tient pièce par
 * pièce**. Les Finances acceptent la facture, demandent à revoir le bon de commande, refusent le
 * devis périmé — et le demandeur ne reprend QUE ce qui est en cause. Le dossier reste le même
 * d'un tour à l'autre : c'est lui qui porte l'historique des refus, celui qu'on relit quand on se
 * demande pourquoi le paiement a pris trois semaines.
 *
 * L'état du dossier n'est jamais saisi à la main : il se DÉDUIT des verdicts (`statusFromPieces`).
 * Personne ne pense à changer un statut en même temps qu'il refuse une facture.
 */

/** Les Finances — celles qui instruisent. La Direction supplée, comme partout ailleurs. */
function isFinance(user: SessionUser): boolean {
  return user.role === "FINANCE_BUDGET_MANAGER"
    || userCan(user, "FINANCES", "VALIDATE")
    || userCan(user, "FINANCES", "UPDATE")
    || hasGlobalView(user.role);
}

function isRequester(user: SessionUser, req: { requesterId: string }): boolean {
  return req.requesterId === user.id || hasGlobalView(user.role);
}

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.paymentRequest.findMany({
    where: { reference: { startsWith: `PAY-${year}-` } }, select: { reference: true },
  });
  return buildRef("PAY", year, refs.map((r) => r.reference));
}

function revalidate(id?: string) {
  revalidatePath("/validations");
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
}

/** Le fil du dossier : chaque geste laisse une trace lisible, dans l'ordre. */
async function trace(requestId: string, actorId: string | null, kind: string, message?: string | null, pieceId?: string | null) {
  await prisma.paymentRequestEvent.create({
    data: { requestId, actorId, kind, message: message || null, pieceId: pieceId || null },
  });
}

const dateOf = (raw: string | null): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const urgencyOf = (raw: string | null): PaymentUrgency => {
  const allowed: PaymentUrgency[] = ["WHEN_POSSIBLE", "THIS_MONTH", "THIS_WEEK", "URGENT"];
  return allowed.includes(raw as PaymentUrgency) ? (raw as PaymentUrgency) : "WHEN_POSSIBLE";
};

const kindOf = (raw: string | null): PaymentPieceKind => {
  const allowed: PaymentPieceKind[] = ["INVOICE", "PURCHASE_ORDER", "QUOTE", "DELIVERY_NOTE", "CONTRACT", "PROOF", "OTHER"];
  return allowed.includes(raw as PaymentPieceKind) ? (raw as PaymentPieceKind) : "OTHER";
};

/**
 * LE RATTACHEMENT, validé contre la liste réelle des types d'entité.
 *
 * C'est lui qui décide de l'EXEMPTION du bon de versement (`isBonDeVersement`) : il ne peut donc
 * pas être un texte libre. `ENTITY_MODULE` couvre exactement l'énumération Prisma — une valeur
 * absente retombe sur « aucun rattachement », et la demande passe par la règle commune.
 */
const entityTypeOf = (raw: string | null): EntityType | null =>
  raw && raw in ENTITY_MODULE ? (raw as EntityType) : null;

/** Une case cochée arrive « on » ; tout le reste vaut non coché. */
const checked = (formData: FormData, name: string): boolean => {
  const v = formData.get(name);
  return v === "on" || v === "1" || v === "true";
};

/**
 * PRÉVENIR QUI DOIT AGIR — le CENTRE, puis les Finances seulement une fois autorisé.
 *
 * Une demande transmise n'attend pas les Finances : elle attend le centre de paiement, qui
 * autorise avant qu'elles ne voient quoi que ce soit. Les prévenir à ce moment-là leur annonçait
 * un travail qu'elles ne pouvaient pas commencer — et noyait la vraie alerte, celle du centre.
 *
 * Le destinataire nommé n'existe plus à la création ; il survit sur les demandes anciennes, et on
 * continue de le prévenir quand il y en a un : sa demande est la sienne, il doit la suivre.
 */
async function alertFinance(req: { id: string; reference: string; title: string; recipientId: string | null }, title: string) {
  const body = `${req.reference} — ${req.title}`;
  const link = `${PATH}/${req.id}`;
  if (req.recipientId) await notifyUser({ userId: req.recipientId, type: "VALIDATION_REQUIRED", title, body, link });
  await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], { type: "VALIDATION_REQUIRED", title, body, link });
}

/** Recalcule l'état d'après les verdicts, et le trace s'il change. */
async function syncStatus(requestId: string, current: string, actorId: string | null): Promise<string> {
  // Les pièces EN VIGUEUR : une pièce remplacée ne dicte plus rien (`piecesEnVigueur`). Mesuré : retiré
  // seul, ce filtre ne change aucun état ici — une pièce remplacée est soit marquée acceptée à son
  // remplacement, soit une pièce jamais mise en cause (en attente ou acceptée), et aucune des deux ne fait
  // changer le dossier de camp (`statusFromPieces`). Il reste parce que c'est la MÊME lecture que la
  // transmission et le bon à payer, qui, eux, en dépendent (le décompte des pièces validées).
  const pieces = await prisma.paymentPiece.findMany({ where: { requestId, replacedBy: { is: null } }, select: { status: true } });
  const next = statusFromPieces(current, pieces);
  if (!next) return current;
  await prisma.paymentRequest.update({ where: { id: requestId }, data: { status: next as PaymentRequestStatus } });
  await trace(requestId, actorId, next === "CHANGES_REQUESTED" ? "CHANGES" : "SUBMIT", "État recalculé d'après les verdicts des pièces.");
  return next;
}

/**
 * LE TTC LU DES FACTURES EN VIGUEUR d'une demande (`finance/montant-facture.ts`) — une facture remplacée ne compte plus.
 * La pièce qu'on vient de déposer arrive avec sa lecture du dépôt ; les autres avec leur lecture gardée.
 */
async function ttcDesFacturesEnVigueur(requestId: string, ajout?: { pieceId: string; ttc: number | null }): Promise<(number | null)[]> {
  const pieces = await prisma.paymentPiece.findMany({
    where: { requestId, kind: "INVOICE", replacedBy: { is: null } }, select: { id: true, documentId: true },
  });
  const stockes = await ttcDesFacturesStockees(pieces.filter((p) => p.id !== ajout?.pieceId).map((p) => p.documentId));
  return pieces.map((p) => (ajout && p.id === ajout.pieceId ? ajout.ttc : stockes.get(p.documentId) ?? null));
}

/** Le refus d'un écart de montant, avec les deux chiffres que l'écran propose de reprendre. */
function refusDuMontant(lecture: LectureMontant, error: string): ActionResult {
  return { ok: false, error, ...(lecture.etat === "ECART" ? { ecartMontant: { montant: lecture.montant, total: lecture.total } } : {}) };
}

// ───────────────────────── Création ─────────────────────────

/**
 * Créer la demande et déposer ses premières pièces, EN UNE FOIS.
 *
 * Les pièces arrivent avec leur commentaire (`note_0`, `note_1`…) et leur nature (`kind_0`…) :
 * « voici la facture, le montant TTC inclut la livraison » appelle une réponse sur CETTE pièce,
 * pas un message général qu'il faudra rattacher de tête.
 */
export async function createPaymentRequest(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!userCan(user, "VALIDATIONS", "CREATE")) return { ok: false, error: "Non autorisé." };

    const title = fdStr(formData, "title");
    const payee = fdStr(formData, "payee");
    const amount = fdNum(formData, "amount");
    if (!title) return { ok: false, error: "Indiquez l'objet du paiement." };
    if (!payee) return { ok: false, error: "Indiquez le bénéficiaire — à qui l'argent doit aller." };
    if (amount == null || amount <= 0) return { ok: false, error: "Indiquez le montant à payer." };

    const submit = fdStr(formData, "submit") !== "0";
    // ── L'ENTITÉ SE DIT, ELLE NE SE DEVINE PLUS ────────────────────────────────────────────
    //
    // Elle était prise en silence sur le compte du demandeur : personne ne la voyait, personne
    // ne la choisissait, et elle pouvait rester vide. La file de paiements mélangeait alors deux
    // sociétés avec un total qui n'appartenait à aucune, et la comptabilité rattachait à la main
    // — donc de mémoire, donc parfois à tort.
    //
    // La règle ne s'applique QU'À L'ENVOI — un brouillon se garde incomplet, c'est sa raison
    // d'être — et QU'À QUI PEUT S'Y CONFORMER : exiger un choix de quelqu'un dont le sélecteur
    // est vide n'est pas une règle, c'est une impasse. Ces demandes-là existent (personne non
    // rattachée, installation mono-société) ; elles partent, et la Direction les voit dans le
    // groupe « Sans entité — à rattacher » de la file, qui existe précisément pour cela.
    //
    // DEPUIS LE 06/10 (Direction), LA DEMANDE D'UN SALARIÉ EST RATTACHÉE D'OFFICE À ADVENTUM : plus
    // de choix d'entité à l'écran, et un `companyId` envoyé quand même est ignoré. La Direction
    // peut toujours corriger l'entité en validant (`canOverrideEntity`). Sans entité Adventum
    // (installation neuve), on retombe sur l'ancienne règle plutôt que de laisser la demande sans
    // société.
    const adventumId = await adventumCompanyId();
    const companyId = adventumId ?? resolveMoneyEntity({
      explicit: fdStr(formData, "companyId"),
      requester: await moneyEntityOf(user.id),
    });
    const mesEntites = adventumId ? [] : (await getMyCompanies(user.id)).map((c) => c.id);
    if (submit && mesEntites.length > 0) {
      const verdict = checkMoneyEntity(companyId, mesEntites, { hasGlobalView: hasGlobalView(user.role) });
      if (!verdict.ok) return { ok: false, error: verdict.reason ?? "Entité manquante." };
    }
    const entityType = entityTypeOf(fdStr(formData, "entityType"));
    // LE RATTACHEMENT À UNE DÉCLARATION D'INFORMATION MÉDICALE DISPENSE DE FACTURE — il se PROUVE
    // (audit 10/2026). Il suffisait de poster le type pour passer sans pièce : n'importe quelle demande
    // s'exemptait. La déclaration doit exister, être visible du demandeur, et la demande naître d'un de
    // ses bons de versement (le jeton de prise que pose `requestSlipPayment`).
    if (entityType === "MEDICAL_INFO_DECLARATION") {
      const refus = await bonDeVersementRattache(user, fdStr(formData, "entityId"), fdStr(formData, "medicalInfoSlipClaim"));
      if (refus) return { ok: false, error: refus };
    }
    const paymentMethodStated = checked(formData, "paymentMethodStated");
    const deadlineNature = deadlineNatureOf(fdStr(formData, "deadlineNature")) as PaymentDeadlineNature;

    // UNE DEMANDE TRANSMISE PORTE SA JUSTIFICATION — un BON DE COMMANDE ou une FACTURE, et la
    // déclaration que le moyen de paiement y figure. Le centre de paiement autorise une sortie
    // d'argent : sans l'un ou l'autre, il autorise une phrase ; sans le moyen de paiement, la
    // comptabilité sait quoi payer mais pas comment, et le dossier repart trois jours pour un RIB.
    //
    // L'exception est le BON DE VERSEMENT (information médicale), qui n'a ni bon ni facture et ne
    // peut pas en avoir : sa quittance n'existe qu'APRÈS le versement. Toute la règle vit dans
    // `finance/payment-dossier.ts` — module pur, testé, partagé avec le formulaire qui l'annonce
    // AVANT qu'on essaie d'envoyer.
    //
    // Un BROUILLON n'est pas concerné : il n'engage rien, il se garde incomplet, c'est sa raison
    // d'être.
    const joints = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (submit) {
      const gate = canSubmitDossier({
        entityType,
        pieces: joints.map((_, i) => ({ kind: kindOf(fdStr(formData, `kind_${i}`)) })),
        paymentMethodStated,
      });
      if (!gate.ok) return { ok: false, error: gate.reason ?? "Le dossier est incomplet." };
    }

    // UNE FACTURE DÉJÀ CONNUE NE REPART PAS AU PAIEMENT (Direction, 14/10) — jugé AVANT toute écriture : le même
    // fichier, ou la même facture lue par Luna (même fournisseur, même numéro), déjà dans une autre demande, un poste
    // Ad & Pro, le registre Legal ou un dossier → refus, et la relance comme seul geste. Un doublon seulement PROBABLE
    // passe, avec la marque « doublon possible » posée plus bas.
    const facturesJointes: (FichierDepose & { i: number })[] = [];
    for (const [i, f] of joints.entries()) {
      if (kindOf(fdStr(formData, `kind_${i}`)) === "INVOICE") facturesJointes.push({ i, octets: Buffer.from(await f.arrayBuffer()), nom: f.name, saisie: { fournisseur: payee } });
    }
    const garde = await verifierFacturesAvantDepot(user, facturesJointes, { instances: [] });
    if (!garde.ok) return { ok: false, error: garde.error, factureConnue: garde.factureConnue };

    // LE MONTANT DEMANDÉ EST CELUI DE LA FACTURE (`finance/montant-facture.ts`) — confronté au TTC que Luna vient de lire
    // pour la garde ci-dessus. Il était le seul champ saisi, jamais comparé : un HT tapé pour un TTC, le chiffre du BC ou
    // du devis partaient au centre sans un mot. Un écart se corrige, ou s'explique et se confirme. Un brouillon n'engage
    // rien : il est confronté à sa transmission (`submitPaymentRequest`).
    const lectureMontant = confronterMontantAuxFactures(amount, facturesJointes.map((_, k) => garde.identites[k]?.ttc ?? null));
    const justificationEcart = fdStr(formData, "ecartJustification");
    if (submit) {
      const refusMontant = refusEcartMontant({ lecture: lectureMontant, justification: justificationEcart, confirme: checked(formData, "ecartConfirme") });
      if (refusMontant) return refusDuMontant(lectureMontant, refusMontant);
    }
    const ecartAssume = submit && lectureMontant.etat === "ECART" && justificationEcart ? noteEcartAssume(lectureMontant, justificationEcart) : null;

    // LA SÉRIE PAY EST PARTAGÉE avec le dossier compagnon d'un ordre (`expense-orders.ts`) : une seule
    // file pour une série, sinon chacune ne protège que sa moitié (§118.182).
    const req = await enSerie(SERIE_DEMANDES_PAIEMENT, () => createWithRetry(async () =>
      prisma.paymentRequest.create({
        data: {
          reference: await nextRef(),
          title,
          description: fdStr(formData, "description"),
          amount,
          payee,
          // PLUS DE DESTINATAIRE À LA CRÉATION. Depuis que le centre de paiement est le guichet
          // unique, les Finances ne voient rien avant l'autorisation : désigner l'une d'elles
          // nommait quelqu'un qui ne pouvait pas encore agir, et faisait dormir la demande
          // jusqu'au retour de l'intéressé s'il était absent. Le champ SURVIT sur les demandes
          // anciennes — il porte leur historique, et la garde d'accès du dossier s'en sert.
          recipientId: null,
          companyId: companyId || null,
          dueDate: dateOf(fdStr(formData, "dueDate")),
          deadlineNature,
          urgency: urgencyOf(fdStr(formData, "urgency")),
          paymentMethodStated,
          // Le contact du bénéficiaire — facultatif, et c'est délibéré : une autorité sanitaire
          // n'a pas d'interlocuteur nommé, et rendre obligatoire ce qui n'est pas toujours
          // pertinent apprend à remplir les champs pour rien.
          contactName: fdStr(formData, "contactName"),
          contactPhone: fdStr(formData, "contactPhone"),
          contactEmail: fdStr(formData, "contactEmail"),
          status: submit ? "SUBMITTED" : "DRAFT",
          submittedAt: submit ? new Date() : null,
          requesterId: user.id,
          // LE RATTACHEMENT EST POSÉ ICI, à la création — pas dans une mise à jour qui suivrait.
          // C'est lui qui ouvre (ou non) l'exemption du bon de versement : le fixer après coup
          // reviendrait à contrôler la règle sur une demande qui ne dit pas encore ce qu'elle est.
          entityType,
          entityId: entityType ? fdStr(formData, "entityId") : null,
          link: fdStr(formData, "link"),
        },
      }),
    ));

    // Les pièces du premier dépôt. Un échec d'enregistrement ne doit pas emporter la demande :
    // on préfère un dossier créé auquel il manque une pièce — visible, corrigeable — à un
    // formulaire perdu avec tout ce qui avait été saisi.
    const files = joints;
    for (const [i, file] of files.entries()) {
      try {
        const doc = await persistUploadedDocument(user.id, {
          entityType: "PAYMENT_REQUEST", entityId: req.id,
          category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file,
        });
        if (!doc.ok || !doc.documentId) throw new Error(doc.error ?? "Enregistrement impossible.");
        await prisma.paymentPiece.create({
          data: {
            requestId: req.id, documentId: doc.documentId,
            kind: kindOf(fdStr(formData, `kind_${i}`)),
            note: fdStr(formData, `note_${i}`),
            position: i, createdById: user.id,
          },
        });
      } catch (e) {
        console.error("[payment] pièce non enregistrée", e);
      }
    }

    // TRANSMETTRE, C'EST ENTRER AU CENTRE. La demande déposée directement (sans passer par le
    // brouillon) suit le même chemin que celle transmise depuis la fiche : l'ordre de dépense naît
    // ici, en attente du centre. Un brouillon, lui, n'engage rien et n'y entre pas.
    let ordreId: string | null = null;
    if (submit) {
      const order = await createExpenseOrder({
        label: `${req.reference} — ${req.title}`,
        amount, category: "FOURNISSEUR", beneficiary: payee,
        sourceType: "PAYMENT_REQUEST", sourceId: req.id,
        requestedById: user.id, dueDate: dateOf(fdStr(formData, "dueDate")),
        deadlineNature,
        // L'écart assumé est écrit DANS l'ordre : c'est l'ordre que le centre lit avant d'autoriser.
        notes: [fdStr(formData, "description"), ecartAssume].filter(Boolean).join(" — ") || null,
      });
      ordreId = order.id;
      await prisma.paymentRequest.update({ where: { id: req.id }, data: { expenseOrderId: order.id } });
    }
    await trace(req.id, user.id, submit ? "SUBMIT" : "COMMENT", submit ? "Demande transmise au centre de paiement." : "Brouillon créé.");
    if (ecartAssume) await trace(req.id, user.id, "ECART_ASSUME", ecartAssume);
    if (submit && lectureMontant.etat === "NON_LU") await trace(req.id, null, "MONTANT_NON_LU", PHRASE_MONTANT_NON_LU);
    // LA MARQUE « DOUBLON POSSIBLE » — dans le fil et sur l'ordre : le centre de paiement et les Finances la lisent.
    for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, ordreIds: [ordreId], demandeId: req.id, acteurId: user.id });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Demandes de paiement",
      entityType: "PAYMENT_REQUEST", entityId: req.id,
      summary: `Demande de paiement ${req.reference} — ${payee} · ${amount} DZD${ecartAssume ? ` — ${ecartAssume}` : ""}`,
    });
    revalidate(req.id);
    const avertissement = garde.probables.map((p) => p.phrase).join(" ") || undefined;
    return { ok: true, id: req.id, ...(avertissement ? { avertissement, message: avertissement } : {}) };
  } catch (err) {
    console.error("[payment] createPaymentRequest failed", err);
    return { ok: false, error: "La demande n'a pas pu être créée. Réessayez dans un instant." };
  }
}

// ───────────────────────── Pièces ─────────────────────────

/**
 * Ajouter une pièce — ou REMPLACER celle que les Finances ont refusée.
 *
 * Le remplacement ne supprime pas l'originale : c'est elle qui explique pourquoi il y a eu un
 * second tour. Elle passe simplement derrière sa remplaçante dans la liste.
 */
export async function addPaymentPiece(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = fdStr(formData, "requestId");
    if (!requestId) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req) && !isFinance(user)) return { ok: false, error: "Non autorisé." };
    if (isClosed(req.status)) return { ok: false, error: "Ce dossier est clos : il ne reçoit plus de pièce." };

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez un fichier." };

    const replacesId = fdStr(formData, "replacesId");
    // LE DEMANDEUR LUI-MÊME — pas la vue globale qui le supplée : c'est lui qui tient le dossier quand
    // il lui revient, et ce sont ses gestes qui ne le renvoient pas aux Finances à sa place.
    const parLeDemandeur = req.requesterId === user.id;
    let ancienne: { status: string } | null = null;
    if (replacesId) {
      const old = await prisma.paymentPiece.findUnique({ where: { id: replacesId }, select: { requestId: true, status: true, replacedBy: { select: { id: true } } } });
      if (!old || old.requestId !== requestId) return { ok: false, error: "Pièce à remplacer introuvable." };
      // Une pièce mise en cause se remplace ; tant que le dossier est chez le demandeur, il remplace
      // aussi une pièce que personne n'a signalée (§118.191, audit R04). La règle vit dans
      // `refusDeRemplacement`, lue aussi par l'écran.
      const refus = refusDeRemplacement({
        pieceStatus: old.status, dejaRemplacee: Boolean(old.replacedBy),
        dossierStatus: req.status, parLeDemandeur: parLeDemandeur || isRequester(user, req),
      });
      if (refus) return { ok: false, error: refus };
      ancienne = old;
    }

    // UNE FACTURE DÉJÀ CONNUE AILLEURS NE S'AJOUTE PAS (Direction, 14/10) — jugé avant d'écrire. Ce dossier-ci (et son
    // ordre) est hors de la comparaison : remplacer sa propre facture, ou la redéposer ici, n'est pas un second paiement.
    const estFacture = kindOf(fdStr(formData, "kind")) === "INVOICE";
    const garde = estFacture
      ? await verifierFacturesAvantDepot(user, [{ octets: Buffer.from(await file.arrayBuffer()), nom: file.name, saisie: { fournisseur: req.payee } }], {
          instances: [`DEMANDE:${requestId}`, ...(req.expenseOrderId ? [`ORDRE:${req.expenseOrderId}`] : [])],
        })
      : { ok: true as const, identites: [], probables: [] };
    if (!garde.ok) return { ok: false, error: garde.error, factureConnue: garde.factureConnue };

    const doc = await persistUploadedDocument(user.id, {
      entityType: "PAYMENT_REQUEST", entityId: requestId,
      category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file,
    });
    if (!doc.ok || !doc.documentId) return { ok: false, error: doc.error ?? "Le fichier n'a pas pu être enregistré." };
    const count = await prisma.paymentPiece.count({ where: { requestId } });
    const piece = await prisma.paymentPiece.create({
      data: {
        requestId, documentId: doc.documentId,
        kind: kindOf(fdStr(formData, "kind")),
        note: fdStr(formData, "note"),
        replacesId: replacesId || null,
        position: count, createdById: user.id,
      },
    });

    // La pièce remplacée sort du décompte (`piecesEnVigueur`) : elle a été reprise, elle ne bloque
    // plus rien. Une pièce MISE EN CAUSE garde sa marque historique (« acceptée — remplacée »), que
    // lisent aussi les synthèses ; une pièce que personne n'avait signalée garde son verdict — on ne
    // déclare pas « acceptée » une pièce que personne n'a examinée.
    if (replacesId && ancienne && needsReplacement(ancienne.status)) {
      await prisma.paymentPiece.update({ where: { id: replacesId }, data: { status: "ACCEPTED", reviewNote: "Remplacée par une nouvelle version." } });
    }
    await trace(requestId, user.id, "PIECE_ADDED", replacesId ? "Pièce remplacée." : "Pièce ajoutée.", piece.id);
    // UNE FACTURE AJOUTÉE OU REMPLACÉE SE CONFRONTE AU MONTANT DE LA DEMANDE (`finance/montant-facture.ts`) — la pièce
    // n'est pas refusée (elle est la bonne, c'est souvent le montant qui ne l'est plus), mais l'écart se DIT : dans le fil,
    // que les Finances lisent, et au déposant, qui corrige le montant. La transmission suivante l'exigera.
    let ecartSignale: string | null = null;
    if (estFacture) {
      const lecture = confronterMontantAuxFactures(toNumber(req.amount), await ttcDesFacturesEnVigueur(requestId, { pieceId: piece.id, ttc: garde.identites[0]?.ttc ?? null }));
      if (lecture.etat === "ECART") {
        ecartSignale = `${phraseEcartMontant(lecture)} Corrigez le montant de la demande, ou expliquez l'écart.`;
        await trace(requestId, user.id, "ECART_MONTANT", ecartSignale, piece.id);
      }
    }
    // LE DEMANDEUR GARDE SON DOSSIER (§118.191). Remplacer la dernière pièce en cause faisait repartir
    // le dossier aux Finances de lui-même — au milieu d'une correction : le montant que le renvoi
    // demandait de revoir ne se corrigeait plus, le dossier n'était plus chez lui. Un geste du
    // demandeur ne lui retire jamais son dossier : il le renvoie quand sa correction est complète
    // (« Envoyer aux Finances »). Un geste des Finances, lui, peut le ramener chez elles.
    if (!parLeDemandeur) await syncStatus(requestId, req.status, user.id);
    for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, ordreIds: [req.expenseOrderId], demandeId: requestId, acteurId: user.id });
    revalidate(requestId);
    const resteChezLui = parLeDemandeur && req.status === "CHANGES_REQUESTED";
    const avertissement = [...garde.probables.map((p) => p.phrase), ecartSignale].filter(Boolean).join(" ") || undefined;
    const phrase = resteChezLui
      ? `${replacesId ? "Pièce remplacée" : "Pièce ajoutée"} — renvoyez le dossier aux Finances quand votre correction est complète.`
      : null;
    const message = [phrase, avertissement].filter(Boolean).join(" ");
    return { ok: true, id: piece.id, ...(message ? { message } : {}), ...(avertissement ? { avertissement } : {}) };
  } catch (err) {
    console.error("[payment] addPaymentPiece failed", err);
    return { ok: false, error: "La pièce n'a pas pu être ajoutée." };
  }
}

/**
 * CE QUE LE DEMANDEUR PEUT ENCORE PRÉCISER APRÈS COUP — la déclaration du moyen de paiement et
 * le contact du bénéficiaire.
 *
 * Sans cette action, un brouillon créé avant que la case n'existe, ou un dossier renvoyé pour
 * correction, serait bloqué à la transmission sans aucun moyen de se débloquer : le formulaire de
 * création est passé, et rien d'autre n'écrit ce champ. C'est exactement le cul-de-sac que la
 * règle est censée éviter.
 *
 * La case est une ATTESTATION : « j'ai la pièce sous les yeux et elle porte le RIB ». Seul le
 * demandeur la coche — les Finances ne peuvent pas attester à sa place de ce qu'elles n'ont pas
 * fourni.
 */
export async function updatePaymentRequestDetails(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.paymentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req)) return { ok: false, error: "Seul le demandeur complète sa demande." };
    if (isClosed(req.status)) return { ok: false, error: "Ce dossier est clos." };

    const paymentMethodStated = checked(formData, "paymentMethodStated");
    await prisma.paymentRequest.update({
      where: { id },
      data: {
        paymentMethodStated,
        contactName: fdStr(formData, "contactName"),
        contactPhone: fdStr(formData, "contactPhone"),
        contactEmail: fdStr(formData, "contactEmail"),
      },
    });
    if (paymentMethodStated !== req.paymentMethodStated) {
      await trace(id, user.id, "COMMENT", paymentMethodStated
        ? "Le demandeur déclare que le moyen de paiement figure sur le document."
        : "Le demandeur retire sa déclaration sur le moyen de paiement.");
    }
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[payment] updatePaymentRequestDetails failed", err);
    return { ok: false, error: "Les précisions n'ont pas pu être enregistrées." };
  }
}

/**
 * CORRIGER SA DEMANDE — l'objet, le bénéficiaire, le montant, le contexte, l'échéance ; et, tant
 * qu'elle n'a jamais été transmise, l'entité et l'urgence (§118.191, audit 360° R04).
 *
 * Ni le montant, ni le bénéficiaire, ni l'objet ne se corrigeaient — pas même en brouillon. La règle
 * (quand, quoi, et ce qui ne se corrige pas ici) vit dans `finance/correction-demande.ts`, lue aussi
 * par l'écran.
 *
 * APRÈS TRANSMISSION, l'ordre de dépense est déjà au centre : il suit, par l'UNIQUE réviseur d'ordre
 * (`payments/revision-ordre.ts`). Relever le montant ou changer de bénéficiaire rouvre une
 * autorisation donnée ; baisser ne rouvre rien. La demande et l'ordre s'écrivent dans la MÊME
 * transaction : un ordre réglé ou refusé entre-temps annule toute la correction, jamais la moitié.
 *
 * Ce que le formulaire ne porte pas ne s'écrit pas (§118.152c) : chaque champ est lu par sa présence.
 * Après transmission, ce qui a changé se DIT (`note`) — les Finances et le centre relisent un dossier
 * qu'ils ont déjà vu, et doivent savoir quoi regarder.
 */
export async function corrigerDemandePaiement(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.paymentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req)) return { ok: false, error: "Seul le demandeur corrige sa demande." };

    // L'ÉTAT D'ABORD (§118.18) : la nature du dossier, sa place dans le circuit, puis l'argent.
    const ordre = req.expenseOrderId
      ? await prisma.expenseOrder.findUnique({ where: { id: req.expenseOrderId }, select: { status: true, centralStatus: true } })
      : null;
    const refus = refusDeCorrection({ status: req.status, compagnon: isCompanionDossier(req.origin), ordre });
    if (refus) return { ok: false, error: refus };

    // CE QUE LE FORMULAIRE PORTE, et lui seul. Les clés sont écrites EN CLAIR, une par une : une boucle
    // sur une liste de clés rendrait l'action illisible à la dérivation des contrats (§118.79b). Les
    // champs du brouillon se refusent d'abord — c'est une question d'état, pas de valeur.
    if (formData.has("companyId")) {
      const horsBrouillon = refusDuChamp(req.status, "companyId");
      if (horsBrouillon) return { ok: false, error: horsBrouillon };
    }
    if (formData.has("urgency")) {
      const horsBrouillon = refusDuChamp(req.status, "urgency");
      if (horsBrouillon) return { ok: false, error: horsBrouillon };
    }
    const apres: Partial<ValeursDemande> = {};
    if (formData.has("title")) {
      const objet = fdStr(formData, "title");
      if (objet === null) return { ok: false, error: "L'objet du paiement ne peut pas être vide." };
      apres.title = objet;
    }
    if (formData.has("payee")) {
      const beneficiaire = fdStr(formData, "payee");
      if (beneficiaire === null) return { ok: false, error: "Le bénéficiaire ne peut pas être vide — à qui l'argent doit-il aller ?" };
      apres.payee = beneficiaire;
    }
    if (formData.has("amount")) {
      const montant = fdNum(formData, "amount");
      if (montant === null || !(montant > 0)) return { ok: false, error: "Indiquez un montant positif." };
      apres.amount = montant;
    }
    if (formData.has("description")) apres.description = fdStr(formData, "description");
    if (formData.has("dueDate")) {
      const brut = fdStr(formData, "dueDate");
      const d = dateOf(brut);
      if (brut !== null && !d) return { ok: false, error: "Échéance illisible." };
      apres.dueDate = d ? d.toISOString().slice(0, 10) : null;
    }
    if (formData.has("deadlineNature")) apres.deadlineNature = deadlineNatureOf(fdStr(formData, "deadlineNature"));
    if (formData.has("urgency")) apres.urgency = urgencyOf(fdStr(formData, "urgency"));
    if (formData.has("companyId")) {
      const brut = fdStr(formData, "companyId");
      if (brut !== null) {
        const verdict = checkMoneyEntity(brut, (await getMyCompanies(user.id)).map((c) => c.id), { hasGlobalView: hasGlobalView(user.role) });
        if (!verdict.ok) return { ok: false, error: verdict.reason ?? "Entité refusée." };
      }
      apres.companyId = brut;
    }

    const avant: ValeursDemande = {
      title: req.title, payee: req.payee, amount: toNumber(req.amount), description: req.description,
      dueDate: req.dueDate ? req.dueDate.toISOString().slice(0, 10) : null,
      deadlineNature: deadlineNatureOf(req.deadlineNature), urgency: req.urgency, companyId: req.companyId,
    };
    const entites = apres.companyId !== undefined
      ? new Map((await prisma.company.findMany({ where: { id: { in: [req.companyId, apres.companyId].filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]))
      : new Map<string, string>();
    const ecarts = ecartsDeCorrection(avant, apres, {
      deadlineNature: (v) => deadlineNatureLabel(v),
      urgency: (v) => (v ? PAYMENT_URGENCY[v] ?? v : "—"),
      companyId: (v) => (v ? entites.get(v) ?? "entité inconnue" : "aucune"),
      dueDate: (v) => (v ? new Date(v).toLocaleDateString("fr-FR", { timeZone: "UTC" }) : "aucune"),
    });
    if (ecarts.length === 0) return { ok: true, id, message: "Rien n'a changé : la demande est restée telle quelle." };

    // LE MOTIF ENSUITE : après transmission, ce qui a changé se dit. Une comparaison à `null` et non une
    // négation : la dérivation des contrats lit la négation d'une variable comme « champ obligatoire »
    // pour toute l'action, et le motif n'est exigé qu'APRÈS transmission (§118.138).
    const note = fdStr(formData, "note");
    if (req.status !== "DRAFT" && note === null) {
      return { ok: false, error: "Dites ce qui a changé : les Finances et le centre relisent un dossier qu'ils ont déjà vu." };
    }

    const raison = `demande ${req.reference} corrigée par son demandeur`;
    const phrase = phraseDeCorrection(ecarts, note);
    let revision: ResultatRevision | null = null;
    try {
      revision = await prisma.$transaction(async (tx) => {
        // Conditionnelle sur l'état LU : un dossier transmis, retiré ou repris par les Finances entre-
        // temps ne se corrige pas en douce.
        const ecrit = await tx.paymentRequest.updateMany({
          where: { id, status: req.status },
          data: {
            ...(apres.title !== undefined ? { title: apres.title } : {}),
            ...(apres.payee !== undefined ? { payee: apres.payee } : {}),
            ...(apres.amount !== undefined ? { amount: apres.amount } : {}),
            ...(apres.description !== undefined ? { description: apres.description } : {}),
            ...(apres.dueDate !== undefined ? { dueDate: apres.dueDate ? new Date(apres.dueDate) : null } : {}),
            ...(apres.deadlineNature !== undefined ? { deadlineNature: apres.deadlineNature as PaymentDeadlineNature } : {}),
            ...(apres.urgency !== undefined ? { urgency: apres.urgency as PaymentUrgency } : {}),
            ...(apres.companyId !== undefined ? { companyId: apres.companyId } : {}),
          },
        });
        if (ecrit.count === 0) throw new CorrectionRefusee("Ce dossier vient de changer de main (transmis, retiré, ou repris par les Finances) : rouvrez la fiche.");
        let r: ResultatRevision | null = null;
        if (req.expenseOrderId) {
          r = await reviserOrdreNonRegle(tx, req.expenseOrderId, {
            montant: apres.amount,
            beneficiaire: apres.payee,
            libelle: apres.title !== undefined ? `${req.reference} — ${apres.title}` : undefined,
            echeance: apres.dueDate !== undefined ? (apres.dueDate ? new Date(apres.dueDate) : null) : undefined,
            natureEcheance: apres.deadlineNature,
          }, { acteurId: user.id, raison });
          if (!r.ok) throw new CorrectionRefusee(r.error);
        }
        await tx.paymentRequestEvent.create({ data: { requestId: id, actorId: user.id, kind: "CORRECTED", message: phrase } });
        return r;
      });
    } catch (e) {
      if (e instanceof CorrectionRefusee) return { ok: false, error: e.message };
      throw e;
    }

    if (revision?.ok && revision.revise) {
      await apresRevisionOrdre(revision, { acteurId: user.id, objet: `${req.reference} — ${apres.title ?? req.title}`, raison });
    }
    // UN MONTANT CORRIGÉ QUI S'ÉCARTE DE LA FACTURE SE DIT (`finance/montant-facture.ts`) — dans le fil, que le centre et les
    // Finances relisent, et à l'écran. Le motif de la correction, exigé après transmission, en est l'explication.
    let ecartSignale: string | null = null;
    if (apres.amount !== undefined) {
      const lecture = confronterMontantAuxFactures(apres.amount, await ttcDesFacturesEnVigueur(id));
      if (lecture.etat === "ECART") {
        ecartSignale = phraseEcartMontant(lecture);
        await trace(id, user.id, "ECART_MONTANT", note === null ? ecartSignale : `${ecartSignale} Motif : « ${note} ».`);
      }
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Demandes de paiement",
      entityType: "PAYMENT_REQUEST", entityId: id, summary: phrase,
    });
    revalidate(id);
    revalidatePath("/centre-de-paiement");
    const rouvert = revision?.ok && revision.revise && revision.rouvert;
    const corrigee = rouvert
      ? "Demande corrigée — le paiement repasse au centre de paiement, qui doit l'autoriser de nouveau."
      : req.status === "CHANGES_REQUESTED"
        ? "Demande corrigée — renvoyez-la aux Finances quand votre correction est complète."
        : "Demande corrigée.";
    return {
      ok: true, id,
      message: ecartSignale ? `${corrigee} Attention : ${ecartSignale}` : corrigee,
      ...(ecartSignale ? { avertissement: ecartSignale } : {}),
    };
  } catch (err) {
    console.error("[payment] corrigerDemandePaiement failed", err);
    return { ok: false, error: "La correction n'a pas pu être enregistrée." };
  }
}

/** Une correction refusée au milieu de la transaction — elle annule tout, et son motif remonte. */
class CorrectionRefusee extends Error {}

/** Le demandeur précise ou corrige le commentaire d'une de ses pièces. */
export async function commentPaymentPiece(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const pieceId = fdStr(formData, "pieceId");
    if (!pieceId) return { ok: false, error: "Pièce introuvable." };
    const piece = await prisma.paymentPiece.findUnique({ where: { id: pieceId }, include: { request: true } });
    if (!piece) return { ok: false, error: "Pièce introuvable." };
    if (!isRequester(user, piece.request)) return { ok: false, error: "Seul le demandeur commente ses pièces." };
    if (isClosed(piece.request.status)) return { ok: false, error: "Ce dossier est clos." };

    const note = fdStr(formData, "note");
    await prisma.paymentPiece.update({ where: { id: pieceId }, data: { note } });
    await trace(piece.requestId, user.id, "COMMENT", note, pieceId);
    revalidate(piece.requestId);
    return { ok: true, id: piece.requestId };
  } catch (err) {
    console.error("[payment] commentPaymentPiece failed", err);
    return { ok: false, error: "Le commentaire n'a pas pu être enregistré." };
  }
}

/** Les Finances se prononcent sur UNE pièce — accepter, faire revoir, refuser. */
export async function reviewPaymentPiece(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!isFinance(user)) return { ok: false, error: "L'examen des pièces revient aux Finances." };
    const pieceId = fdStr(formData, "pieceId");
    const verdict = fdStr(formData, "verdict");
    const allowed: PaymentPieceStatus[] = ["PENDING", "ACCEPTED", "CHANGES_REQUESTED", "REJECTED"];
    if (!pieceId || !allowed.includes(verdict as PaymentPieceStatus)) return { ok: false, error: "Verdict invalide." };

    const piece = await prisma.paymentPiece.findUnique({ where: { id: pieceId }, include: { request: true, replacedBy: { select: { id: true } } } });
    if (!piece) return { ok: false, error: "Pièce introuvable." };
    if (isClosed(piece.request.status)) return { ok: false, error: "Ce dossier est clos." };
    // UN BROUILLON NE S'EXAMINE PAS (§118.191) : il n'a pas été transmis. Un verdict sur une de ses
    // pièces le faisait passer « à revoir » puis « transmis » de lui-même, sans son demandeur et sans
    // l'ordre de dépense que la transmission fait naître.
    if (piece.request.status === "DRAFT") return { ok: false, error: "Ce dossier est encore un brouillon : ses pièces s'examinent quand son demandeur l'aura transmis." };
    if (piece.replacedBy) return { ok: false, error: "Cette pièce a été remplacée : c'est sa remplaçante qui s'examine." };

    const reviewNote = fdStr(formData, "note");
    // Mettre en cause une pièce SANS dire pourquoi renvoie le demandeur deviner : c'est le
    // deuxième aller-retour garanti.
    if ((verdict === "CHANGES_REQUESTED" || verdict === "REJECTED") && !reviewNote) {
      return { ok: false, error: "Dites ce qui ne va pas — sans motif, la pièce reviendra identique." };
    }

    await prisma.paymentPiece.update({
      where: { id: pieceId },
      data: {
        status: verdict as PaymentPieceStatus,
        reviewNote,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
    });
    await trace(piece.requestId, user.id, "PIECE_REVIEWED", `${verdict}${reviewNote ? ` — ${reviewNote}` : ""}`, pieceId);

    // Le dossier passe automatiquement au demandeur si une pièce est mise en cause.
    const before = piece.request.status;
    const after = await syncStatus(piece.requestId, before, user.id);
    if (after !== before && after === "CHANGES_REQUESTED") {
      await notifyUser({
        userId: piece.request.requesterId, type: "GENERIC",
        title: "Demande de paiement — pièces à revoir",
        body: `${piece.request.reference} — ${piece.request.title}`,
        link: `${PATH}/${piece.requestId}`,
      });
    }
    revalidate(piece.requestId);
    return { ok: true, id: piece.requestId };
  } catch (err) {
    console.error("[payment] reviewPaymentPiece failed", err);
    return { ok: false, error: "Le verdict n'a pas pu être enregistré." };
  }
}

// ───────────────────────── Circuit du dossier ─────────────────────────

/** Un message libre dans le fil — les deux côtés peuvent en écrire. */
export async function addPaymentComment(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const requestId = fdStr(formData, "requestId");
    const message = fdStr(formData, "message");
    if (!requestId || !message) return { ok: false, error: "Écrivez un message." };
    const req = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req) && !isFinance(user) && req.recipientId !== user.id) return { ok: false, error: "Non autorisé." };

    await trace(requestId, user.id, "COMMENT", message);
    const other = isRequester(user, req) ? req.recipientId : req.requesterId;
    if (other && other !== user.id) {
      await notifyUser({ userId: other, type: "GENERIC", title: "Demande de paiement — nouveau message", body: `${req.reference} — ${message.slice(0, 120)}`, link: `${PATH}/${requestId}` });
    }
    revalidate(requestId);
    return { ok: true, id: requestId };
  } catch (err) {
    console.error("[payment] addPaymentComment failed", err);
    return { ok: false, error: "Le message n'a pas pu être envoyé." };
  }
}

/** Le demandeur (re)transmet son dossier aux Finances. */
export async function submitPaymentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    // `kind` autant que `status` : la complétude du dossier se juge sur la NATURE des pièces
    // (bon de commande ou facture), leur verdict ne dit rien de ce qui manque.
    const req = await prisma.paymentRequest.findUnique({ where: { id }, include: { pieces: { where: { replacedBy: { is: null } }, select: { status: true, kind: true } } } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req)) return { ok: false, error: "Seul le demandeur transmet son dossier." };
    // Un dossier COMPAGNON est déjà parti avec son ordre : le « transmettre » créerait un second
    // ordre pour la même dépense.
    if (isCompanionDossier(req.origin)) {
      return { ok: false, error: "Ce dossier accompagne un ordre de dépense déjà transmis — il n'y a rien à envoyer." };
    }

    const check = canResubmit(req, req.pieces);
    if (!check.ok) return { ok: false, error: check.reason ?? "Transmission impossible." };
    const next = nextPaymentStatus(req.status, "SUBMIT");
    if (!next) return { ok: false, error: "Ce dossier n'est pas en attente d'envoi." };

    // LE MONTANT FACE AUX FACTURES EN VIGUEUR (`finance/montant-facture.ts`) — un brouillon n'a jamais été confronté, et un
    // dossier renvoyé a pu changer de facture ou de montant. Un écart déjà assumé à l'identique ne se redemande pas.
    const montant = toNumber(req.amount);
    const lectureMontant = confronterMontantAuxFactures(montant, await ttcDesFacturesEnVigueur(id));
    const dejaAssume = lectureMontant.etat === "ECART"
      && (await prisma.paymentRequestEvent.count({ where: { requestId: id, kind: "ECART_ASSUME", message: { contains: phraseEcartMontant(lectureMontant) } } })) > 0;
    const justificationEcart = fdStr(formData, "ecartJustification");
    const refusMontant = refusEcartMontant({ lecture: lectureMontant, justification: justificationEcart, confirme: checked(formData, "ecartConfirme"), dejaAssume });
    if (refusMontant) return refusDuMontant(lectureMontant, refusMontant);
    const ecartAssume = lectureMontant.etat === "ECART" && !dejaAssume && justificationEcart ? noteEcartAssume(lectureMontant, justificationEcart) : null;

    // UNE TRANSMISSION À LA FOIS (§118.151, audit données 2026-10-27) : le statut se lit et s'écrit dans la même
    // instruction. Deux clics franchissaient tous deux la lecture et ouvraient DEUX ordres au centre pour une
    // seule facture, le second écrasant le lien du premier — un ordre orphelin, autorisable et payable.
    // Le perdant ne touche à rien : l'ordre n'est créé que par celui qui a fait passer le dossier.
    const pris = await prisma.paymentRequest.updateMany({
      where: { id, status: req.status, expenseOrderId: req.expenseOrderId },
      data: { status: next as PaymentRequestStatus, submittedAt: new Date() },
    });
    if (pris.count === 0) return { ok: false, error: "Ce dossier vient d'être transmis ou modifié — rechargez la page." };

    // LE DOSSIER ENTRE AU CENTRE DE PAIEMENT DÈS LA SOUMISSION, pas au bon à payer.
    //
    // C'était l'inversion la plus coûteuse du circuit : l'ordre de dépense ne naissait qu'APRÈS
    // l'instruction des Finances, si bien qu'elles épluchaient pièce par pièce des dossiers que le
    // centre refuserait peut-être ensuite. Le centre tranche d'abord — c'est lui qui dit si
    // l'entreprise engage cet argent —, les Finances instruisent et paient ce qui est autorisé.
    //
    // L'ordre n'est créé qu'UNE FOIS : après un renvoi pour correction, le dossier est resoumis
    // mais `expenseOrderId` est déjà posé, et le centre retrouve le même dossier dans son fil.
    if (!req.expenseOrderId) {
      const order = await createExpenseOrder({
        label: `${req.reference} — ${req.title}`,
        amount: toNumber(req.amount),
        category: "FOURNISSEUR",
        beneficiary: req.payee,
        sourceType: "PAYMENT_REQUEST",
        sourceId: req.id,
        requestedById: req.requesterId,
        dueDate: req.dueDate,
        deadlineNature: req.deadlineNature,
        notes: [fdStr(formData, "note"), ecartAssume].filter(Boolean).join(" — ") || null,
      });
      await prisma.paymentRequest.update({ where: { id }, data: { expenseOrderId: order.id } });
    }

    await trace(id, user.id, "SUBMIT", fdStr(formData, "note") ?? "Dossier transmis au centre de paiement.");
    if (ecartAssume) await trace(id, user.id, "ECART_ASSUME", ecartAssume);
    if (lectureMontant.etat === "NON_LU") await trace(id, null, "MONTANT_NON_LU", PHRASE_MONTANT_NON_LU);
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[payment] submitPaymentRequest failed", err);
    return { ok: false, error: "La transmission a échoué." };
  }
}

/**
 * La décision des Finances : instruire, mettre en attente, reprendre, renvoyer, payer, refuser.
 *
 * Un seul point d'entrée pour tous ces gestes, parce qu'ils partagent la même garde et la même
 * trace. Ce qui les distingue est dans la table de transitions, pas ici.
 */
export async function decidePaymentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    if (!isFinance(user)) return { ok: false, error: "La décision revient aux Finances." };
    const id = fdStr(formData, "id");
    const move = fdStr(formData, "move") as PaymentMove | null;
    const moves: PaymentMove[] = ["REVIEW", "HOLD", "RESUME", "REQUEST_CHANGES", "APPROVE", "REJECT"];
    if (!id || !move || !moves.includes(move)) return { ok: false, error: "Geste inconnu." };

    // Les pièces EN VIGUEUR : une pièce remplacée, déclarée « acceptée » pour cesser de bloquer, ne
    // compte pas comme une pièce validée — sinon le bon à payer passait sur une remplaçante jamais
    // examinée (§118.191).
    const req = await prisma.paymentRequest.findUnique({ where: { id }, include: { pieces: { where: { replacedBy: { is: null } }, select: { status: true, kind: true } } } });
    if (!req) return { ok: false, error: "Demande introuvable." };

    // UN DOSSIER COMPAGNON NE SE TRANCHE PAS ICI (§118.148). Il accompagne un ordre de dépense déjà
    // parti au centre de paiement : son bon à payer, son refus, sa mise en attente se décident au
    // centre puis aux Finances, sur l'ORDRE. L'écran cachait ces boutons ; l'action, elle, les
    // acceptait — et la garde qui le disait (`canDecideFromDossier`) était écrite, testée, et
    // n'avait AUCUN appelant (§118.14). Un « refusé » posé ici laissait l'ordre payable sous un
    // dossier qui annonçait le contraire : deux vérités sur le même paiement (§118.5, §118.71).
    const depuisDossier = canDecideFromDossier(req.origin);
    if (!depuisDossier.ok) return { ok: false, error: depuisDossier.reason ?? "Ce paiement se décide au centre de paiement." };

    const next = nextPaymentStatus(req.status, move);
    if (!next) return { ok: false, error: "Ce geste n'a pas de sens à ce stade du dossier." };

    const note = fdStr(formData, "note");
    // Une mise en attente sans motif ne dit rien à personne — et le demandeur relancera.
    if (move === "HOLD" && !note) return { ok: false, error: "Dites pourquoi le dossier est mis en attente." };
    if (move === "REJECT" && !note) return { ok: false, error: "Un refus se motive : c'est ce que lira le demandeur." };
    if (move === "APPROVE") {
      const check = canApprove(
        { status: req.status, amount: toNumber(req.amount), entityType: req.entityType, paymentMethodStated: req.paymentMethodStated },
        req.pieces,
      );
      if (!check.ok) return { ok: false, error: check.reason ?? "Bon à payer impossible." };
    }

    // UN REFUS FERME LE PAIEMENT (§118.185, audit 360° I7). L'ordre de dépense est né à la soumission
    // et attend au centre : refuser le dossier en le laissant ouvert, c'était dire « refusé » ici et
    // le payer là-bas. Il est annulé AVANT le refus — et s'il est déjà réglé, rien n'est refusé.
    let ordreAnnule: string | null = null;
    if (move === "REJECT") {
      const annulation = await annulerOrdreNonRegle(req.expenseOrderId, { acteurId: user.id, motif: `demande de paiement ${req.reference} refusée par les Finances` });
      if (!annulation.ok) return { ok: false, error: annulation.error };
      if (annulation.annule) ordreAnnule = annulation.reference;
    }

    // LE STATUT SE LIT ET S'ÉCRIT DANS LA MÊME INSTRUCTION (§118.151, audit 2026-10-24). Le geste a été
    // jugé sur le statut LU plus haut ; deux décisions simultanées (deux comptables, un double clic)
    // passaient toutes deux — et deux « bon à payer » sur un dossier d'avant l'ordre-à-la-soumission
    // émettaient DEUX ordres de dépense pour un seul paiement. Seule la décision qui trouve encore
    // le statut qu'elle a jugé s'écrit ; l'autre ne touche à rien.
    // (Un refus a déjà annulé l'ordre non réglé ci-dessus : s'il perd la course, l'ordre reste
    // annulé — aucun argent ne sort, et la personne voit le dossier tel que l'autre l'a tranché.)
    const ecrit = await prisma.paymentRequest.updateMany({
      where: { id, status: req.status },
      data: {
        status: next as PaymentRequestStatus,
        holdReason: move === "HOLD" ? note : move === "RESUME" ? null : req.holdReason,
        decisionNote: move === "APPROVE" || move === "REJECT" || move === "REQUEST_CHANGES" ? note : req.decisionNote,
        decidedById: move === "APPROVE" || move === "REJECT" ? user.id : req.decidedById,
        decidedAt: move === "APPROVE" || move === "REJECT" ? new Date() : req.decidedAt,
      },
    });
    if (ecrit.count === 0) {
      return { ok: false, error: "Ce dossier vient d'être traité par quelqu'un d'autre : rechargez la page pour voir sa décision — la vôtre n'a pas été enregistrée." };
    }
    await trace(id, user.id, move, note);

    // L'ORDRE DE DÉPENSE EXISTE DÉJÀ : il est né à la soumission, et le centre l'a autorisé avant
    // que ce dossier n'arrive ici. Le bon à payer ne le crée donc plus — il constate que les
    // pièces sont conformes. Le verrou du décaissement reste `canDisburse`, au règlement.
    // Filet pour les dossiers ANTÉRIEURS à cette règle, soumis quand l'ordre naissait ici :
    // sans lui, ils n'auraient jamais de règlement.
    if (move === "APPROVE" && !req.expenseOrderId) {
      const order = await createExpenseOrder({
        label: `${req.reference} — ${req.title}`,
        amount: toNumber(req.amount),
        category: "FOURNISSEUR",
        beneficiary: req.payee,
        sourceType: "PAYMENT_REQUEST",
        sourceId: req.id,
        requestedById: req.requesterId,
        dueDate: req.dueDate,
        deadlineNature: req.deadlineNature,
        notes: note ?? null,
      });
      await prisma.paymentRequest.update({ where: { id }, data: { expenseOrderId: order.id } });
    }

    if (move !== "REVIEW") {
      const titles: Record<string, string> = {
        HOLD: "Demande de paiement mise en attente",
        RESUME: "Demande de paiement reprise",
        REQUEST_CHANGES: "Demande de paiement — pièces à revoir",
        APPROVE: "Bon à payer accordé",
        REJECT: "Demande de paiement refusée",
      };
      await notifyUser({
        userId: req.requesterId, type: "GENERIC",
        title: titles[move] ?? "Demande de paiement",
        body: `${req.reference} — ${req.title}`, link: `${PATH}/${id}`,
      });
    }
    await recordAudit({
      actorId: user.id, action: move === "APPROVE" ? "VALIDATE" : "UPDATE", module: "Demandes de paiement",
      entityType: "PAYMENT_REQUEST", entityId: id, summary: `${move} — ${req.reference}`,
    });
    revalidate(id);
    return ordreAnnule
      ? { ok: true, id, message: `Demande refusée — l'ordre de dépense ${ordreAnnule} est annulé : il ne sera pas payé.` }
      : { ok: true, id };
  } catch (err) {
    console.error("[payment] decidePaymentRequest failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/**
 * RELANCER, OU SIGNALER UNE URGENCE DE PAIEMENT.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Une fois sa demande partie, le demandeur n'avait plus qu'un statut à regarder. C'est pourtant
 * le moment où il en a le plus besoin : son fournisseur rappelle, sa quittance a une date, et il
 * ne sait pas si quelqu'un a seulement ouvert le dossier. Il décrochait donc son téléphone — et
 * la relance n'existait nulle part : ni trace, ni file, ni preuve qu'elle a eu lieu. Quand le
 * paiement partait trois semaines plus tard, personne ne pouvait dire s'il avait prévenu.
 *
 * ── DEUX GESTES, ET ILS NE DISENT PAS LA MÊME CHOSE ─────────────────────────────────────────
 *
 *   • **RELANCER** — « où en est-on ? ». Le dossier remonte, personne n'est pris en faute ;
 *   • **SIGNALER UNE URGENCE** — « ce paiement est devenu pressant, et voici pourquoi ». Il
 *     REMONTE la priorité dans la file des Finances (`urgency`), ce qui n'est pas gratuit : d'où
 *     le motif exigé, que les Finances liront pour arbitrer entre deux dossiers pressants.
 *
 * Les fondre en un seul bouton aurait fait de chaque relance une urgence, et une file où tout est
 * urgent n'a plus de priorité du tout.
 *
 * La règle — qui peut, quand, et le délai de courtoisie — vit dans `finance/dossier-auto.ts`,
 * module pur et testé. Le délai se lit sur le FIL du dossier : il porte déjà chaque relance, et
 * une colonne « dernière relance » dirait la même chose une seconde fois (§118-5).
 */
export async function nudgePaymentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.paymentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    // LE DEMANDEUR, ET LUI SEUL. Les Finances n'ont personne à relancer : le dossier est chez
    // elles. Un tiers qui relance à la place du demandeur brouille la question « qui attend ? ».
    if (req.requesterId !== user.id && !hasGlobalView(user.role)) {
      return { ok: false, error: "Seul le demandeur peut relancer sa demande." };
    }

    const kind = nudgeKindOf(fdStr(formData, "kind"));
    const comment = fdStr(formData, "comment");
    const dernier = await prisma.paymentRequestEvent.findFirst({
      where: { requestId: id, kind: kind === "URGENT" ? "URGENT" : "NUDGE", actorId: user.id },
      orderBy: { at: "desc" }, select: { at: true },
    });
    const verdict = canNudge({ status: req.status, kind, comment, lastNudgeAt: dernier?.at ?? null });
    if (!verdict.ok) return { ok: false, error: verdict.reason ?? "Relance impossible." };

    const message = nudgeMessage(kind, req.reference, comment);
    await trace(id, user.id, kind === "URGENT" ? "URGENT" : "NUDGE", comment || NUDGE_LABEL[kind]);
    // UNE URGENCE DÉPLACE LE DOSSIER DANS LA FILE, sinon elle n'est qu'un message de plus. C'est
    // `urgency` qui classe (`sortByPriority`) : le signaler sans le poser laisserait le dossier
    // exactement où il était, et le demandeur croirait avoir agi.
    if (kind === "URGENT" && req.urgency !== "URGENT") {
      await prisma.paymentRequest.update({ where: { id }, data: { urgency: "URGENT" } });
    }

    // LES DESTINATAIRES : QUI A LA MAIN (Direction, 14/10) — la règle de la relance unifiée (`prevenirQuiALaMain`) :
    // le centre de paiement tant qu'il n'a pas autorisé, les Finances ensuite. La Direction reste prévenue d'une URGENCE.
    const title = kind === "URGENT" ? "Paiement signalé urgent" : "Relance sur une demande de paiement";
    const ordre = req.expenseOrderId
      ? await prisma.expenseOrder.findUnique({ where: { id: req.expenseOrderId }, select: { status: true, centralStatus: true } })
      : null;
    await prevenirQuiALaMain({
      etat: etatDuPaiement({ ordre, demande: req }), title, body: message, dossierId: id,
      recipientId: req.recipientId, demandeurId: req.requesterId, acteurId: user.id,
    });
    if (kind === "URGENT") await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], { type: "VALIDATION_REQUIRED", title, body: message, link: `${PATH}/${id}` });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Demandes de paiement",
      entityType: "PAYMENT_REQUEST", entityId: id, summary: message,
    });
    revalidate(id);
    return { ok: true, id, message: kind === "URGENT" ? "Urgence signalée — les Finances sont prévenues." : "Relance envoyée." };
  } catch (err) {
    console.error("[payment] nudgePaymentRequest failed", err);
    return { ok: false, error: "La relance n'a pas pu être envoyée." };
  }
}

/**
 * Le demandeur retire son dossier — y compris APPROUVÉ, tant que l'ordre n'est pas réglé (décision
 * de la Direction du 04/10 : on annule sa demande tant que l'autre ne l'a pas exécutée ; pour un
 * paiement, l'exécution est le règlement). La règle est `refusDeRetrait`, lue aussi par la fiche.
 */
export async function cancelPaymentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.paymentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!isRequester(user, req)) return { ok: false, error: "Seul le demandeur retire sa demande." };
    const ordre = req.expenseOrderId
      ? await prisma.expenseOrder.findUnique({ where: { id: req.expenseOrderId }, select: { status: true } })
      : null;
    // RETIRER UN COMPAGNON NE RETIRERAIT RIEN : une dépense se retire là où elle a été décidée.
    const refus = refusDeRetrait({ status: req.status, compagnon: isCompanionDossier(req.origin), ordre });
    if (refus) return { ok: false, error: refus };

    // RETIRER SA DEMANDE RETIRE SON PAIEMENT (§118.185, audit 360° I7). Déjà réglé entre la lecture
    // et ici : l'écrivain commun refuse sans rien toucher.
    const annulation = await annulerOrdreNonRegle(req.expenseOrderId, { acteurId: user.id, motif: `demande de paiement ${req.reference} retirée par son demandeur` });
    if (!annulation.ok) return { ok: false, error: annulation.error };

    // UN GESTE À LA FOIS : l'écriture exige un dossier encore vivant. Deux clics → un seul retrait ;
    // un refus des Finances passé entre-temps a déjà annulé l'ordre, et le dossier reste refusé.
    const pris = await prisma.paymentRequest.updateMany({
      where: { id, status: { notIn: ["CANCELLED", "REJECTED"] } },
      data: { status: "CANCELLED" },
    });
    if (pris.count === 0) return { ok: false, error: "Cette demande vient d'être close — rechargez la fiche." };
    await trace(id, user.id, "CANCEL", fdStr(formData, "note"));
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Demandes de paiement",
      entityType: "PAYMENT_REQUEST", entityId: id, field: "status", oldValue: req.status, newValue: "CANCELLED",
      summary: `Demande de paiement ${req.reference} retirée par son demandeur`,
    });
    if (isWithFinance(req.status) || req.status === "APPROVED" || annulation.annule) await alertFinance(req, "Demande de paiement retirée");
    revalidate(id);
    return annulation.annule
      ? { ok: true, id, message: `Demande retirée — l'ordre de dépense ${annulation.reference ?? ""} est annulé : il ne sera pas payé.` }
      : { ok: true, id };
  } catch (err) {
    console.error("[payment] cancelPaymentRequest failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

/**
 * SUPPRIMER DÉFINITIVEMENT SA DEMANDE — retirée ou restée brouillon (Direction, 19/10/2026).
 *
 * Par le cœur commun (`supprimerReversible`) : la demande part EN LOT avec son ordre de dépense annulé, ses pièces et
 * son fil ; elle se restaure depuis la corbeille, et l'audit nomme qui l'a supprimée. Le refus (`refusDeSuppression`,
 * dans le registre — la même règle pour l'écran, Adam et la corbeille) garde un dossier vivant, un compagnon, et tout
 * dossier dont le paiement est sorti. Le droit : le demandeur, ou le Super Admin (`peutSupprimerUneDemandePaiement`).
 */
export async function supprimerDemandePaiement(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    if (!(await peutSupprimerUneDemandePaiement(user, id))) return { ok: false, error: "Seul le demandeur (ou le Super Admin) supprime sa demande." };
    const req = await prisma.paymentRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
    if (!req) return { ok: false, error: "Demande introuvable (déjà supprimée ?)." };
    const r = await supprimerReversible("PAYMENT_REQUEST", id, user.id, `Demande de paiement ${req.reference} — « ${req.title} » supprimée définitivement (restaurable depuis la corbeille)`);
    if (!r.ok) return { ok: false, error: r.error ?? "Suppression impossible." };
    revalidate();
    revalidatePath("/centre-de-paiement");
    return { ok: true, redirect: PATH, message: `Demande ${req.reference} supprimée — restaurable depuis la corbeille par le Super Admin.` };
  } catch (err) {
    console.error("[payment] supprimerDemandePaiement failed", err);
    return { ok: false, error: "La suppression a échoué." };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI VIVAIT ICI, ET POURQUOI CE N'EST PLUS LÀ.
 *
 * `askPaymentValidation` (faire valider le dossier) et `askPieceValidation` (faire valider une
 * pièce) permettaient aux Finances de demander une signature sur un paiement. Elles n'ont plus
 * d'objet : depuis que le centre de paiement est le GUICHET UNIQUE, un dossier n'atteint les
 * Finances **que parce que le centre l'a autorisé**. Faire valider ce qui vient d'être validé
 * n'aboutit nulle part — et proposer un geste sans effet est pire que ne rien proposer : on
 * l'exerce, on attend une réponse, elle ne vient jamais.
 *
 * Supprimées à l'écran, dans les ops d'Adam et ICI, ensemble : une action sans appelant réel
 * n'existe pas (§118-14), et une action que l'écran ne propose plus mais que l'assistant peut
 * encore appeler est une porte dérobée (§118-7).
 *
 * Ce que les Finances gardent sur un dossier : LIRE les pièces, et RÉCLAMER celles qui manquent
 * (`ItemAskPanel`) — ce qui n'est pas une décision, mais ce qui permet d'en prendre une.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
