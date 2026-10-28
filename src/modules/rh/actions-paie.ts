"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { validateUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { enSerie } from "@/lib/refs";
import { formatMonth } from "@/lib/utils";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { createExpenseOrder } from "@/lib/expense-orders";
import { getMyCompanies, entitePermisePourFiche } from "@/lib/company";
import { getBudgetCategoryOptions } from "@/lib/queries/budget";
import {
  entryCost, etatVirement, etatSalaire, virementCouvre, moisDeLEntite, lireSommeAVirer, libelleVirementPaie,
  noteVirementPaie, moisDeLaPaie, deMois, ETAT_VIREMENT_LABEL, SOMME_A_VIRER_MANQUANTE, saisiAvantLeCentre,
  type VirementDuMois, instantDuCentreDePaie, chargerSalairesPartis, decisionRattachement,
  phraseRattachement, validateAmounts, resolvedGross, amendImpact, canAmend,
} from "@/modules/rh/api";
import { docxToPdf, isConvertibleWord, pdfFileName } from "@/lib/payslip/to-pdf";
import { MIME_DOCX } from "@/lib/artifact/adapters/docx/adapter";
import { sansBloquer } from "@/lib/journal";

const PATH = "/rh/paie";
/** Marge avant de notifier l'employé (en cas d'erreur de saisie, les RH peuvent annuler). */
const NOTIFY_DELAY_MS = 24 * 3600 * 1000;

const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

function canRunPayroll(user: Parameters<typeof userCan>[0]): boolean {
  return userCan(user, "RH", "UPDATE");
}

/**
 * DÉPOSER UNE FICHE DE PAIE — en PDF, quel que soit le format d'origine.
 *
 * ── CE QUI SE PASSE ─────────────────────────────────────────────────────────────────────────
 *
 * Un `.docx` est CONVERTI en PDF (`lib/payslip/to-pdf.ts`) ; un PDF reste tel quel ; tout autre
 * format est conservé sans transformation. Le salarié reçoit donc un bulletin qui s'ouvre
 * partout, sans Word, et qui s'affiche dans l'application au lieu d'atterrir sur son disque.
 *
 * ── POURQUOI L'ORIGINAL SURVIT ──────────────────────────────────────────────────────────────
 *
 * La conversion redessine la structure du document ; elle ne le photographie pas. Sur un
 * bulletin, les libellés, les colonnes et les montants arrivent justes, mais la trame, les
 * bordures et le logo se perdent. Seul un œil humain peut dire si le résultat est acceptable —
 * on garde donc le `.docx` de départ, INVISIBLE DU SALARIÉ, pour que les ressources humaines
 * puissent le récupérer sans le redemander. Une conversion qui détruit son entrée est une
 * conversion qu'on ne peut plus contredire.
 *
 * ── ET SI LA CONVERSION ÉCHOUE ? ────────────────────────────────────────────────────────────
 *
 * On dépose le fichier d'origine et l'on continue. Payer un salarié passe avant le format de son
 * bulletin : faire échouer la paie parce qu'un Word est corrompu serait une règle absurde.
 */
async function deposerFicheDePaie(
  employeeId: string,
  file: File,
  period: string,
  uploadedById: string,
): Promise<{ id: string } | { error: string }> {
  const invalid = validateUpload(file.name, file.size, (await getAppSettings()).maxUploadMb);
  if (invalid) return { error: invalid };

  const octets = Buffer.from(await file.arrayBuffer());
  const creer = async (name: string, bytes: Buffer, mime: string, visibleToEmployee: boolean) => {
    const { blobId } = await putBlob(bytes);
    return prisma.employeeDocument.create({
      data: {
        employeeId, category: "PAYSLIP", name, blobId, mime, size: bytes.length,
        period, visibleToEmployee, uploadedById,
      },
      select: { id: true },
    });
  };

  if (isConvertibleWord(file.name, file.type)) {
    const conv = await docxToPdf(octets);
    if (conv.ok) {
      const pdf = await creer(pdfFileName(file.name), conv.pdf, "application/pdf", true);
      // La source, gardée et NON visible du salarié : deux bulletins pour le même mois lui
      // feraient deviner lequel fait foi.
      await creer(`${file.name} (source Word)`, octets, file.type || MIME_DOCX, false).catch(sansBloquer("payroll-hr-actions.deposerFicheDePaie.creer", null));
      return { id: pdf.id };
    }
    // Conversion impossible : on garde le Word plutôt que de bloquer la paie.
    console.warn("[payroll] fiche de paie non convertie, dépôt du Word d'origine :", conv.error);
  }

  const doc = await creer(file.name, octets, file.type || "application/pdf", true);
  return { id: doc.id };
}

/**
 * Marque le salaire d'un employé « Payé » pour un mois : montant total versé +
 * fiche de paie (déposée dans le dossier RH de l'employé, période YYYY-MM).
 * L'employé est notifié 24 h PLUS TARD (marge d'erreur), via les tâches planifiées.
 */
export async function markSalaryPaid(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canRunPayroll(user)) return { ok: false, error: "Réservé aux RH." };
  const employeeId = fdStr(formData, "employeeId");
  const year = fdNum(formData, "year");
  const month = fdNum(formData, "month");
  // COÛT EMPLOYEUR = ce que la société décaisse réellement (brut + charges patronales), et donc
  // le total imputé au BUDGET ; net = salaire affiché au SALARIÉ. Le brut reste une information
  // de bulletin, facultative : c'est le coût employeur qui fait la masse salariale.
  const employerCost = fdNum(formData, "employerCost");
  const gross = fdNum(formData, "gross");
  const net = fdNum(formData, "net");
  if (!employeeId || !year || !month || month < 1 || month > 12) return { ok: false, error: "Paramètres invalides." };
  // Les règles arithmétiques du bulletin vivent dans un module partagé : la CORRECTION les
  // rejoue à l'identique, et une ligne corrigée ne peut donc pas passer un contrôle que la
  // même ligne créée n'aurait pas passé.
  const invalidAmounts = validateAmounts({ employerCost, net, gross });
  if (invalidAmounts) return { ok: false, error: invalidAmounts };

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { fullName: true, companyId: true } });
  // LA PORTE DE LA FICHE (`/rh/[id]`, `updateEmployee`) : la pièce d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!employee || !(await entitePermisePourFiche(user.id, employee.companyId))) return { ok: false, error: "Employé introuvable." };

  const existing = await prisma.payrollEntry.findUnique({ where: { employeeId_year_month: { employeeId, year, month } } });
  if (existing?.status === "PAID") return { ok: false, error: "Ce mois est déjà marqué payé pour cet employé." };

  // Fiche de paie (FACULTATIVE) → si fournie, déposée dans le dossier RH de l'employé
  // (visible par lui). Sinon le mois est marqué payé sans pièce jointe.
  const file = formData.get("payslip");
  let payslipDocumentId: string | null = null;
  if (file instanceof File && file.size > 0) {
    const depot = await deposerFicheDePaie(employeeId, file, ym(year, month), user.id);
    if ("error" in depot) return { ok: false, error: depot.error };
    payslipDocumentId = depot.id;
  }

  const now = new Date();
  const data = {
    // Le brut n'est plus obligatoire : à défaut de saisie, on l'inscrit au coût employeur
    // plutôt que de laisser un 0 qui ferait passer la ligne pour une paie nulle.
    gross: resolvedGross({ employerCost, net, gross }),
    employerCost: employerCost as number,
    net: net as number, status: "PAID" as const, paidDate: now,
    payslipDocumentId,
    employeeNotifyAt: new Date(now.getTime() + NOTIFY_DELAY_MS),
    employeeNotifiedAt: null,
    // Une saisie NEUVE n'est couverte par aucun virement : celui d'un ancien envoi refusé ne la
    // porte plus, et elle partira au prochain (§118.176).
    payrollWireId: null,
    createdById: existing ? undefined : user.id,
  };
  if (existing) await prisma.payrollEntry.update({ where: { id: existing.id }, data });
  else await prisma.payrollEntry.create({ data: { employeeId, year, month, ...data, createdById: user.id } });

  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: "RH", entityType: "PAYROLL",
    summary: `Paie ${ym(year, month)} — ${employee.fullName} : saisie (coût employeur ${data.employerCost.toLocaleString("fr-FR")} · net ${data.net.toLocaleString("fr-FR")} DZD au salarié) — versée au virement de la paie de son entité`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Annule un « Payé » (erreur de saisie) tant que la ligne n'a pas été transférée
 * dans le budget : supprime la fiche déposée et la notification différée si elle
 * n'est pas encore partie.
 */
export async function unmarkSalaryPaid(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canRunPayroll(user)) return { ok: false, error: "Réservé aux RH." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Ligne introuvable." };
  const entry = await prisma.payrollEntry.findUnique({
    where: { id },
    include: {
      employee: { select: { fullName: true, companyId: true } },
      payrollWire: { select: { paidAt: true, expenseOrder: { select: { reference: true, status: true, centralStatus: true } } } },
    },
  });
  // LA PORTE DE LA FICHE (`/rh/[id]`, `updateEmployee`) : la ligne d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!entry || entry.status !== "PAID" || !(await entitePermisePourFiche(user.id, entry.employee.companyId))) return { ok: false, error: "Ligne introuvable." };
  if (entry.budgetTransferredAt) return { ok: false, error: "Déjà transférée dans le budget : annulation impossible ici." };
  // UN SALAIRE ENVOYÉ AU CENTRE NE S'ANNULE PLUS (§118.176) : il fait partie de la somme que le
  // centre autorise — ou que les Finances ont virée. L'annuler laisserait cette somme décrire une
  // paie qui n'existe plus. Il se CORRIGE (bulletin, montants) ; refusé, le virement le libère.
  if (entry.payrollWire) {
    const etat = etatVirement({ paidAt: entry.payrollWire.paidAt, ordre: entry.payrollWire.expenseOrder });
    if (virementCouvre(etat)) {
      const ref = entry.payrollWire.expenseOrder?.reference;
      return {
        ok: false,
        error: `Ce salaire fait partie de la paie ${ETAT_VIREMENT_LABEL[etat]}${ref ? ` (${ref})` : ""} : corrigez la ligne au lieu de l'annuler.`,
      };
    }
  }

  if (entry.payslipDocumentId) {
    const doc = await prisma.employeeDocument.findUnique({ where: { id: entry.payslipDocumentId }, select: { blobId: true } });
    await prisma.employeeDocument.delete({ where: { id: entry.payslipDocumentId } }).catch(sansBloquer("payroll-hr-actions.unmarkSalaryPaid.employeeDocument"));
    if (doc) await releaseBlob(doc.blobId).catch(sansBloquer("payroll-hr-actions.unmarkSalaryPaid.releaseBlob"));
  }
  await prisma.payrollEntry.update({
    where: { id },
    data: { status: "DRAFT", paidDate: null, payslipDocumentId: null, employeeNotifyAt: null, payrollWireId: null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH", entityType: "PAYROLL",
    summary: `Paie ${ym(entry.year, entry.month)} — ${entry.employee.fullName} : paiement annulé (correction)`,
  });
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * ENVOYER LA PAIE D'UNE ENTITÉ AU CENTRE DE PAIEMENT — un bouton par entité (§118.176).
 *
 * « Pour la paie, c'est un bouton pour toute la paie avec mention obligatoire de la somme des
 * salaires à virer. (un bouton par entité) » — la Direction, 01/10/2026.
 *
 * ── CE QUE L'ENVOI FAIT ─────────────────────────────────────────────────────────────────────
 *
 * Il crée l'ORDRE DE DÉPENSE de la paie, en attente du centre : le centre l'autorise, les Finances
 * la virent, et c'est AU RÈGLEMENT qu'une écriture — une seule, de la somme déclarée — entre au
 * livre. Il remplace le « transfert au budget », qui écrivait un décaissement par salarié sans
 * que personne au centre l'ait vu : c'était précisément le chemin que la Direction vient de fermer.
 *
 * Il pose son virement sur les salaires saisis À CE MOMENT-LÀ de cette entité : c'est d'eux que
 * la somme déclarée parle. Un salaire saisi ensuite part dans un COMPLÉMENT — un second envoi,
 * jamais tant que le premier est en cours.
 *
 * ── LA SOMME EST DÉCLARÉE, PAS DEVINÉE ──────────────────────────────────────────────────────
 *
 * Obligatoire, et jamais pré-remplie : c'est l'attestation des RH sur ce qui doit partir. La somme
 * des nets saisis l'accompagne dans la note du centre, avec l'écart s'il y en a un — une prime ou
 * une retenue l'explique, et le centre juge en le voyant.
 *
 * ── DEUX ENVOIS SIMULTANÉS N'EN FONT QU'UN ──────────────────────────────────────────────────
 *
 * Un double clic ferait sinon deux ordres pour la même paie, et le centre pourrait dire oui aux
 * deux. Les envois d'une même entité et d'un même mois passent UN PAR UN (`enSerie`), et chacun
 * relit, dans son tour, ce qui est déjà en cours.
 */
export async function envoyerPaieAuCentre(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canRunPayroll(user)) return { ok: false, error: "Réservé aux RH." };
  const companyId = fdStr(formData, "companyId");
  const year = fdNum(formData, "year");
  const month = fdNum(formData, "month");
  if (!companyId) return { ok: false, error: "Précisez l'entité dont la paie part au centre." };
  if (!year || !month || month < 1 || month > 12) return { ok: false, error: "Mois invalide." };
  const sommeSaisie = fdStr(formData, "amount");
  if (!sommeSaisie) return { ok: false, error: SOMME_A_VIRER_MANQUANTE };
  const somme = lireSommeAVirer(sommeSaisie);
  if (!somme.ok) return { ok: false, error: somme.erreur };

  // L'ENTITÉ DOIT ÊTRE L'UNE DES VÔTRES : envoyer la paie d'une société qu'on ne voit pas, c'est
  // engager son argent sans en avoir le droit.
  const entite = (await getMyCompanies(user.id)).find((c) => c.id === companyId);
  if (!entite) return { ok: false, error: "Cette entité ne vous est pas ouverte : sa paie ne part pas d'ici." };
  const nomEntite = entite.shortName || entite.name;

  // LA CATÉGORIE BUDGÉTAIRE, facultative : sans elle, les Finances classent au règlement. Choisie,
  // elle doit être l'une de celles qui vous sont ouvertes — un identifiant forgé ne classe pas la
  // paie dans l'enveloppe d'un autre.
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  if (budgetCategoryId) {
    const ouvertes = await getBudgetCategoryOptions(undefined, user);
    if (!ouvertes.some((o) => o.id === budgetCategoryId)) {
      return { ok: false, error: "Cette catégorie budgétaire ne vous est pas ouverte." };
    }
  }

  const depuisLeCentre = await instantDuCentreDePaie();
  return enSerie(`paie:${companyId}:${year}-${month}`, async (): Promise<ActionResult> => {
    const [lignes, virements] = await Promise.all([
      prisma.payrollEntry.findMany({
        where: { year, month, status: "PAID", employee: { companyId } },
        select: {
          id: true, status: true, net: true, transactionId: true, budgetTransferredAt: true, paidDate: true, createdAt: true,
          payrollWire: { select: { paidAt: true, expenseOrder: { select: { status: true, centralStatus: true } } } },
        },
      }),
      prisma.payrollWire.findMany({
        where: { companyId, year, month },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, amount: true, createdAt: true, paidAt: true,
          expenseOrder: { select: { reference: true, status: true, centralStatus: true } },
        },
      }),
    ]);
    const salaires = lignes.map((l) => ({
      id: l.id,
      net: Number(l.net),
      etat: etatSalaire({
        status: l.status, transactionId: l.transactionId, budgetTransferredAt: l.budgetTransferredAt,
        virement: l.payrollWire ? etatVirement({ paidAt: l.payrollWire.paidAt, ordre: l.payrollWire.expenseOrder }) : null,
        // Versé par l'ANCIEN circuit (marqué payé avant la bascule) : jamais couvert par un envoi —
        // le renvoyer au centre le paierait deux fois.
        avantLeCentre: saisiAvantLeCentre(l, depuisLeCentre),
      }),
    }));
    const duMois: VirementDuMois[] = virements.map((v) => ({
      id: v.id,
      reference: v.expenseOrder?.reference ?? null,
      montant: Number(v.amount),
      etat: etatVirement({ paidAt: v.paidAt, ordre: v.expenseOrder }),
      envoyeLe: v.createdAt.toISOString(),
      vireLe: v.paidAt ? v.paidAt.toISOString() : null,
    }));
    const mois = moisDeLEntite({ entite: nomEntite, year, month, salaires, virements: duMois });
    if (mois.refus) return { ok: false, error: mois.refus };

    const aCouvrir = salaires.filter((s) => s.etat === "SAISI");
    const wire = await prisma.payrollWire.create({
      data: { companyId, year, month, amount: somme.montant, createdById: user.id },
      select: { id: true },
    });
    let ordre: { id: string; reference: string };
    try {
      ordre = await createExpenseOrder({
        label: libelleVirementPaie(nomEntite, year, month, mois.complement),
        amount: somme.montant,
        category: "SALAIRE",
        beneficiary: `Salariés — ${nomEntite}`,
        sourceType: "PAYROLL",
        sourceId: wire.id,
        requestedById: user.id,
        notes: noteVirementPaie({ declare: somme.montant, salaires: aCouvrir.length, nets: mois.netsAEnvoyer }),
        budgetCategoryId: budgetCategoryId ?? null,
      });
    } catch (e) {
      // RIEN N'EST PARTI : on ne laisse pas un virement sans ordre, qui se lirait « annulé » sans
      // que personne ait rien décidé.
      await prisma.payrollWire.delete({ where: { id: wire.id } }).catch(sansBloquer("payroll-hr-actions.envoyerPaieAuCentre.payrollWire"));
      console.error("[paie] envoi au centre de paiement non abouti", e);
      return { ok: false, error: "L'envoi au centre de paiement n'a pas abouti — rien n'est parti, réessayez." };
    }

    await prisma.$transaction([
      prisma.payrollWire.update({ where: { id: wire.id }, data: { expenseOrderId: ordre.id } }),
      prisma.payrollEntry.updateMany({ where: { id: { in: aCouvrir.map((s) => s.id) } }, data: { payrollWireId: wire.id } }),
    ]);

    const libelleMois = moisDeLaPaie(year, month);
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "RH", entityType: "PAYROLL", entityId: wire.id,
      summary: `${mois.complement ? "Complément de paie" : "Paie"} ${libelleMois} — ${nomEntite} envoyé${mois.complement ? "" : "e"} au centre de paiement (${ordre.reference}) : ${somme.montant.toLocaleString("fr-FR")} DZD déclarés, ${aCouvrir.length} salaire${aCouvrir.length > 1 ? "s" : ""}`,
    });
    revalidatePath(PATH);
    revalidatePath("/centre-de-paiement");
    return {
      ok: true,
      message: mois.complement
        ? `Le complément de paie ${deMois(libelleMois)} de ${nomEntite} est envoyé au centre de paiement (${ordre.reference}). Il sera viré une fois autorisé ; les salariés concernés seront prévenus au virement.`
        : `La paie ${deMois(libelleMois)} de ${nomEntite} est envoyée au centre de paiement (${ordre.reference}). Elle sera virée une fois autorisée ; les salariés seront prévenus au virement.`,
    };
  });
}

/** Au-delà, le lot se fait en plusieurs fois — limite opérationnelle, pas d'architecture. */
const RATTACHEMENT_MAX = 200;

/**
 * RATTACHER À UNE ENTITÉ DES SALARIÉS QUI N'EN ONT PAS — depuis l'écran de la paie, un salarié ou
 * tous d'un geste (Direction, 04/10/2026). Écrit la société de la FICHE SALARIÉ : c'est elle que
 * la paie lit (voir `hr/rattachement-paie.ts`, et pourquoi on n'écrit rien sur les lignes).
 *
 * La garde est celle de l'écran de la paie (RH qui écrit) ; l'entité visée est l'une de celles
 * que le menu propose (`getMyCompanies`) ; l'écriture est CONDITIONNELLE (« encore sans entité ») :
 * un salarié rattaché entre-temps par quelqu'un d'autre garde SON entité et la phrase le nomme. Un
 * salaire déjà parti au nom d'une autre entité REFUSE tout le lot, en le nommant.
 */
export async function rattacherSalariesAEntite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canRunPayroll(user)) return { ok: false, error: "Réservé aux RH." };
  const companyId = fdStr(formData, "companyId");
  if (!companyId) return { ok: false, error: "Choisissez l'entité à laquelle rattacher." };
  const ids = [...new Set(formData.getAll("employeeIds").map((v) => String(v).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucun salarié à rattacher." };
  if (ids.length > RATTACHEMENT_MAX) {
    return { ok: false, error: `${ids.length} salariés d'un coup : au-delà de ${RATTACHEMENT_MAX}, rattachez-les en plusieurs fois.` };
  }

  const entite = (await getMyCompanies(user.id)).find((c) => c.id === companyId);
  if (!entite) return { ok: false, error: "Cette entité ne vous est pas ouverte : on n'y rattache pas un salarié d'ici." };
  const nomCible = entite.shortName || entite.name;

  const fiches = await prisma.employee.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true, companyId: true },
  });
  if (fiches.length !== ids.length) return { ok: false, error: "Salarié introuvable — rechargez la page." };
  // LA PORTE DE LA FICHE (celle de `updateEmployee`) : la fiche d'une société qu'on ne voit pas reste introuvable.
  for (const f of fiches) {
    if (!(await entitePermisePourFiche(user.id, f.companyId))) return { ok: false, error: "Salarié introuvable — rechargez la page." };
  }
  const dejaRattaches = fiches.filter((f) => f.companyId !== null);
  const aRattacher = fiches.filter((f) => f.companyId === null);
  if (aRattacher.length === 0) {
    return { ok: false, error: `${dejaRattaches.length > 1 ? "Ces salariés ont" : "Ce salarié a"} déjà une entité — rien à rattacher. Rechargez la page.` };
  }

  // CE QUI EST DÉJÀ PARTI — lu sur chaque salaire payé, par la MÊME règle que l'écran et l'envoi.
  const { partisParSalarie, saisisParSalarie } = await chargerSalairesPartis(aRattacher.map((f) => f.id));
  const societes = await prisma.company.findMany({ select: { id: true, name: true, shortName: true } });
  const nomDe = new Map(societes.map((c) => [c.id, c.shortName || c.name]));
  const decision = decisionRattachement(
    aRattacher.map((f) => ({ id: f.id, nom: f.fullName, salairesPartis: partisParSalarie.get(f.id) ?? [] })),
    { id: companyId, nom: nomCible },
    (id) => nomDe.get(id) ?? "une entité supprimée",
  );
  if (!decision.ok) return { ok: false, error: decision.refus };

  // L'ÉCRITURE CONDITIONNELLE, salarié par salarié : on sait ainsi lesquels ont réellement bougé.
  const rattaches = await prisma.$transaction(async (tx) => {
    const faits: { id: string; nom: string }[] = [];
    for (const f of aRattacher) {
      const r = await tx.employee.updateMany({ where: { id: f.id, companyId: null }, data: { companyId } });
      if (r.count === 1) faits.push({ id: f.id, nom: f.fullName });
    }
    return faits;
  });
  if (rattaches.length === 0) {
    return { ok: false, error: "Rattachés entre-temps par quelqu'un d'autre — rien n'a été modifié ici. Rechargez la page." };
  }
  const bouges = new Set(rattaches.map((r) => r.id));
  const ancienCircuit = aRattacher
    .filter((f) => bouges.has(f.id))
    .reduce((a, f) => a + (partisParSalarie.get(f.id) ?? []).filter((p) => p.companyId === null).length, 0);
  for (const r of rattaches) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: r.id,
      field: "companyId", oldValue: null, newValue: companyId,
      summary: `Fiche de ${r.nom} rattachée à ${nomCible} depuis l'écran de la paie (elle n'avait pas d'entité)`,
    });
  }
  revalidatePath(PATH);
  revalidatePath("/rh");
  return {
    ok: true,
    message: phraseRattachement({
      noms: rattaches.map((r) => r.nom),
      cible: nomCible,
      saisis: rattaches.reduce((a, r) => a + (saisisParSalarie.get(r.id) ?? 0), 0),
      ancienCircuit,
      dejaRattaches: fiches.filter((f) => !bouges.has(f.id)).map((f) => f.fullName),
    }),
  };
}

/**
 * CORRIGER UNE LIGNE DE PAIE DÉJÀ FAITE — montants, fiche de paie, y compris après transfert.
 *
 * Jusqu'ici un mois marqué payé ne se corrigeait pas : on ne pouvait que l'ANNULER en entier,
 * et seulement avant le transfert au budget. Une erreur de mille dinars sur un net obligeait
 * donc à défaire la ligne puis à tout ressaisir — ce que personne ne fait un vendredi soir.
 * On la laissait fausse, et la masse salariale avec.
 *
 * APRÈS LE TRANSFERT, la correction ne s'arrête pas à la ligne : elle suit jusqu'à l'écriture
 * de trésorerie créée par le transfert. Sinon la paie dit un montant et le budget en dit un
 * autre, et l'on découvre l'écart en fin d'exercice sans savoir lequel des deux a raison.
 *
 * La FICHE DE PAIE se remplace : la nouvelle prend la place de l'ancienne dans le dossier de
 * l'employé, et l'ancienne est libérée. Empiler deux bulletins pour le même mois dans le
 * dossier d'un salarié, c'est lui laisser deviner lequel fait foi.
 */
export async function updatePayrollEntry(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canRunPayroll(user)) return { ok: false, error: "Réservé aux RH." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Ligne introuvable." };

  const entry = await prisma.payrollEntry.findUnique({
    where: { id },
    include: {
      employee: { select: { fullName: true, companyId: true } },
      payrollWire: { select: { paidAt: true, expenseOrder: { select: { reference: true, status: true, centralStatus: true } } } },
    },
  });
  // LA PORTE DE LA FICHE (`/rh/[id]`, `updateEmployee`) : la pièce d'une société qu'on ne voit pas reste introuvable (audit 27/10).
  if (!entry || !(await entitePermisePourFiche(user.id, entry.employee.companyId))) return { ok: false, error: "Ligne introuvable." };
  const allowed = canAmend(entry);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  const employerCost = fdNum(formData, "employerCost");
  const net = fdNum(formData, "net");
  const gross = fdNum(formData, "gross");
  const invalid = validateAmounts({ employerCost, net, gross });
  if (invalid) return { ok: false, error: invalid };

  const before = { employerCost: Number(entry.employerCost ?? entry.gross), net: Number(entry.net) };
  const after = { employerCost: employerCost as number, net: net as number };
  const impact = amendImpact(before, after, { transferred: Boolean(entry.budgetTransferredAt) });

  // La fiche de paie REMPLACE la précédente, elle ne s'y ajoute pas.
  const file = formData.get("payslip");
  let payslipDocumentId = entry.payslipDocumentId;
  if (file instanceof File && file.size > 0) {
    const depot = await deposerFicheDePaie(entry.employeeId, file, ym(entry.year, entry.month), user.id);
    if ("error" in depot) return { ok: false, error: depot.error };
    const fresh = depot;
    if (entry.payslipDocumentId) {
      const old = await prisma.employeeDocument.findUnique({ where: { id: entry.payslipDocumentId }, select: { blobId: true } });
      await prisma.employeeDocument.delete({ where: { id: entry.payslipDocumentId } }).catch(sansBloquer("payroll-hr-actions.updatePayrollEntry.employeeDocument"));
      if (old) await releaseBlob(old.blobId).catch(sansBloquer("payroll-hr-actions.updatePayrollEntry.releaseBlob"));
    }
    payslipDocumentId = fresh.id;
  }

  await prisma.payrollEntry.update({
    where: { id },
    data: {
      employerCost: after.employerCost,
      net: after.net,
      gross: resolvedGross({ employerCost, net, gross }),
      payslipDocumentId,
    },
  });

  // LE BUDGET SUIT. Sans cette reprise, la ligne corrigée et l'écriture de trésorerie
  // divergeraient en silence.
  if (impact.syncBudget && entry.transactionId) {
    await prisma.financeTransaction.update({
      where: { id: entry.transactionId },
      data: {
        amount: entryCost({
          employerCost: after.employerCost,
          gross: Number(entry.gross), bonuses: Number(entry.bonuses), deductions: Number(entry.deductions),
        }),
        label: `Salaire ${ym(entry.year, entry.month)} — ${entry.employee.fullName} (coût employeur, corrigé)`,
      },
    }).catch(sansBloquer("payroll-hr-actions.updatePayrollEntry.financeTransaction"));
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "RH", entityType: "PAYROLL", entityId: id,
    summary: `Paie ${formatMonth(ym(entry.year, entry.month))} — ${entry.employee.fullName} : ${impact.summary}${impact.syncBudget ? " · écriture budgétaire corrigée" : ""}`,
  });
  revalidatePath(PATH);
  if (impact.syncBudget) { revalidatePath("/finances"); revalidatePath("/budgets"); }
  // UN SALAIRE DÉJÀ ENVOYÉ AU CENTRE SE CORRIGE — le virement, lui, ne bouge pas (§118.176) : il
  // porte la somme que les RH ont déclarée et que le centre a vue (ou que les Finances ont virée).
  // Le dire évite de croire que la banque a suivi la correction.
  const virement = entry.payrollWire
    ? { etat: etatVirement({ paidAt: entry.payrollWire.paidAt, ordre: entry.payrollWire.expenseOrder }), ref: entry.payrollWire.expenseOrder?.reference ?? null }
    : null;
  if (virement && virementCouvre(virement.etat)) {
    return {
      ok: true,
      message: `Ligne corrigée. La paie ${ETAT_VIREMENT_LABEL[virement.etat]}${virement.ref ? ` (${virement.ref})` : ""} n'est pas modifiée : elle porte la somme déclarée à l'envoi.`,
    };
  }
  return { ok: true, message: impact.syncBudget ? "Ligne et écriture budgétaire corrigées." : "Ligne corrigée." };
}
