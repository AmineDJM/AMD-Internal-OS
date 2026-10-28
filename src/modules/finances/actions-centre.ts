"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { lienRemiseCaisse } from "@/lib/chemins/moyens-generaux";
import {
  sitsOnPaymentCentre, applyDecision, applyResubmission, canResubmitAuCentre as canResubmit, memeBeneficiaire, CENTRAL_DECISION_LABEL,
  CENTRAL_STATUS_LABEL, type CentralDecision, type CentralStatus, PAYMENT_CENTRE_REFUSAL, refusOrdreFerme,
  ROLES_CENTRE_DE_PAIEMENT, dossierHrefByOrder, ENTITE_SANS, slugSectionDeLOrdre, verserLaRemise,
} from "@/modules/finances/api";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { lienCentreDePaiement, lienOrdreAPayer } from "@/lib/chemins/finances";
import { sansBloquer } from "@/lib/journal";

/**
 * LE CENTRE DE PAIEMENT — le PDG, le Directeur Général et le Super Admin autorisent, la comptabilité exécute.
 *
 * DEUX ISSUES : autoriser ou refuser (décision de la Direction, 02/09/2026 — voir `isDecision`).
 * Ce texte en annonçait quatre, et l'en-tête de l'écran promettait encore « une révision du
 * montant ou une argumentation » qu'aucun bouton n'offrait plus : une prose qui promet un geste
 * que le code n'a pas fait chercher ce qui n'existe pas (audit 360°, R03 ; §118.116). Un refus
 * EXIGE son motif, qui reste dans le fil attaché au paiement : six mois plus tard, on sait à
 * quelles conditions il a été autorisé, ou pourquoi il ne l'a pas été. Les dossiers d'avant qui
 * portent encore « révision » ou « argumentation » se répondent et reviennent au centre
 * (`respondToPaymentCentre`) : rien ne reste bloqué.
 *
 * Toutes les règles d'état viennent du module pur `payments/authorization` : cette action ne fait
 * que vérifier QUI agit, écrire, et prévenir.
 */

const PATH = "/centre-de-paiement";

/**
 * UNE REMISE DE CAISSE D'AVANCE REFUSÉE SORT DU FOND (§118.176).
 *
 * Elle avait été inscrite par les RH en attente du centre : refusée, elle n'a jamais eu lieu. On
 * la CLÔT — elle quitte la caisse en cours sans rien emporter, puisque rien n'a pu y être dépensé
 * — et la raison du refus s'écrit sur elle, lisible là où la détentrice l'attendait. La garder
 * ouverte la ferait compter parmi les sommes « remises », et relancer une confirmation qu'aucune
 * réception ne pourra donner. L'écran la montre « refusée par le centre », pas « soldée » : il le
 * lit sur l'ordre, qui le dit.
 *
 * La paie refusée n'a rien à écrire : son état se lit sur l'ordre, et ses salaires redeviennent
 * « à envoyer » d'eux-mêmes (`virementCouvre`). Les RH qui l'ont envoyée sont prévenues comme tout
 * demandeur.
 */
async function suitesDuRefus(orderId: string, motif: string): Promise<void> {
  try {
    const remise = await prisma.pettyCashAllotment.findUnique({
      where: { expenseOrderId: orderId },
      select: { id: true, status: true, note: true, holderId: true, createdById: true, amount: true, department: { select: { name: true } } },
    });
    if (!remise || remise.status !== "ALLOTTED") return;
    const raison = `Refusée par le centre de paiement : ${motif}`;
    await prisma.pettyCashAllotment.updateMany({
      where: { id: remise.id, status: "ALLOTTED" },
      data: { status: "CLOSED", note: remise.note ? `${remise.note} — ${raison}` : raison },
    });
    if (remise.holderId && remise.holderId !== remise.createdById) {
      await notifyUser({
        userId: remise.holderId, type: "GENERIC", title: "Remise de caisse refusée",
        body: `${Number(remise.amount).toLocaleString("fr-FR")} DZD annoncés pour la caisse ${remise.department.name} : refusés par le centre de paiement — ${motif.slice(0, 200)}`,
        link: lienRemiseCaisse(remise.id),
      });
    }
    revalidatePath("/moyens-generaux");
  } catch (e) {
    // La décision est déjà écrite : une remise qui ne se clôt pas reste visible « refusée » à
    // l'écran (lu sur l'ordre) et ne peut pas être confirmée. Rien ne doit défaire le refus.
    console.error("[centre] remise de caisse refusée non close", e);
  }
}

/**
 * DEUX DÉCISIONS, ET DEUX SEULEMENT : autoriser ou refuser.
 *
 * `REQUEST_CHANGES` (« réviser le montant ») et `REQUEST_INFO` (« demander une argumentation »)
 * ont été retirés du centre. Ils y ajoutaient deux allers-retours pour une question qui se pose
 * AVANT — le montant et sa justification appartiennent à la demande, pas à l'autorisation — et
 * quatre boutons sur une ligne où l'on engage l'argent de la société font hésiter là où il faut
 * trancher.
 *
 * On les retire ICI et pas seulement à l'écran : un geste que l'écran ne propose plus mais que
 * l'action accepte encore reste ouvert à l'assistant et à l'API (§118-7). Les deux ÉTATS, eux,
 * survivent — des dossiers en cours les portent, et leur demandeur doit pouvoir répondre et
 * resoumettre (`respondToPaymentCentre`) : l'ordre revient alors « en attente » et le centre
 * tranche. Rien ne reste bloqué.
 */
function isDecision(v: string): v is Extract<CentralDecision, "APPROVE" | "REFUSE"> {
  return v === "APPROVE" || v === "REFUSE";
}

/**
 * Le centre tranche : autoriser ou refuser.
 *
 * Le MOTIF est exigé pour un refus : refuser sans dire pourquoi renvoie le demandeur deviner — et
 * le dossier revient identique, par une nouvelle pièce, sans que rien ait changé.
 */
export async function decidePayment(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!sitsOnPaymentCentre(user)) {
    return { ok: false, error: PAYMENT_CENTRE_REFUSAL };
  }

  const id = fdStr(formData, "id");
  const decisionRaw = fdStr(formData, "decision") ?? "";
  if (!id || !isDecision(decisionRaw)) return { ok: false, error: "Décision invalide." };
  const decision = decisionRaw;

  const body = fdStr(formData, "body") ?? "";
  if (decision !== "APPROVE" && !body.trim()) {
    return { ok: false, error: "Dites pourquoi : sans motif, le demandeur ne peut que deviner." };
  }

  const order = await prisma.expenseOrder.findUnique({
    where: { id },
    select: { id: true, reference: true, label: true, amount: true, beneficiary: true, centralStatus: true, requestedById: true, status: true, dueDate: true, sourceType: true, sourceId: true },
  });
  if (!order) return { ok: false, error: "Ordre de dépense introuvable." };
  // UN ORDRE ANNULÉ (demande retirée) OU RÉGLÉ NE SE DÉCIDE PLUS : son autorisation est restée « en attente », jamais
  // rendue — la lire seule laissait autoriser un paiement que plus personne ne demande (`refusOrdreFerme`).
  const ferme = refusOrdreFerme(order.status, order.reference);
  if (ferme) return { ok: false, error: ferme };
  // LE BV D'UN DOSSIER RÉGLEMENTAIRE : la décision se lit sur l'étape « Demande du BV » du dossier
  // (« autorisé — chez les Finances », « refusé — motif ») ; c'est là que le demandeur est renvoyé.
  const dossierBv = order.sourceType === "REGULATORY_PRODUCT" && order.sourceId ? `/regulatory/${order.sourceId}` : null;

  const next = applyDecision(order.centralStatus as CentralStatus, decision);
  if (!next) {
    return {
      ok: false,
      error: `Impossible : ce paiement est « ${CENTRAL_STATUS_LABEL[order.centralStatus as CentralStatus]} ». Une décision rendue ne se rejoue pas : un refus se reprend par un nouvel envoi de la pièce, corrigée.`,
    };
  }

  // L'ÉCHÉANCE QUE LE CENTRE IMPOSE AUX FINANCES — distincte de celle qui a été DEMANDÉE.
  //
  // Le demandeur dit quand il aurait besoin d'être payé ; c'est un souhait, formé sans voir la
  // trésorerie ni les autres engagements du mois. Le centre, lui, voit la file entière : il
  // arbitre. Écraser silencieusement la date demandée aurait effacé la demande ; on la garde
  // (elle reste dans la demande de paiement) et l'on pose ICI la date que la comptabilité doit
  // tenir. Sans date fournie, celle du dossier reste — ne rien dire n'est pas repousser à jamais.
  const echeance = decision === "APPROVE" ? fdStr(formData, "dueDate") : null;
  const echeanceDate = echeance ? new Date(echeance) : null;
  if (echeance && Number.isNaN(echeanceDate!.getTime())) {
    return { ok: false, error: "Échéance illisible." };
  }

  // CE QUE LE CENTRE A LU (§118.191). Le centre autorise une somme, à quelqu'un — et depuis que le
  // demandeur corrige sa demande, l'une et l'autre peuvent bouger pendant qu'un siège lit l'ordre.
  // L'écran renvoie ce qu'il affichait ; un écart se dit avec les deux valeurs. Un appelant qui ne
  // l'envoie pas n'est pas comparé ici : l'écriture, elle, porte toujours sur l'état LU.
  const montantVu = fdNum(formData, "montantVu");
  const montantActuel = Number(order.amount);
  if (montantVu !== null && montantVu !== montantActuel) {
    return {
      ok: false,
      error: `Le montant de ce paiement a changé pendant que vous lisiez (${montantVu.toLocaleString("fr-FR")} → ${montantActuel.toLocaleString("fr-FR")} DZD) : relisez l'ordre avant de décider.`,
    };
  }
  if (formData.has("beneficiaireVu") && !memeBeneficiaire(fdStr(formData, "beneficiaireVu"), order.beneficiary)) {
    return {
      ok: false,
      error: `Le bénéficiaire de ce paiement a changé pendant que vous lisiez (désormais : « ${order.beneficiary ?? "non précisé"} ») : relisez l'ordre avant de décider.`,
    };
  }

  // UNE DÉCISION À LA FOIS, ET SUR CE QUI A ÉTÉ LU. L'écriture était faite par le seul identifiant :
  // deux sièges qui tranchaient à la même seconde voyaient le second écraser le premier — un refus
  // devenir une autorisation sans que personne l'ait vue —, et un montant relevé pendant la décision
  // était autorisé sans avoir été lu. Elle est désormais conditionnelle sur l'autorisation, le montant
  // et le bénéficiaire lus ; perdue, rien n'est écrit, pas même le message.
  const changee = "Ce paiement vient de changer (décidé par un autre siège, corrigé ou annulé) : rouvrez le centre.";
  const decide = await prisma.$transaction(async (tx) => {
    const ecrit = await tx.expenseOrder.updateMany({
      where: { id, centralStatus: order.centralStatus, amount: order.amount, beneficiary: order.beneficiary, status: order.status },
      data: {
        centralStatus: next,
        centralDecidedById: user.id,
        centralDecidedAt: new Date(),
        ...(echeanceDate ? { dueDate: echeanceDate } : {}),
      },
    });
    if (ecrit.count === 0) return false;
    await tx.paymentCentreMessage.create({
      data: { orderId: id, decision, body: body.trim() || CENTRAL_DECISION_LABEL[decision], authorId: user.id },
    });
    return true;
  });
  if (!decide) return { ok: false, error: changee };

  const money = `${Number(order.amount).toLocaleString("fr-FR")} DZD`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: id,
    summary: `Centre de paiement — ${CENTRAL_DECISION_LABEL[decision]} : ${order.reference} « ${order.label} » (${money})`,
  });

  if (next === "REFUSED") await suitesDuRefus(id, body.trim());

  // UNE REMISE DE CAISSE D'AVANCE AUTORISÉE ENTRE DANS LA CAISSE (Direction, 28/10/2026) : elle ne va
  // pas dans « Banque & paiements » — l'autorisation vaut versement (`finance/verser-remise.ts`).
  // Un versement qui échoue (ordre révisé ou annulé à la même seconde) laisse l'ordre autorisé : il
  // reste alors dans la file des Finances, comme avant, plutôt que de disparaître.
  const versement = next === "APPROVED" ? await verserLaRemise({ orderId: id, acteurId: user.id, par: "CENTRE" }) : null;
  if (versement && !versement.ok) console.error(`[centre] remise ${order.reference} autorisée mais non versée : ${versement.error}`);
  const caisseCreditee = versement?.ok === true;

  // On prévient CELUI QUI ATTEND : le demandeur quand la balle lui revient, la comptabilité quand
  // le paiement est enfin exécutable.
  if (next === "APPROVED" && !caisseCreditee) {
    await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], {
      type: "VALIDATION_REQUIRED",
      title: "Paiement autorisé — à régler",
      body: `${order.reference} — ${order.label} (${money})`,
      link: lienOrdreAPayer(id),
    });
  }
  if (order.requestedById) {
    // Le demandeur ne siège pas au centre : il va sur SON dossier (la demande qui porte l'ordre).
    const dossier = dossierBv ?? await dossierHrefByOrder([id]).then((m) => m.get(id)).catch(sansBloquer("payment-centre-actions.decidePayment.dossierHrefByOrder"));
    await notifyUser({
      userId: order.requestedById,
      type: next === "APPROVED" ? "GENERIC" : "VALIDATION_REQUIRED",
      title: `Centre de paiement — ${CENTRAL_DECISION_LABEL[decision]}`,
      body: `${order.reference} — ${order.label} (${money})${body.trim() ? ` : ${body.trim().slice(0, 200)}` : ""}`,
      link: dossier ?? PATH,
    });
  }

  revalidatePath(PATH);
  revalidatePath("/finances/paiements-a-faire");
  if (dossierBv) revalidatePath(dossierBv);
  if (versement?.ok) {
    revalidatePath("/moyens-generaux");
    return { ok: true, message: `Autorisé — ${versement.montant.toLocaleString("fr-FR")} DZD ajoutés à la caisse d'avance ${versement.departement}.` };
  }
  return { ok: true, message: `${CENTRAL_DECISION_LABEL[decision]} — enregistré.` };
}

/**
 * Le demandeur répond et resoumet : la balle repasse au centre — pour les dossiers D'AVANT la
 * décision du 02/09/2026, qui portent encore « révision du montant » ou « argumentation demandée ».
 * Le centre ne pose plus ces états ; ceux qui en portent un doivent pouvoir en sortir.
 *
 * On ne resoumet QUE si le centre a rendu la main — sinon on pourrait relancer indéfiniment un
 * dossier qu'il n'a pas encore regardé.
 */
export async function respondToPaymentCentre(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = (fdStr(formData, "body") ?? "").trim();
  if (!id) return { ok: false, error: "Ordre de dépense introuvable." };
  if (!body) return { ok: false, error: "Écrivez votre réponse." };

  const order = await prisma.expenseOrder.findUnique({
    where: { id },
    select: { id: true, reference: true, label: true, amount: true, centralStatus: true, requestedById: true, companyId: true, sourceType: true, status: true },
  });
  if (!order) return { ok: false, error: "Ordre de dépense introuvable." };
  // Répondre au centre sur un ordre annulé le renverrait « en attente » d'une autorisation que plus personne ne demande.
  const ferme = refusOrdreFerme(order.status, order.reference);
  if (ferme) return { ok: false, error: ferme };

  // Le demandeur, ou quelqu'un du centre agissant pour lui (il arrive qu'on saisisse la réponse
  // reçue par téléphone). Personne d'autre : c'est un argumentaire, il engage son auteur.
  const isRequester = order.requestedById === user.id;
  if (!isRequester && !sitsOnPaymentCentre(user)) {
    return { ok: false, error: "Seul le demandeur peut répondre à cette demande." };
  }
  if (!canResubmit(order.centralStatus as CentralStatus)) {
    return { ok: false, error: "Ce paiement n'attend pas de réponse de votre part." };
  }

  const next = applyResubmission(order.centralStatus as CentralStatus);
  if (!next) return { ok: false, error: "Ce paiement n'attend pas de réponse de votre part." };

  await prisma.$transaction([
    prisma.expenseOrder.update({ where: { id }, data: { centralStatus: next } }),
    prisma.paymentCentreMessage.create({ data: { orderId: id, body, authorId: user.id } }),
  ]);

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: id,
    summary: `Centre de paiement — réponse du demandeur : ${order.reference} « ${order.label} »`,
  });
  await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], {
    type: "VALIDATION_REQUIRED",
    title: "Réponse reçue — autorisation à reprendre",
    body: `${order.reference} — ${order.label} (${Number(order.amount).toLocaleString("fr-FR")} DZD)`,
    link: lienCentreDePaiement(order.companyId ?? ENTITE_SANS, slugSectionDeLOrdre(order.sourceType)),
  });

  revalidatePath(PATH);
  return { ok: true, message: "Réponse envoyée — le dossier retourne au centre de paiement." };
}
