/**
 * Écriture des lignes d'un ticket, côté serveur — le pont entre le module pur `receipt.ts` et
 * la base.
 *
 * Vit à part des deux actions qui l'appellent (caisse d'avance et dépense sur budget) parce que
 * la règle est la même des deux côtés : un ticket, ses articles, un total qui vient des lignes.
 * L'écrire deux fois, c'est se garantir deux comportements différents au premier correctif.
 */
import { prisma } from "@/lib/prisma";
import { allowedGeneralMeansCategoryIds, keepAllowedCategory } from "./budget-targets";
import { parseLinesField, validateReceipt, receiptTotal, receiptLabel, type ReceiptLine } from "./receipt";
import { lireValeurNouvelle, valeurNouvelle } from "./natures";
import { assurerNaturesMoyensGeneraux, categoriePourNom, naturesConnues } from "./natures-store";
import { classerLibelles } from "@/lib/natures-depenses-ia";

export interface ReceiptDraft {
  lines: ReceiptLine[];
  /** Total du ticket, calculé depuis les lignes — jamais saisi à côté. */
  total: number;
  label: string;
}

/**
 * Lit les lignes du formulaire et les complète depuis le CATALOGUE : une ligne peut n'envoyer
 * qu'un `articleId`, c'est alors le nom du catalogue qui fait foi — et il est recopié dans la
 * ligne, pour qu'un article renommé plus tard ne réécrive pas un ticket déjà classé.
 *
 * Un `articleId` inconnu (article supprimé entre l'ouverture du formulaire et l'envoi) n'est pas
 * une erreur : la ligne redevient un achat libre, à condition d'être nommée.
 */
export async function readReceipt(raw: unknown, givenLabel?: string | null): Promise<ReceiptDraft | { error: string }> {
  const lines = parseLinesField(raw);
  const ids = Array.from(new Set(lines.map((l) => l.articleId).filter((x): x is string => Boolean(x))));
  const names = new Map<string, string>();
  if (ids.length) {
    const articles = await prisma.officeSupplyArticle.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const a of articles) names.set(a.id, a.name);
  }
  // Les cases budgétaires envoyées par le formulaire sont RE-VÉRIFIÉES ici : une catégorie hors
  // des enveloppes ouvertes aux moyens généraux est ignorée, l'article reste « à classer ».
  const allowedCategories = lines.some((l) => l.budgetCategoryId)
    ? await allowedGeneralMeansCategoryIds()
    : new Set<string>();
  const resolved: ReceiptLine[] = lines.map((l) => ({
    ...l,
    articleId: l.articleId && names.has(l.articleId) ? l.articleId : null,
    label: l.label || (l.articleId ? names.get(l.articleId) ?? "" : ""),
    // Une NOUVELLE catégorie proposée (« nouvelle:… ») passe telle quelle : `finaliserNatures` la crée — ou l'écarte —
    // au moment d'écrire. Toute autre valeur est revérifiée contre la liste ouverte.
    budgetCategoryId: lireValeurNouvelle(l.budgetCategoryId)
      ? valeurNouvelle(lireValeurNouvelle(l.budgetCategoryId) as string)
      : keepAllowedCategory(l.budgetCategoryId, allowedCategories),
  }));

  const check = validateReceipt(resolved);
  if (!check.ok) return { error: check.error ?? "Ticket incomplet." };
  return { lines: resolved, total: receiptTotal(resolved), label: receiptLabel(resolved, givenLabel) };
}

/**
 * LA NATURE DE CHAQUE ARTICLE, JUSTE AVANT D'ÉCRIRE (Direction, 10/2026).
 *
 *   1. une nouvelle catégorie proposée par l'IA dans le formulaire (« nouvelle:… ») est créée dans l'enveloppe des
 *      moyens généraux — ou retrouvée, si une catégorie du même nom existe déjà ;
 *   2. avec `classer`, un article resté sans catégorie (la proposition n'était pas arrivée, ou personne ne l'a
 *      choisie) est rangé ici, par l'IA puis les mots-clés.
 *
 * Appelée APRÈS les contrôles (droits, pièce, montant) : une saisie refusée ne laisse pas de catégorie derrière elle.
 * Ne bloque jamais l'enregistrement : en cas d'échec, l'article reste simplement « Non classé ».
 */
export async function finaliserNatures(
  lines: ReceiptLine[],
  opts: { userId: string; objet?: string | null; classer: boolean },
): Promise<ReceiptLine[]> {
  const sansNouvelle = (ls: ReceiptLine[]) => ls.map((l) => (lireValeurNouvelle(l.budgetCategoryId) ? { ...l, budgetCategoryId: null } : l));
  const aFaire = lines.some((l) => lireValeurNouvelle(l.budgetCategoryId)) || (opts.classer && lines.some((l) => !l.budgetCategoryId));
  if (!aFaire) return lines;
  try {
    await assurerNaturesMoyensGeneraux();
    const connues = await naturesConnues();
    const out: ReceiptLine[] = [];
    for (const l of lines) {
      const nom = lireValeurNouvelle(l.budgetCategoryId);
      out.push(nom ? { ...l, budgetCategoryId: (await categoriePourNom(nom, connues))?.id ?? null } : l);
    }
    if (!opts.classer) return out;
    const restantes = out.map((l, i) => ({ l, i })).filter((x) => !x.l.budgetCategoryId);
    if (restantes.length === 0) return out;
    const { propositions } = await classerLibelles({
      libelles: restantes.map((x) => x.l.label), objet: opts.objet ?? null, categories: connues, userId: opts.userId,
    });
    for (let k = 0; k < restantes.length; k++) {
      const p = propositions[k];
      if (!p) continue;
      const id = "categorieId" in p ? p.categorieId : (await categoriePourNom(p.nouvelle, connues))?.id ?? null;
      out[restantes[k].i] = { ...out[restantes[k].i], budgetCategoryId: id };
    }
    return out;
  } catch (err) {
    console.error("[moyens-generaux] nature des articles non déterminée", err);
    return sansNouvelle(lines);
  }
}

/** Enregistre les lignes d'un ticket sur une dépense déjà créée. */
export async function saveReceiptLines(expenseId: string, lines: ReceiptLine[]): Promise<void> {
  if (lines.length === 0) return;
  await prisma.departmentExpenseLine.createMany({
    data: lines.map((l) => ({
      expenseId,
      articleId: l.articleId,
      label: l.label,
      quantity: l.quantity,
      amount: l.amount,
      budgetCategoryId: l.budgetCategoryId,
    })),
  });
}
