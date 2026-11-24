/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES IMPÔTS ET TAXES DANS LE BUDGET (Super Admin, 24/11/2026 : « c'est important »).
 *
 * La TVA nette reversée à l'État et les impôts de l'année (IBS : acomptes et solde), comme l'IRG des salaires, la CNAS
 * et les autres taxes, se COMPTABILISENT dans une enveloppe « Impôts & taxes » par société et par année. Ses CLÉS sont
 * STABLES — le code les reconnaît, la campagne budgétaire les utilise pour la prévision : on les importe d'ici
 * (`@/modules/finances/partage`), jamais recopiées.
 *
 *   enveloppe        IMPOTS_TAXES  (`BudgetEnvelope.module`)
 *   lignes (`BudgetCategoryLine.cle`) :
 *     TVA_NETTE      la TVA à reverser (collectée − déductible)
 *     IBS            les acomptes et le solde de l'impôt sur les bénéfices
 *     IRG_SALAIRES   l'IRG retenu sur les salaires
 *     CNAS           les cotisations sociales (parts salariale et patronale)
 *     AUTRES_TAXES   les autres impôts et taxes, en SOUS-NATURES (sous-catégories à clé stable, `SOUS_NATURES_AUTRES_TAXES`) :
 *                    CASNOS (gérants non salariés — distincte de la CNAS), TFP_APPRENTISSAGE, RETENUES_SOURCE,
 *                    TAXE_FONCIERE, VIGNETTES, TIMBRE_ENREGISTREMENT, PENALITES ; le TAP et le reste, à la ligne mère.
 *
 * Chaque ordre émis par « Impôts & cotisations » est imputé à SA ligne : une G50 qui porte plusieurs natures émet un
 * ordre par ligne budgétaire (IRG, TVA, autres), un seul paiement par ordre — l'engagé et le consommé suivent la
 * mécanique de toutes les enveloppes (ordre non réglé = engagé, réglé = consommé). Montants alloués à 0 : la campagne
 * budgétaire les fixe.
 *
 * Module PUR — sans aucun import, lisible par un écran comme par un autre lot.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CODE_ENVELOPPE_IMPOTS = "IMPOTS_TAXES" as const;

export const LIGNES_BUDGET_IMPOTS = {
  TVA_NETTE: "TVA_NETTE",
  IBS: "IBS",
  IRG_SALAIRES: "IRG_SALAIRES",
  CNAS: "CNAS",
  AUTRES_TAXES: "AUTRES_TAXES",
} as const;

export type CleLigneBudgetImpots = keyof typeof LIGNES_BUDGET_IMPOTS;

/** Les lignes de l'enveloppe, dans l'ordre où elles se créent et s'affichent. */
export const CATEGORIES_BUDGET_IMPOTS: readonly { cle: CleLigneBudgetImpots; nom: string }[] = [
  { cle: "TVA_NETTE", nom: "TVA nette à reverser" },
  { cle: "IBS", nom: "IBS — acomptes et solde" },
  { cle: "IRG_SALAIRES", nom: "IRG salaires" },
  { cle: "CNAS", nom: "CNAS — cotisations sociales" },
  { cle: "AUTRES_TAXES", nom: "Autres impôts et taxes" },
];

/** Les SOUS-NATURES de « Autres impôts et taxes » — sous-catégories à clé stable (audit des dépenses, 24/11/2026). */
export const SOUS_NATURES_AUTRES_TAXES = {
  CASNOS: "CASNOS",
  TFP_APPRENTISSAGE: "TFP_APPRENTISSAGE",
  RETENUES_SOURCE: "RETENUES_SOURCE",
  TAXE_FONCIERE: "TAXE_FONCIERE",
  VIGNETTES: "VIGNETTES",
  TIMBRE_ENREGISTREMENT: "TIMBRE_ENREGISTREMENT",
  PENALITES: "PENALITES",
} as const;

export type CleSousNatureTaxe = keyof typeof SOUS_NATURES_AUTRES_TAXES;

export const CATEGORIES_SOUS_NATURES: readonly { cle: CleSousNatureTaxe; nom: string }[] = [
  { cle: "CASNOS", nom: "CASNOS — gérants non salariés" },
  { cle: "TFP_APPRENTISSAGE", nom: "TFP et taxe d'apprentissage" },
  { cle: "RETENUES_SOURCE", nom: "Retenues à la source" },
  { cle: "TAXE_FONCIERE", nom: "Taxe foncière" },
  { cle: "VIGNETTES", nom: "Vignettes automobiles" },
  { cle: "TIMBRE_ENREGISTREMENT", nom: "Droits de timbre et d'enregistrement" },
  { cle: "PENALITES", nom: "Pénalités et majorations" },
];

/**
 * LA SOUS-NATURE D'UN MONTANT « autres taxes » — lue sur le libellé et l'organisme saisis ; `null` = la ligne mère
 * (le TAP, une taxe que rien ne désigne).
 */
export function sousNatureDe(libelle: string, organisme = ""): CleSousNatureTaxe | null {
  const t = `${libelle} ${organisme}`;
  if (/p[ée]nalit|majoration|amende/i.test(t)) return "PENALITES";
  if (/\bCASNOS\b|non salari/i.test(t)) return "CASNOS";
  if (/\bTFP\b|apprentissage|formation professionnelle/i.test(t)) return "TFP_APPRENTISSAGE";
  if (/retenues? [àa] la source/i.test(t)) return "RETENUES_SOURCE";
  if (/fonci[eè]re/i.test(t)) return "TAXE_FONCIERE";
  if (/vignette/i.test(t)) return "VIGNETTES";
  if (/timbre|enregistrement/i.test(t)) return "TIMBRE_ENREGISTREMENT";
  return null;
}

/** Le nom de l'enveloppe d'une année (« Impôts & taxes 2026 »). */
export const nomEnveloppeImpots = (annee: number): string => `Impôts & taxes ${annee}`;

/** Une part d'un envoi, imputée à une ligne de l'enveloppe (et, sous « autres taxes », à sa sous-nature). */
export interface PartBudgetaire {
  cle: CleLigneBudgetImpots;
  sousNature: CleSousNatureTaxe | null;
  montant: number;
}

/** Les montants d'une décomposition, réduits à ce que la ventilation lit. */
export interface MontantDecompose {
  cle: string;
  montant: number;
  /** Le libellé de la ligne (une « autre ligne » de la G50 dit sa sous-nature : droit de timbre, retenue à la source…). */
  label?: string;
}

/**
 * LA LIGNE BUDGÉTAIRE D'UN MONTANT UNIQUE (acompte, solde, ponctuel) — lue sur la nature et l'organisme saisis : un
 * acompte ou un solde d'IBS va à « IBS », un versement à la CNAS à « CNAS » (la CASNOS des gérants, elle, est une
 * sous-nature des autres taxes), le reste aux autres taxes.
 */
export function ligneBudgetDuMontant(nature: string, organisme: string): CleLigneBudgetImpots {
  if (/\bIBS\b|imp[oô]t sur les b[ée]n[ée]fices/i.test(nature)) return "IBS";
  if (/\bTVA\b/i.test(nature) && !/G50/i.test(nature)) return "TVA_NETTE";
  if (/\bCASNOS\b/i.test(`${organisme} ${nature}`)) return "AUTRES_TAXES";
  if (/\bCNAS\b/i.test(organisme) || /\bCNAS\b/i.test(nature)) return "CNAS";
  return "AUTRES_TAXES";
}

/**
 * LA VENTILATION D'UN ENVOI — une part par ligne budgétaire, montants nuls écartés. G50 : l'IRG à IRG_SALAIRES, la TVA
 * à TVA_NETTE, le TAP et les autres lignes à AUTRES_TAXES. CNAS : tout à CNAS. Un montant unique : sa ligne.
 * La somme des parts égale TOUJOURS le total envoyé.
 */
export function ventilationBudgetaire(
  composition: "G50" | "CNAS" | "MONTANT", lignes: readonly MontantDecompose[], nature: string, organisme: string,
): PartBudgetaire[] {
  const cleDe = (cle: string): CleLigneBudgetImpots => {
    if (composition === "CNAS") return "CNAS";
    if (composition === "MONTANT") return ligneBudgetDuMontant(nature, organisme);
    if (cle === "irg") return "IRG_SALAIRES";
    if (cle === "tva") return "TVA_NETTE";
    return "AUTRES_TAXES";
  };
  const parts = new Map<string, PartBudgetaire>();
  for (const l of lignes) {
    if (!(l.montant > 0)) continue;
    const cle = cleDe(l.cle);
    const sousNature = cle !== "AUTRES_TAXES" ? null
      : composition === "MONTANT" ? sousNatureDe(nature, organisme)
        : l.cle.startsWith("autre") ? sousNatureDe(l.label ?? "") : null;
    const k = `${cle}:${sousNature ?? ""}`;
    const p = parts.get(k) ?? { cle, sousNature, montant: 0 };
    p.montant = Math.round((p.montant + l.montant) * 100) / 100;
    parts.set(k, p);
  }
  const rang = (p: PartBudgetaire) => CATEGORIES_BUDGET_IMPOTS.findIndex((c) => c.cle === p.cle) * 100
    + (p.sousNature ? 1 + CATEGORIES_SOUS_NATURES.findIndex((c) => c.cle === p.sousNature) : 0);
  return [...parts.values()].sort((a, b) => rang(a) - rang(b));
}

/** Le libellé d'une ligne budgétaire (« IRG salaires », « Autres impôts et taxes › Taxe foncière »). */
export const libelleLigneBudget = (cle: CleLigneBudgetImpots, sousNature?: CleSousNatureTaxe | null): string => {
  const mere = CATEGORIES_BUDGET_IMPOTS.find((c) => c.cle === cle)!.nom;
  const sous = sousNature ? CATEGORIES_SOUS_NATURES.find((c) => c.cle === sousNature)?.nom : null;
  return sous ? `${mere} › ${sous}` : mere;
};
