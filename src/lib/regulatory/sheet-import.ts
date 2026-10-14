/**
 * LECTURE D'UNE FEUILLE DE SÉLECTION PRODUITS (« Sélection PF Produits ») → dossier Regulatory.
 *
 * La feuille métier n'est pas un formulaire : le dosage se trouve tantôt dans la colonne
 * « Forme galénique & dosage » (« GELULE 0,5MG »), tantôt dans « Conditionnement »
 * (« 5 MG/B 30 ») ; les formes sont abrégées à la main (« CPR.PELL. LP », « PDRE+SOLV ») ;
 * une association s'écrit avec un « + » et une alternative avec « Ou ». Traduire ça en
 * silence, c'est se tromper de dossier — chaque règle est donc explicite et testée, et la
 * ligne d'origine est conservée en commentaire du dossier pour qu'un humain puisse vérifier.
 *
 * Module PUR : aucune lecture de fichier, aucun accès base. Il sert au générateur de la
 * migration d'import (scripts/) et reste vérifiable par les tests.
 */

export interface SheetProductRow {
  /** « Spé » — spécialité médicale (Neuro, Psy, Uro…). */
  specialty: string;
  /** « Priorisation » — 1 (le plus urgent) à 4. */
  prioritization: string;
  /** « Produit » — DCI, parfois « DCI : Marque ». */
  product: string;
  /** « Forme Galénique & Dosage ». */
  form: string;
  /** « Conditionnement » — B/30, et souvent le dosage aussi. */
  packaging: string;
  /** « Commercialisation Actuelle » — Off (officine) / Hop (hôpital). */
  commercialization: string;
  /** « Statut » — Fabrication / Importation. */
  status: string;
  qtyCity: string;
  qtyPch: string;
  fobPrice: string;
  marketSize: string;
  actors: string;
  n1: string;
  n2: string;
  n3: string;
}

export interface MappedProduct {
  dci: string;
  /** Molécules d'une association (« A + B »), sinon null : une seule molécule ne se liste pas. */
  molecules: string[] | null;
  brandName: string | null;
  pharmaceuticalForm: string | null;
  dosage: string | null;
  dosageUnit: string | null;
  packaging: string | null;
  therapeuticClass: string | null;
  channel: "RETAIL" | "HOSPITAL" | "BOTH";
  manufacturingStatus: "IMPORTATION" | "FULL_PROCESS";
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  comments: string;
}

/** Espaces insécables, retours à la ligne, doubles espaces : la feuille en est pleine. */
export function tidy(raw: string): string {
  return String(raw ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

// ───────────────────────────── Spécialité → classe thérapeutique ─────────────────────────────

/** Les abréviations de la colonne « Spé ». Inconnue = on garde le libellé brut, jamais vide. */
const SPECIALTY: Record<string, string> = {
  NEURO: "Neurologie",
  PSY: "Psychiatrie",
  REA: "Réanimation",
  URO: "Urologie",
  GYN: "Gynécologie",
  DER: "Dermatologie",
  ONCO: "Oncologie",
  "INF ET REA": "Infectiologie & Réanimation",
  INF: "Infectiologie",
};

export function therapeuticClassOf(specialty: string): string | null {
  const key = tidy(specialty).toUpperCase();
  if (!key) return null;
  return SPECIALTY[key] ?? tidy(specialty);
}

// ───────────────────────────── Priorisation → priorité du dossier ─────────────────────────────

/**
 * La feuille priorise de 1 (à traiter en premier) à 4. Une case vide n'est pas une priorité
 * basse : c'est une absence d'arbitrage — elle retombe donc sur la valeur par défaut du
 * dossier (Moyenne), à charge pour la supervision de trancher.
 */
export function priorityOf(prioritization: string): MappedProduct["priority"] {
  switch (tidy(prioritization)) {
    case "1": return "CRITICAL";
    case "2": return "HIGH";
    case "3": return "MEDIUM";
    case "4": return "LOW";
    default: return "MEDIUM";
  }
}

// ───────────────────────────── Commercialisation → canal ─────────────────────────────

/** « Off » = officine (ville), « Hop » = hôpital. Les deux mentions = les deux canaux. */
export function channelOf(commercialization: string): MappedProduct["channel"] {
  const v = tidy(commercialization).toUpperCase();
  const city = v.includes("OFF");
  const hospital = v.includes("HOP");
  if (city && hospital) return "BOTH";
  if (hospital) return "HOSPITAL";
  if (city) return "RETAIL";
  return "BOTH";
}

// ───────────────────────────── Statut → niveau industriel déclaré ─────────────────────────────

/**
 * La colonne « Statut » de la feuille dit comment le produit sera SOURCÉ : fabriqué localement
 * ou importé. C'est une DÉCLARATION d'intention du métier, pas une variation obtenue auprès de
 * l'ANPP — et le tableau Regulatory l'affiche comme telle (« déclaré » vs « variation obtenue »).
 * Une case mentionnant les deux (« Importation / Fabrication ») part d'Importation : c'est
 * l'état de départ, la fabrication viendra par variation.
 */
export function manufacturingOf(status: string): MappedProduct["manufacturingStatus"] {
  const v = tidy(status).toUpperCase();
  if (v.includes("IMPORTATION")) return "IMPORTATION";
  if (v.includes("FABRICATION")) return "FULL_PROCESS";
  return "IMPORTATION";
}

// ───────────────────────────── Produit → DCI, molécules, marque ─────────────────────────────

/**
 * « VALPROIC ACID : Depakine » → DCI + nom commercial. Le séparateur métier est « : ».
 * « MINOCYCLINE Ou LYMECYCLINE » reste une seule DCI : « ou » désigne une ALTERNATIVE encore
 * à trancher, pas une association — la scinder inventerait deux dossiers là où il y en a un.
 */
export function splitProduct(product: string): { dci: string; brandName: string | null; molecules: string[] | null } {
  const raw = tidy(product);
  const colon = raw.indexOf(":");
  const left = colon >= 0 ? tidy(raw.slice(0, colon)) : raw;
  const brandName = colon >= 0 ? tidy(raw.slice(colon + 1)) || null : null;
  const parts = left.split("+").map((p) => tidy(p).toUpperCase()).filter(Boolean);
  if (parts.length > 1) return { dci: parts.join(" + "), brandName, molecules: parts };
  return { dci: left.toUpperCase(), brandName, molecules: null };
}

// ───────────────────────────── Forme galénique ─────────────────────────────

/**
 * Abréviations de la feuille → clés de PHARMA_FORM. L'ORDRE compte : « GELULE » contient
 * « GEL », « PDRE+SOLV P/SOL INJ » contient « INJ ». On teste donc du plus spécifique au plus
 * général, et la forme non reconnue tombe sur « Autre » — le texte d'origine reste dans les
 * commentaires du dossier plutôt que d'être deviné.
 */
const FORM_RULES: { match: RegExp; form: string }[] = [
  { match: /OVULE/, form: "OVULE" },
  { match: /CAPS\.?\s*MOLLE|CAPSULE\s+MOLLE/, form: "CAPSULE_MOLLE" },
  { match: /GELULE|G[ÉE]LULE/, form: "GELULE" },
  { match: /PDRE\s*\+\s*SOLV|PDRE\/SOLV|POUDRE\s*\+\s*SOLV/, form: "POUDRE_INJECTABLE" },
  { match: /SUS\.?\s*BV|SUSP?\.?\s*BUV|GRANNUL|GRANUL/, form: "SUSPENSION_BUVABLE" },
  { match: /SOL(N|UTION)?\.?\s*BUV/, form: "SOLUTION_BUVABLE" },
  // Une ÉMULSION injectable (ou pour perfusion — émulsions lipidiques) : avant « PERF » et « INJ », qui la prendraient
  // pour une solution. Une émulsion cutanée ou buvable n'est pas concernée.
  { match: /[ÉE]MULS.*(\bINJ|PERF)|(\bINJ|PERF).*[ÉE]MULS/, form: "EMULSION_INJECTABLE" },
  { match: /PERF/, form: "PERFUSION" },
  { match: /\bINJ\b|INJECTABLE/, form: "SOLUTION_INJECTABLE" },
  { match: /PELL|PELLIC/, form: "COMPRIME_PELLICULE" },
  { match: /\bCPR|COMP\b|COMPRIME|COMPRIMÉ/, form: "COMPRIME" },
  { match: /POMMAD/, form: "POMMADE" },
  { match: /CREME|CRÈME/, form: "CREME" },
  { match: /\bGEL\b|GEL\s*DERM/, form: "GEL" },
  { match: /COLLYRE/, form: "COLLYRE" },
  { match: /SUPPOSITOIRE/, form: "SUPPOSITOIRE" },
  { match: /CAPS|CAPSULE/, form: "GELULE" },
];

export function formOf(rawForm: string): string | null {
  const v = tidy(rawForm).toUpperCase();
  if (!v) return null;
  for (const rule of FORM_RULES) if (rule.match.test(v)) return rule.form;
  return "AUTRE";
}

// ───────────────────────────── Dosage ─────────────────────────────

/** Unités reconnues, de la plus spécifique à la plus générale (« MG/ML » avant « MG »). */
const UNIT_RULES: { match: RegExp; unit: string }[] = [
  { match: /^MG\s*\/\s*ML$/, unit: "MG_ML" },
  { match: /^MG\s*\/\s*G$/, unit: "MG_G" },
  { match: /^(MCG|µG|UG)$/, unit: "MCG" },
  { match: /^MG$/, unit: "MG" },
  { match: /^G$/, unit: "G" },
  { match: /^UI$/, unit: "UI" },
  { match: /^%$/, unit: "PERCENT" },
  { match: /^ML$/, unit: "ML" },
];

function unitKey(raw: string): string | null {
  const v = raw.replace(/\s+/g, "").toUpperCase();
  for (const rule of UNIT_RULES) if (rule.match.test(v)) return rule.unit;
  return null;
}

/**
 * « O,1% » est écrit avec la LETTRE O dans la feuille. On corrige uniquement ce cas précis
 * (O suivi d'une virgule ou d'un point puis d'un chiffre) : ailleurs, un O reste un O.
 */
function fixTypedZero(v: string): string {
  return v.replace(/(^|[\s(/])O(?=[.,]\d)/gi, "$10");
}

/**
 * Le millilitre SEUL n'est pas dans cette liste, volontairement : « 10MG/10ML » dose 10 mg —
 * les 10 ml sont le volume du solvant, et « B/1 40 ML » un flacon de 40 ml. Compter un volume
 * comme un dosage donnerait des dossiers dosés en millilitres.
 */
const DOSE = /(\d+(?:[.,]\d+)?)\s*(MG\s*\/\s*ML|MG\s*\/\s*G|MCG|µG|UG|MG|G|UI|%)(?![A-Z])/gi;

/**
 * Extrait le dosage d'un texte libre. Un seul dosage → valeur + unité séparées, comme dans le
 * formulaire. Plusieurs (association « 0,4 mg + 5 mg », ou « 10MG/10ML ») → l'expression
 * complète va dans le champ dosage et l'unité reste vide : découper une association en une
 * seule unité en perdrait la moitié.
 */
export function parseDosage(text: string): { dosage: string | null; dosageUnit: string | null } {
  const v = fixTypedZero(tidy(text)).toUpperCase();
  const found = [...v.matchAll(DOSE)].map((m) => ({ value: m[1].replace(",", "."), unit: m[2] }));
  if (found.length === 0) return { dosage: null, dosageUnit: null };
  if (found.length === 1) {
    const key = unitKey(found[0].unit);
    if (key) return { dosage: found[0].value, dosageUnit: key };
    return { dosage: `${found[0].value} ${found[0].unit.toLowerCase()}`, dosageUnit: null };
  }
  return {
    dosage: found.map((f) => `${f.value} ${f.unit.replace(/\s+/g, "").toLowerCase()}`).join(" + "),
    dosageUnit: null,
  };
}

/**
 * Le dosage se lit d'abord dans la colonne « Forme galénique & dosage ». Quand elle n'en porte
 * pas (« CPR. PELLIC »), il est dans « Conditionnement » (« 5 MG/B 30 ») — on l'y cherche
 * alors, après avoir écarté ce qui mesure le CONTENANT et non le principe actif.
 */
export function dosageFrom(rawForm: string, rawPackaging: string): { dosage: string | null; dosageUnit: string | null } {
  const first = parseDosage(rawForm);
  if (first.dosage) return first;
  return parseDosage(stripContainerSize(rawPackaging));
}

/**
 * Écarte les mesures du CONTENANT : « B 30 » compte des boîtes, et dans « 1 tube 15 G / 45 G »
 * les grammes pèsent le tube, pas le principe actif — un tube de 30 g de pommade n'est pas
 * un dosage de 30 g. Tout ce qui suit « tube », « flacon », « ampoule » ou « sachet » décrit
 * donc le contenant et sort du calcul ; le libellé d'origine reste dans les commentaires.
 */
export function stripContainerSize(raw: string): string {
  return tidy(
    tidy(raw)
      .replace(/\bB\s*\/?\s*\d+\b/gi, " ")
      .replace(/\b(TUBE|FL|FLACON|AMP|AMPOULE|SACHET)\b[\s\S]*$/i, " "),
  );
}

// ───────────────────────────── Commentaires : la ligne d'origine ─────────────────────────────

const num = (v: string): string | null => {
  const t = tidy(v).replace(/\$/g, "").replace(/ /g, "");
  return t && t !== "-" && t !== "0.00" ? t : null;
};

/**
 * Le dossier garde la trace de sa source. Les chiffres de marché (quantités, prix FOB, taille
 * du marché, concurrents) n'ont pas de champ dédié dans Regulatory : les jeter serait perdre
 * l'arbitrage qui a conduit à retenir le produit, les inventer un champ chacun serait pire.
 * Ils sont donc écrits en clair, avec la forme et le conditionnement d'origine.
 */
export function importComments(row: SheetProductRow, source: string): string {
  const lines: string[] = [`Importé depuis « ${source} ».`];
  const orig = [tidy(row.form), tidy(row.packaging)].filter(Boolean).join(" — ");
  if (orig) lines.push(`Libellé d'origine : ${orig}`);
  if (tidy(row.status)) lines.push(`Statut visé (feuille) : ${tidy(row.status)}`);

  const market: string[] = [];
  const city = num(row.qtyCity);
  const pch = num(row.qtyPch);
  if (city) market.push(`quantité marché ville ${city}`);
  if (pch) market.push(`quantité marché PCH ${pch}`);
  if (num(row.fobPrice)) market.push(`prix FOB ${num(row.fobPrice)}`);
  if (num(row.marketSize)) market.push(`taille de marché ${num(row.marketSize)} $`);
  if (num(row.actors)) market.push(`${num(row.actors)} acteur(s)`);
  if (market.length) lines.push(`Marché : ${market.join(", ")}.`);

  const rivals = [row.n1, row.n2, row.n3].map(tidy).filter(Boolean);
  if (rivals.length) lines.push(`Concurrence : ${rivals.join(" · ")}.`);
  return lines.join("\n");
}

// ───────────────────────────── Assemblage ─────────────────────────────

/** Une ligne de la feuille est un produit dès qu'elle porte une DCI. Le reste est décor. */
export function isProductRow(row: SheetProductRow): boolean {
  return tidy(row.product).length > 0;
}

export function mapSheetRow(row: SheetProductRow, source: string): MappedProduct {
  const { dci, brandName, molecules } = splitProduct(row.product);
  const { dosage, dosageUnit } = dosageFrom(row.form, row.packaging);
  return {
    dci,
    molecules,
    brandName,
    pharmaceuticalForm: formOf(row.form),
    dosage,
    dosageUnit,
    packaging: tidy(row.packaging) || null,
    therapeuticClass: therapeuticClassOf(row.specialty),
    channel: channelOf(row.commercialization),
    manufacturingStatus: manufacturingOf(row.status),
    priority: priorityOf(row.prioritization),
    comments: importComments(row, source),
  };
}
