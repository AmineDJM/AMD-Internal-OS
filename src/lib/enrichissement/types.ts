/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT DE L'ENRICHISSEMENT — ce qu'une pièce déposée produit, avant toute écriture.
 *
 * Module pur, ZÉRO import : classement, extracteurs, moteur de décision et écrivains partagent ces
 * types (refonte des données, `docs/architecture/refonte-donnees-et-monolithe-modulaire.md`, §3-E).
 *
 *   pièce → nature (`NaturePiece`) → extraction (`ResultatExtraction` : des `FaitExtrait`)
 *         → décision (confirmé d'office / à confirmer / conflit / coffre) → fiche.
 *
 * Un fait n'est JAMAIS une écriture : c'est une proposition, avec sa preuve (page, extrait) et sa
 * confiance. Une valeur sensible (`sensible: true`) ne va qu'au coffre, jamais dans une fiche en
 * clair, et ne quitte jamais le serveur vers un modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_PIECE = [
  "PASSEPORT", "CNI", "PERMIS_CONDUIRE", "VISA",
  "DEVIS", "FACTURE", "BON_DE_COMMANDE", "AVOIR", "BON_LIVRAISON",
  "CONTRAT", "CONVENTION", "RIB", "REGISTRE_COMMERCE", "ATTESTATION_NIF", "CARTE_IMMATRICULATION_FISCALE",
  "CV", "DIPLOME", "CARTE_VISITE", "ATTESTATION", "BULLETIN_PAIE",
  "PROGRAMME_CONGRES", "INVITATION", "BILLET_TRANSPORT", "RESERVATION_HOTEL",
  "COURRIER", "PROCES_VERBAL", "AUTRE",
] as const;
export type NaturePiece = (typeof NATURES_PIECE)[number];

/** Les natures qui ne se lisent QUE sur ce serveur (OCR local, aucun modèle externe). */
export const NATURES_LOCALES: readonly NaturePiece[] = ["PASSEPORT", "CNI", "PERMIS_CONDUIRE", "VISA", "BULLETIN_PAIE", "RIB"];

export type TypeSujet = "PERSONNE" | "ORGANISATION" | "PRODUIT";

/**
 * Le rôle du sujet DANS la pièce — c'est lui qui permet de rattacher les faits : sur un devis,
 * l'« ÉMETTEUR » est le fournisseur et le « DESTINATAIRE » une société du groupe ; sur un passeport,
 * le « TITULAIRE ».
 */
export type RoleSujet = "TITULAIRE" | "EMETTEUR" | "DESTINATAIRE" | "SIGNATAIRE" | "PARTIE" | "ORGANISATEUR" | "MENTIONNE";

export type TypeValeur = "texte" | "date" | "nombre" | "montant" | "email" | "telephone" | "identifiant" | "adresse" | "url" | "pays";

export interface Attribut {
  /** Clé stable — « personne.nom », « organisation.nif ». La renommer orphelinerait les faits. */
  cle: string;
  sujet: TypeSujet;
  libelle: string;
  type: TypeValeur;
  /** Va au coffre, jamais en clair dans une fiche, jamais à un modèle. */
  sensible: boolean;
  /** Identifie le sujet (deux sujets ne peuvent pas partager la valeur). */
  identifiant: boolean;
  /** Peut être confirmé d'office si la confiance et la nature de la pièce le permettent. */
  autoConfirmable: boolean;
  /** Plusieurs valeurs vivantes à la fois (téléphones, diplômes) — sinon une seule, historisée. */
  multiple: boolean;
}

const a = (cle: string, libelle: string, type: TypeValeur, o: Partial<Omit<Attribut, "cle" | "libelle" | "type" | "sujet">> = {}): Attribut => ({
  cle, sujet: cle.startsWith("personne.") ? "PERSONNE" : cle.startsWith("organisation.") ? "ORGANISATION" : "PRODUIT",
  libelle, type, sensible: false, identifiant: false, autoConfirmable: false, multiple: false, ...o,
});

/** LE CATALOGUE DES ATTRIBUTS — fermé : un extracteur ne propose que ce qui y figure. */
export const ATTRIBUTS: readonly Attribut[] = [
  a("personne.civilite", "Civilité", "texte"),
  a("personne.nom", "Nom", "texte"),
  a("personne.prenoms", "Prénom(s)", "texte"),
  a("personne.naissance", "Date de naissance", "date"),
  a("personne.lieuNaissance", "Lieu de naissance", "texte"),
  a("personne.sexe", "Sexe", "texte"),
  a("personne.nationalite", "Nationalité", "pays"),
  a("personne.email", "E-mail", "email", { autoConfirmable: true, multiple: true }),
  a("personne.telephone", "Téléphone", "telephone", { autoConfirmable: true, multiple: true }),
  a("personne.adresse", "Adresse", "adresse", { autoConfirmable: true }),
  a("personne.fonction", "Fonction", "texte", { multiple: true }),
  a("personne.specialite", "Spécialité médicale", "texte"),
  a("personne.diplome", "Diplôme", "texte", { multiple: true }),
  a("personne.experience", "Expérience", "texte", { multiple: true }),
  a("personne.langue", "Langue", "texte", { multiple: true }),
  a("personne.passeport.numero", "N° de passeport", "identifiant", { sensible: true, identifiant: true }),
  a("personne.passeport.expiration", "Expiration du passeport", "date", { sensible: true }),
  a("personne.cni.numero", "N° de carte d'identité", "identifiant", { sensible: true, identifiant: true }),
  a("personne.nin", "NIN", "identifiant", { sensible: true, identifiant: true }),
  a("personne.salaire", "Rémunération", "montant", { sensible: true }),
  a("personne.rib", "RIB / IBAN", "identifiant", { sensible: true }),

  a("organisation.raisonSociale", "Raison sociale", "texte"),
  a("organisation.nomCommercial", "Nom commercial", "texte", { multiple: true }),
  a("organisation.formeJuridique", "Forme juridique", "texte"),
  a("organisation.capital", "Capital social", "montant"),
  a("organisation.nif", "NIF", "identifiant", { identifiant: true }),
  a("organisation.nis", "NIS", "identifiant", { identifiant: true }),
  a("organisation.rc", "Registre du commerce", "identifiant", { identifiant: true }),
  a("organisation.ai", "Article d'imposition", "identifiant", { identifiant: true }),
  a("organisation.agrement", "N° d'agrément", "identifiant", { multiple: true }),
  a("organisation.adresse", "Adresse", "adresse", { autoConfirmable: true, multiple: true }),
  a("organisation.telephone", "Téléphone", "telephone", { autoConfirmable: true, multiple: true }),
  a("organisation.email", "E-mail", "email", { autoConfirmable: true, multiple: true }),
  a("organisation.siteWeb", "Site web", "url", { autoConfirmable: true }),
  a("organisation.banque", "Banque", "texte"),
  a("organisation.rib", "RIB / IBAN", "identifiant", { sensible: true }),
  a("organisation.representant", "Représentant légal", "texte"),

  a("produit.prixUnitaireHt", "Prix unitaire HT", "montant", { multiple: true }),
  a("produit.designationFournisseur", "Désignation chez le fournisseur", "texte", { multiple: true }),
];

export const ATTRIBUT_PAR_CLE: ReadonlyMap<string, Attribut> = new Map(ATTRIBUTS.map((x) => [x.cle, x]));

/** Un fait lu sur une pièce — une PROPOSITION, jamais une écriture. */
export interface FaitExtrait {
  /** Identifiant local du sujet dans la pièce (« titulaire », « emetteur », « ligne-3 ») : groupe les faits d'un même sujet. */
  sujetRef: string;
  sujetType: TypeSujet;
  role: RoleSujet;
  /** Une clé de `ATTRIBUTS`. */
  attribut: string;
  /** Telle que lue (bornée). */
  valeur: string;
  /** Normalisée pour comparer (chiffres seuls pour un NIF, E.164 pour un téléphone, ISO pour une date). */
  valeurNormalisee: string;
  /** 0 à 1. */
  confiance: number;
  preuve: { page: number | null; extrait: string };
  /** Recopié du catalogue : un fait sensible ne quitte jamais le serveur. */
  sensible: boolean;
}

export interface ResultatExtraction {
  nature: NaturePiece;
  /** « mrz-local/1 », « pieces-lues/3 », « regles-cv/1 »… */
  moteur: string;
  /** Vrai : rien n'est sorti du serveur. */
  local: boolean;
  faits: FaitExtrait[];
  /** Ce qui n'a pas pu être lu, dit — jamais un silence. */
  notes: string[];
}

export interface ClassementPiece {
  nature: NaturePiece;
  confiance: number;
  /** Pourquoi : les indices retenus (« zone MRZ », « Devis N° », « NIF »). */
  indices: string[];
}

export type DecisionFait =
  | { decision: "CONFIRMER_D_OFFICE"; raison: string }
  | { decision: "A_CONFIRMER"; raison: string }
  | { decision: "CONFLIT"; raison: string; valeurActuelle: string }
  | { decision: "COFFRE"; raison: string }
  | { decision: "IGNORER"; raison: string };
