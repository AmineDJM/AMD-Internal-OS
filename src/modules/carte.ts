/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE DES MODULES — qui a le droit de lire qui (rapport d'audit 08, §3.1 règle 4).
 *
 * Chaque module migré sous `src/modules/<module>/` figure ici avec la liste des modules qu'il
 * peut importer (par leur porte). Un module absent de la liste d'un autre lui est INTERDIT.
 * `frontieres.test.ts` mesure les imports réels et exige : arêtes mesurées ⊆ carte, carte sans
 * cycle, et chaque arête déclarée réellement utilisée (une permission morte se retire).
 *
 * LE SOCLE MÉTIER (`SOCLE_METIER`) : les référentiels que tout le monde lit. Ils ne lisent que
 * d'autres modules du socle — jamais un métier (proposition §5.3 : « tout le monde le lit, lui ne
 * lit personne »).
 *
 * Donnée pure, sans import : lue par les tests et par la documentation (`docs/architecture/MODULES.md`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const CARTE = {
  // ── Socle métier : les référentiels ────────────────────────────────────────────────────────
  /** Wilayas et communes : normaliser un lieu écrit à la main, poser `wilayaCode`. */
  lieux: [],
  /** Données sensibles chiffrées (IBAN, RIB, NIN, salaire) : double écriture, lecture journalisée. */
  coffre: [],
  /** Personnes, organisations, coordonnées : double écriture, doublons, fusion, reprises. */
  referentiels: ["lieux", "coffre"],

  // ── Métiers ────────────────────────────────────────────────────────────────────────────────
  /** Consumption Intelligence : imports de ventes, résolution, affinité (module pilote). */
  consommation: [],
  /**
   * Ad & Pro : sponsoring, congrès, événements, « autres », prise en charge, postes, porte du DG,
   * centre de validation, clôture. Relie les personnes qu'il crée au référentiel (double écriture).
   */
  "ad-pro": ["referentiels"],
  /** RH : congés, paie (par le centre de paiement), avances, notes de frais, documents RH, organisation. */
  rh: ["coffre", "referentiels", "bibliotheque"],
  /**
   * Bibliothèque (J1) : toute pièce entrée est inscrite au registre (`Piece`/`PieceLien`), lue une fois, découpée,
   * vectorisée ; une requête la retrouve par son contenu, sous la règle d'ouverture de l'écran qui la sert.
   */
  bibliotheque: [],
} as const satisfies Record<string, readonly string[]>;

export type NomModule = keyof typeof CARTE;

/** Les modules du socle métier : lus par tous, ils ne lisent que le socle. */
export const SOCLE_METIER: readonly NomModule[] = ["lieux", "coffre", "referentiels"];
