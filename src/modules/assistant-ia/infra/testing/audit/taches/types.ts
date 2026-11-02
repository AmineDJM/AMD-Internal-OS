/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — LE CONTRAT D'UNE TÂCHE, partagé par tous les domaines (`./index.ts`).
 *
 * Une tâche mesure : la RÉUSSITE (la bonne carte, ses champs justes, l'objet créé en base APRÈS le clic « Confirmer »
 * simulé, le fichier produit, ou le vérificateur du domaine), le NOMBRE DE QUESTIONS avant d'agir (cible 0 ; au plus
 * `questionsMax`), la vérité (« c'est fait » jamais dit sans outil réussi), la beauté d'un mail, la latence et le coût.
 *
 * RÈGLES D'ÉCRITURE (tenues par `audit-assistant.test.ts`) : (1) aucune tâche ne réussit sur une observation VIDE — son
 * jugement ou son vérificateur doit échouer quand rien n'est fait (« le banc à vide ») ; (2) une tâche de REFUS (sans carte,
 * objet, fichier, mail ni vérificateur) déclare `contient` — ce que le refus doit DIRE (« droit », « accès », « réservé »…) :
 * `interdit` ou `pasPlusDe` seuls réussiraient sur une réponse vide.
 *
 * Un DOMAINE (fichier de `taches/`) n'écrit que ses tâches et, s'il en a besoin, son SEMIS (`SemisDeDomaine`, appelé
 * après le semis commun) et ses VÉRIFICATEURS (`verifier`, appelé après la tâche). Aucun domaine ne touche aux autres.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { PersonaCle, Titulaire } from "../personas";

/** L'objet attendu en base (compté avant / après) — après le clic « Confirmer » quand une carte est attendue. */
export type ObjetAttendu =
  | "tache" | "message" | "mail" | "sponsoring" | "prise_en_charge" | "materiel_promo" | "validation" | "note" | "mission" | "routine" | "fichier" | "memoire" | "rendez_vous"
  | "conge" | "demande_rh" | "evenement" | "document_legal" | "demande_admin";

/** Une pièce du semis : un nœud du Drive (id, nom), déposé chez une persona. */
export interface PieceSemee { id: string; nom: string }

/** Ce que reçoit le vérificateur d'un domaine, une fois la tâche jouée (et la carte confirmée, si elle l'a été). */
export interface ContexteVerification {
  userId: string;
  /** Les comptes semés (titulaire → id) et les pièces de tous les domaines. */
  users: Record<Titulaire, string>;
  pieces: Record<string, PieceSemee>;
  /** Le début de la tâche : ce qui est créé depuis est l'œuvre de la tâche. */
  t0: Date;
  carte: { titre: string; champs: string[]; payload: unknown; statut: string } | null;
  /** Les réponses de l'assistant (texte et blocs), dans l'ordre. */
  reponses: string[];
  /** Les fichiers déposés dans le Drive de la persona pendant la tâche (texte extrait). */
  fichiers: { nom: string; mime: string; texte: string }[];
  /** La carte a été confirmée et exécutée par le banc. */
  executee: boolean;
}

export interface Tache {
  id: string;
  /** Rempli par l'index : le domaine (fichier) d'où vient la tâche — le rapport compte par domaine. */
  domaine?: string;
  categorie: string;
  persona: PersonaCle;
  tours: string[];
  /** La réponse que la persona donne si l'assistant lui pose une question (comptée). */
  precision?: string;
  /** Le message est DIT (délégation vocale) au lieu d'être écrit. */
  voix?: boolean;
  /** Une pièce du semis jointe au premier message : « devis » (socle) ou une clé posée par le semis d'un domaine. */
  piece?: string;
  attendu: {
    /** La carte attendue (titre ou genre) — absente : une réponse seule (lecture, analyse). */
    carte?: RegExp;
    /** Des champs de la carte : [libellé, valeur attendue]. */
    champs?: [RegExp, RegExp][];
    /** Des champs qui ne doivent PAS porter cette valeur (inversion fournisseur / client). */
    champsInterdits?: [RegExp, RegExp][];
    objet?: ObjetAttendu;
    /** Le banc ne clique pas « Confirmer » (la carte suffit, ou l'objet naît sans carte). */
    sansConfirmer?: boolean;
    /** Un fichier produit pendant le tour (nom ou type). */
    fichier?: RegExp;
    contient?: RegExp[];
    interdit?: RegExp[];
    mail?: { tableau?: boolean };
    questionsMax?: number;
    /** Le nombre d'un objet ne doit PAS augmenter (une fusion qui crée une troisième mission). */
    pasPlusDe?: ObjetAttendu;
  };
  /** Le vérificateur du domaine : les motifs d'échec (vide = réussi), lus EN BASE après la tâche. */
  verifier?: (c: ContexteVerification) => Promise<string[]>;
}

/** L'aide d'écriture d'une tâche (même ordre partout : id, catégorie, persona, tours, attendu, options). */
export const tache = (id: string, categorie: string, persona: PersonaCle, tours: string | string[], attendu: Tache["attendu"], o: Partial<Tache> = {}): Tache => ({
  id, categorie, persona, tours: Array.isArray(tours) ? tours : [tours], attendu, ...o,
});

/** Le semis d'un domaine : reçoit les comptes et les gestes de dépôt, rend ses pièces (clé → nœud du Drive). */
export type SemisDeDomaine = (c: {
  etiquette: string;
  users: Record<Titulaire, string>;
  employes: Record<Titulaire, string>;
  companyId: string;
}) => Promise<Record<string, PieceSemee>>;

export interface Domaine {
  /** Le nom court, préfixe des identifiants (« socle », « documents », « transverse »…). */
  nom: string;
  taches: Tache[];
  semer?: SemisDeDomaine;
}
