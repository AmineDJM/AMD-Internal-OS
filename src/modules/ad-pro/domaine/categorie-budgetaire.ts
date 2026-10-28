/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CATÉGORIE BUDGÉTAIRE CONVIENT-ELLE À LA DEMANDE ? (Direction, 27/10 — point 9)
 *
 * « Catégorie budgétaire : seule son existence est vérifiée. » Un identifiant posté désignait
 * n'importe quelle ligne de n'importe quelle enveloppe : une prise en charge nationale pouvait
 * peser sur « Événements », un congrès de 2026 sur l'enveloppe 2027, la dépense d'une gamme sur
 * le budget d'une autre. Le serveur vérifie désormais TROIS choses, sur ce que le modèle porte :
 *
 *   1. LA NATURE — portée par `module` (catégorie, sinon sa parente la plus proche qui en déclare
 *      un ; à défaut, les `modules` de l'enveloppe). La nature de la demande se traduit en module
 *      budgétaire (`MODULE_BUDGET_DE_LA_NATURE`) : un événement s'impute sur `EVENTS`, une PEC
 *      nationale sur `CONGRESS_NATIONAL`… Une catégorie qui ne dit AUCUNE nature, dans une
 *      enveloppe qui n'en dit aucune non plus, ne contredit rien : elle passe (on ne devine pas).
 *   2. L'EXERCICE — la période de l'enveloppe (`periodStart` → `periodEnd`, au jour près) doit
 *      contenir la date de la demande. Une enveloppe désactivée ne reçoit plus rien.
 *   3. LA BUSINESS UNIT — quand celle de la demande est connue, une enveloppe ou une
 *      (sous-)catégorie rattachée à une AUTRE gamme est refusée. Sans BU d'un côté ou de
 *      l'autre, l'enveloppe est commune : elle passe.
 *
 * Module PUR, sans aucun import : la lecture (`categorie-budgetaire-serveur.ts`) passe des faits.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les six natures d'une demande Ad & Pro qui engagent un budget. */
export type NatureDemandeAdPro =
  | "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER" | "PROMO_MATERIAL";

/** Le module budgétaire de chaque nature — les codes que portent enveloppes et catégories (`MODULES_AD_PRO_BUDGET`). */
export const MODULE_BUDGET_DE_LA_NATURE: Record<NatureDemandeAdPro, string> = {
  SPONSORING: "SPONSORING",
  CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL",
  EVENT: "EVENTS",
  AD_PRO_OTHER: "AD_PRO_OTHER",
  PROMO_MATERIAL: "PROMO_MATERIAL",
};

export const LIBELLE_NATURE_DEMANDE: Record<NatureDemandeAdPro, string> = {
  SPONSORING: "un sponsoring",
  CONGRESS_NATIONAL: "une prise en charge nationale",
  CONGRESS_INTERNATIONAL: "une prise en charge internationale",
  EVENT: "un événement",
  AD_PRO_OTHER: "une autre demande Ad & Pro",
  PROMO_MATERIAL: "un matériel promotionnel",
};

const LIBELLE_MODULE: Record<string, string> = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prises en charge nationales",
  CONGRESS_INTERNATIONAL: "Prises en charge internationales",
  EVENTS: "Événements",
  AD_PRO_OTHER: "Autres demandes Ad & Pro",
  PROMO_MATERIAL: "Matériel promotionnel",
};
const libelleModule = (m: string) => LIBELLE_MODULE[m] ?? m;

export interface NoeudCategorieControle {
  nom: string;
  module: string | null;
  businessUnitId: string | null;
}

export interface CategoriePourControle extends NoeudCategorieControle {
  /** Les parentes, de la plus proche à la racine. */
  ancetres: readonly NoeudCategorieControle[];
  enveloppe: {
    nom: string;
    isActive: boolean;
    modules: readonly string[];
    /** Module principal (déprécié). */
    module: string | null;
    periodStart: Date;
    periodEnd: Date;
    businessUnitId: string | null;
  };
}

export interface DemandePourControle {
  nature: NatureDemandeAdPro;
  /** La date de la demande — c'est son exercice qui doit porter la dépense. */
  date: Date;
  /** La Business Unit de la demande (celle du demandeur), quand elle est connue. */
  businessUnitId: string | null;
}

/** La nature que déclare la catégorie : la sienne, sinon celle de la parente la plus proche qui en déclare une. */
export function moduleDeLaCategorie(cat: Pick<CategoriePourControle, "module" | "ancetres">): string | null {
  if (cat.module) return cat.module;
  for (const a of cat.ancetres) if (a.module) return a.module;
  return null;
}

const jour = (d: Date) => d.toISOString().slice(0, 10);
const fr = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "UTC" });

/**
 * Le REFUS (phrase française) si la catégorie ne convient pas à la demande, sinon `null`.
 * L'ordre suit la question qu'on se pose : de quoi est-ce la dépense, de quelle année, de quelle gamme.
 */
export function refusCategoriePourDemande(cat: CategoriePourControle, demande: DemandePourControle): string | null {
  const attendu = MODULE_BUDGET_DE_LA_NATURE[demande.nature];
  const nomCat = `« ${cat.nom} » (enveloppe « ${cat.enveloppe.nom} »)`;

  if (!cat.enveloppe.isActive) return `La catégorie ${nomCat} appartient à une enveloppe désactivée : elle ne reçoit plus de dépense.`;

  // 1. LA NATURE
  const declare = moduleDeLaCategorie(cat);
  if (declare) {
    if (declare !== attendu) {
      return `La catégorie ${nomCat} est réservée aux dépenses « ${libelleModule(declare)} » : elle ne peut pas porter ${LIBELLE_NATURE_DEMANDE[demande.nature]}. Choisissez une catégorie « ${libelleModule(attendu)} ».`;
    }
  } else {
    const couverts = [...new Set([...cat.enveloppe.modules, ...(cat.enveloppe.module ? [cat.enveloppe.module] : [])])];
    if (couverts.length > 0 && !couverts.includes(attendu)) {
      return `L'enveloppe « ${cat.enveloppe.nom} » ne couvre pas les dépenses « ${libelleModule(attendu)} » (elle couvre : ${couverts.map(libelleModule).join(", ")}) : elle ne peut pas porter ${LIBELLE_NATURE_DEMANDE[demande.nature]}.`;
    }
  }

  // 2. L'EXERCICE — au jour près : une période saisie « 31/12 » s'arrête à minuit, pas avant.
  const j = jour(demande.date);
  if (j < jour(cat.enveloppe.periodStart) || j > jour(cat.enveloppe.periodEnd)) {
    return `La catégorie ${nomCat} relève de l'exercice du ${fr(cat.enveloppe.periodStart)} au ${fr(cat.enveloppe.periodEnd)} : la demande, datée du ${fr(demande.date)}, n'en fait pas partie. Choisissez une catégorie de l'enveloppe de son exercice.`;
  }

  // 3. LA BUSINESS UNIT
  if (demande.businessUnitId) {
    const rattachements = [cat.enveloppe.businessUnitId, cat.businessUnitId, ...cat.ancetres.map((a) => a.businessUnitId)];
    if (rattachements.some((bu) => bu != null && bu !== demande.businessUnitId)) {
      return `La catégorie ${nomCat} est rattachée à une autre Business Unit que celle de la demande : la dépense d'une gamme ne pèse pas sur le budget d'une autre.`;
    }
  }
  return null;
}
