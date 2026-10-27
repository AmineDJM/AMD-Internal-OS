import { derniersCaracteres, masque, normaliser, type NatureCoffre } from "./natures";

/**
 * LES COLONNES SENSIBLES COPIÉES AU COFFRE (refonte V2-E) — catalogue PUR (aucun import lourd).
 *
 * Une ligne par colonne en clair qui existe aujourd'hui (`refonte-p3-inventaire.md` §3). La colonne RESTE
 * (l'effacer est le palier P5, accord de la Direction) ; le coffre en tient une copie chiffrée, que la
 * reprise remplit, que la double écriture tient à jour et que la double lecture lit.
 *
 * `natures` : la première qui accepte la valeur l'emporte. La colonne « RIB / IBAN » d'un salarié ou le
 * RIB d'un fournisseur reçoit l'un ou l'autre selon ce qu'on a saisi ; on ne devine pas, on valide (clé
 * mod-97 de l'IBAN, clé RIB) — une valeur qui ne passe ni l'un ni l'autre n'entre pas au coffre et la
 * colonne reste seule à la porter.
 *
 * Hors catalogue, exprès : `Employee.cnasNumber` (pas de nature au coffre), `TreasuryAccount.rib` (le
 * compte du groupe, lu par les seules Finances), le RIB lu sur un devis (`AdProDevis.fournisseurLu`,
 * JSON) — voir `docs/architecture/refonte-v2e-coffre.md` §6.
 */

export const MODELES_SENSIBLES = ["Employee", "CompanyContact", "CompanyLegalIdentity"] as const;
export type ModeleSensible = (typeof MODELES_SENSIBLES)[number];

export interface ChampSensible {
  modele: ModeleSensible;
  champ: string;
  natures: readonly NatureCoffre[];
  /** Le genre du titulaire au référentiel : la fiche Personne du salarié, l'Organisation du tiers ou de la société. */
  titulaire: "PERSONNE" | "ORGANISATION";
  libelle: string;
}

export const CHAMPS_SENSIBLES: readonly ChampSensible[] = [
  { modele: "Employee", champ: "iban", natures: ["IBAN", "RIB"], titulaire: "PERSONNE", libelle: "RIB / IBAN du salarié" },
  { modele: "Employee", champ: "nationalId", natures: ["NIN"], titulaire: "PERSONNE", libelle: "NIN du salarié" },
  { modele: "Employee", champ: "baseSalary", natures: ["SALAIRE"], titulaire: "PERSONNE", libelle: "Salaire de base" },
  { modele: "Employee", champ: "grossSalary", natures: ["SALAIRE"], titulaire: "PERSONNE", libelle: "Salaire brut" },
  { modele: "Employee", champ: "netToPay", natures: ["SALAIRE"], titulaire: "PERSONNE", libelle: "Net à payer" },
  { modele: "Employee", champ: "employerCost", natures: ["SALAIRE"], titulaire: "PERSONNE", libelle: "Coût employeur" },
  { modele: "CompanyContact", champ: "rib", natures: ["RIB", "IBAN"], titulaire: "ORGANISATION", libelle: "RIB du partenaire" },
  { modele: "CompanyLegalIdentity", champ: "rib", natures: ["RIB", "IBAN"], titulaire: "ORGANISATION", libelle: "RIB de la société" },
  { modele: "CompanyLegalIdentity", champ: "iban", natures: ["IBAN", "RIB"], titulaire: "ORGANISATION", libelle: "IBAN de la société" },
];

export const LIBELLE_MODELE: Record<ModeleSensible, string> = {
  Employee: "Salarié",
  CompanyContact: "Partenaire (annuaire)",
  CompanyLegalIdentity: "Identité légale d'une société",
};

export function estModeleSensible(v: unknown): v is ModeleSensible {
  return typeof v === "string" && (MODELES_SENSIBLES as readonly string[]).includes(v);
}

export function champsDe(modele: ModeleSensible): readonly ChampSensible[] {
  return CHAMPS_SENSIBLES.filter((c) => c.modele === modele);
}

export function champSensible(modele: string, champ: string): ChampSensible | null {
  return CHAMPS_SENSIBLES.find((c) => c.modele === modele && c.champ === champ) ?? null;
}

/** Une valeur de colonne en texte : `Decimal` et nombres compris. `null` pour une colonne vide. */
export function texteDeColonne(brut: unknown): string | null {
  if (brut === null || brut === undefined) return null;
  const s = typeof brut === "string" ? brut : typeof brut === "number" || typeof brut === "object" ? String(brut) : "";
  return s.trim() === "" ? null : s.trim();
}

export type Classement =
  | { ok: true; nature: NatureCoffre; valeur: string }
  | { ok: false; vide: true }
  | { ok: false; vide: false; erreur: string };

/**
 * La nature et la forme canonique d'une valeur de colonne. Un salaire à zéro est VIDE (la colonne
 * `baseSalary` vaut 0 par défaut : ce n'est pas une rémunération). L'erreur ne recopie jamais la valeur.
 */
export function classerValeur(c: ChampSensible, brut: unknown): Classement {
  const s = texteDeColonne(brut);
  if (s === null) return { ok: false, vide: true };
  if (c.natures.includes("SALAIRE") && /^0+(?:[.,]0+)?$/.test(s)) return { ok: false, vide: true };
  let premiere: string | null = null;
  for (const nature of c.natures) {
    const n = normaliser(nature, s);
    if (n.ok) return { ok: true, nature, valeur: n.valeur };
    premiere ??= n.erreur;
  }
  const erreur = c.natures.length > 1 ? `${c.libelle} : ni ${c.natures.join(" ni ")} valide.` : premiere ?? `${c.libelle} invalide.`;
  return { ok: false, vide: false, erreur };
}

/**
 * Le masque d'une colonne en clair, sans le coffre : ce qu'on montre à qui ne lit pas la valeur.
 * Une valeur que le coffre refuse (mal formée) garde ses quatre derniers caractères, sans plus.
 */
export function masqueDepuisClair(c: ChampSensible, brut: unknown): string | null {
  const k = classerValeur(c, brut);
  if (k.ok) return masque(k.nature, derniersCaracteres(k.nature, k.valeur));
  if (k.vide) return null;
  const nature = c.natures[0];
  const compact = (texteDeColonne(brut) ?? "").replace(/\s/g, "");
  return masque(nature, nature === "SALAIRE" ? null : compact.slice(-4));
}

/** Une valeur saisie dans un formulaire qui n'est qu'un masque (« •••• 1234 ») : on garde la valeur en place. */
export function estUnMasque(saisie: unknown): boolean {
  return typeof saisie === "string" && saisie.includes("•");
}
