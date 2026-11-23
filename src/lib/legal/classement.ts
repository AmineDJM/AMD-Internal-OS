/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEMENT DES PIÈCES AD & PRO DANS LEGAL (recette du 23/11/2026) — règles PURES.
 *
 * « Tous les documents doivent être rangés dans Legal de façon structurée : quand on cherche un BC
 * ou une facture d'un événement, on doit savoir qu'il est à cet événement. »
 *
 * Chaque pièce rattachée à un poste (devis, bon de commande — signé compris, c'est la même fiche —,
 * facture) se range dans l'armoire Legal sous SA demande :
 *
 *     Événements › 2026 › Journée régionale de cardiologie
 *     Sponsorings › 2026 › SP-2026-014
 *
 * Un dossier par demande, et non un par nature : la colonne « Nature » et son filtre distinguent déjà
 * le devis, le BC et la facture, et ouvrir le dossier de l'événement montre TOUTE sa chaîne d'un coup.
 * La recherche lit aussi le nom du dossier : « BC cardiologie » retrouve le BC de l'événement.
 *
 * Aucun import : la page, la recherche et le composant client le relisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le dossier racine de chaque type de demande Ad & Pro. */
export const RACINES_CLASSEMENT: Record<string, string> = {
  EVENT: "Événements",
  SPONSORING: "Sponsorings",
  CONGRESS_NATIONAL: "Prises en charge nationales",
  CONGRESS_INTERNATIONAL: "Prises en charge internationales",
  AD_PRO_OTHER: "Autres demandes Ad & Pro",
};

/** Un nom de dossier propre : sans saut de ligne, sans espaces doublés, 120 caractères au plus. */
export function nomDeDossier(brut: string): string {
  const net = brut.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return (net.length > 120 ? `${net.slice(0, 119).trimEnd()}…` : net) || "Sans nom";
}

/** Le chemin de dossiers d'une pièce : racine du type, année, demande. `null` : type inconnu. */
export function cheminDeClassement(parent: string, annee: number, nomDemande: string): string[] | null {
  const racine = RACINES_CLASSEMENT[parent];
  if (!racine) return null;
  return [racine, String(annee), nomDeDossier(nomDemande)];
}

/**
 * LES MOTS QUI DÉSIGNENT UNE NATURE — « BC », « facture », « devis » ne sont écrits ni dans le titre
 * d'un bon de commande (« Bon de commande n° 045/DG/2026 — … » : « BC » n'y figure pas) ni dans sa
 * référence. La recherche les lit comme la nature elle-même.
 */
const MOTS_NATURE: [RegExp, string][] = [
  [/^(bc|bdc|bons?|commandes?|po)$/i, "PURCHASE_ORDER"],
  [/^(factures?|fact|fac|invoices?)$/i, "INVOICE"],
  [/^(devis|proformas?|pro-formas?|quotes?)$/i, "QUOTE"],
  [/^(contrats?|conventions?)$/i, "CONTRACT"],
];

export function natureDuMot(mot: string): string | null {
  const m = mot.trim();
  for (const [re, kind] of MOTS_NATURE) if (re.test(m)) return kind;
  return null;
}

/** « Événements › 2026 › Journée… » — le chemin lisible d'un dossier, d'après ses ancêtres. */
export function cheminLisible(noms: readonly string[]): string {
  return noms.filter(Boolean).join(" › ");
}
