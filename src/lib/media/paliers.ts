/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REPLI À QUATRE PALIERS (mandat 5 §38) — pur.
 *
 *   NATIF (parseur déterministe) → OCR ciblé → VISION RAPIDE (Luna) → VISION SUPÉRIEURE (Terra)
 *
 * La règle qui ne se négocie pas : JAMAIS 500 PAGES DANS UN GROS MODÈLE. Chaque page est jugée
 * pour elle-même — ce que le parseur a lu, ce que l'OCR a lu et avec quelle confiance, ce que la
 * lecture visuelle a rendu — et ne monte d'un palier que si le précédent ne suffit pas. Le
 * palier supérieur est réservé aux pages qui l'EXIGENT (visées par la question, illisibles en
 * dessous) et plafonné en dur (`PLAFOND_SUPERIEUR_ABSOLU`), quelle que soit l'exigence.
 *
 * Ce module ne lit rien : il DÉCIDE (quelle page, quel palier, pourquoi), il BORNE (le budget),
 * et il RAPPORTE (ce qui a été lu par quoi, ce qui reste hors budget — dit, jamais tu). Le pont
 * (`platform/in-process/media/lecture.ts`) exécute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PALIERS = ["NATIF", "OCR", "VISION_RAPIDE", "VISION_SUPERIEURE"] as const;
export type Palier = (typeof PALIERS)[number];

/** `rapide` : jamais le modèle supérieur ; `auto` : le supérieur pour les pages visées et illisibles ; `precis` : le supérieur dès qu'un doute reste, sous plafond. */
export type Exigence = "rapide" | "auto" | "precis";

export interface EtatPage {
  n: number;
  /** Ce que le parseur déterministe a lu (couche texte du PDF, texte d'un DOCX…). */
  caracteresNatifs: number;
  /** Ce que l'OCR a rendu, s'il a tourné. */
  ocr?: { confiance: number; caracteres: number } | null;
  /** Ce que la lecture visuelle rapide a rendu, si elle a tourné. */
  vision?: { lisibilite: "bonne" | "partielle" | "mauvaise"; caracteres: number } | null;
  /** Ce que le modèle supérieur a rendu, s'il a tourné — le dernier mot. */
  superieure?: { caracteres: number } | null;
  /** La page est VISÉE par la question (plage demandée, occurrence trouvée) : elle passe devant. */
  visee?: boolean;
  /** Contenu graphique probable (tableau, schéma, photo) : une lecture visuelle vaut mieux qu'un OCR. */
  graphique?: boolean;
}

export interface Budget { ocr: number; visionRapide: number; visionSuperieure: number }

/** Le plafond ABSOLU du palier supérieur, par appel — aucune exigence ne le lève. */
export const PLAFOND_SUPERIEUR_ABSOLU = 8;

export const BUDGETS: Readonly<Record<Exigence, Budget>> = {
  rapide: { ocr: 12, visionRapide: 4, visionSuperieure: 0 },
  auto: { ocr: 12, visionRapide: 6, visionSuperieure: 2 },
  precis: { ocr: 40, visionRapide: 12, visionSuperieure: PLAFOND_SUPERIEUR_ABSOLU },
};

export const SEUILS = {
  /** Sous ce nombre de caractères natifs, la couche texte ne suffit pas (page scannée, image, blanche). */
  natifMin: 40,
  /** Une confiance d'OCR en dessous appelle une lecture visuelle. */
  ocrConfianceOk: 70,
  /** Un OCR qui rend moins que ça sur une page non blanche est « mince » : photo, tableau, manuscrit. */
  ocrMince: 80,
  /** En dessous, même relu visuellement, la page mérite le modèle supérieur si elle est visée. */
  ocrSuperieure: 55,
} as const;

/** Le coût indicatif d'une page par palier (USD) — pour dire ce qu'une lecture va coûter AVANT de la faire. */
export const COUT_PAGE_USD: Readonly<Record<Palier, number>> = { NATIF: 0, OCR: 0.001, VISION_RAPIDE: 0.003, VISION_SUPERIEURE: 0.03 };

export interface Decision { n: number; palier: Palier; raison: string }
export interface Plan {
  aFaire: Decision[];
  /** Ce que la règle aurait fait et que le budget retient — dit à la personne, jamais tu. */
  horsBudget: Decision[];
  budget: Budget;
  coutEstimeUsd: number;
}

/** Le palier que la page réclame ENCORE, ou `null` si ce qu'on a suffit. */
export function palierRequis(p: EtatPage, exigence: Exigence): { palier: Palier; raison: string } | null {
  if (p.superieure) return null;
  // Le parseur déterministe a le dernier mot quand il a lu : une couche texte n'est pas une lecture probable.
  if (p.caracteresNatifs >= SEUILS.natifMin) return null;
  if (!p.ocr) return { palier: "OCR", raison: p.caracteresNatifs === 0 ? "aucun texte natif" : `texte natif trop mince (${p.caracteresNatifs} caractères)` };
  const raisons: string[] = [];
  if (p.ocr.confiance < SEUILS.ocrConfianceOk) raisons.push(`OCR peu sûr (confiance ${Math.round(p.ocr.confiance)} %)`);
  if (p.ocr.caracteres < SEUILS.ocrMince) raisons.push(`OCR mince (${p.ocr.caracteres} caractères)`);
  if (p.graphique) raisons.push("contenu graphique");
  if (raisons.length && !p.vision) return { palier: "VISION_RAPIDE", raison: raisons.join(", ") };
  if (exigence === "rapide") return null;
  const visionFaible = p.vision ? p.vision.lisibilite !== "bonne" : false;
  const tresFaible = p.ocr.confiance < SEUILS.ocrSuperieure;
  if (p.vision && (visionFaible || tresFaible) && (exigence === "precis" || p.visee)) {
    return { palier: "VISION_SUPERIEURE", raison: [visionFaible ? `lecture visuelle ${p.vision!.lisibilite}` : null, tresFaible ? `OCR très faible (${Math.round(p.ocr.confiance)} %)` : null, p.visee ? "page visée par la question" : null].filter(Boolean).join(", ") };
  }
  return null;
}

/** L'ordre de passage sous budget : les pages VISÉES d'abord, puis les moins sûres, puis l'ordre de lecture. */
function priorite(a: EtatPage, b: EtatPage): number {
  if (Boolean(a.visee) !== Boolean(b.visee)) return a.visee ? -1 : 1;
  const ca = a.ocr?.confiance ?? -1; const cb = b.ocr?.confiance ?? -1;
  if (ca !== cb) return ca - cb;
  return a.n - b.n;
}

/**
 * LE PLAN : pour chaque page, le prochain palier qu'elle réclame — borné par le budget de
 * l'exigence, le supérieur toujours sous le plafond absolu. Ce qui dépasse est rendu à part.
 */
export function planifier(pages: readonly EtatPage[], exigence: Exigence, budget: Partial<Budget> = {}): Plan {
  const b: Budget = {
    ocr: Math.max(0, budget.ocr ?? BUDGETS[exigence].ocr),
    visionRapide: Math.max(0, budget.visionRapide ?? BUDGETS[exigence].visionRapide),
    visionSuperieure: Math.min(PLAFOND_SUPERIEUR_ABSOLU, Math.max(0, budget.visionSuperieure ?? BUDGETS[exigence].visionSuperieure)),
  };
  if (exigence === "rapide") b.visionSuperieure = 0;
  const restes: Record<Palier, number> = { NATIF: Number.POSITIVE_INFINITY, OCR: b.ocr, VISION_RAPIDE: b.visionRapide, VISION_SUPERIEURE: b.visionSuperieure };
  const aFaire: Decision[] = [];
  const horsBudget: Decision[] = [];
  for (const p of [...pages].sort(priorite)) {
    const r = palierRequis(p, exigence);
    if (!r) continue;
    const d = { n: p.n, palier: r.palier, raison: r.raison };
    if (restes[r.palier] > 0) { restes[r.palier] -= 1; aFaire.push(d); } else horsBudget.push(d);
  }
  aFaire.sort((x, y) => x.n - y.n);
  horsBudget.sort((x, y) => x.n - y.n);
  return { aFaire, horsBudget, budget: b, coutEstimeUsd: estimerCout(aFaire) };
}

export function estimerCout(decisions: readonly Decision[]): number {
  return Math.round(decisions.reduce((s, d) => s + COUT_PAGE_USD[d.palier], 0) * 10_000) / 10_000;
}

/** Ce qui a FINALEMENT lu la page — le palier le plus haut qui a rendu du texte. */
export function methodeDe(p: EtatPage): Palier | "SANS" {
  if (p.superieure && p.superieure.caracteres > 0) return "VISION_SUPERIEURE";
  if (p.vision && p.vision.caracteres > 0) return "VISION_RAPIDE";
  if (p.ocr && p.ocr.caracteres > 0) return "OCR";
  if (p.caracteresNatifs > 0) return "NATIF";
  return "SANS";
}

/** Le bilan lisible : combien de pages par méthode, ce qui reste hors budget, ce qui est illisible. */
export function rapport(pages: readonly EtatPage[], plan?: Plan | null): { parMethode: Record<Palier | "SANS", number>; lignes: string[] } {
  const parMethode: Record<Palier | "SANS", number> = { NATIF: 0, OCR: 0, VISION_RAPIDE: 0, VISION_SUPERIEURE: 0, SANS: 0 };
  for (const p of pages) parMethode[methodeDe(p)] += 1;
  const lignes: string[] = [];
  if (parMethode.NATIF) lignes.push(`${parMethode.NATIF} page(s) lues par le parseur (texte natif)`);
  if (parMethode.OCR) lignes.push(`${parMethode.OCR} page(s) océrisées`);
  if (parMethode.VISION_RAPIDE) lignes.push(`${parMethode.VISION_RAPIDE} page(s) lues visuellement (modèle rapide)`);
  if (parMethode.VISION_SUPERIEURE) lignes.push(`${parMethode.VISION_SUPERIEURE} page(s) relues par le modèle supérieur`);
  if (parMethode.SANS) lignes.push(`${parMethode.SANS} page(s) sans texte lisible`);
  if (plan?.horsBudget.length) {
    const parPalier = new Map<Palier, number[]>();
    for (const d of plan.horsBudget) parPalier.set(d.palier, [...(parPalier.get(d.palier) ?? []), d.n]);
    for (const [palier, ns] of parPalier) lignes.push(`${ns.length} page(s) hors budget ${libellePalier(palier)} (${ns.slice(0, 8).join(", ")}${ns.length > 8 ? "…" : ""}) — à demander explicitement`);
  }
  return { parMethode, lignes };
}

export function libellePalier(p: Palier): string {
  switch (p) {
    case "NATIF": return "texte natif";
    case "OCR": return "OCR";
    case "VISION_RAPIDE": return "lecture visuelle rapide";
    case "VISION_SUPERIEURE": return "modèle supérieur";
  }
}

/** La confiance qu'on peut accorder au texte d'une page selon ce qui l'a lue — pour la calibration (§29). */
export function confianceDe(p: EtatPage): "VERIFIE" | "PROBABLE" | "INCERTAIN" | "ABSENT" {
  switch (methodeDe(p)) {
    case "NATIF": return "VERIFIE";
    case "VISION_SUPERIEURE": return "PROBABLE";
    case "VISION_RAPIDE": return p.vision?.lisibilite === "bonne" ? "PROBABLE" : "INCERTAIN";
    case "OCR": return (p.ocr?.confiance ?? 0) >= SEUILS.ocrConfianceOk ? "PROBABLE" : "INCERTAIN";
    default: return "ABSENT";
  }
}
