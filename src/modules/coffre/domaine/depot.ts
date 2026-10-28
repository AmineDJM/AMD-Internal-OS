import type { NatureCoffre } from "./natures";
import type { TitulaireCoffre } from "./politique";

/**
 * LE PORT DU COFFRE — ce que le service attend d'un stockage, sans dire lequel.
 *
 * Le dépôt ne voit JAMAIS une valeur en clair : il reçoit et rend des chiffrés, des empreintes et
 * des masques. Le chiffrement, la normalisation et la politique de lecture restent au service
 * (`service.ts`) ; un dépôt ne peut donc ni fuiter une valeur, ni décider seul d'une lecture.
 */

/** Le titulaire tel qu'il est STOCKÉ : la fiche, pas le compte (le compte se résout à la lecture). */
export type RefTitulaire =
  | { genre: "PERSONNE"; personneId: string }
  | { genre: "ORGANISATION"; organisationId: string };

export function refTitulaire(t: TitulaireCoffre): RefTitulaire {
  return t.genre === "PERSONNE" ? { genre: "PERSONNE", personneId: t.personneId } : { genre: "ORGANISATION", organisationId: t.organisationId };
}

export interface DonneeSensibleStockee {
  id: string;
  titulaire: RefTitulaire;
  nature: NatureCoffre;
  /** `c1.<id de clé>.<…>` — voir `chiffrement.ts`. */
  valeurChiffree: string;
  /** HMAC-SHA256 hexadécimal de la valeur normalisée. */
  empreinte: string;
  /** Caractères affichables (quatre derniers, année d'expiration), `null` pour un salaire. */
  derniers4: string | null;
  pieceSourceId: string | null;
  valideDu: Date | null;
  valideAu: Date | null;
  deposeParId: string | null;
  deposeLe: Date;
}

/** Une donnée sans son chiffré : ce que rend une recherche. */
export type ResumeDonneeSensible = Omit<DonneeSensibleStockee, "valeurChiffree">;

/** Une ligne du journal : qui a demandé quoi, quand, pour quel geste, et ce qui a été répondu. */
export interface AccesDonneeSensibleJournal {
  donneeId: string;
  lecteurGenre: "UTILISATEUR" | "IA";
  /** Compte du lecteur ; `null` pour un modèle d'IA. */
  lecteurId: string | null;
  /** Nom du modèle d'IA refusé ; `null` pour un utilisateur. */
  lecteurNom: string | null;
  geste: string;
  autorise: boolean;
  motif: string;
  le: Date;
}

export interface DepotCoffre {
  deposer(donnee: DonneeSensibleStockee): Promise<void>;
  /**
   * Lit une donnée ET écrit sa ligne de journal dans la MÊME transaction : une lecture sans trace
   * n'existe pas. `decider` reçoit la ligne (sans qu'elle soit déchiffrée) et rend l'accès à
   * journaliser ; refus compris. `null` si la donnée n'existe pas (rien à journaliser).
   */
  lireAvecJournal(
    id: string,
    decider: (donnee: DonneeSensibleStockee) => Promise<AccesDonneeSensibleJournal>,
  ): Promise<{ donnee: DonneeSensibleStockee; acces: AccesDonneeSensibleJournal } | null>;
  /** Données d'une nature dont l'empreinte vaut `empreinte`, éventuellement d'un seul titulaire. */
  chercherParEmpreinte(nature: NatureCoffre, empreinte: string, titulaire?: RefTitulaire): Promise<ResumeDonneeSensible[]>;
}
