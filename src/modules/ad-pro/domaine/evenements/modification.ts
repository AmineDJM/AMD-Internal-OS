/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI MODIFIE UN ÉVÉNEMENT EN ENTIER — et quoi, une fois la prise en charge décidée (§118.184).
 *
 * L'audit 360° l'a mesuré : le formulaire complet d'un événement s'ouvrait au droit UPDATE du
 * module, que les délégués et les National Sales portent (CONTRIBUTE). Tout délégué réécrivait
 * donc l'événement d'un collègue — budget, médecins, produits —, même d'une autre société, et
 * même APRÈS la décision de prise en charge, ce qui transformait la décision en autre chose que
 * ce qui avait été décidé.
 *
 *   • La VUE GLOBALE (Direction, Directeur des opérations, Super Admin) modifie tout, toujours :
 *     c'est le seul niveau qui corrige un dossier tranché en assumant ce que cela veut dire — la
 *     même règle que la correction d'une demande (`ad-pro-edit.ts`).
 *   • QUI TRANCHE les événements (VALIDATE) modifie tout AVANT la décision ; APRÈS, seulement
 *     l'organisation (organisateur, lien de connexion, responsable, description, état). Ce qui a
 *     FONDÉ l'accord — nom, dates, lieu, médecins, produits, budget… — est figé : figer aussi
 *     l'organisation empêcherait d'ajouter le lien d'un webinaire déjà financé, un refus à tort
 *     plus coûteux que le défaut (§118.27).
 *   • Les autres ne passent pas par ici : le DEMANDEUR corrige SA demande tant qu'elle n'est pas
 *     tranchée, par la correction de demande (liste blanche), comme pour les cinq autres natures.
 *
 * Module PUR — l'écran (qui montre le bouton) et l'action (qui écrit) lisent la même réponse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type PorteeModificationEvenement = "TOUT" | "ORGANISATION" | "AUCUNE";

export function porteeModificationEvenement(f: {
  vueGlobale: boolean;
  /** Droit de VALIDER le module Événements. */
  tranche: boolean;
  /** La prise en charge est-elle décidée (`isAdProDecided`) ? Un événement sans circuit ne l'est jamais. */
  decided: boolean;
}): PorteeModificationEvenement {
  if (f.vueGlobale) return "TOUT";
  if (!f.tranche) return "AUCUNE";
  return f.decided ? "ORGANISATION" : "TOUT";
}

/** Ce qui a FONDÉ la décision de prise en charge — clé de colonne → libellé lisible. */
export const CHAMPS_DE_LA_DECISION: Readonly<Record<string, string>> = {
  name: "nom",
  businessUnitId: "Business Unit",
  type: "type",
  scope: "portée",
  format: "format",
  startDate: "date de début",
  endDate: "date de fin",
  location: "lieu",
  city: "ville",
  country: "pays",
  specialty: "spécialité",
  doctor: "médecins",
  products: "produits",
  estimatedBudget: "budget estimé",
};

/** Une valeur comparable : une date au jour près, un montant en nombre, un texte sans blanc, le vide unique. */
function normaliser(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "toNumber" in (v as object) && typeof (v as { toNumber: unknown }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** L'ORGANISATION d'un événement — ce qui reste modifiable après la décision. */
export const CHAMPS_ORGANISATION: Readonly<Record<string, string>> = {
  status: "état",
  description: "description",
  organizer: "organisateur",
  meetingLink: "lien de connexion",
  responsibleId: "responsable",
};

/**
 * Les colonnes à PLUSIEURS valeurs jointes (« A · B ») : leur ORDRE ne dit rien. Rouvrir le formulaire
 * recoche les médecins dans l'ordre de l'annuaire, puis ajoute ceux écrits à la main : la même liste
 * peut revenir dans un autre ordre, et y voir une modification bloquerait à tort qui ne touche qu'au
 * lien de connexion d'un événement déjà financé (§118.27).
 */
const MULTIVALUEES = new Set(["doctor", "products"]);

function normaliserMulti(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const noms = String(v).split(/\s·\s|·|\r?\n|;/).map((t) => t.trim()).filter(Boolean);
  return noms.length > 0 ? [...new Set(noms)].sort().join(" · ") : null;
}

/**
 * Les champs de `table` que cette écriture CHANGERAIT, en libellés. Une clé ABSENTE de l'écriture
 * (`undefined`) ne change rien : ce que le formulaire ne porte pas ne s'écrit pas (§118.152c).
 */
export function champsModifies(
  avant: Record<string, unknown>,
  apres: Record<string, unknown>,
  table: Readonly<Record<string, string>> = CHAMPS_DE_LA_DECISION,
): string[] {
  const out: string[] = [];
  for (const [cle, libelle] of Object.entries(table)) {
    if (!(cle in apres) || apres[cle] === undefined) continue;
    const lire = MULTIVALUEES.has(cle) ? normaliserMulti : normaliser;
    if (lire(avant[cle]) !== lire(apres[cle])) out.push(libelle);
  }
  return out;
}
