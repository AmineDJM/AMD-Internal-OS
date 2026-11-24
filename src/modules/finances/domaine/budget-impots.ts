/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES IMPÔTS ET COTISATIONS DANS LE BUDGET (Super Admin, 24/11/2026 — décisions de l'audit des dépenses, qui font foi).
 *
 * DEUX MAISONS, des clés STABLES que la campagne budgétaire et les autres lots importent d'ici (`@/modules/finances/partage`) :
 *
 *   • l'enveloppe « Impôts & taxes » d'une société et d'une année — code `IMPOTS_TAXES` (`BudgetEnvelope.module`) —, qui ne
 *     porte QUE deux lignes (`BudgetCategoryLine.cle`) :
 *       TVA_NETTE   la TVA à reverser = collectée sur les ventes − déductible sur les achats ;
 *       IBS         les acomptes et le solde de l'impôt sur les bénéfices ;
 *   • la MASSE SALARIALE de chaque département (l'enveloppe de son pôle), qui INCLUT l'IRG et la CNAS, affichés à part, à
 *     côté de la ligne de masse salariale (net + primes) :
 *       MS_IRG      l'IRG retenu sur les salaires ;
 *       MS_CNAS     les cotisations sociales (parts salariale et patronale).
 *     Un paiement d'IRG ou de CNAS se RÉPARTIT entre les départements au prorata des retenues que portent les fiches de
 *     leurs salariés.
 *
 * Une G50 se ventile donc : la part TVA → IMPOTS_TAXES/TVA_NETTE ; la part IRG → MS_IRG des départements. Une autre ligne
 * de la G50 (libre) n'a pas de ligne budgétaire désignée : elle reste « à classer » — les Finances la classent au règlement.
 * Chaque part est un ORDRE (un paiement), imputé à sa catégorie : engagé tant qu'il n'est pas réglé, consommé au règlement,
 * comme toute enveloppe. Montants alloués à 0 : la campagne budgétaire les fixe.
 *
 * Module PUR — sans aucun import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CODE_ENVELOPPE_IMPOTS = "IMPOTS_TAXES" as const;

export const LIGNES_BUDGET_IMPOTS = {
  TVA_NETTE: "TVA_NETTE",
  IBS: "IBS",
} as const;

export type CleLigneBudgetImpots = keyof typeof LIGNES_BUDGET_IMPOTS;

/** Les lignes de l'enveloppe « Impôts & taxes », dans l'ordre où elles se créent et s'affichent. */
export const CATEGORIES_BUDGET_IMPOTS: readonly { cle: CleLigneBudgetImpots; nom: string }[] = [
  { cle: "TVA_NETTE", nom: "TVA nette à reverser" },
  { cle: "IBS", nom: "IBS — acomptes et solde" },
];

/** Les lignes IRG et CNAS de la masse salariale d'un département (à côté de la ligne net + primes). */
export const LIGNES_MASSE_SALARIALE = {
  MS_IRG: "MS_IRG",
  MS_CNAS: "MS_CNAS",
} as const;

export type CleLigneMasseSalariale = keyof typeof LIGNES_MASSE_SALARIALE;

export const CATEGORIES_MASSE_SALARIALE_IMPOTS: readonly { cle: CleLigneMasseSalariale; nom: string }[] = [
  { cle: "MS_IRG", nom: "Masse salariale — IRG" },
  { cle: "MS_CNAS", nom: "Masse salariale — CNAS" },
];

/** Le nom de l'enveloppe d'une année (« Impôts & taxes 2026 »). */
export const nomEnveloppeImpots = (annee: number): string => `Impôts & taxes ${annee}`;

/**
 * LES RETENUES À LA SOURCE REVERSÉES PAR LA G50 (honoraires de médecins, prestataires étrangers) : déjà CONSOMMÉES sur la
 * ligne budgétaire de la dépense qui les a retenues (`constaterRetenueAuReglement`) — leur part de la G50 se règle donc
 * SANS ligne budgétaire, sinon la même somme compterait deux fois.
 */
export const PART_RETENUES_SOURCE = "RETENUES_SOURCE" as const;

/**
 * Où va une part d'un envoi : une ligne d'« Impôts & taxes », une ligne de la masse salariale, les retenues à la source
 * (aucune ligne : déjà consommées), ou « à classer » (`null`).
 */
export type CleBudget = CleLigneBudgetImpots | CleLigneMasseSalariale | typeof PART_RETENUES_SOURCE | null;

export interface PartBudgetaire {
  cle: CleBudget;
  montant: number;
}

/** Les montants d'une décomposition, réduits à ce que la ventilation lit. */
export interface MontantDecompose {
  cle: string;
  montant: number;
}

/**
 * LA LIGNE D'UN MONTANT UNIQUE (acompte, solde, ponctuel) — lue sur la nature et l'organisme saisis : un acompte ou un
 * solde d'IBS → IBS ; une TVA → TVA_NETTE ; un versement à la CNAS → MS_CNAS ; un IRG → MS_IRG ; le reste → à classer.
 */
export function ligneBudgetDuMontant(nature: string, organisme: string): CleBudget {
  if (/\bIBS\b|imp[oô]t sur les b[ée]n[ée]fices/i.test(nature)) return "IBS";
  if (/\bTVA\b/i.test(nature)) return "TVA_NETTE";
  if (/\bCNAS\b/i.test(`${organisme} ${nature}`)) return "MS_CNAS";
  if (/\bIRG\b/i.test(nature)) return "MS_IRG";
  return null;
}

const ORDRE_DES_CLES: readonly CleBudget[] = ["TVA_NETTE", "IBS", "MS_IRG", "MS_CNAS", PART_RETENUES_SOURCE, null];

/**
 * LA VENTILATION D'UN ENVOI — une part par destination, montants nuls écartés. G50 : la TVA → TVA_NETTE, l'IRG → MS_IRG,
 * une autre ligne → à classer. CNAS : tout → MS_CNAS. Un montant unique : sa ligne. La somme des parts égale le total.
 */
export function ventilationBudgetaire(
  composition: "G50" | "CNAS" | "MONTANT", lignes: readonly MontantDecompose[], nature: string, organisme: string,
): PartBudgetaire[] {
  const cleDe = (cle: string): CleBudget => {
    if (composition === "CNAS") return "MS_CNAS";
    if (composition === "MONTANT") return ligneBudgetDuMontant(nature, organisme);
    if (cle === "irg") return "MS_IRG";
    if (cle === "tva") return "TVA_NETTE";
    if (cle === "ras") return PART_RETENUES_SOURCE;
    return null;
  };
  const parts = new Map<CleBudget, number>();
  for (const l of lignes) {
    if (!(l.montant > 0)) continue;
    const c = cleDe(l.cle);
    parts.set(c, Math.round(((parts.get(c) ?? 0) + l.montant) * 100) / 100);
  }
  return ORDRE_DES_CLES.filter((c) => parts.has(c)).map((cle) => ({ cle, montant: parts.get(cle)! }));
}

/**
 * LA RÉPARTITION AU PRORATA — un montant partagé entre des destinations selon leurs poids (les retenues des fiches de
 * chaque département), au centime, la somme TOMBANT JUSTE (le reste des arrondis va aux plus gros restes). Sans poids
 * utilisable, tout va à « à classer » (`null`).
 */
export function repartirAuProrata<K>(montant: number, poids: readonly { cle: K; poids: number }[]): { cle: K | null; montant: number }[] {
  const utiles = poids.filter((p) => p.poids > 0);
  const total = utiles.reduce((t, p) => t + p.poids, 0);
  const centimes = Math.round(montant * 100);
  if (centimes <= 0) return [];
  if (total <= 0) return [{ cle: null, montant: centimes / 100 }];
  const parts = utiles.map((p) => {
    const exact = (centimes * p.poids) / total;
    return { cle: p.cle, c: Math.floor(exact), reste: exact - Math.floor(exact) };
  });
  let manque = centimes - parts.reduce((t, p) => t + p.c, 0);
  for (const p of [...parts].sort((a, b) => b.reste - a.reste)) {
    if (manque <= 0) break;
    p.c += 1;
    manque -= 1;
  }
  return parts.filter((p) => p.c > 0).map((p) => ({ cle: p.cle, montant: p.c / 100 }));
}

/** Le libellé d'une destination (« TVA nette à reverser », « Masse salariale — IRG », « à classer au règlement »). */
export function libelleLigneBudget(cle: CleBudget): string {
  if (cle === null) return "à classer au règlement";
  if (cle === PART_RETENUES_SOURCE) return "Retenues à la source — déjà imputées aux dépenses";
  return [...CATEGORIES_BUDGET_IMPOTS, ...CATEGORIES_MASSE_SALARIALE_IMPOTS].find((c) => c.cle === cle)!.nom;
}
