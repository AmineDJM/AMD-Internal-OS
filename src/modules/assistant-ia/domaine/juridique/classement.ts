/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 — RANGER UN DOCUMENT « PARFAITEMENT À SA PLACE » DANS LE JURIDIQUE : les règles PURES.
 *
 * « Qu'il range parfaitement les documents à leurs places » (Direction, 02/11/2026). La place d'une pièce juridique,
 * c'est trois choses que le modèle ne doit pas deviner chacun à sa façon :
 *   • sa NATURE au registre (`LegalDocKind`) — « statuts », « PV d'AG », « AMM », « agrément » n'existent pas comme
 *     natures : ils se rangent sous la nature la plus proche (OTHER, LICENSE) ET dans le dossier qui les nomme ;
 *   • son DOSSIER de classement (`LegalFolder`) — un nom par famille de pièces, toujours le même (« Agréments et
 *     autorisations », jamais « AMM » un jour et « Autorisations » le lendemain) ;
 *   • ses DATES — lues sur la pièce, au format AAAA-MM-JJ, et cohérentes (la fin après le début).
 *
 * Pur : ni base, ni réseau, ni import. Testé dans `classement.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureRegistre =
  | "CONTRACT" | "QUOTE" | "PURCHASE_ORDER" | "INVOICE" | "CREDIT_NOTE" | "AMENDMENT" | "AGREEMENT" | "NDA" | "INSURANCE" | "LICENSE" | "LEASE" | "OTHER";

export interface FamillePiece {
  /** Le mot que la personne emploie (« statuts »). */
  cle: string;
  nature: NatureRegistre;
  /** Le dossier de classement par défaut — toujours le même nom. */
  dossier: string;
  libelle: string;
  /** Une pièce de cette famille a-t-elle d'ordinaire une partie en face ? (statuts, PV : non — c'est la société). */
  partieAttendue: boolean;
}

/** L'ordre compte : la première famille dont un motif répond l'emporte (« avenant au contrat » est un avenant). */
const FAMILLES: readonly (FamillePiece & { motifs: RegExp })[] = [
  { cle: "avenant", nature: "AMENDMENT", dossier: "Avenants", libelle: "Avenant", partieAttendue: true, motifs: /avenant/ },
  { cle: "statuts", nature: "OTHER", dossier: "Statuts et PV", libelle: "Statuts", partieAttendue: false, motifs: /\bstatuts?\b(?! (du|de la) (dossier|demande))/ },
  { cle: "pv", nature: "OTHER", dossier: "Statuts et PV", libelle: "Procès-verbal", partieAttendue: false, motifs: /\bpv\b|proces[- ]verbal|assemblee generale|\bago\b|\bage\b|conseil d.administration/ },
  { cle: "amm", nature: "LICENSE", dossier: "Agréments et autorisations", libelle: "Autorisation de mise sur le marché", partieAttendue: true, motifs: /\bamm\b|mise sur le marche|enregistrement/ },
  { cle: "agrement", nature: "LICENSE", dossier: "Agréments et autorisations", libelle: "Agrément", partieAttendue: true, motifs: /agrement|autorisation|licence|license|decision d.homologation|homologation/ },
  { cle: "assurance", nature: "INSURANCE", dossier: "Assurances", libelle: "Police d'assurance", partieAttendue: true, motifs: /assurance|police\b|attestation d.assurance/ },
  { cle: "bail", nature: "LEASE", dossier: "Baux", libelle: "Bail", partieAttendue: true, motifs: /\bbail\b|\bbaux\b|location|loyer/ },
  { cle: "nda", nature: "NDA", dossier: "Confidentialité", libelle: "Accord de confidentialité", partieAttendue: true, motifs: /\bnda\b|confidentialit/ },
  { cle: "convention", nature: "AGREEMENT", dossier: "Conventions et accords", libelle: "Convention", partieAttendue: true, motifs: /convention|accord[- ]cadre|\baccord\b|protocole|partenariat/ },
  { cle: "devis", nature: "QUOTE", dossier: "Devis", libelle: "Devis", partieAttendue: false, motifs: /\bdevis\b|proforma|pro[- ]forma/ },
  { cle: "facture", nature: "INVOICE", dossier: "Factures", libelle: "Facture", partieAttendue: true, motifs: /facture/ },
  { cle: "bon de commande", nature: "PURCHASE_ORDER", dossier: "Bons de commande", libelle: "Bon de commande", partieAttendue: true, motifs: /bon de commande|\bbc\b/ },
  { cle: "attestation", nature: "OTHER", dossier: "Attestations et certificats", libelle: "Attestation", partieAttendue: true, motifs: /attestation|certificat|extrait|registre du commerce|\bnif\b|\bcnas\b|\bcasnos\b/ },
  { cle: "contrat", nature: "CONTRACT", dossier: "Contrats", libelle: "Contrat", partieAttendue: true, motifs: /contrat|distribution|prestation|consulting|mandat/ },
];

/** Les natures que ce geste ne range PAS : elles ont leur circuit (BC → centre de validation, facture → sens de l'argent). */
export const NATURES_A_CIRCUIT: readonly NatureRegistre[] = ["PURCHASE_ORDER", "INVOICE", "CREDIT_NOTE"];

export const replierTexte = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

/**
 * LA FAMILLE D'UNE PIÈCE — d'après ce que la personne en dit, son titre et le nom du fichier. `null` : rien ne
 * permet de le dire (l'hypothèse « Contrat » est alors celle de l'appelant, dite sur la carte).
 */
export function familleDe(...indices: (string | null | undefined)[]): FamillePiece | null {
  // LA PLUS PRÉCISE l'emporte, d'où qu'elle vienne : « contrat » dit par le modèle pour « Avenant n°1 au contrat… » reste un
  // avenant (mesuré au banc, DOC-07) — l'ordre de `FAMILLES` va du plus précis au plus général.
  let meilleur = -1;
  for (const brut of indices) {
    const t = replierTexte(brut ?? "");
    if (!t) continue;
    const i = FAMILLES.findIndex((x) => x.motifs.test(t));
    if (i >= 0 && (meilleur < 0 || i < meilleur)) meilleur = i;
  }
  if (meilleur < 0) return null;
  const { motifs: _m, ...famille } = FAMILLES[meilleur]!;
  return famille;
}

export const FAMILLE_PAR_DEFAUT: FamillePiece = { cle: "contrat", nature: "CONTRACT", dossier: "Contrats", libelle: "Contrat", partieAttendue: true };

/** Les noms de dossiers canoniques — un dossier demandé qui en est une variante y est ramené. */
export const DOSSIERS_CANONIQUES: readonly string[] = [...new Set(FAMILLES.map((f) => f.dossier))];

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

/** « 30/06/2027 », « 2027-06-30 », « 30 juin 2027 », « 1er janvier 2026 » → « 2027-06-30 ». `null` sinon. */
export function dateJuridique(v: string | null | undefined): string | null {
  const s = replierTexte(v ?? "");
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valide(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valide(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})$/);
  if (m && MOIS[m[2]!]) return valide(+m[3]!, MOIS[m[2]!]!, +m[1]!);
  return null;
}

function valide(a: number, mo: number, j: number): string | null {
  if (a < 1950 || a > 2100 || mo < 1 || mo > 12 || j < 1 || j > 31) return null;
  const d = new Date(Date.UTC(a, mo - 1, j));
  if (d.getUTCMonth() !== mo - 1) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * LES DATES TROUVÉES DANS UN TEXTE, dans l'ordre — pour une pièce dont le modèle n'a pas donné l'échéance. Repère les
 * formes « du … au … », « à compter du … », « valable jusqu'au … », « expire le … ». Une seule lecture déterministe ;
 * la carte dit d'où vient la date.
 */
export function datesDuTexte(texte: string): { debut: string | null; fin: string | null; preuve: string | null } {
  const t = replierTexte(texte);
  const DATE = String.raw`(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:er)? [a-z]+ \d{4})`;
  const du = new RegExp(String.raw`du ${DATE} au ${DATE}`).exec(t);
  if (du) return { debut: dateJuridique(du[1]), fin: dateJuridique(du[2]), preuve: du[0] };
  const fin = new RegExp(String.raw`(?:jusqu.au|expire le|expiration le|echeance le|echeance :|valable jusqu.au|fin le|prend fin le) ?${DATE}`).exec(t);
  const debut = new RegExp(String.raw`(?:a compter du|prend effet le|effet le|date d.effet :?|signe le|fait a [a-z]+,? le|en date du|delivree? le) ?${DATE}`).exec(t);
  return {
    debut: debut ? dateJuridique(debut[1]) : null,
    fin: fin ? dateJuridique(fin[1]) : null,
    preuve: [debut?.[0], fin?.[0]].filter(Boolean).join(" · ") || null,
  };
}

/** Un montant écrit (« 1 200 000 DZD », « 1.200.000,00 ») → nombre ; `null` sinon. */
export function montantJuridique(v: string | null | undefined): number | null {
  const s = (v ?? "").replace(/[\s  ]/g, "").replace(/dzd|da$/i, "");
  if (!s) return null;
  const norm = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/[.,](?=\d{3}(\D|$))/g, "");
  const n = Number(norm);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Le dossier demandé, ramené au nom canonique quand c'en est une variante (« amm » → « Agréments et autorisations »). */
export function dossierCanonique(demande: string | null | undefined, famille: FamillePiece): string {
  const d = (demande ?? "").trim();
  if (!d) return famille.dossier;
  const exact = DOSSIERS_CANONIQUES.find((c) => replierTexte(c) === replierTexte(d));
  if (exact) return exact;
  const f = familleDe(d);
  // « amm » → le dossier canonique ; « Range-le dans AMM Hépatologie » : un nom PRÉCIS (plusieurs mots) est gardé tel quel.
  return f && replierTexte(d).split(" ").length === 1 ? f.dossier : d.slice(0, 120);
}

export type NiveauEcheance = "EXPIRE" | "IMMINENT" | "PROCHE" | "LOIN" | "SANS";

/** Même seuils que le module Juridique (`lib/legal/lifecycle.ts` : 30 j imminent, 90 j proche). */
export function niveauEcheance(fin: Date | null, maintenant = new Date()): { niveau: NiveauEcheance; jours: number | null } {
  if (!fin) return { niveau: "SANS", jours: null };
  const jours = Math.floor((fin.getTime() - maintenant.getTime()) / 86_400_000);
  return { niveau: jours < 0 ? "EXPIRE" : jours <= 30 ? "IMMINENT" : jours <= 90 ? "PROCHE" : "LOIN", jours };
}

/** Une institution publique (sphère « PUBLIC » de l'annuaire) d'après son nom. */
export const estInstitutionPublique = (nom: string): boolean =>
  /\b(anpp|ministere|cnrc|cnas|casnos|dgi|impots|douane|wilaya|direction de la sante|\bdsp\b|pch|chu|tribunal|notaire|ansm|onpm|inpi|inapi|banque d.algerie)\b/.test(replierTexte(nom));
