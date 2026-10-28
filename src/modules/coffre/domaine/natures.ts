/**
 * LES NATURES DU COFFRE — validation, normalisation, masque. Module PUR (aucun import).
 *
 * Une donnée n'entre au coffre que sous une forme canonique : c'est elle qu'on chiffre et dont on
 * calcule l'empreinte de recherche. Deux saisies du même IBAN (« dz58 0002… » et « DZ580002… »)
 * donnent donc la même empreinte, et une valeur mal formée est refusée AVANT d'être chiffrée — un
 * chiffré illisible pour les humains n'en serait que plus difficile à corriger ensuite.
 *
 * Le masque d'affichage montre les quatre derniers caractères, sauf pour le salaire : les quatre
 * derniers chiffres d'une rémunération en disent l'ordre de grandeur, il n'est donc jamais montré.
 */

export const NATURES_COFFRE = [
  "IBAN",
  "RIB",
  "NIN",
  "PASSEPORT_NUMERO",
  "PASSEPORT_EXPIRATION",
  "CNI_NUMERO",
  "SALAIRE",
] as const;
export type NatureCoffre = (typeof NATURES_COFFRE)[number];

/** Le domaine qui tient une nature : il décide de qui la lit (voir `politique.ts`). */
export type DomaineCoffre = "RH" | "FINANCES";

export const DOMAINE_DE: Record<NatureCoffre, DomaineCoffre> = {
  IBAN: "FINANCES",
  RIB: "FINANCES",
  NIN: "RH",
  PASSEPORT_NUMERO: "RH",
  PASSEPORT_EXPIRATION: "RH",
  CNI_NUMERO: "RH",
  SALAIRE: "RH",
};

/** Une organisation n'a ni NIN, ni passeport, ni salaire : seules ses coordonnées bancaires vont au coffre. */
export const NATURES_ORGANISATION: ReadonlySet<NatureCoffre> = new Set<NatureCoffre>(["IBAN", "RIB"]);

export const LIBELLE_NATURE: Record<NatureCoffre, string> = {
  IBAN: "IBAN",
  RIB: "RIB",
  NIN: "NIN",
  PASSEPORT_NUMERO: "N° de passeport",
  PASSEPORT_EXPIRATION: "Expiration du passeport",
  CNI_NUMERO: "N° de carte d'identité",
  SALAIRE: "Rémunération",
};

export function estNatureCoffre(v: unknown): v is NatureCoffre {
  return typeof v === "string" && (NATURES_COFFRE as readonly string[]).includes(v);
}

export type ResultatNormalisation =
  | { ok: true; valeur: string }
  | { ok: false; erreur: string };

const ok = (valeur: string): ResultatNormalisation => ({ ok: true, valeur });
const ko = (erreur: string): ResultatNormalisation => ({ ok: false, erreur });

/** Retire espaces (y compris insécables), tirets, points et barres obliques de séparation. */
const compacter = (s: string) => s.replace(/[\s  .\-/]/g, "");

/** Reste de la division d'un grand nombre écrit en chiffres décimaux par 97, sans BigInt. */
function mod97(chiffres: string): number {
  let r = 0;
  for (const c of chiffres) r = (r * 10 + (c.charCodeAt(0) - 48)) % 97;
  return r;
}

/**
 * IBAN (ISO 13616) — de 15 à 34 caractères, pays + 2 chiffres de contrôle, contrôle mod-97 = 1.
 * La longueur par pays n'est pas imposée : l'IBAN algérien n'est pas au registre SWIFT et les
 * banques ne l'écrivent pas toutes de la même longueur ; le mod-97 suffit à attraper une faute de frappe.
 */
export function normaliserIban(brut: string): ResultatNormalisation {
  const v = compacter(brut).toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return ko("IBAN mal formé : deux lettres de pays, deux chiffres de contrôle, puis 11 à 30 caractères.");
  const reordonne = v.slice(4) + v.slice(0, 4);
  const chiffres = reordonne.replace(/[A-Z]/g, (l) => String(l.charCodeAt(0) - 55));
  if (mod97(chiffres) !== 1) return ko("IBAN invalide : la clé de contrôle ne correspond pas (faute de frappe ?).");
  return ok(v);
}

/**
 * RIB algérien — 20 chiffres : banque (3), agence (5), compte (10), clé (2). Le CCP d'Algérie Poste
 * suit la même forme (banque 007).
 *
 * Clé : 97 − ((banque‖agence‖compte × 100) mod 97), donc 01 à 97. Autrement dit les 20 chiffres pris
 * comme un seul nombre sont divisibles par 97 — c'est ce qu'on vérifie.
 */
export function normaliserRib(brut: string): ResultatNormalisation {
  const v = compacter(brut);
  if (!/^\d{20}$/.test(v)) return ko("RIB mal formé : 20 chiffres attendus (banque, agence, compte, clé).");
  const cle = Number(v.slice(18));
  if (cle < 1 || cle > 97 || mod97(v) !== 0) return ko("RIB invalide : la clé RIB ne correspond pas (faute de frappe ?).");
  return ok(v);
}

/** La clé RIB attendue pour les 18 premiers chiffres (banque‖agence‖compte). */
export function cleRib(dixHuitChiffres: string): string {
  if (!/^\d{18}$/.test(dixHuitChiffres)) throw new Error("cleRib : 18 chiffres attendus.");
  return String(97 - mod97(dixHuitChiffres + "00")).padStart(2, "0");
}

/** NIN — Numéro d'Identification Nationale : 18 chiffres. */
export function normaliserNin(brut: string): ResultatNormalisation {
  const v = compacter(brut);
  if (!/^\d{18}$/.test(v)) return ko("NIN mal formé : 18 chiffres attendus.");
  return ok(v);
}

function normaliserNumeroPiece(brut: string, libelle: string, min: number, max: number): ResultatNormalisation {
  const v = compacter(brut).toUpperCase();
  if (!new RegExp(`^[A-Z0-9]{${min},${max}}$`).test(v)) return ko(`${libelle} mal formé : ${min} à ${max} lettres ou chiffres attendus.`);
  return ok(v);
}

/**
 * Date d'expiration → ISO `AAAA-MM-JJ`. Accepte `AAAA-MM-JJ` et `JJ/MM/AAAA` (ou `JJ.MM.AAAA`,
 * `JJ-MM-AAAA`), et refuse une date qui n'existe pas (31/02).
 */
export function normaliserDate(brut: string): ResultatNormalisation {
  const s = brut.trim();
  let a: number, m: number, j: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (r) [a, m, j] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{2})[/.\-](\d{2})[/.\-](\d{4})$/.exec(s))) [j, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return ko("Date mal formée : AAAA-MM-JJ ou JJ/MM/AAAA attendu.");
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== j) return ko("Date invalide : ce jour n'existe pas.");
  return ok(`${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`);
}

/**
 * Salaire en DZD → décimal canonique à deux chiffres (`185000.00`). Accepte « 185 000 », « 185 000,50 DA »,
 * « 185.000,50 DZD », « 185000.5 ». Refuse un montant nul, négatif ou ambigu.
 */
export function normaliserSalaire(brut: string): ResultatNormalisation {
  let s = brut.trim().replace(/\s*(?:DZD|DA|dinars?)\s*$/i, "").replace(/[\s  ]/g, "");
  if (!/^[\d.,]+$/.test(s)) return ko("Montant mal formé : chiffres attendus, en dinars.");
  const dernierSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  // Un séparateur suivi d'un ou deux chiffres en fin de chaîne est la virgule décimale ; les autres groupent les milliers.
  if (dernierSep >= 0 && s.length - dernierSep - 1 <= 2) {
    const entier = s.slice(0, dernierSep).replace(/[.,]/g, "");
    s = `${entier}.${s.slice(dernierSep + 1)}`;
  } else {
    s = s.replace(/[.,]/g, "");
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return ko("Montant mal formé.");
  const [ent, dec = ""] = s.split(".");
  const entier = ent.replace(/^0+(?=\d)/, "");
  if (/^0*$/.test(entier) && /^0*$/.test(dec)) return ko("Montant nul : une rémunération est positive.");
  return ok(`${entier}.${dec.padEnd(2, "0")}`);
}

/** Valide et met sous forme canonique une valeur selon sa nature. */
export function normaliser(nature: NatureCoffre, brut: string): ResultatNormalisation {
  if (typeof brut !== "string" || brut.trim() === "") return ko(`${LIBELLE_NATURE[nature]} vide.`);
  switch (nature) {
    case "IBAN": return normaliserIban(brut);
    case "RIB": return normaliserRib(brut);
    case "NIN": return normaliserNin(brut);
    case "PASSEPORT_NUMERO": return normaliserNumeroPiece(brut, "N° de passeport", 6, 12);
    case "CNI_NUMERO": return normaliserNumeroPiece(brut, "N° de carte d'identité", 6, 20);
    case "PASSEPORT_EXPIRATION": return normaliserDate(brut);
    case "SALAIRE": return normaliserSalaire(brut);
  }
}

const POINTS = "••••";

/**
 * Les caractères affichables d'une valeur normalisée : les quatre derniers, ou `null` quand la
 * nature n'en montre aucun (salaire). Pour une date, on montre l'ANNÉE (les quatre derniers de
 * `JJ/MM/AAAA`) : c'est ce qui sert à savoir si un passeport est encore valable.
 */
export function derniersCaracteres(nature: NatureCoffre, normalisee: string): string | null {
  if (nature === "SALAIRE") return null;
  if (nature === "PASSEPORT_EXPIRATION") return normalisee.slice(0, 4);
  return normalisee.slice(-4);
}

/** Le masque montré à l'écran à qui ne lit pas la valeur : « •••• 1234 », « ••/••/2031 », « •••••• DZD ». */
export function masque(nature: NatureCoffre, derniers: string | null): string {
  if (nature === "SALAIRE") return "•••••• DZD";
  if (nature === "PASSEPORT_EXPIRATION") return `••/••/${derniers ?? POINTS}`;
  return `${POINTS} ${derniers ?? POINTS}`;
}
