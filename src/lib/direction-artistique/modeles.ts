/**
 * LA DIRECTION ARTISTIQUE — quel modèle Word habille une pièce, et où ce choix est rangé.
 *
 * Module PUR, sans aucun import : l'écran (composant client) en lit les libellés, la fabrique
 * (serveur) en applique la règle. Une seule écriture de la règle, testée sans base.
 *
 * ── LA RÈGLE DU PAPIER D'UNE PIÈCE ──────────────────────────────────────────────────────────
 *
 *   1. le papier CHOISI pour cette pièce (le menu « Papier en-tête » du composeur) ;
 *   2. le modèle que la Direction artistique a désigné pour CETTE NATURE de pièce
 *      (`CompanyDocumentProfile.settings.modelesParType.BON_DE_COMMANDE`…) ;
 *   3. le papier en-tête PAR DÉFAUT de l'entité (`CompanyDocumentProfile.letterheadId`) ;
 *   4. le premier papier Word de l'entité, puis un papier commun au groupe.
 *
 * Et une règle qui passe avant toutes : JAMAIS le papier d'une autre entité. Écrire sur l'en-tête
 * d'une société, c'est l'engager — un réglage périmé ou un identifiant glissé dans un formulaire
 * ne doit pas pouvoir le faire. Un papier désigné qui n'est plus utilisable (retiré, supprimé,
 * rattaché ailleurs) est simplement sauté : on descend d'un cran, on ne sort pas sur un autre.
 */

/** Les natures de pièce dont la Direction artistique désigne le modèle (celles que la fabrique émet). */
export const TYPES_MODELE = ["BON_DE_COMMANDE", "DEVIS", "FACTURE", "AVOIR"] as const;
export type TypeModele = (typeof TYPES_MODELE)[number];

export const LIBELLE_TYPE_MODELE: Record<TypeModele, string> = {
  BON_DE_COMMANDE: "Bon de commande",
  DEVIS: "Devis",
  FACTURE: "Facture",
  AVOIR: "Avoir",
};

export const estTypeModele = (v: unknown): v is TypeModele => typeof v === "string" && (TYPES_MODELE as readonly string[]).includes(v);

type Reglages = Record<string, unknown>;

const objet = (v: unknown): Reglages | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Reglages) : null);

/** Les modèles désignés par nature, lus dans `settings.modelesParType` — seules les entrées bien formées comptent. */
export function lireModelesParType(settings: unknown): Partial<Record<TypeModele, string>> {
  const brut = objet(objet(settings)?.modelesParType);
  if (!brut) return {};
  const out: Partial<Record<TypeModele, string>> = {};
  for (const type of TYPES_MODELE) {
    const v = brut[type];
    if (typeof v === "string" && v.trim()) out[type] = v.trim();
  }
  return out;
}

/**
 * Le `settings` réécrit avec le modèle d'une nature (ou sans, si `letterheadId` est vide).
 * Les autres clés (`marque`, `numerotation`…) sont recopiées telles quelles : le profil est partagé.
 */
export function avecModeleParType(settings: unknown, type: TypeModele, letterheadId: string | null): Reglages {
  const base: Reglages = { ...(objet(settings) ?? {}) };
  const modeles: Record<string, string> = { ...lireModelesParType(settings) };
  if (letterheadId && letterheadId.trim()) modeles[type] = letterheadId.trim();
  else delete modeles[type];
  base.modelesParType = modeles;
  return base;
}

export interface PapierCandidat {
  id: string;
  kind: string;
  companyId: string | null;
  isActive: boolean;
}

export type SourcePapier = "choisi" | "nature" | "defaut" | "entite" | "commun";

export interface PapierResolu<T> {
  papier: T | null;
  source: SourcePapier | null;
  /** Un papier a été CHOISI explicitement mais n'est pas utilisable pour cette entité : la fabrique refuse. */
  choisiIntrouvable: boolean;
}

/** Les papiers Word actifs que cette entité peut porter : les siens, puis les communs. Jamais ceux d'une autre. */
export function papiersUtilisables<T extends PapierCandidat>(entetes: T[], societeId: string): T[] {
  const usable = entetes.filter((l) => l.isActive && l.kind === "word");
  return [
    ...usable.filter((l) => l.companyId === societeId),
    ...usable.filter((l) => l.companyId === null),
  ];
}

/** Applique la règle du papier d'une pièce (voir l'en-tête du module). */
export function resoudrePapierEnTete<T extends PapierCandidat>(
  entetes: T[],
  o: { societeId: string; choisi?: string | null; parNature?: string | null; defaut?: string | null },
): PapierResolu<T> {
  const usable = papiersUtilisables(entetes, o.societeId);
  const trouver = (id: string | null | undefined) => {
    const v = (id ?? "").trim();
    return v ? usable.find((l) => l.id === v) ?? null : null;
  };
  const voulu = (o.choisi ?? "").trim();
  if (voulu) {
    const choisi = trouver(voulu);
    return choisi ? { papier: choisi, source: "choisi", choisiIntrouvable: false } : { papier: null, source: null, choisiIntrouvable: true };
  }
  const nature = trouver(o.parNature);
  if (nature) return { papier: nature, source: "nature", choisiIntrouvable: false };
  const defaut = trouver(o.defaut);
  if (defaut) return { papier: defaut, source: "defaut", choisiIntrouvable: false };
  const premier = usable[0] ?? null;
  if (!premier) return { papier: null, source: null, choisiIntrouvable: false };
  return { papier: premier, source: premier.companyId === o.societeId ? "entite" : "commun", choisiIntrouvable: false };
}

/** Un modèle tel que l'écran le montre (lu côté serveur, rendu côté client). */
export interface ModeleLu {
  id: string;
  name: string;
  kind: string;
  /** null = commun au groupe. */
  companyId: string | null;
  isActive: boolean;
  size: number;
  updatedAt: string;
  uploadedBy: string | null;
}
