/**
 * LA MÉMOIRE PERSONNELLE DE L'ASSISTANT IA — la part PURE (types, libellés, bornes), sans aucun
 * import : l'écran (navigateur) et le serveur la lisent tous deux. Le module serveur
 * (`memoire.ts`) la réexporte.
 *
 * M1 (décision 0045) : la mémoire ne porte plus seulement le travail. Ce que la personne dit D'ELLE — sa famille, ses
 * études, ses voyages, ses goûts — a désormais sa sorte, son libellé et son groupe dans « Ce qu'il retient ».
 */

/** Les sortes de souvenirs, dans l'ordre où le panneau les montre. */
export const SORTES_MEMOIRE = [
  "PERSONNEL_IDENTITE", "FAMILLE", "ETUDES_PARCOURS", "SANTE_DECLAREE",
  "VOYAGES", "GOUTS_LOISIRS", "PROJETS",
  "ORGANIZATIONAL_CONTEXT", "WORKING_STYLE", "CONTRAINTES", "PERSONNES_CITEES",
  "USER_PREFERENCE", "ENTITY_ALIAS", "TERMINOLOGY",
] as const;
export type SorteMemoire = (typeof SORTES_MEMOIRE)[number];

export const LIBELLE_SORTE: Record<SorteMemoire, string> = {
  PERSONNEL_IDENTITE: "Qui je suis",
  FAMILLE: "Famille et proches",
  ETUDES_PARCOURS: "Études et parcours",
  SANTE_DECLAREE: "Santé (ce que j'en ai dit)",
  VOYAGES: "Voyages",
  GOUTS_LOISIRS: "Goûts et loisirs",
  PROJETS: "Projets",
  ORGANIZATIONAL_CONTEXT: "Mon contexte (société, service, produits)",
  WORKING_STYLE: "Habitude de travail",
  CONTRAINTES: "Contraintes et disponibilités",
  PERSONNES_CITEES: "Personnes que je cite",
  USER_PREFERENCE: "Préférence",
  ENTITY_ALIAS: "Raccourci (alias)",
  TERMINOLOGY: "Vocabulaire",
};

/** Les GROUPES du panneau « Ce qu'il retient » — chaque sorte appartient à un seul. */
export const GROUPES_MEMOIRE: readonly { titre: string; sortes: readonly SorteMemoire[] }[] = [
  { titre: "Moi", sortes: ["PERSONNEL_IDENTITE", "FAMILLE", "ETUDES_PARCOURS", "SANTE_DECLAREE"] },
  { titre: "Ma vie", sortes: ["VOYAGES", "GOUTS_LOISIRS", "PROJETS"] },
  { titre: "Mon travail", sortes: ["ORGANIZATIONAL_CONTEXT", "WORKING_STYLE", "CONTRAINTES", "PERSONNES_CITEES"] },
  { titre: "Comment me répondre", sortes: ["USER_PREFERENCE", "ENTITY_ALIAS", "TERMINOLOGY"] },
];

export const estSorteMemoire = (v: unknown): v is SorteMemoire =>
  typeof v === "string" && (SORTES_MEMOIRE as readonly string[]).includes(v);

/** Bornes : une phrase, pas un document ; une mémoire, pas un entrepôt. */
export const MEMOIRE_MAX_CARACTERES = 400;
export const MEMOIRE_MAX_ELEMENTS = 300;

/** D'où vient un souvenir — dit dans le panneau. */
export type OrigineMemoire = "manuel" | "propose" | "auto" | "voix";
export const LIBELLE_ORIGINE: Record<OrigineMemoire, string> = {
  manuel: "ajouté par vous",
  propose: "retenu sur votre confirmation",
  auto: "retenu de la conversation",
  voix: "retenu de la conversation vocale",
};

export interface ElementMemoire {
  id: string;
  sorte: SorteMemoire | string;
  contenu: string;
  modifieLe: string;
  /** M1 : origine, conversation d'origine (son titre), date de la source, et combien de versions il a remplacées. */
  origine?: OrigineMemoire | string;
  conversation?: { id: string; titre: string | null } | null;
  sourceLe?: string;
  versionsAnterieures?: number;
}

/** Une mémoire proposée par l'assistant, en attente de la confirmation de la personne. */
export interface MemoireProposee {
  contenu: string;
  sorte: SorteMemoire;
}

/** M1 : un souvenir RETENU d'office après un tour — la ligne « Retenu : … (annuler) » de la conversation. */
export interface MemoireRetenue {
  id: string;
  contenu: string;
  sorte: string;
  /** « ajoute » : un fait neuf ; « remplace » : un fait qui a changé (l'ancien est dans l'historique). */
  geste: "ajoute" | "remplace";
  /** Annulé depuis (la ligne le dit, le souvenir n'existe plus ou l'ancien est revenu). */
  annule?: boolean;
}

/** La ligne discrète de la conversation : « Retenu : Part à Lyon le 12 avec sa fille Lina ». */
export const ligneRetenu = (m: Pick<MemoireRetenue, "contenu" | "geste">): string =>
  `${m.geste === "remplace" ? "Mis à jour" : "Retenu"} : ${m.contenu}`;
