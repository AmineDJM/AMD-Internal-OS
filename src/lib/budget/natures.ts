/**
 * LA NATURE D'UNE DÉPENSE — billetterie, hôtellerie, inscriptions, sponsoring… (Budget Marketing, Direction 10/2026).
 *
 * Jamais devinée : elle se LIT sur ce que la dépense paie — la nature du poste Ad & Pro (`AdProItemKind`), la nature
 * de la case d'une prise en charge (`CareServiceKind`), et en dernier recours la rubrique comptable de l'écriture
 * quand elle dit une nature (déplacements). Tout le reste est « Non renseignée » : un camembert qui inventerait la
 * nature d'une dépense mentirait sur ce qu'on a acheté.
 *
 * Module PUR, sans aucun import (lu par le serveur, par l'écran et par les exports).
 */

export const NATURE_NON_RENSEIGNEE = "Non renseignée";

export const NATURES = {
  BILLETTERIE: "Billetterie",
  HOTELLERIE: "Hôtellerie",
  INSCRIPTIONS: "Inscriptions",
  SPONSORING_DIRECT: "Sponsoring d'associations",
  SPONSORING_INDIRECT: "Sponsoring indirect",
  REPAS: "Repas et dîners",
  TRANSPORT: "Transport local",
  DEPLACEMENTS: "Déplacements",
  VISAS: "Frais de visa",
  MATERIEL: "Matériel et impression",
  STANDS: "Stands, symposiums et salles",
  PRESTATIONS: "Prestations et consulting",
  AUTRES: "Autres natures",
} as const;

/** Nature d'un poste Ad & Pro (`AdProItemKind`). */
const PAR_POSTE: Record<string, string> = {
  TICKETING: NATURES.BILLETTERIE,
  ACCOMMODATION: NATURES.HOTELLERIE,
  ASSOCIATION_SUPPORT: NATURES.SPONSORING_DIRECT,
  INDIRECT_SUPPORT: NATURES.SPONSORING_INDIRECT,
  DINNER: NATURES.REPAS,
  CATERING: NATURES.REPAS,
  TRAVEL: NATURES.DEPLACEMENTS,
  PROMO_MATERIAL: NATURES.MATERIEL,
  PRINTING: NATURES.MATERIEL,
  STOCK_MATERIAL: NATURES.MATERIEL,
  STAND: NATURES.STANDS,
  SYMPOSIUM: NATURES.STANDS,
  VENUE: NATURES.STANDS,
  SERVICE: NATURES.PRESTATIONS,
  CONSULTING: NATURES.PRESTATIONS,
  OTHER: NATURES.AUTRES,
};

/** Nature d'une case de prise en charge (`CareServiceKind`). */
const PAR_SERVICE: Record<string, string> = {
  TICKET: NATURES.BILLETTERIE,
  HOTEL: NATURES.HOTELLERIE,
  REGISTRATION: NATURES.INSCRIPTIONS,
  CATERING: NATURES.REPAS,
  TRANSPORT: NATURES.TRANSPORT,
  VISA_FEE: NATURES.VISAS,
  PROMO_MATERIAL: NATURES.MATERIEL,
  OTHER: NATURES.AUTRES,
};

/** Rubrique comptable (`FinanceCategory`) : seule celle qui dit une nature compte. */
const PAR_RUBRIQUE: Record<string, string> = {
  VOYAGE: NATURES.DEPLACEMENTS,
};

export function natureDuPoste(kind: string | null | undefined): string | null {
  return kind ? PAR_POSTE[kind] ?? null : null;
}

export function natureDuService(kind: string | null | undefined): string | null {
  return kind ? PAR_SERVICE[kind] ?? null : null;
}

export function natureDeLaRubrique(categorie: string | null | undefined): string | null {
  return categorie ? PAR_RUBRIQUE[categorie] ?? null : null;
}

/**
 * La nature d'une dépense, dans l'ordre du plus précis au plus vague : le poste Ad & Pro, les cases de prise en charge
 * (une seule nature si toutes concordent), la rubrique comptable — sinon « Non renseignée ».
 */
export function natureDeLaDepense(s: { poste?: string | null; services?: readonly (string | null | undefined)[]; rubrique?: string | null }): string {
  const poste = natureDuPoste(s.poste);
  if (poste) return poste;
  const services = [...new Set((s.services ?? []).map(natureDuService).filter((x): x is string => Boolean(x)))];
  if (services.length === 1) return services[0];
  const rubrique = natureDeLaRubrique(s.rubrique);
  if (rubrique) return rubrique;
  return NATURE_NON_RENSEIGNEE;
}

/**
 * Une prise en charge payée par UN ordre couvrant PLUSIEURS cases de natures différentes (un devis d'agence pour le
 * billet et l'hôtel) : le montant se répartit au prorata des montants des cases — lus, jamais supposés. Sans montant
 * sur les cases, rien n'est réparti : tout va à « Non renseignée ».
 */
export function repartirParNature(montant: number, cases: readonly { service: string | null | undefined; montant: number | null | undefined }[]): { nature: string; montant: number }[] {
  const natures = [...new Set(cases.map((c) => natureDuService(c.service) ?? NATURE_NON_RENSEIGNEE))];
  if (natures.length === 1) return [{ nature: natures[0], montant }];
  const total = cases.reduce((a, c) => a + (c.montant && c.montant > 0 ? c.montant : 0), 0);
  if (!(total > 0)) return [{ nature: NATURE_NON_RENSEIGNEE, montant }];
  const parNature = new Map<string, number>();
  for (const c of cases) {
    const part = c.montant && c.montant > 0 ? (montant * c.montant) / total : 0;
    const n = natureDuService(c.service) ?? NATURE_NON_RENSEIGNEE;
    parNature.set(n, (parNature.get(n) ?? 0) + part);
  }
  return [...parNature].map(([nature, m]) => ({ nature, montant: m })).filter((x) => x.montant > 0);
}
