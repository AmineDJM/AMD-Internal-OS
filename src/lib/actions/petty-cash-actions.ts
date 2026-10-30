"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { UserRole } from "@prisma/client";
import { userCan, hasGlobalView, getAccess, rolesWithModule, anyRoleFilter, PERMISSIONS } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { lienRemiseCaisse, lienRallongeCaisse, lienCaisseAvance } from "@/lib/chemins/moyens-generaux";
import { deposerPieceDeModule } from "@/lib/storage";
import { validateAttachments } from "@/lib/attach-files";
import { normalizeAmount, normalizeYear } from "@/lib/department-budget";
import {
  currentPeriod, periodLabel, normalizeRechargeDay, nextRechargeDate, grantedTopUpAmount,
} from "@/lib/petty-cash";
import { continuousCash, canSpendFromFund } from "@/lib/general-means/continuous-cash";
import { openRemittances } from "@/lib/queries/general-means";
import { toNumber } from "@/lib/utils";
import { createExpenseOrder } from "@/modules/finances/api";
import { ordreDeRemise } from "@/lib/general-means/remettre";
import { etatRemise, refusConfirmationRemise } from "@/lib/general-means/remise-centre";
import { fdStr, fdNum, fdCase, type ActionResult } from "@/lib/actions/types";
import { refusAnnulationRallonge } from "@/lib/annulations/regles";
import { readReceipt, saveReceiptLines, finaliserNatures } from "@/lib/general-means/expense-lines";
import { allowedGeneralMeansCategoryIds, keepAllowedCategory } from "@/lib/general-means/budget-targets";
import { sansBloquer } from "@/lib/journal";

const PATH = "/moyens-generaux";

/**
 * CAISSE D'AVANCE — actions serveur.
 *
 * Trois gestes, trois responsabilités : l'administration REMET la somme, la détentrice
 * CONFIRME l'avoir reçue, puis DÉPENSE — chaque fois avec le justificatif. Séparer la remise
 * de la confirmation n'est pas de la bureaucratie : c'est la seule façon de savoir si l'argent
 * a réellement changé de mains, et donc de distinguer « décidé » de « détenu ».
 */

/**
 * Remettre (ou rallonger) la caisse, et régler son montant mensuel : les RESSOURCES HUMAINES,
 * qui pilotent le module des moyens généraux — plus l'administration et les finances, qui
 * sortent l'argent. Jamais la détentrice : on ne se recharge pas soi-même.
 */
function canAllot(user: Parameters<typeof userCan>[0]): boolean {
  return hasGlobalView(user)
    || userCan(user, "RH", "UPDATE")
    || userCan(user, "BUDGETS", "UPDATE") || userCan(user, "BUDGETS", "VALIDATE");
}

/**
 * QUI TRANCHE UNE RALLONGE — et donc QUI EN EST PRÉVENU (audit Assistante de direction, 10/2026).
 *
 * La demande de rallonge notifiait la Direction et le Super Admin, alors que c'est `canAllot` qui
 * tranche (`decidePettyCashTopUp`) : les RH et les Budgets, qui avaient le bouton, n'étaient pas
 * prévenus, et la Direction l'était d'une décision qu'elle n'avait pas à prendre. Les destinataires
 * sont désormais LUS PAR LA MÊME GARDE, sur l'accès effectif de chacun (rôle, autre rôle, console) :
 * les candidats sont les comptes actifs dont le rôle — ou une ligne de la console — peut ouvrir
 * l'un des droits de `canAllot`, puis chacun passe la garde elle-même.
 */
async function quiTrancheLesRallonges(): Promise<string[]> {
  const roles = [...new Set<UserRole>([
    ...(Object.keys(PERMISSIONS) as UserRole[]).filter((r) => hasGlobalView(r)),
    ...rolesWithModule("RH", "UPDATE"), ...rolesWithModule("BUDGETS", "UPDATE"), ...rolesWithModule("BUDGETS", "VALIDATE"),
  ])];
  const [parRole, parConsole] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(roles) }, select: { id: true, role: true, secondaryRole: true } }),
    prisma.userAccess.findMany({
      where: { user: { isActive: true }, OR: [{ module: "RH", canUpdate: true }, { module: "BUDGETS", OR: [{ canUpdate: true }, { canValidate: true }] }] },
      select: { user: { select: { id: true, role: true, secondaryRole: true } } },
    }),
  ]);
  const candidats = new Map<string, { id: string; role: UserRole; secondaryRole: UserRole | null }>();
  for (const u of [...parRole, ...parConsole.map((a) => a.user)]) candidats.set(u.id, u);
  const ids: string[] = [];
  for (const u of candidats.values()) {
    if (canAllot({ id: u.id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(u.id, u.role) })) ids.push(u.id);
  }
  return ids;
}

/** Prévient ceux qui tranchent les rallonges (`quiTrancheLesRallonges`) — jamais en faisant échouer le geste. */
async function prevenirQuiTranche(input: { type: "VALIDATION_REQUIRED" | "GENERIC"; title: string; body: string; link: string }, sauf?: string): Promise<void> {
  try {
    const ids = await quiTrancheLesRallonges();
    await Promise.all(ids.filter((id) => id !== sauf).map((userId) => notifyUser({ ...input, userId })));
  } catch (e) {
    console.error("[petty-cash] destinataires de la rallonge non prévenus", e);
  }
}

/**
 * REMETTRE UNE SOMME — et c'est tout ce que ça fait.
 *
 * Chaque remise est une LIGNE, avec sa date, sa période, son montant et sa confirmation de
 * réception. Elle s'ajoute au fond ; elle ne clôt pas la précédente et n'ouvre pas un « nouveau
 * mois ». Auparavant, remettre une somme en septembre fusionnait avec la caisse de septembre si
 * elle existait, et faisait sortir de l'écran celle d'août — dont l'argent était pourtant
 * toujours dans le tiroir. On ne peut pas répondre à « qu'a-t-on remis, et quand ? » avec une
 * somme qui s'incrémente : la question a besoin des lignes.
 */
export async function allotPettyCash(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAllot(user)) return { ok: false, error: "Remettre une caisse d'avance est réservé à l'administration." };

  const departmentId = fdStr(formData, "departmentId");
  const holderId = fdStr(formData, "holderId");
  if (!departmentId) return { ok: false, error: "Département non précisé." };
  const period = fdStr(formData, "period") || currentPeriod();
  const amount = normalizeAmount(fdStr(formData, "amount"));
  if (typeof amount !== "number") return { ok: false, error: amount.error };
  if (amount <= 0) return { ok: false, error: "Indiquez la somme remise." };

  const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { name: true, companyId: true } });
  if (!department) return { ok: false, error: "Département introuvable." };

  // À QUI ? La personne nommée sur le formulaire ; à défaut celle qui détient déjà le fond, à
  // défaut celle que les RH ont désignée dans le réglage mensuel. Sans ce repli, une rallonge
  // exigerait de redésigner à chaque fois quelqu'un qui n'a pas changé.
  const ouvertes = await openRemittances(departmentId);
  const plan = await prisma.pettyCashPlan.findUnique({ where: { departmentId }, select: { holderId: true } });
  const holder = holderId || ouvertes.find((r) => r.holderId)?.holderId || plan?.holderId || "";
  if (!holder) return { ok: false, error: "Indiquez à qui la somme est remise." };

  // LE NOM DE LA DÉTENTRICE figure sur l'écriture : « Caisse d'avance — Logistique » sans dire à
  // qui la somme a été remise oblige à rouvrir le module pour lire une ligne de banque.
  const holderName = (await prisma.user.findUnique({ where: { id: holder }, select: { name: true } }))?.name ?? null;

  const premiere = ouvertes.length === 0;

  // ── LA REMISE PASSE PAR LE CENTRE DE PAIEMENT (§118.176) ──────────────────────────────────
  //
  // « La caisse qui est donnée mensuellement aux moyens généraux […] doit dorénavant aussi passer
  // par le centre de paiement et attendre la validation » (la Direction, 01/10/2026). La remise
  // naît donc avec son ORDRE DE DÉPENSE, en attente du centre — et l'écriture de trésorerie ne se
  // pose plus ici : elle se pose au RÈGLEMENT de l'ordre, là où l'argent quitte réellement la
  // banque. L'écrire maintenant, c'était inscrire au livre un décaissement que personne n'avait
  // encore autorisé.
  //
  // L'ordre porte l'entité du DÉPARTEMENT : c'est elle qui engage la dépense, pas celle de la
  // personne qui clique.
  const remise = await prisma.pettyCashAllotment.create({
    data: { departmentId, period, amount, holderId: holder, note: fdStr(formData, "note"), createdById: user.id },
    select: { id: true },
  });
  let ordre: { id: string; reference: string };
  try {
    ordre = await createExpenseOrder(ordreDeRemise({ departement: department, periode: periodLabel(period), amount, holderName, createdById: user.id, nature: "REMISE" }));
  } catch (e) {
    // RIEN N'EST PARTI : une remise sans ordre ne serait ni autorisable ni confirmable.
    await prisma.pettyCashAllotment.delete({ where: { id: remise.id } }).catch(sansBloquer("petty-cash-actions.allotPettyCash.pettyCashAllotment"));
    console.error("[petty-cash] ordre de la remise non créé", e);
    return { ok: false, error: "La remise n'a pas pu partir au centre de paiement — rien n'a été enregistré, réessayez." };
  }
  await prisma.pettyCashAllotment.update({ where: { id: remise.id }, data: { expenseOrderId: ordre.id } });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Budgets",
    entityType: "BUDGET", entityId: departmentId,
    summary: `Caisse d'avance — ${department.name} : ${premiere ? "" : "nouvelle "}remise de ${amount} DZD (${periodLabel(period)}) envoyée au centre de paiement (${ordre.reference})`,
  });
  // LA DÉTENTRICE APPREND CE QUI L'ATTEND — pas « confirmez la réception » d'une somme qui n'est
  // pas partie : elle sera prévenue une seconde fois au versement, et c'est alors qu'elle confirme.
  await notifyUser({
    userId: holder, type: "GENERIC",
    title: premiere ? "Caisse d'avance annoncée" : "Nouvelle remise en caisse d'avance annoncée",
    body: `${amount} DZD demandés au centre de paiement le ${new Date().toLocaleDateString("fr-FR")} — elle s'ajoutera à la caisse dès que le centre l'autorise ; vous en serez prévenue.`,
    link: lienRemiseCaisse(remise.id),
  });
  revalidatePath(PATH);
  revalidatePath("/centre-de-paiement");
  return { ok: true, message: `Remise de ${amount.toLocaleString("fr-FR")} DZD envoyée au centre de paiement (${ordre.reference}) : elle s'ajoutera au fond dès que le centre l'autorise.` };
}

/**
 * CONFIRMER LA RÉCEPTION — par la détentrice, et par elle seule.
 *
 * Tant qu'elle n'a pas confirmé, le solde disponible reste à zéro : afficher un fonds qu'on
 * n'a pas encore en main conduit à engager des dépenses qu'on ne peut pas payer.
 */
export async function confirmPettyCashReceipt(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Caisse non précisée." };
  const cash = await prisma.pettyCashAllotment.findUnique({
    where: { id },
    include: {
      department: { select: { name: true, id: true } },
      expenseOrder: { select: { status: true, centralStatus: true } },
    },
  });
  if (!cash) return { ok: false, error: "Caisse introuvable." };
  if (cash.holderId !== user.id && !hasGlobalView(user)) {
    return { ok: false, error: "Seule la personne à qui la somme a été remise confirme sa réception." };
  }
  // ON NE CONFIRME PAS AVOIR REÇU CE QUI N'EST PAS PARTI (§118.176) : tant que le centre n'a pas
  // autorisé la remise et que les Finances ne l'ont pas versée, il n'y a rien à recevoir. Une
  // remise d'avant la règle (sans ordre) se confirme comme avant.
  const refusAttente = refusConfirmationRemise(etatRemise({
    aUnOrdre: Boolean(cash.expenseOrderId), ordre: cash.expenseOrder, transactionId: cash.transactionId,
  }));
  if (cash.status !== "ALLOTTED") return { ok: false, error: "Cette réception est déjà confirmée." };
  if (refusAttente) return { ok: false, error: refusAttente };

  // SUR L'ÉTAT LU (audit 27/10, reste de DONNEES-06) : une remise soldée entre la lecture et cette écriture ne repasse
  // pas « reçue » — la confirmation réécrivait RECEIVED par-dessus CLOSED et la remise revenait dans le fond.
  const recue = await prisma.pettyCashAllotment.updateMany({
    where: { id, status: "ALLOTTED" },
    data: { status: "RECEIVED", receivedAt: new Date() },
  });
  if (recue.count === 0) return { ok: false, error: "Cette remise vient de changer (confirmée ou soldée) : rouvrez la caisse." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: cash.department.id,
    summary: `Remise en caisse d'avance reçue — ${toNumber(cash.amount)} DZD (${periodLabel(cash.period)})`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * SOLDER LA CAISSE — le fond ENTIER, jamais une remise isolée.
 *
 * Solder, c'est arrêter les comptes : on rend le reliquat, on classe les tickets, on repart de
 * zéro. Ne solder qu'une remise retirerait son montant du fond en y laissant les dépenses
 * imputées sur les autres — un solde qui s'effondre sans qu'une seule dépense n'ait été faite.
 * Il n'y a qu'une caisse : on la solde d'un bloc.
 */
export async function closePettyCash(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Caisse non précisée." };
  const cash = await prisma.pettyCashAllotment.findUnique({ where: { id }, select: { departmentId: true } });
  if (!cash) return { ok: false, error: "Caisse introuvable." };

  const toutes = await openRemittances(cash.departmentId);
  if (toutes.length === 0) return { ok: false, error: "Cette caisse est déjà soldée." };
  if (!toutes.some((r) => r.holderId === user.id) && !canAllot(user)) return { ok: false, error: "Non autorisé." };
  // UNE REMISE QUI ATTEND LE CENTRE NE SE SOLDE PAS AVEC LE FOND (§118.176) : elle n'y est pas
  // encore. La solder ferait verser par les Finances une remise close, que personne ne pourrait
  // plus recevoir — l'argent sortirait de la banque vers une caisse fermée.
  const ouvertes = toutes.filter((r) => !r.enAttenteDuCentre);
  if (ouvertes.length === 0) {
    return { ok: false, error: "Rien à solder : la seule remise en cours attend encore le centre de paiement (ou son versement par les Finances)." };
  }

  // SOLDER SOUS LE VERROU DE LA CAISSE (audit 27/10, reste de DONNEES-06) : la clôture lisait le fond puis écrivait
  // sans verrou ni condition — une dépense saisie au même instant tombait sur une remise close, et deux clôtures
  // simultanées journalisaient deux soldes. Le département se verrouille (comme pour une dépense), le fond se relit
  // dessous, et seules les remises encore ouvertes se closent ; une seconde clôture trouve la caisse déjà soldée.
  const solde = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Department" WHERE id = ${cash.departmentId} FOR UPDATE`;
    const encore = (await openRemittances(cash.departmentId, tx)).filter((r) => !r.enAttenteDuCentre);
    if (encore.length === 0) return null;
    await tx.pettyCashAllotment.updateMany({
      where: { id: { in: encore.map((r) => r.id) }, status: { not: "CLOSED" } },
      data: { status: "CLOSED" },
    });
    return encore;
  });
  if (!solde) return { ok: false, error: "Cette caisse est déjà soldée." };
  const fund = continuousCash(solde);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: cash.departmentId,
    summary: `Caisse d'avance soldée — ${solde.length} remise(s), ${fund.remitted} DZD remis, ${fund.spent} DZD dépensés, reliquat ${fund.remaining} DZD`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * DÉPENSER SUR LA CAISSE — avec justificatif scanné, sans exception.
 *
 * La dépense est déduite du fond ET imputée au budget des moyens généraux : c'est le même
 * argent vu de deux endroits (ce qu'on avait le droit de dépenser, ce qu'on avait en main).
 * L'écrire deux fois séparément, c'était garantir deux totaux différents.
 */
export async function spendFromPettyCash(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cashId = fdStr(formData, "cashId");
  if (!cashId) return { ok: false, error: "Caisse non précisée." };

  const cash = await prisma.pettyCashAllotment.findUnique({
    where: { id: cashId },
    select: { id: true, departmentId: true, period: true },
  });
  if (!cash) return { ok: false, error: "Caisse introuvable." };

  // LE FOND DÉCIDE, PAS LA REMISE. Trois remises de 20 000 paient un achat de 55 000 : c'est le
  // même tiroir. Comparer au montant d'une seule remise refusait la dépense au motif que
  // « septembre ne la couvre pas », alors que l'argent était là.
  const ouvertes = await openRemittances(cash.departmentId);
  if (!ouvertes.some((r) => r.holderId === user.id) && !hasGlobalView(user)) {
    return { ok: false, error: "Seule la personne qui détient la caisse y impute des dépenses." };
  }

  // LE TICKET FAIT LA DÉPENSE. Les articles achetés (catalogue ou saisie libre) donnent le
  // montant : un total saisi à côté du détail finirait par ne plus lui correspondre, et c'est
  // le budget qui deviendrait faux. À défaut de lignes — ancien formulaire, saisie rapide —
  // on retombe sur le couple libellé + montant.
  const rawLines = formData.get("lines");
  const read = await readReceipt(rawLines, fdStr(formData, "label"));
  if ("error" in read && rawLines) return { ok: false, error: read.error };
  const ticket = "error" in read ? null : read;

  const label = ticket ? ticket.label : fdStr(formData, "label");
  if (!label) return { ok: false, error: "Indiquez ce qui a été acheté." };
  const amount = ticket ? ticket.total : normalizeAmount(fdStr(formData, "amount"));
  if (typeof amount !== "number") return { ok: false, error: amount.error };

  const fund = continuousCash(ouvertes);
  const allowed = canSpendFromFund(fund, amount);
  if (!allowed.ok) return { ok: false, error: allowed.reason ?? "Dépense impossible." };
  // La dépense s'inscrit sur la remise EN MAIN la plus récente : le fond est un, mais chaque
  // sortie doit rester rattachée à une remise pour que l'historique se lise.
  const imputeSur = fund.currentId ?? cash.id;

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { ok: false, error: "Scannez la facture ou le bon de paiement : une dépense sans pièce n'est qu'une affirmation." };
  }
  // LA PIÈCE SE JUGE AVANT LA DÉPENSE — le même défaut que `addDepartmentExpense`, par sa seconde
  // porte. Contrôlé après la création, un fichier refusé laissait la dépense en base sans pièce
  // ni audit : sortie du fond et imputée au budget, sans rien qui la justifie, et chaque nouvel
  // essai en ajoutait une. Même règle que toutes les pièces jointes (`validateAttachments`).
  const pieceRefusee = await validateAttachments(files);
  if (pieceRefusee !== null) return { ok: false, error: pieceRefusee };

  const year = normalizeYear(fdStr(formData, "year"));
  // Un achat payé en liquide se classe dans le budget comme les autres : c'est la même dépense,
  // seul le moyen de paiement diffère. La case est revérifiée côté serveur.
  const budgetCategoryId = keepAllowedCategory(fdStr(formData, "budgetCategoryId"), await allowedGeneralMeansCategoryIds());
  // La nature de chaque article se règle AVANT le verrou : l'appel à l'IA ne doit pas tenir la caisse fermée.
  const lignes = ticket
    ? await finaliserNatures(ticket.lines, { userId: user.id, objet: fdStr(formData, "label"), classer: !budgetCategoryId })
    : [];

  // ── LA DÉPENSE EST ATOMIQUE (audit Assistante de direction, 10/2026) ──────────────────────
  //
  // Le contrôle du fond ci-dessus lit le solde, puis la dépense s'écrivait : deux achats envoyés au
  // même instant lisaient chacun « 30 000 en caisse » et passaient tous les deux — la caisse finissait
  // en négatif, ce que la règle interdit précisément. Le fond se RELIT donc sous verrou, dans la
  // transaction qui écrit : le département est verrouillé (`FOR UPDATE`), la seconde dépense attend la
  // première, relit le solde déjà diminué, et se refuse en le disant. Le contrôle d'avant reste — il
  // refuse tôt, avant le dépôt des pièces ; celui-ci tranche.
  const ecrite = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Department" WHERE id = ${cash.departmentId} FOR UPDATE`;
    const sousVerrou = continuousCash(await openRemittances(cash.departmentId, tx));
    const encore = canSpendFromFund(sousVerrou, amount);
    if (!encore.ok) return { ok: false as const, error: encore.reason ?? "Dépense impossible." };
    const depense = await tx.departmentBudgetExpense.create({
      data: {
        departmentId: cash.departmentId,
        year,
        kind: "OPERATING",
        label,
        amount,
        budgetCategoryId,
        notes: fdStr(formData, "notes"),
        pettyCashId: sousVerrou.currentId ?? imputeSur,
        createdById: user.id,
      },
      select: { id: true },
    });
    return { ok: true as const, id: depense.id };
  });
  if (!ecrite.ok) return { ok: false, error: ecrite.error };
  const created = { id: ecrite.id };
  if (ticket) await saveReceiptLines(created.id, lignes);

  for (const file of files) {
    // Fichier au coffre, fiche, inscription à la bibliothèque (J1) — une écriture ratée garde la fiche (métadonnées seules).
    await deposerPieceDeModule(file, { entityType: "DEPARTMENT_EXPENSE", entityId: created.id, category: "INVOICE", confidentiality: "INTERNAL", uploadedById: user.id, journal: "petty-cash" });
  }

  // Le fond baisse : on prévient AVANT d'être à sec, pas une fois bloqué.
  // Relu APRÈS l'écriture : une dépense simultanée compte aussi dans ce qui reste.
  const after = continuousCash(await openRemittances(cash.departmentId));
  if (after.lowOnCash) {
    await prevenirQuiTranche({
      type: "GENERIC",
      title: "Caisse d'avance presque épuisée",
      body: `Il reste ${Math.max(0, after.remaining)} DZD en caisse.`,
      link: lienCaisseAvance(),
    });
  }

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Budgets", entityType: "BUDGET", entityId: cash.departmentId,
    summary: `Dépense sur caisse d'avance — ${label} (${amount} DZD)`,
  });
  revalidatePath(PATH);
  revalidatePath("/budgets/departements");
  return { ok: true, id: created.id };
}

/**
 * DEMANDER UNE RALLONGE — par la détentrice, quand le fond s'épuise.
 *
 * Ce n'est pas une dotation budgétaire : c'est une demande d'ARGENT LIQUIDE, et elle doit
 * pouvoir être ACCORDÉE, REFUSÉE, ou accordée à un AUTRE MONTANT. Une simple notification ne
 * laissait rien à trancher et ne gardait aucune trace de ce qui avait été décidé.
 */
export async function requestPettyCashTopUp(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cashId = fdStr(formData, "cashId");
  if (!cashId) return { ok: false, error: "Caisse non précisée." };
  const cash = await prisma.pettyCashAllotment.findUnique({
    where: { id: cashId },
    select: { id: true, departmentId: true, department: { select: { name: true } } },
  });
  if (!cash) return { ok: false, error: "Caisse introuvable." };
  const ouvertes = await openRemittances(cash.departmentId);
  if (!ouvertes.some((r) => r.holderId === user.id) && !hasGlobalView(user)) return { ok: false, error: "Non autorisé." };

  const amount = normalizeAmount(fdStr(formData, "amount"));
  if (typeof amount !== "number") return { ok: false, error: amount.error };
  if (amount <= 0) return { ok: false, error: "Indiquez le montant demandé." };

  const already = await prisma.pettyCashTopUpRequest.count({
    where: { allotmentId: { in: ouvertes.map((r) => r.id) }, status: "PENDING" },
  });
  if (already > 0) return { ok: false, error: "Une demande de rallonge est déjà en attente sur cette caisse." };

  const reason = fdStr(formData, "reason");
  const demandee = await prisma.pettyCashTopUpRequest.create({
    data: { allotmentId: cashId, amountRequested: amount, reason, requestedById: user.id },
    select: { id: true },
  });

  // CE QUI RESTE, C'EST LE FOND — pas ce qui reste sur la remise à laquelle la demande
  // s'accroche. Celui qui tranche décide sur le tiroir, pas sur une tranche.
  const remaining = continuousCash(ouvertes).remaining;
  await prevenirQuiTranche({
    type: "VALIDATION_REQUIRED",
    title: "Rallonge de caisse d'avance à trancher",
    body: `${cash.department.name} : +${amount} DZD demandés (il reste ${Math.max(0, remaining)} DZD en caisse)${reason ? ` — ${reason}` : ""}`,
    link: lienRallongeCaisse(demandee.id),
  }, user.id);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Budgets", entityType: "BUDGET", entityId: cash.departmentId,
    summary: `Rallonge de caisse demandée : +${amount} DZD`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * RETIRER SA DEMANDE DE RALLONGE (décision de la Direction, 04/10) — tant que les RH ne l'ont pas
 * tranchée. Elle se clôt (`CANCELLED`) par une écriture conditionnelle : une décision croisée
 * l'emporte, et deux clics ne retirent qu'une fois. Ceux qui tranchent sont prévenus.
 */
export async function annulerRallongeCaisse(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const req = await prisma.pettyCashTopUpRequest.findUnique({
    where: { id },
    select: { id: true, status: true, requestedById: true, amountRequested: true, allotment: { select: { departmentId: true, department: { select: { name: true } } } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.requestedById !== user.id) return { ok: false, error: "Seule la personne qui a demandé la rallonge la retire." };
  const refus = refusAnnulationRallonge(req.status);
  if (refus) return { ok: false, error: refus };
  const pris = await prisma.pettyCashTopUpRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
  if (pris.count === 0) return { ok: false, error: "Cette demande vient d'être tranchée — rechargez la page." };
  await prevenirQuiTranche({
    type: "GENERIC",
    title: "Rallonge de caisse retirée",
    body: `${req.allotment.department.name} : la demande de +${toNumber(req.amountRequested)} DZD est retirée par ${user.name} — il n'y a plus rien à trancher.`,
    link: lienRallongeCaisse(id),
  }, user.id);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: req.allotment.departmentId,
    field: "status", oldValue: "PENDING", newValue: "CANCELLED",
    summary: `Rallonge de caisse retirée par sa demandeuse : +${toNumber(req.amountRequested)} DZD`,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Demande de rallonge retirée." };
}

/**
 * TRANCHER LA RALLONGE — les ressources humaines, au montant QU'ELLES écrivent.
 *
 * Accorder exactement ce qui a été demandé serait le cas particulier, pas la règle : les RH
 * ajustent. Le montant retenu est donc celui qu'elles saisissent, et il s'AJOUTE au fonds du
 * mois — ouvrir une seconde caisse rendrait le solde indécidable.
 */
export async function decidePettyCashTopUp(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAllot(user)) return { ok: false, error: "Trancher une rallonge est réservé aux ressources humaines." };
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || (decision !== "APPROVED" && decision !== "REJECTED")) return { ok: false, error: "Décision invalide." };

  const req = await prisma.pettyCashTopUpRequest.findUnique({
    where: { id },
    include: { allotment: { include: { department: { select: { name: true, companyId: true } } } } },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.status !== "PENDING") return { ok: false, error: "Cette demande a déjà été tranchée." };

  const written = fdNum(formData, "amountGranted");
  const granted = decision === "APPROVED"
    ? grantedTopUpAmount({ amountRequested: toNumber(req.amountRequested) }, written)
    : 0;
  if (granted < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const note = fdStr(formData, "note");

  // UNE DÉCISION À LA FOIS : la demande se tranche sur l'état LU — deux accords croisés
  // n'enverraient pas deux rallonges au centre.
  const pris = await prisma.pettyCashTopUpRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: decision,
      amountGranted: decision === "APPROVED" ? granted : null,
      decidedById: user.id, decidedAt: new Date(), decisionNote: note,
    },
  });
  if (pris.count === 0) return { ok: false, error: "Cette demande vient d'être tranchée." };

  let reference: string | null = null;
  if (decision === "APPROVED" && granted > 0) {
    // ── LA RALLONGE PASSE PAR LE CENTRE DE PAIEMENT (§118.202) ─────────────────────────────
    //
    // « La rallonge de caisse doit passer dans le centre de paiement » (la Direction, 04/10/2026).
    // Accordée, elle devient une REMISE comme les autres : son ordre attend le centre, elle rejoint
    // le fond une fois versée, et la détentrice confirme alors sa réception. Elle ne s'écrit plus
    // au livre ici : c'est le règlement de l'ordre qui le fait, là où l'argent quitte la banque.
    const holder = req.allotment.holderId ?? req.requestedById;
    const holderName = holder ? (await prisma.user.findUnique({ where: { id: holder }, select: { name: true } }))?.name ?? null : null;
    let ordre: { id: string; reference: string } | null = null;
    if (holder) {
      const remise = await prisma.pettyCashAllotment.create({
        data: { departmentId: req.allotment.departmentId, period: req.allotment.period, amount: granted, holderId: holder, note: note ?? "Rallonge accordée sur demande", createdById: user.id },
        select: { id: true },
      });
      try {
        ordre = await createExpenseOrder(ordreDeRemise({
          departement: req.allotment.department, periode: periodLabel(req.allotment.period), amount: granted, holderName, createdById: user.id, nature: "RALLONGE",
        }));
        await prisma.pettyCashAllotment.update({ where: { id: remise.id }, data: { expenseOrderId: ordre.id } });
      } catch (e) {
        await prisma.pettyCashAllotment.delete({ where: { id: remise.id } }).catch(sansBloquer("petty-cash-actions.decidePettyCashTopUp.pettyCashAllotment"));
        console.error("[petty-cash] ordre de la rallonge non créé", e);
        ordre = null;
      }
    }
    if (!ordre) {
      // L'accord n'a pas pu partir : la demande redevient à trancher — rien n'a quitté la banque.
      await prisma.pettyCashTopUpRequest.updateMany({
        where: { id, status: "APPROVED", decidedById: user.id },
        data: { status: "PENDING", amountGranted: null, decidedById: null, decidedAt: null, decisionNote: null },
      });
      return { ok: false, error: "La rallonge n'a pas pu partir au centre de paiement — la demande reste à trancher, réessayez." };
    }
    reference = ordre.reference;
  }

  if (req.requestedById) {
    await notifyUser({
      userId: req.requestedById, type: "GENERIC",
      title: decision === "APPROVED" ? "Rallonge accordée" : "Rallonge refusée",
      body: decision === "APPROVED"
        ? `${granted} DZD accordés, envoyés au centre de paiement${reference ? ` (${reference})` : ""} : ils s'ajouteront à la caisse dès que le centre les autorise${note ? ` — ${note}` : ""}`
        : `Demande refusée${note ? ` — ${note}` : ""}`,
      link: lienRallongeCaisse(id),
    });
  }
  await recordAudit({
    actorId: user.id, action: decision === "APPROVED" ? "VALIDATE" : "REFUSE", module: "Budgets",
    entityType: "BUDGET", entityId: req.allotment.departmentId,
    summary: `Rallonge de caisse ${decision === "APPROVED" ? `accordée (${granted} DZD${reference ? `, envoyée au centre de paiement : ${reference}` : ""})` : "refusée"} — ${req.allotment.department.name}`,
  });
  revalidatePath(PATH);
  revalidatePath("/centre-de-paiement");
  return { ok: true, message: reference ? `Rallonge accordée et envoyée au centre de paiement (${reference}) : elle s'ajoutera à la caisse dès que le centre l'autorise.` : undefined };
}

/**
 * RÉGLER LE MONTANT MENSUEL — par les ressources humaines.
 *
 * Sans ce réglage, la caisse dépendait d'un geste dont personne ne se souvenait à date fixe, et
 * l'on ne pouvait prévenir de rien faute de savoir quand le rechargement était attendu. Le jour
 * est borné à 28 : le 31 n'existe pas tous les mois, et une date fantôme ne déclencherait jamais
 * le rappel.
 */
export async function setPettyCashPlan(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAllot(user)) return { ok: false, error: "Régler la caisse mensuelle est réservé aux ressources humaines." };
  const departmentId = fdStr(formData, "departmentId");
  if (!departmentId) return { ok: false, error: "Département non précisé." };
  const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { name: true } });
  if (!department) return { ok: false, error: "Département introuvable." };

  const monthlyAmount = normalizeAmount(fdStr(formData, "monthlyAmount"));
  if (typeof monthlyAmount !== "number") return { ok: false, error: monthlyAmount.error };
  const rechargeDay = normalizeRechargeDay(fdStr(formData, "rechargeDay"));
  const holderId = fdStr(formData, "holderId");
  // ABSENT = actif (un plan qu'on crée sans toucher à la case l'est) ; le témoin caché « 0 » seul =
  // suspendu ; la case cochée (« 0 » PUIS « 1 ») = actif. Lu par `fdStr`, le témoin passait
  // devant la case et suspendait le plan à chaque enregistrement ; sans témoin, décocher ne
  // suspendait rien (§118.172).
  const isActive = fdCase(formData, "isActive") ?? true;

  const data = { monthlyAmount, rechargeDay, holderId, isActive, setById: user.id };
  await prisma.pettyCashPlan.upsert({
    where: { departmentId },
    create: { departmentId, ...data },
    update: data,
  });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: departmentId,
    summary: `Caisse mensuelle réglée — ${department.name} : ${monthlyAmount} DZD le ${rechargeDay} du mois`,
  });
  if (holderId) {
    await notifyUser({
      userId: holderId, type: "GENERIC", title: "Caisse d'avance — réglage mensuel",
      body: `${monthlyAmount} DZD vous seront remis le ${rechargeDay} de chaque mois.`, link: lienCaisseAvance(),
    });
  }
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * RAPPEL AUX RH, 48 H AVANT LE RECHARGEMENT — appelé par le planificateur.
 *
 * Prévenir le jour même ne sert à rien : sortir la somme demande une préparation. Le rappel
 * n'est envoyé qu'UNE fois par échéance (`lastReminderPeriod`), sans quoi le battement du
 * planificateur — qui repasse toutes les minutes — enverrait la même alerte des centaines de
 * fois. La règle elle-même est une fonction pure, testée : voir `shouldRemindRecharge`.
 */
export async function runPettyCashRechargeReminders(now = new Date()): Promise<number> {
  const { shouldRemindRecharge } = await import("@/lib/petty-cash");
  const plans = await prisma.pettyCashPlan
    .findMany({ where: { isActive: true }, include: { department: { select: { name: true } } } })
    .catch(sansBloquer("petty-cash-actions.runPettyCashRechargeReminders.pettyCashPlan", []));
  let sent = 0;
  for (const plan of plans) {
    const r = shouldRemindRecharge(
      { rechargeDay: plan.rechargeDay, isActive: plan.isActive, lastReminderPeriod: plan.lastReminderPeriod },
      now,
    );
    if (!r.due) continue;
    await prevenirQuiTranche({
      type: "GENERIC",
      title: "Caisse d'avance — rechargement dans 48 h",
      body: `${plan.department.name} : ${toNumber(plan.monthlyAmount)} DZD à remettre le ${r.at.toLocaleDateString("fr-FR")}. La remise passe par le centre de paiement : envoyez-la dès maintenant pour qu'elle soit autorisée et versée à temps.`,
      link: lienCaisseAvance(),
    });
    await prisma.pettyCashPlan.update({ where: { id: plan.id }, data: { lastReminderPeriod: r.period } });
    sent += 1;
  }
  return sent;
}

/** La prochaine échéance de rechargement d'un département — pour l'afficher à l'écran. */
export async function nextRechargeFor(departmentId: string, now = new Date()): Promise<Date | null> {
  const plan = await prisma.pettyCashPlan.findUnique({ where: { departmentId }, select: { rechargeDay: true, isActive: true } });
  if (!plan || !plan.isActive) return null;
  return nextRechargeDate(plan.rechargeDay, now);
}
