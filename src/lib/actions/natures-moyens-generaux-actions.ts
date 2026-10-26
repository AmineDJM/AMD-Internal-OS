"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { LIBELLE_MAX, valeurNouvelle } from "@/lib/general-means/natures";
import { assurerNaturesMoyensGeneraux, categoriePourNom, naturesConnues } from "@/lib/general-means/natures-store";
import { classerLibelles } from "@/lib/natures-depenses-ia";

/**
 * LES NATURES DES DÉPENSES DES MOYENS GÉNÉRAUX — les deux gestes autour de l'IA (Direction, 10/2026).
 *
 *   • `proposerNaturesLignes` — pendant la saisie : chaque article reçoit une catégorie PROPOSÉE, que la personne voit
 *     et peut changer avant d'enregistrer. Rien ne s'écrit (hors journal d'usage de l'IA) : une nouvelle catégorie
 *     revient sous la forme « nouvelle:Nom » et ne se crée qu'à l'enregistrement de la dépense.
 *   • `classerDepensesNonClassees` — une fois, pour l'existant : le Super Admin range les dépenses restées « Non
 *     classé ». Par lots, pour qu'un clic ne tienne pas la page des minutes.
 */

const LIGNES_MAX = 30;
const LOT_LIGNES = 120;
const LOT_DEPENSES = 60;

export interface PropositionLigne {
  /** L'identifiant d'une catégorie existante, ou « nouvelle:Nom ». */
  valeur: string;
  /** Le nom à afficher. */
  nom: string;
  nouvelle: boolean;
}

export interface ResultatPropositions extends ActionResult {
  /** Une entrée par libellé envoyé, `null` = rien à proposer. */
  propositions?: (PropositionLigne | null)[];
}

export async function proposerNaturesLignes(formData: FormData): Promise<ResultatPropositions> {
  const user = await requireUser();
  if (!userCan(user, "GENERAL_MEANS", "VIEW")) return { ok: false, error: "Accès refusé." };

  let libelles: string[] = [];
  try {
    const brut: unknown = JSON.parse(fdStr(formData, "libelles") ?? "[]");
    if (Array.isArray(brut)) libelles = brut.slice(0, LIGNES_MAX).map((l) => String(l ?? "").trim().slice(0, LIBELLE_MAX));
  } catch {
    return { ok: false, error: "Lignes illisibles." };
  }
  if (libelles.every((l) => !l)) return { ok: true, propositions: libelles.map(() => null) };

  await assurerNaturesMoyensGeneraux();
  const categories = await naturesConnues();
  const noms = new Map(categories.map((c) => [c.id, c.nom]));
  const { propositions } = await classerLibelles({ libelles, objet: fdStr(formData, "objet"), categories, userId: user.id });
  return {
    ok: true,
    propositions: propositions.map((p) => {
      if (!p) return null;
      if ("categorieId" in p) return { valeur: p.categorieId, nom: noms.get(p.categorieId) ?? "", nouvelle: false };
      return { valeur: valeurNouvelle(p.nouvelle), nom: p.nouvelle, nouvelle: true };
    }),
  };
}

const estSuperAdmin = (u: { role: string; secondaryRole?: string | null }) => u.role === "SUPER_ADMIN" || u.secondaryRole === "SUPER_ADMIN";

/**
 * RANGER L'EXISTANT : les articles sans catégorie (sur un ticket qui n'en a pas non plus), puis les dépenses sans
 * article ni catégorie. Super Admin seul — c'est une écriture en masse dans le budget. Un lot par clic ; le message dit
 * ce qui reste.
 */
export async function classerDepensesNonClassees(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!estSuperAdmin(user)) return { ok: false, error: "Réservé au Super Admin." };
  const departmentId = fdStr(formData, "departmentId");
  const duDepartement = departmentId ? { departmentId } : {};

  await assurerNaturesMoyensGeneraux();
  const categories = await naturesConnues();

  const lignes = await prisma.departmentExpenseLine.findMany({
    where: { budgetCategoryId: null, expense: { budgetCategoryId: null, kind: { not: "HR" }, ...duDepartement } },
    select: { id: true, label: true, expense: { select: { label: true } } },
    orderBy: { createdAt: "desc" },
    take: LOT_LIGNES,
  });
  const depenses = await prisma.departmentBudgetExpense.findMany({
    where: { budgetCategoryId: null, kind: { not: "HR" }, lines: { none: {} }, ...duDepartement },
    select: { id: true, label: true },
    orderBy: { date: "desc" },
    take: LOT_DEPENSES,
  });
  if (lignes.length === 0 && depenses.length === 0) return { ok: true, message: "Aucune dépense à classer : tout est rangé." };

  const { propositions, ia } = await classerLibelles({
    libelles: [...lignes.map((l) => `${l.label} (ticket : ${l.expense.label})`), ...depenses.map((d) => d.label)],
    categories,
    userId: user.id,
  });

  let rangees = 0;
  const creees = new Set<string>();
  const idDe = async (k: number): Promise<string | null> => {
    const p = propositions[k];
    if (!p) return null;
    if ("categorieId" in p) return p.categorieId;
    const avant = categories.length;
    const c = await categoriePourNom(p.nouvelle, categories);
    if (c && categories.length > avant) creees.add(c.nom);
    return c?.id ?? null;
  };
  for (let k = 0; k < lignes.length; k++) {
    const id = await idDe(k);
    if (!id) continue;
    await prisma.departmentExpenseLine.update({ where: { id: lignes[k].id }, data: { budgetCategoryId: id } });
    rangees++;
  }
  for (let k = 0; k < depenses.length; k++) {
    const id = await idDe(lignes.length + k);
    if (!id) continue;
    await prisma.departmentBudgetExpense.update({ where: { id: depenses[k].id }, data: { budgetCategoryId: id } });
    rangees++;
  }

  const [resteLignes, resteDepenses] = await Promise.all([
    prisma.departmentExpenseLine.count({ where: { budgetCategoryId: null, expense: { budgetCategoryId: null, kind: { not: "HR" }, ...duDepartement } } }),
    prisma.departmentBudgetExpense.count({ where: { budgetCategoryId: null, kind: { not: "HR" }, lines: { none: {} }, ...duDepartement } }),
  ]);
  const reste = resteLignes + resteDepenses;

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: departmentId ?? "moyens-generaux",
    summary: `Natures des dépenses des moyens généraux : ${rangees} élément(s) rangé(s)${ia ? " par l'IA" : " par mots-clés (IA indisponible)"}${creees.size ? ` · nouvelles catégories : ${[...creees].join(", ")}` : ""}`,
  });
  revalidatePath("/moyens-generaux");

  const morceaux = [
    `${rangees} élément${rangees > 1 ? "s" : ""} rangé${rangees > 1 ? "s" : ""}${ia ? "" : " (par mots-clés : l'IA n'a pas répondu)"}.`,
    creees.size ? `Nouvelles catégories : ${[...creees].join(", ")}.` : "",
    reste > 0 ? `Il en reste ${reste} — relancez pour continuer.` : "",
  ].filter(Boolean);
  return { ok: true, message: morceaux.join(" ") };
}
