import { canonicalForm, extractDosage, type GalenicForm } from "@/lib/market/galenic";
import { normText } from "@/lib/market/text";
import { cleDci, normalizeDosage } from "@/lib/products/identity";

/**
 * VENTES PCH — LES CLÉS DE COMPARAISON (module PUR).
 *
 *   • CLIENT d'une DR (« MSPRH/E.P.H GDYEL », « MSPRH/ETAB PUB HOSPITA AIN SALAH ») → la même clé que le nom de
 *     l'établissement à l'annuaire (« EPH Gdyel », « EPH Ain Salah ») : préfixe ministériel retiré, sigles recollés,
 *     abréviations de la PCH ramenées au sigle. C'est une NORMALISATION d'écriture, pas une ressemblance : deux noms
 *     ne se rejoignent que s'ils écrivent la même chose une fois mis au propre.
 *   • FOURNISSEUR de la PCH (« SARL HIKMA PHARMA ALGERIA », « HETERO LABS LTD ») → ses mots distinctifs, sans forme
 *     juridique, pour le rapprocher du laboratoire partenaire d'un dossier.
 *   • PRÉSENTATION d'un produit (« DOLUTEGRAVIR 50MG COMP ») → molécule (radical, sans sel), première dose, famille
 *     de forme. La même fonction lit nos produits : un produit et un poste PCH se comparent dans la même langue.
 */

// ─────────────────────────── Établissements ───────────────────────────

/** Les écritures longues de la PCH et des annuaires, ramenées au sigle. L'ordre compte : la plus longue d'abord. */
const SIGLES: [RegExp, string][] = [
  [/\bETAB(?:LISSEMENT)? PUB(?:LIC)? (?:DE )?SANTE (?:DE )?PROX(?:IMITE)?\b/g, "EPSP"],
  [/\bETAB(?:LISSEMENT)? PUB(?:LIC)? HOSP(?:ITA(?:LIER)?)?\b/g, "EPH"],
  [/\bETAB(?:LISSEMENT)? HOSP(?:ITALIER)? SPEC(?:IALISE)?\b/g, "EHS"],
  [/\bETAB(?:LISSEMENT)? HOSP(?:ITALIER)? UNIV(?:ERSITAIRE)?\b/g, "EHU"],
  [/\bETAB(?:LISSEMENT)? HOSP(?:ITALIER)? PRIV(?:E)?\b/g, "EHP"],
  [/\bCENTRE HOSPITALO UNIVERSITAIRE\b/g, "CHU"],
  [/\bCENTRE (?:ANTI|DE LUTTE CONTRE LE) CANCER\b/g, "CAC"],
  [/\bE P S P\b/g, "EPSP"],
  [/\bE P H\b/g, "EPH"],
  [/\bE H S\b/g, "EHS"],
  [/\bE H U\b/g, "EHU"],
  [/\bC H U\b/g, "CHU"],
  [/\bC A C\b/g, "CAC"],
];
const MOTS_VIDES_ETAB = new Set(["DE", "DU", "DES", "LA", "LE", "LES", "D", "L", "ET"]);

/**
 * LA CLÉ D'UN ÉTABLISSEMENT — « MSPRH/E.P.H GDYEL » et « EPH Gdyel » rendent « EPH GDYEL » ;
 * « MSPRH/ETAB PUB SANTE PROX AIN GUEZZAM » et « EPSP d'Ain-Guezzam » rendent « EPSP AIN GUEZZAM ».
 */
export function cleClient(raw: string | null | undefined): string {
  let t = String(raw ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
  // Le préfixe du ministère de tutelle (« MSPRH/ ») ne fait pas partie du nom.
  t = t.replace(/^(?:MSPRH|MSP|MSPH|MSPRS)\s*\/\s*/, "");
  // Les points des sigles se recollent (« E.P.H » → « EPH »), toute autre ponctuation sépare.
  t = t.replace(/\./g, "").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, sigle] of SIGLES) t = t.replace(re, sigle);
  return t.split(" ").filter((w) => w && !MOTS_VIDES_ETAB.has(w)).join(" ");
}

// ─────────────────────────── Fournisseurs ───────────────────────────

/** Formes juridiques et mots qui ne DISTINGUENT aucun laboratoire. */
const MOTS_GENERIQUES_FOUR = new Set([
  "SARL", "SPA", "EURL", "SNC", "EPE", "SA", "SAS", "SAE", "LTD", "LIMITED", "GMBH", "AG", "BV", "NV", "INC", "LLC", "FZ", "FZE", "FZCO",
  "PVT", "PRIVATE", "CO", "CORP", "CORPORATION", "COMPANY", "GROUPE", "GROUP", "INTERNATIONAL", "INTL", "ALGERIE", "ALGERIA", "DZ",
  "PHARMA", "PHARMACEUTICALS", "PHARMACEUTICAL", "PHARMACEUTIQUE", "PHARMACEUTIQUES", "LABORATOIRES", "LABORATOIRE", "LABORATORIES",
  "LABORATORY", "LABS", "LAB", "HEALTHCARE", "HEALTH", "MIDDLE", "EAST", "EXPORT", "SERVICES", "INDUSTRIE", "INDUSTRIES", "DU", "MEDICAMENT",
  "FOR", "AND", "THE", "OF", "DE", "ET", "LES", "LA", "LE", "MEDICAL", "APPLIANCES", "PRODUCTS", "IDEA", "META", "SPA", "S",
]);

/** La clé d'un fournisseur PCH : majuscules, sans accents ni ponctuation (« S.P.A » → « SPA »). Sert d'identifiant. */
export function cleFournisseur(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Les mots DISTINCTIFS d'un nom de laboratoire (« SARL HIKMA PHARMA ALGERIA » → HIKMA). */
export function motsDistinctifs(raw: string | null | undefined): string[] {
  return [...new Set(cleFournisseur(raw).split(" ").filter((w) => w.length >= 2 && !MOTS_GENERIQUES_FOUR.has(w)))];
}

/**
 * CE FOURNISSEUR PCH EST-IL CE LABORATOIRE ? Oui quand tous les mots distinctifs du plus court se retrouvent dans
 * l'autre (« SD PHARMACEUTICALS » ↔ « SD Pharmaceuticals Ltd », « HIKMA » ↔ « SARL HIKMA PHARMA ALGERIA »).
 * Un nom sans mot distinctif (« PHARMA ») ne désigne personne.
 */
export function fournisseurCorrespond(nomFour: string, labo: string): boolean {
  const a = motsDistinctifs(nomFour), b = motsDistinctifs(labo);
  if (!a.length || !b.length) return false;
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  return court.every((w) => long.includes(w));
}

// ─────────────────────────── Présentations ───────────────────────────

/**
 * La FAMILLE de forme qui se compare : un comprimé et une gélule du même dosage se substituent à l'hôpital (et la
 * PCH écrit l'un pour l'autre) ; un injectable et une perfusion aussi. Le reste garde sa famille galénique.
 */
export type FamilleForme = "ORAL_SOLIDE" | "PARENTERAL" | Exclude<GalenicForm, "COMPRIME" | "GELULE" | "INJECTABLE" | "PERFUSION">;

/** Les abréviations de la PCH que le vocabulaire galénique commun ne lit pas (« GLES », « PILLULE »). */
function formesPch(raw: string): string {
  return normText(raw)
    .replace(/\bGLES?\b/g, "GELULE")
    .replace(/\bPILLULES?\b/g, "COMPRIME");
}

export function familleForme(raw: string | null | undefined): FamilleForme {
  const f = canonicalForm(formesPch(String(raw ?? "")));
  if (f === "COMPRIME" || f === "GELULE") return "ORAL_SOLIDE";
  if (f === "INJECTABLE" || f === "PERFUSION") return "PARENTERAL";
  return f;
}

export interface Presentation {
  /** Le radical de la (des) molécule(s), comme `cleDci` (« DOLUTEGRAVIR », « ACID CLAVULANIQU+AMOXICILLIN »). */
  molecule: string;
  /** La première dose, en écriture stable (« 50MG », « 0.5MG ») ; null si le libellé n'en porte pas. */
  dose: string | null;
  forme: FamilleForme;
}

/** Les mots de FORME qu'un libellé PCH accole à la molécule (« DOLUTEGRAVIR COMP », « COLISTINE INJ »). */
const MOTS_DE_FORME = new Set([
  "COMP", "COMPRIME", "COMPRIMES", "CP", "CPR", "CPS", "GELULE", "GELULES", "GEL", "GLE", "GLES", "CAPS", "CAPSULE", "CAPSULES", "PILLULE",
  "PILLULES", "INJ", "INJECTABLE", "IV", "IM", "SC", "PERF", "PERFUSION", "SOL", "SOLUTION", "SUSP", "SUSPENSION", "BUV", "BUVABLE", "SIROP",
  "PDRE", "PDR", "POUDRE", "LYOPH", "LYOPHILISAT", "LYOPHILISE", "LYOPHILISEE", "FL", "FLACON", "AMP", "AMPOULE", "PELL", "PELLICULE",
  "PELLICULES", "ENROBE", "ENROBES", "LP", "SB", "SECABLE", "DISP", "DISPERSIBLE", "ORAL", "ORALE", "POUR", "PR", "CONC", "CONCENTRE",
  "CONCENTREE", "DILUER", "SER", "SERINGUE", "PREREMPLIE", "STYLO", "CREME", "POMMADE", "GTTES", "COLLYRE", "OVULE", "SUPPO", "SACHET",
  "GRANULE", "GRANULES", "EN", "EFF", "EFFERVESCENT", "B", "BTE", "STERILE", "INTRATRACHEALE",
]);

/** Les sels que le vocabulaire commun (`galenic.ts`) ne retire pas et que la PCH écrit (« SUNITINIB MALATE »). */
const SELS_PCH = new Set(["MALATE", "TOSILATE", "TOSYLATE", "DIMESYLATE", "DIMESILATE", "ISETHIONATE", "BESYLATE", "HYCLATE", "CAMSYLATE", "MEGLUMINE"]);

/**
 * LA MOLÉCULE d'un texte (une DCI de dossier, ou la tête d'un libellé PCH) : associations séparées par « + » ou « / »,
 * mots de forme et sels retirés, puis la clé commune `cleDci`. « RALTEGRAVIR COMP/GLES » rend RALTEGRAVIR (la barre
 * séparait deux formes) ; « DOLUTEGRAVIR+LAMIVUDINE » rend l'association.
 */
export function moleculeDe(raw: string | null | undefined): string {
  const parts = String(raw ?? "")
    .split(/[+/]/)
    .map((p) => normText(p).split(" ").filter((w) => w && !MOTS_DE_FORME.has(w) && !SELS_PCH.has(w)).join(" "))
    .filter(Boolean);
  return cleDci(parts.join(" + "));
}

/** Le nombre d'une dose, en écriture stable : « 50.0 » → « 50 », « 0,50 » → « 0.5 ». */
function nombreStable(n: string): string {
  const v = Number(n.replace(",", "."));
  return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : n;
}

/** La PREMIÈRE dose d'un libellé, le gramme ramené au milligramme (1 G = 1000MG) — pour comparer, jamais pour afficher. */
export function premiereDose(raw: string | null | undefined): string | null {
  const d = extractDosage(raw);
  if (!d) return null;
  const m = d.split("/")[0].match(/^(\d+(?:\.\d+)?)(MG|MCG|UG|G|ML|UI|%)$/);
  if (!m) return null;
  let valeur = m[1], unite = m[2];
  if (unite === "G") { valeur = String(Number(valeur) * 1000); unite = "MG"; }
  if (unite === "UG") unite = "MCG";
  return `${nombreStable(valeur)}${unite}`;
}

/** LA PRÉSENTATION D'UN LIBELLÉ PCH — « NILOTINIB 200MG GELULE » → NILOTINIB · 200MG · ORAL_SOLIDE. */
export function presentationPch(designation: string | null | undefined): Presentation {
  const brut = String(designation ?? "").replace(/\s+/g, " ").trim();
  // La molécule est ce qui précède le premier nombre (« B12 » reste un mot : il ne COMMENCE pas par un chiffre).
  const mots: string[] = [];
  for (const w of brut.split(" ")) {
    if (/^\d/.test(w)) break;
    mots.push(w);
  }
  return { molecule: moleculeDe(mots.join(" ")), dose: premiereDose(brut), forme: familleForme(brut) };
}

/** LA PRÉSENTATION D'UN DE NOS PRODUITS — mêmes règles, sur ses champs d'identité. */
export function presentationProduit(p: { dci: string; dosage?: string | null; dosageUnit?: string | null; form?: string | null }): Presentation {
  // L'écriture des dossiers (« 50/300 » + « mg ») passe par la normalisation du catalogue, qui rend « 50MG/300MG ».
  // Un dosage sans unité (« 50 ») ne se compare pas à « 50 MG » : la dose reste illisible plutôt que devinée.
  const dosage = p.dosage ? normalizeDosage(p.dosage, p.dosageUnit) : "";
  return { molecule: moleculeDe(p.dci), dose: premiereDose(dosage), forme: familleForme(p.form) };
}

/** La clé stockée sur chaque ligne : « DOLUTEGRAVIR|50MG|ORAL_SOLIDE ». */
export function clePresentation(p: Presentation): string {
  return `${p.molecule}|${p.dose ?? ""}|${p.forme}`;
}

/**
 * MÊME PRÉSENTATION ? Même molécule, même première dose, même famille de forme. Une dose ou une forme ILLISIBLE d'un
 * côté ne conclut pas (« inconnu » n'est pas « identique ») : la ligne reste au marché de la molécule, sans produit.
 */
export function memePresentation(a: Presentation, b: Presentation): boolean {
  return !!a.molecule && a.molecule === b.molecule && !!a.dose && a.dose === b.dose && a.forme !== "AUTRE" && a.forme === b.forme;
}

/**
 * MÊME MARCHÉ ? Pour la part de marché et la demande : même molécule et même dose ; la forme ne départage que si les
 * deux la disent. C'est la question de l'hôpital — « du dolutégravir 50 mg » — pas celle du dossier.
 */
export function memeMarche(a: Presentation, b: Presentation): boolean {
  if (!a.molecule || a.molecule !== b.molecule) return false;
  if (a.dose && b.dose && a.dose !== b.dose) return false;
  if (!a.dose !== !b.dose) return false;
  return a.forme === "AUTRE" || b.forme === "AUTRE" || a.forme === b.forme;
}
