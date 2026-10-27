"use server";

import { revalidatePath } from "next/cache";
import { FinanceCategory, FinanceMethod, type FinanceDirection, type FinanceStatus, type PayrollStatus, type Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { anyRoleFilter, userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildRef, nextRefNumber } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { broadcastNotification } from "@/lib/notify";
import { entiteParDefaut } from "@/lib/company-defaut";
import { fdStr, fdNum, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { getMyCompanies, companyScopedWhere } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { compteDeLEcriture, comptesTresorerie } from "@/lib/finance/comptes";
import { resoudreCompte } from "@/lib/finance/tresorerie";
import { relierALaPersonne } from "@/lib/referentiels/personnes/double-ecriture";

const IN_CATEGORIES = ["RECETTE", "CCA", "PRET"];

async function nextRef(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.financeTransaction.findMany({ where: { reference: { startsWith: `${prefix}-${year}-` } }, select: { reference: true } });
  return buildRef(prefix, year, refs.map((r) => r.reference));
}

export async function createTransaction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };

  const label = fdStr(formData, "label");
  const amount = fdNum(formData, "amount");
  const category = (fdStr(formData, "category") as FinanceCategory) ?? "AUTRE";
  if (!label || amount === null) return { ok: false, error: "Libellé et montant obligatoires." };

  const direction = (fdStr(formData, "direction") as FinanceDirection) ??
    (IN_CATEGORIES.includes(category) ? "IN" : "OUT");

  // Référence SAISIE acceptée (les encaissements portent souvent celle du reçu ou du virement) ;
  // à défaut, on continue de la générer. Une référence déjà prise repart en auto plutôt que de
  // faire échouer la saisie sur une contrainte d'unicité.
  const wanted = fdStr(formData, "reference");
  const free = wanted ? (await prisma.financeTransaction.count({ where: { reference: wanted } })) === 0 : false;

  const created = await prisma.financeTransaction.create({
    data: {
      reference: free && wanted ? wanted : await nextRef("FIN"),
      date: fdDate(formData, "date") ?? new Date(),
      direction,
      category,
      label,
      amount: Math.abs(amount),
      method: (fdStr(formData, "method") as FinanceMethod) ?? "BANK_TRANSFER",
      account: fdStr(formData, "account") ?? "Banque",
      counterparty: fdStr(formData, "counterparty"),
      invoiceRef: fdStr(formData, "invoiceRef"),
      status: (fdStr(formData, "status") as FinanceStatus) ?? "SETTLED",
      notes: fdStr(formData, "notes"),
      companyId: fdStr(formData, "companyId") || null,
      // LE COMPTE SE FIGE À L'ÉCRITURE (§118.176) : celui qui a été choisi, sinon la règle.
      treasuryAccountId: await compteDeLEcriture({
        compteId: fdStr(formData, "treasuryAccountId"), compte: fdStr(formData, "account") ?? "Banque", societeId: fdStr(formData, "companyId") || null,
      }),
      createdById: user.id,
    },
  });

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Finances",
    entityType: "FINANCE_TRANSACTION", entityId: created.id,
    summary: `${direction === "IN" ? "Encaissement" : "Décaissement"} ${created.reference} — ${label}`,
  });
  revalidatePath("/finances");
  return { ok: true, id: created.id };
}

export async function updateTransactionStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as FinanceStatus;
  if (!id || !status) return { ok: false, error: "Paramètres manquants." };
  await prisma.financeTransaction.update({ where: { id }, data: { status } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "FINANCE_TRANSACTION",
    entityId: id, field: "status", newValue: status, summary: "Statut de transaction mis à jour",
  });
  revalidatePath("/finances");
  return { ok: true };
}

/**
 * Modifie une écriture du livre comptable (tous champs sauf la référence, qui reste stable).
 * Réservé à qui peut mettre à jour les Finances. La consommation budgétaire et la trésorerie
 * se recalculent automatiquement à partir des champs mis à jour.
 */
export async function updateTransaction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const label = fdStr(formData, "label");
  const amount = fdNum(formData, "amount");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  if (!label || amount === null) return { ok: false, error: "Libellé et montant obligatoires." };
  const category = (fdStr(formData, "category") as FinanceCategory) ?? "AUTRE";
  const direction = (fdStr(formData, "direction") as FinanceDirection) ??
    (IN_CATEGORIES.includes(category) ? "IN" : "OUT");

  await prisma.financeTransaction.update({
    where: { id },
    data: {
      date: fdDate(formData, "date") ?? undefined,
      direction,
      category,
      label,
      amount: Math.abs(amount),
      method: (fdStr(formData, "method") as FinanceMethod) ?? "BANK_TRANSFER",
      account: fdStr(formData, "account") ?? "Banque",
      counterparty: fdStr(formData, "counterparty"),
      invoiceRef: fdStr(formData, "invoiceRef"),
      status: (fdStr(formData, "status") as FinanceStatus) ?? "SETTLED",
      notes: fdStr(formData, "notes"),
      // Le compte FIGÉ ne bouge que si le formulaire en NOMME un : corriger un libellé ne doit pas
      // faire changer de compte un paiement déjà rattaché (§118.152c, §118.176).
      ...(formData.has("treasuryAccountId") ? { treasuryAccountId: fdStr(formData, "treasuryAccountId") || null } : {}),
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", entityType: "FINANCE_TRANSACTION",
    entityId: id, summary: `Écriture modifiée — ${label}`,
  });
  revalidatePath("/finances");
  return { ok: true };
}

/** Supprime définitivement une écriture du livre comptable (trésorerie recalculée). */
export async function deleteTransaction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "DELETE")) return { ok: false, error: "Suppression non autorisée." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const tx = await prisma.financeTransaction.findUnique({ where: { id }, select: { reference: true, label: true } });
  if (!tx) return { ok: false, error: "Écriture introuvable." };
  // Un bulletin de paie réglé peut pointer cette écriture : on délie proprement (repasse en non réglé).
  await prisma.payrollEntry.updateMany({ where: { transactionId: id }, data: { transactionId: null, status: "VALIDATED", paidDate: null } }).catch(() => {});
  await prisma.financeTransaction.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Finances", entityType: "FINANCE_TRANSACTION",
    entityId: id, summary: `Écriture supprimée — ${tx.reference} · ${tx.label}`,
  });
  revalidatePath("/finances");
  return { ok: true };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IMPORT D'UN RELEVÉ NE COMPTE QUE CE QUI EST ÉCRIT — ET DIT CE QU'IL ÉCARTE, LIGNE PAR LIGNE.
 *
 * Le défaut mesuré : chaque écriture s'achevait par `.catch(() => undefined); n += 1`. Une ligne
 * que la base refusait (une date que `new Date` ne lisait pas, une catégorie ou un mode de
 * paiement hors de l'énumération) était COMPTÉE ; l'audit annonçait « N transactions
 * importées », l'action rendait `{ ok: true }` sans un mot, et l'écran affichait « Import
 * réussi. » — le faux succès parfait, sur des mouvements de trésorerie. Les lignes sautées plus
 * haut (colonnes manquantes, montant illisible) disparaissaient de la même façon.
 *
 * Désormais : seule une écriture qui a RÉUSSI compte ; chaque ligne écartée garde son NUMÉRO dans
 * le texte collé et sa RAISON ; le bilan les nomme (borné, le reste compté, §118.60) ; rien
 * d'importé est un refus, pas un succès vide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le bilan d'un import : le message nomme les lignes écartées, le compte dit à l'écran s'il en reste. */
export type ResultatImport = ActionResult & { ecartees?: number };

/** Les valeurs que le relevé peut porter — lues dans l'énumération du schéma, pas recopiées. */
const CATEGORIES_RECONNUES: readonly string[] = Object.values(FinanceCategory);
const MODES_RECONNUS: readonly string[] = Object.values(FinanceMethod);
const FORMATS_DATE = "attendu AAAA-MM-JJ ou JJ/MM/AAAA";
/** Au plus huit lignes NOMMÉES dans le bilan : au-delà, le compte du reste. */
const LIGNES_DITES = 8;

type LigneReleve =
  | {
      ok: true;
      date: Date; direction: FinanceDirection; category: FinanceCategory; label: string;
      amount: number; method: FinanceMethod; account: string; counterparty: string | null;
    }
  | { ok: false; raison: string };

interface LigneEcartee { numero: number; raison: string }

/**
 * LA DATE D'UNE LIGNE — lue à coup sûr, ou pas du tout.
 *
 * `new Date(texte)` lisait « 06/01/2026 » comme le 1er JUIN (l'ordre américain) et faisait de
 * « 28/09/2026 » une date invalide que la base refusait ensuite. Deux formes seulement : celle de
 * l'exemple (AAAA-MM-JJ) et celle d'ici (JJ/MM/AAAA). Une date qui n'existe pas (31/02) est
 * illisible, pas « reportée » au mois suivant.
 */
function dateDuReleve(brut: string): Date | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(brut);
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(brut);
  const parties = iso ? [iso[1], iso[2], iso[3]] : fr ? [fr[3], fr[2], fr[1]] : null;
  if (parties === null) return null;
  const [a, m, j] = parties.map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j ? d : null;
}

/** Une ligne du relevé, lue colonne par colonne — ou écartée avec la raison exacte. */
function lireLigneReleve(colonnes: string[]): LigneReleve {
  if (colonnes.length < 5) return { ok: false, raison: `colonnes manquantes (${colonnes.length} lue${colonnes.length > 1 ? "s" : ""}, 5 au moins)` };
  const [date, direction, category, label, amount, method, account, counterparty] = colonnes;
  // Pas de date, pas de mouvement : l'inscrire « aujourd'hui » fabriquerait une date que le relevé
  // ne dit pas — et le solde d'un compte ancré ne compte que les écritures POSTÉRIEURES à son
  // ancrage (§118.176).
  if (date === "") return { ok: false, raison: "date absente" };
  const quand = dateDuReleve(date);
  if (quand === null) return { ok: false, raison: `date illisible « ${date} » (${FORMATS_DATE})` };
  if (label === "") return { ok: false, raison: "libellé absent" };
  const montantBrut = (amount ?? "").replace(/\s/g, "").replace(",", ".");
  const montant = Number(montantBrut);
  // `Number("")` vaut 0 : une colonne vide devenait un mouvement de 0 DZD.
  if (montantBrut === "") return { ok: false, raison: "montant absent" };
  if (!Number.isFinite(montant)) return { ok: false, raison: `montant illisible « ${amount} »` };
  // Une colonne VIDE garde le défaut annoncé ; une valeur hors de l'énumération est écartée, jamais
  // rangée d'office ailleurs.
  const categorie = (category || "AUTRE").toUpperCase();
  if (!CATEGORIES_RECONNUES.includes(categorie)) return { ok: false, raison: `catégorie inconnue « ${category} »` };
  const mode = (method || "BANK_TRANSFER").toUpperCase();
  if (!MODES_RECONNUS.includes(mode)) return { ok: false, raison: `mode de paiement inconnu « ${method} »` };
  const sens = (direction ?? "").toUpperCase();
  return {
    ok: true,
    date: quand,
    direction: (sens === "IN" ? "IN" : sens === "OUT" ? "OUT" : IN_CATEGORIES.includes(categorie) ? "IN" : "OUT") as FinanceDirection,
    category: categorie as FinanceCategory,
    label,
    amount: Math.abs(montant),
    method: mode as FinanceMethod,
    account: account || "Banque",
    counterparty: counterparty || null,
  };
}

/** « 2 mouvements importés ; 1 ligne écartée : ligne 4 — … » — accordé, borné, et le remède dit. */
function bilanImport(importes: number, ecartees: LigneEcartee[]): string {
  const s = (n: number): string => (n > 1 ? "s" : "");
  const tete = importes === 0 ? "Aucun mouvement importé" : `${importes} mouvement${s(importes)} importé${s(importes)}`;
  const k = ecartees.length;
  if (k === 0) return `${tete}.`;
  const dites = ecartees.slice(0, LIGNES_DITES).map((e) => `ligne ${e.numero} — ${e.raison}`).join(" ; ");
  const reste = k > LIGNES_DITES ? ` ; et ${k - LIGNES_DITES} autre${s(k - LIGNES_DITES)}` : "";
  const aide: string[] = [];
  if (ecartees.some((e) => e.raison.startsWith("catégorie inconnue"))) aide.push(`Catégories reconnues : ${CATEGORIES_RECONNUES.join(", ")}.`);
  if (ecartees.some((e) => e.raison.startsWith("mode de paiement inconnu"))) aide.push(`Modes reconnus : ${MODES_RECONNUS.join(", ")}.`);
  // Le texte collé contient encore les lignes passées : le réimporter tel quel les doublerait.
  if (importes > 0) aide.push("Les lignes importées sont enregistrées : ne réimportez que les lignes corrigées.");
  return [`${tete} ; ${k} ligne${s(k)} écartée${s(k)} : ${dites}${reste}.`, ...aide].join(" ");
}

/** CSV import: date,direction(IN/OUT),category,label,amount,method,account,counterparty */
export async function importTransactions(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ResultatImport> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };
  const csv = fdStr(formData, "csv");
  if (!csv) return { ok: false, error: "Aucune donnée." };

  // Chaque ligne garde son NUMÉRO dans le texte collé — l'en-tête est la ligne 1, et une ligne vide
  // au milieu compte : c'est ce numéro que la personne cherche pour corriger une ligne écartée.
  const nonVides = csv.split(/\r?\n/).map((texte, i) => ({ texte: texte.trim(), numero: i + 1 })).filter((l) => l.texte.length > 0);
  const lignes = nonVides.slice(1);
  if (lignes.length === 0) return { ok: false, error: "Aucune ligne à importer : la première ligne est l'en-tête des colonnes, et rien ne la suit." };
  // Le séparateur se lit sur l'EN-TÊTE. Un tableur français sépare par « ; » et écrit ses
  // décimales avec une virgule : couper AUSSI sur la virgule décalait les colonnes — « 90000,50 »
  // devenait un montant de 90 000 et un mode de paiement « 50 ».
  const separateur = nonVides[0].texte.includes(";") ? ";" : ",";

  let n = 0;
  const ecartees: LigneEcartee[] = [];
  const year = new Date().getFullYear();
  const existingRefs = await prisma.financeTransaction.findMany({ where: { reference: { startsWith: `FIN-${year}-` } }, select: { reference: true } });
  let base = nextRefNumber(existingRefs.map((r) => r.reference)) - 1; // prochain = base+1 (dérivé du max, robuste aux trous)
  const comptes = await comptesTresorerie();
  for (const { texte, numero } of lignes) {
    const lue = lireLigneReleve(texte.split(separateur).map((x) => x.trim()));
    if (!lue.ok) { ecartees.push({ numero, raison: lue.raison }); continue; }
    base += 1;
    try {
      await prisma.financeTransaction.create({
        data: {
          reference: `FIN-${year}-${String(base).padStart(3, "0")}`,
          date: lue.date,
          direction: lue.direction,
          category: lue.category,
          label: lue.label,
          amount: lue.amount,
          method: lue.method,
          account: lue.account,
          counterparty: lue.counterparty,
          status: "SETTLED",
          // La colonne « compte » du relevé désigne le compte par son NOM ; sinon la règle (§118.176).
          treasuryAccountId: resoudreCompte(comptes, { compte: lue.account, societeId: null }),
          createdById: user.id,
        },
      });
      n += 1;
    } catch (err) {
      // Une ligne que la base refuse n'est PAS importée : la compter annoncerait un mouvement qui
      // n'existe nulle part.
      console.error(`[finances] import CSV — ligne ${numero} refusée par la base`, err);
      ecartees.push({ numero, raison: "écriture refusée par la base" });
    }
  }
  // Rien d'écrit n'est pas un succès vide : c'est un refus, qui dit pourquoi pour chaque ligne.
  if (n === 0) return { ok: false, error: bilanImport(0, ecartees) };
  const k = ecartees.length;
  await recordAudit({
    actorId: user.id, action: "IMPORT", module: "Finances",
    summary: `Import CSV — ${n} mouvement${n > 1 ? "s" : ""} importé${n > 1 ? "s" : ""}${k > 0 ? `, ${k} ligne${k > 1 ? "s" : ""} écartée${k > 1 ? "s" : ""}` : ""}`,
  });
  revalidatePath("/finances");
  return { ok: true, message: bilanImport(n, ecartees), ecartees: k };
}

// ── Comptes de trésorerie ANCRÉS (§118.176) ──

/** Un RIB algérien : vingt chiffres (banque, agence, compte, clé). Un IBAN étranger passe tel quel. */
function lireRib(brut: string | null): { ok: true; rib: string | null } | { ok: false; error: string } {
  if (!brut) return { ok: true, rib: null };
  const net = brut.replace(/[\s.-]/g, "").toUpperCase();
  if (/^\d+$/.test(net)) {
    return net.length === 20 ? { ok: true, rib: net } : { ok: false, error: `Un RIB algérien compte 20 chiffres — celui-ci en a ${net.length}.` };
  }
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(net) ? { ok: true, rib: net } : { ok: false, error: "RIB illisible : 20 chiffres (RIB algérien) ou un IBAN." };
}

/** L'entité titulaire doit être une entité que la personne voit — un compte ne s'ouvre pas au nom d'une autre. */
async function entiteOuverte(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true;
  return (await getMyCompanies(userId)).some((c) => c.id === companyId);
}

/**
 * UN SEUL COMPTE PRINCIPAL PAR ENTITÉ — et le changement se DIT. Désigner un nouveau principal
 * retire ce rôle à l'ancien, dans la même écriture, et la phrase le nomme : un changement silencieux
 * déciderait d'où partent les paiements à venir sans que personne l'ait lu. Les écritures passées ne
 * bougent pas : chacune a figé son compte en s'écrivant.
 */
async function retirerLesAutresPrincipaux(tx: Prisma.TransactionClient, companyId: string | null, saufId: string): Promise<string[]> {
  const autres = await tx.treasuryAccount.findMany({ where: { principal: true, companyId, id: { not: saufId } }, select: { id: true, name: true } });
  if (autres.length > 0) await tx.treasuryAccount.updateMany({ where: { id: { in: autres.map((a) => a.id) } }, data: { principal: false } });
  return autres.map((a) => a.name);
}

/**
 * OUVRIR UN COMPTE DE TRÉSORERIE — et rien d'autre.
 *
 * « SGA Birkhadem, compte Adventum, 2 966 153 DZD au 28/09/2026 » : un compte naît ANCRÉ — un solde
 * de relevé à une date, en fin de journée. L'ancien geste était un « upsert » sur le nom : rouvrir
 * « Banque » réécrivait son ouverture en silence, et l'on ne savait plus d'où partait le solde
 * affiché. Un nom déjà pris est REFUSÉ, et le refus nomme le geste qui corrige : l'ancrage se
 * corrige à part, avec un motif.
 */
export async function setTreasuryOpeningBalance(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const name = (fdStr(formData, "name") ?? "").trim();
  if (!name) return { ok: false, error: "Nom du compte obligatoire." };
  const openingBalance = fdNum(formData, "openingBalance");
  if (openingBalance === null || !Number.isFinite(openingBalance)) return { ok: false, error: "Indiquez le solde du relevé à la date d'ancrage (0 accepté)." };
  const openingDate = fdDate(formData, "openingDate");
  if (!openingDate) return { ok: false, error: "Indiquez la date du relevé : le solde s'entend en fin de cette journée." };
  const rib = lireRib(fdStr(formData, "rib"));
  if (!rib.ok) return { ok: false, error: rib.error };
  const companyId = fdStr(formData, "companyId") || null;
  if (!(await entiteOuverte(user.id, companyId))) return { ok: false, error: "Entité introuvable ou hors de votre périmètre." };
  const principal = fdCase(formData, "principal") === true;

  const existant = await prisma.treasuryAccount.findUnique({ where: { name }, select: { id: true } });
  if (existant) {
    return { ok: false, error: `Le compte « ${name} » existe déjà : son ancrage ne se réécrit pas par une ouverture. Corrigez-le depuis « Corriger l'ancrage », avec un motif.` };
  }

  const { compte, retires } = await prisma.$transaction(async (tx) => {
    const cree = await tx.treasuryAccount.create({
      data: {
        name, openingBalance, openingDate, notes: fdStr(formData, "notes"), bank: fdStr(formData, "bank"), rib: rib.rib,
        companyId, principal, createdById: user.id, updatedById: user.id,
      },
      select: { id: true },
    });
    const retires = principal ? await retirerLesAutresPrincipaux(tx, companyId, cree.id) : [];
    return { compte: cree, retires };
  });
  const jour = openingDate.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Finances",
    summary: `Compte de trésorerie « ${name} » ouvert — ancré à ${openingBalance.toLocaleString("fr-FR")} DZD au ${jour}${principal ? " (compte principal)" : ""}${retires.length ? ` ; ${retires.join(", ")} cesse d'être principal` : ""}`,
  });
  revalidatePath("/finances");
  return {
    ok: true, id: compte.id,
    message: `Compte « ${name} » ouvert : ${openingBalance.toLocaleString("fr-FR")} DZD au ${jour}.${retires.length ? ` ${retires.join(", ")} n'est plus le compte principal.` : ""}`,
  };
}

/**
 * MODIFIER UN COMPTE — libellé, banque, RIB, entité, compte principal, notes. JAMAIS l'ancrage :
 * il se corrige à part, avec un motif (`corrigerAncrageTresorerie`). Seules les clés PRÉSENTES
 * s'écrivent : un formulaire qui ne porte pas le RIB ne l'efface pas (§118.152c).
 */
export async function modifierCompteTresorerie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Compte non précisé." };
  const avant = await prisma.treasuryAccount.findFirst({ where: await companyScopedWhere(user.id, { id }), select: { id: true, name: true, companyId: true, principal: true } });
  if (!avant) return { ok: false, error: "Compte introuvable." };

  const data: Prisma.TreasuryAccountUpdateInput = {};
  const changes: string[] = [];
  if (formData.has("name")) {
    const name = (fdStr(formData, "name") ?? "").trim();
    if (!name) return { ok: false, error: "Nom du compte obligatoire." };
    if (name !== avant.name) {
      if (await prisma.treasuryAccount.count({ where: { name, id: { not: id } } })) return { ok: false, error: `Un compte « ${name} » existe déjà.` };
      data.name = name;
      changes.push(`nom « ${avant.name} » → « ${name} »`);
    }
  }
  if (formData.has("bank")) data.bank = fdStr(formData, "bank");
  if (formData.has("rib")) {
    const rib = lireRib(fdStr(formData, "rib"));
    if (!rib.ok) return { ok: false, error: rib.error };
    data.rib = rib.rib;
  }
  if (formData.has("notes")) data.notes = fdStr(formData, "notes");
  let companyId = avant.companyId;
  if (formData.has("companyId")) {
    companyId = fdStr(formData, "companyId") || null;
    if (!(await entiteOuverte(user.id, companyId))) return { ok: false, error: "Entité introuvable ou hors de votre périmètre." };
    data.company = companyId ? { connect: { id: companyId } } : { disconnect: true };
  }
  const principal = formData.has("principal") ? fdCase(formData, "principal") === true : avant.principal;
  data.principal = principal;

  const retires = await prisma.$transaction(async (tx) => {
    await tx.treasuryAccount.update({ where: { id }, data: { ...data, updatedById: user.id } });
    return principal ? retirerLesAutresPrincipaux(tx, companyId, id) : [];
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances",
    summary: `Compte de trésorerie « ${avant.name} » modifié${changes.length ? ` — ${changes.join(", ")}` : ""}${principal !== avant.principal ? (principal ? " — devient principal" : " — n'est plus principal") : ""}${retires.length ? ` ; ${retires.join(", ")} cesse d'être principal` : ""}`,
  });
  revalidatePath("/finances");
  return { ok: true, id, message: `Compte modifié.${retires.length ? ` ${retires.join(", ")} n'est plus le compte principal.` : ""}` };
}

/**
 * CORRIGER L'ANCRAGE — le solde du relevé ou sa date. Un MOTIF est exigé, et l'audit garde l'ancien
 * et le nouveau : c'est le point de départ de tous les soldes affichés, il ne change pas sans
 * qu'on puisse dire pourquoi ni d'où l'on venait.
 */
export async function corrigerAncrageTresorerie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Compte non précisé." };
  const openingBalance = fdNum(formData, "openingBalance");
  const openingDate = fdDate(formData, "openingDate");
  const motif = (fdStr(formData, "motif") ?? "").trim();
  const manque: string[] = [];
  if (openingBalance === null || !Number.isFinite(openingBalance)) manque.push("le solde du relevé");
  if (!openingDate) manque.push("sa date");
  if (motif.length < 5) manque.push("le motif de la correction");
  if (manque.length) return { ok: false, error: `Indiquez ${manque.join(", ")}.` };
  const avant = await prisma.treasuryAccount.findFirst({ where: await companyScopedWhere(user.id, { id }), select: { name: true, openingBalance: true, openingDate: true } });
  if (!avant) return { ok: false, error: "Compte introuvable." };
  await prisma.treasuryAccount.update({ where: { id }, data: { openingBalance: openingBalance!, openingDate: openingDate!, updatedById: user.id } });
  const jour = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances", field: "ancrage",
    oldValue: `${toNumber(avant.openingBalance).toLocaleString("fr-FR")} DZD au ${jour(avant.openingDate)}`,
    newValue: `${openingBalance!.toLocaleString("fr-FR")} DZD au ${jour(openingDate!)}`,
    summary: `Ancrage du compte « ${avant.name} » corrigé — ${toNumber(avant.openingBalance).toLocaleString("fr-FR")} DZD au ${jour(avant.openingDate)} → ${openingBalance!.toLocaleString("fr-FR")} DZD au ${jour(openingDate!)} — motif : ${motif}`,
  });
  revalidatePath("/finances", "layout");
  return { ok: true, id, message: `Ancrage corrigé : ${openingBalance!.toLocaleString("fr-FR")} DZD au ${jour(openingDate!)}.` };
}

/**
 * SUPPRIMER UN COMPTE — refusé tant que des écritures le NOMMENT : le supprimer laisserait ces
 * paiements sans compte, et l'ancien geste avalait l'erreur et répondait « fait » (un faux succès
 * parfait, la clé étrangère refusant la suppression en silence).
 */
export async function deleteTreasuryAccount(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const compte = await prisma.treasuryAccount.findFirst({ where: await companyScopedWhere(user.id, { id }), select: { name: true, openingBalance: true } });
  if (!compte) return { ok: false, error: "Compte introuvable." };
  const nommees = await prisma.financeTransaction.count({ where: { treasuryAccountId: id } });
  if (nommees > 0) {
    return { ok: false, error: `${nommees} écriture(s) nomment le compte « ${compte.name} » : il ne se supprime pas. Renommez-le, ou corrigez son ancrage, s'il le faut.` };
  }
  await prisma.treasuryAccount.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Finances", summary: `Compte de trésorerie « ${compte.name} » supprimé (ancrage ${toNumber(compte.openingBalance).toLocaleString("fr-FR")} DZD)` });
  revalidatePath("/finances");
  return { ok: true };
}

// ── Payroll ──

export async function createEmployee(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };
  const fullName = fdStr(formData, "fullName");
  if (!fullName) return { ok: false, error: "Le nom est obligatoire." };
  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const created = await prisma.$transaction(async (tx) => {
    const e = await tx.employee.create({
      data: {
        fullName, position: fdStr(formData, "position"), department: fdStr(formData, "department"),
        email: fdStr(formData, "email"), phone: fdStr(formData, "phone"), iban: fdStr(formData, "iban"),
        baseSalary: fdNum(formData, "baseSalary") ?? 0, hireDate: fdDate(formData, "hireDate"),
      },
    });
    await relierALaPersonne(tx, "Employee", e.id, user.id);
    return e;
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Finances", entityType: "EMPLOYEE", entityId: created.id, summary: `Employé « ${fullName} »` });
  revalidatePath("/finances");
  return { ok: true, id: created.id };
}

export async function createPayroll(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };
  const employeeId = fdStr(formData, "employeeId");
  if (!employeeId) return { ok: false, error: "Employé requis." };
  const gross = fdNum(formData, "gross") ?? 0;
  const bonuses = fdNum(formData, "bonuses") ?? 0;
  const deductions = fdNum(formData, "deductions") ?? 0;
  const net = gross + bonuses - deductions;
  const year = fdNum(formData, "year") ?? new Date().getFullYear();
  const month = fdNum(formData, "month") ?? new Date().getMonth() + 1;

  try {
    const created = await prisma.payrollEntry.create({
      data: { employeeId, year, month, gross, bonuses, deductions, net,
        status: (fdStr(formData, "status") as PayrollStatus) ?? "DRAFT", createdById: user.id },
    });
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Finances", entityType: "PAYROLL", entityId: created.id, summary: `Bulletin ${month}/${year}` });
  } catch {
    return { ok: false, error: "Un bulletin existe déjà pour cet employé sur ce mois." };
  }
  revalidatePath("/finances");
  return { ok: true };
}

/**
 * « RÉGLER LA PAIE » D'UN BULLETIN N'EXISTE PLUS ICI (§118.176). Cette action marquait un bulletin
 * payé et inscrivait l'écriture SALAIRE — l'argent sortait du livre sans que le centre de paiement
 * l'ait vu. « La paie doit dorénavant passer par le centre de paiement et attendre la validation »
 * (Direction, 01/10/2026) : elle part, entité par entité, depuis RH › Paie (`envoyerPaieAuCentre`),
 * et c'est le RÈGLEMENT de son ordre qui l'inscrit au livre. Aucun écran ne l'appelait ; seule une
 * op d'Adam le faisait — retirée avec elle. La laisser aurait gardé une porte ouverte à côté de la
 * porte gardée (§118.71).
 */

/**
 * ENCAISSEMENT SIMPLE — cinq champs et c'est réglé : date, référence, libellé, montant, client.
 *
 * Le formulaire complet (catégorie, méthode, compte, statut, entité, pièce…) est fait pour la
 * saisie comptable soignée ; encaisser un règlement client n'a pas besoin de tout cela, et
 * l'obligation de tout remplir décourageait la saisie au fil de l'eau. Les valeurs implicites
 * sont celles du cas courant : recette, réglée, virement bancaire.
 */
export async function createQuickIncome(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "CREATE")) return { ok: false, error: "Non autorisé." };

  const label = fdStr(formData, "label");
  const amount = fdNum(formData, "amount");
  if (!label || amount === null) return { ok: false, error: "Libellé et montant obligatoires." };
  if (amount <= 0) return { ok: false, error: "Le montant d'un encaissement doit être positif." };

  const wanted = fdStr(formData, "reference");
  const free = wanted ? (await prisma.financeTransaction.count({ where: { reference: wanted } })) === 0 : false;
  if (wanted && !free) return { ok: false, error: `La référence « ${wanted} » est déjà utilisée.` };

  const created = await prisma.financeTransaction.create({
    data: {
      reference: wanted || (await nextRef("FIN")),
      date: fdDate(formData, "date") ?? new Date(),
      direction: "IN",
      category: "RECETTE",
      label,
      amount,
      method: "BANK_TRANSFER",
      account: "Banque",
      counterparty: fdStr(formData, "client"),
      status: "SETTLED",
      companyId: fdStr(formData, "companyId") || null,
      treasuryAccountId: await compteDeLEcriture({
        compteId: fdStr(formData, "treasuryAccountId"), compte: "Banque", societeId: fdStr(formData, "companyId") || null,
      }),
      createdById: user.id,
    },
    select: { id: true, reference: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Finances",
    entityType: "FINANCE_TRANSACTION", entityId: created.id,
    summary: `Encaissement ${created.reference} — ${label} (${amount.toLocaleString("fr-FR")} DZD)`,
  });
  revalidatePath("/finances");
  return { ok: true, id: created.id };
}

/**
 * LE SUPER ADMIN DEMANDE une mise à jour du solde de trésorerie. Les Finances le mettent à jour
 * quand elles le veulent ; lui ne saisit pas à leur place — il le demande, et la demande arrive
 * là où elle sera traitée.
 *
 * ── UNE DEMANDE, PAS UNE SONNERIE (Direction, 10/2026) ──────────────────────────────────────
 *
 * La demande porte sur UNE entité (celle ouverte à l'écran, Adventum par défaut) et s'enregistre
 * (`DemandeActualisationSoldes`) avec une ligne par compte de l'entité, figée à l'ancrage d'alors.
 * Elle part aux seuls responsables Finance / Budget qui VOIENT l'entité, et leur notification
 * OUVRE l'écran de réponse (`/finances/actualisation-soldes/[id]`) : ils saisissent le solde du
 * relevé et sa date compte par compte, ou « pas encore reçu ». Le Super Admin est prévenu en retour
 * (`repondreActualisationSoldes`). Une demande déjà ouverte pour l'entité n'est pas doublée : le
 * second clic RELANCE la même.
 *
 * ── POURQUOI LE SEUL SUPER ADMIN ────────────────────────────────────────────────────────────
 *
 * Le geste sonne chez TOUS les responsables Finances. Ouvert à toute la direction, il devient une
 * sonnerie fréquente — et une sonnerie fréquente finit par n'être plus écoutée, y compris le jour
 * où le solde est vraiment douteux.
 *
 * LA RÈGLE VIT EN TROIS ENDROITS, et c'est délibéré : ici (le serveur, qui décide), sur le bouton
 * de « Banque & paiements » (l'écran, qui ne montre pas ce qu'on ne peut pas faire) et dans
 * l'opération d'Adam `request_treasury_update` (la même porte, par la conversation). Un bouton
 * masqué n'est pas un contrôle d'accès : c'est CETTE ligne qui refuse.
 */
export async function requestTreasuryUpdate(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const note = fdStr(formData, "note");

  // L'ENTITÉ : celle ouverte à l'écran si la personne la voit, sinon l'entité par défaut (Adventum) —
  // la même règle que la page Banque & paiements (`entiteParDefaut`), sans quoi le bouton demanderait
  // pour une autre société que celle qu'on regarde.
  const societes = await getMyCompanies(user.id);
  const entiteId = entiteParDefaut(societes, fdStr(formData, "entite"));
  const societe = societes.find((s) => s.id === entiteId) ?? null;
  const nomEntite = societe ? societe.shortName || societe.name : "sans entité";

  const comptes = await prisma.treasuryAccount.findMany({
    where: await companyScopedWhere(user.id, entiteId ? { companyId: entiteId } : {}),
    select: { id: true, openingBalance: true, openingDate: true },
    orderBy: [{ principal: "desc" }, { name: "asc" }],
  });
  if (comptes.length === 0) {
    return { ok: false, error: `Aucun compte de trésorerie pour ${nomEntite} : ouvrez-en un depuis « Comptes de trésorerie » avant d'en demander le solde.` };
  }

  // LES DESTINATAIRES : les responsables Finance / Budget (rôle principal ou secondaire) qui VOIENT
  // l'entité — prévenir un comptable cloisonné sur une autre société l'enverrait vers un écran qui
  // lui répondrait « introuvable ».
  const candidats = await prisma.user.findMany({ where: { ...anyRoleFilter(["FINANCE_BUDGET_MANAGER"]), isActive: true }, select: { id: true } });
  const destinataires: string[] = [];
  for (const c of candidats) {
    if (!entiteId || (await getMyCompanies(c.id)).some((s) => s.id === entiteId)) destinataires.push(c.id);
  }
  if (destinataires.length === 0) {
    return { ok: false, error: `Aucun responsable Finance / Budget actif ne voit ${nomEntite} : personne ne pourrait répondre. Attribuez le rôle ou l'entité dans Administration › Utilisateurs.` };
  }

  // UNE DEMANDE OUVERTE POUR L'ENTITÉ N'EST PAS DOUBLÉE : le second clic la RELANCE.
  const ouverte = await prisma.demandeActualisationSoldes.findFirst({
    where: { companyId: entiteId, termineeLe: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  const demande = ouverte ?? await prisma.demandeActualisationSoldes.create({
    data: {
      companyId: entiteId, note, demandeParId: user.id,
      lignes: { create: comptes.map((c) => ({ compteId: c.id, ancienSolde: c.openingBalance, ancienneDate: c.openingDate })) },
    },
    select: { id: true, createdAt: true },
  });
  const relance = Boolean(ouverte);

  await broadcastNotification({
    audience: "USERS",
    userIds: destinataires,
    title: `${relance ? "Relance — " : ""}Mise à jour du solde de trésorerie demandée — ${nomEntite}`,
    body: `${note ? `${note} — ` : ""}${comptes.length} compte(s) à actualiser. Ouvrez pour saisir le solde du relevé et sa date.`,
    link: `/finances/actualisation-soldes/${demande.id}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances",
    summary: `${relance ? "Relance de la demande" : "Mise à jour du solde de trésorerie demandée"} — ${nomEntite}, ${comptes.length} compte(s), ${destinataires.length} responsable(s) Finance prévenu(s)${note ? ` — ${note}` : ""}`,
  });
  revalidatePath("/finances", "layout");
  return {
    ok: true, id: demande.id,
    message: relance
      ? `Une demande était déjà en cours pour ${nomEntite} : ${destinataires.length} responsable(s) Finance relancé(s).`
      : `Demande envoyée à ${destinataires.length} responsable(s) Finance pour ${nomEntite} (${comptes.length} compte(s)).`,
  };
}
