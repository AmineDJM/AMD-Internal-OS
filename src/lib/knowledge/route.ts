import {
  type ExtractedBy,
  type RouteReason,
  EXTRACTION_RANK,
  CONFIDENCE_ACCEPT,
  CONFIDENCE_VERIFY,
  verdictOf,
} from "./contract";
import { textLooksUsable, ocrLooksBroken } from "./text";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCHELLE — la pièce qui décide de NE PAS appeler un modèle.
 *
 * ── LA DOCTRINE, EN UNE PHRASE ───────────────────────────────────────────────────────────
 *
 * **Ne jamais appeler un modèle pour une donnée que le code sait déjà comprendre parfaitement.**
 *
 * Elle se décline en une échelle stricte, du moins cher au plus cher :
 *
 *   metadata → native → ocr → luna → terra
 *
 * On ne monte d'un barreau que sur un FAIT CONSTATÉ, jamais sur une intuition. Le fait est
 * consigné (`RouteReason`), ce qui rend le sur-recours visible dans un tableau plutôt que sur
 * une facture — et permet de discuter d'une règle plutôt que d'un ressenti.
 *
 * ── CE QUE CE MODULE EST ─────────────────────────────────────────────────────────────────
 *
 * PUR. Il ne lit aucun fichier, n'appelle aucun modèle, ne touche pas la base. Il répond à
 * « faut-il monter, et pourquoi ? » à partir de faits qu'on lui donne. C'est ce qui permet de
 * tester la politique de coût sans dépenser un centime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on sait d'un document AVANT de décider. Des faits, pas des impressions. */
export interface RouteFacts {
  /** Le type MIME détecté (par les octets, pas par l'extension). */
  mime: string;
  /** L'objet est-il déjà structuré dans l'ERP ? (une tâche, un dossier — rien à « comprendre ») */
  structured?: boolean;
  /** Texte obtenu par parsing natif, s'il y en a eu. */
  nativeText?: string | null;
  /** Le parser natif a-t-il échoué franchement ? */
  parserFailed?: boolean;
  /** Texte obtenu par OCR, s'il y en a eu. */
  ocrText?: string | null;
  /** Nombre de pages/diapositives, quand la notion existe. */
  pages?: number;
  /** Pages où le parsing natif n'a rien rendu d'exploitable. */
  unreadablePages?: string[];
  /** Pages repérées comme portant un tableau important. */
  tablePages?: string[];
  /** Confiance rendue par le dernier moyen employé. */
  confidence?: number | null;
}

export interface RouteDecision {
  /** Le moyen à employer MAINTENANT. */
  use: ExtractedBy;
  /** Vide si l'on reste au barreau le moins cher — le cas normal, et le plus fréquent. */
  reasons: RouteReason[];
  /**
   * Les pages à confier à la vision. VIDE veut dire « tout le document » seulement si `use`
   * vaut `luna` ET qu'aucune page n'a pu être isolée : sinon, on n'envoie QUE ces pages.
   */
  pages: string[];
  /** Explication en clair — elle finit dans le journal et dans l'écran d'observabilité. */
  why: string;
}

/** Les formats où il n'y a, par construction, rien à parser : il faut REGARDER. */
const IMAGE_MIMES = /^image\//;

export const isImage = (mime: string): boolean => IMAGE_MIMES.test(mime);

/**
 * LA DÉCISION.
 *
 * L'ordre des tests EST la doctrine : chaque `return` anticipé est un appel de modèle évité.
 */
export function decideRoute(f: RouteFacts): RouteDecision {
  // 0 — DÉJÀ STRUCTURÉ. Une tâche a un titre, un responsable et une échéance : il n'y a rien à
  //     comprendre, seulement à indexer. C'est le cas le plus fréquent de l'ERP, et le seul qui
  //     coûte exactement zéro.
  if (f.structured) {
    return {
      use: "metadata",
      reasons: ["structured_only"],
      pages: [],
      why: "Objet déjà structuré dans l'ERP — aucune extraction nécessaire.",
    };
  }

  // 1 — UNE IMAGE. Photo, capture, scan pur : le parsing n'a pas de prise, la vision est le
  //     PREMIER moyen possible, pas une escalade.
  if (isImage(f.mime)) {
    return {
      use: "luna",
      reasons: ["image_source"],
      pages: [],
      why: "Source image : il n'y a pas de texte à extraire, il faut le lire.",
    };
  }

  const native = (f.nativeText ?? "").trim();

  // 2 — LE PARSING NATIF A SUFFI. Le cas nominal d'un PDF texte, d'un DOCX, d'un XLSX.
  if (!f.parserFailed && textLooksUsable(native)) {
    const pages = selectVisionPages(f);
    // 2b — …sauf pour QUELQUES pages : on n'envoie PAS le document entier à la vision pour
    //      trois pages illisibles. C'est la règle §8, et c'est là que se joue le coût d'un PDF
    //      de 150 pages.
    if (pages.length > 0) {
      return {
        use: "luna",
        reasons: reasonsForPages(f),
        pages,
        why: `Texte exploitable, mais ${pages.length} page(s) demandent d'être regardées — seules celles-là partent en vision.`,
      };
    }
    return {
      use: "native",
      reasons: [],
      pages: [],
      why: "Le parsing natif a rendu un texte exploitable — aucun modèle appelé.",
    };
  }

  // 3 — PAS DE TEXTE NATIF UTILISABLE → l'OCR, qui reste du code et coûte bien moins qu'un modèle.
  const ocr = (f.ocrText ?? "").trim();
  if (ocr) {
    if (ocrLooksBroken(ocr)) {
      return {
        use: "luna",
        reasons: ["ocr_unreliable"],
        pages: selectVisionPages(f),
        why: "L'OCR a rendu un texte incohérent — on regarde le document plutôt que de le croire.",
      };
    }
    if (textLooksUsable(ocr)) {
      return {
        use: "ocr",
        reasons: [native ? "text_too_sparse" : "no_text_layer"],
        pages: [],
        why: "Aucune couche texte exploitable, mais l'OCR est propre — aucun modèle appelé.",
      };
    }
  }

  // 4 — RIEN N'A MARCHÉ. La vision est le dernier moyen avant l'escalade.
  return {
    use: "luna",
    reasons: f.parserFailed ? ["parser_failed"] : native ? ["text_too_sparse"] : ["no_text_layer"],
    pages: selectVisionPages(f),
    why: f.parserFailed
      ? "Le parsing natif a échoué — il faut regarder le document."
      : "Aucun texte exploitable (couche absente ou trop pauvre) — il faut regarder le document.",
  };
}

/** Les motifs qui justifient d'envoyer CERTAINES pages, et pas le document. */
function reasonsForPages(f: RouteFacts): RouteReason[] {
  const r: RouteReason[] = [];
  if ((f.unreadablePages ?? []).length) r.push("no_text_layer");
  if ((f.tablePages ?? []).length) r.push("table_heavy");
  return r.length ? r : ["text_too_sparse"];
}

/**
 * QUELLES PAGES REGARDER — §8.
 *
 * Un PDF de 150 pages ne part JAMAIS entier à la vision par défaut. On isole les pages qui le
 * méritent : celles que le parsing n'a pas su lire, et celles qui portent un tableau que le
 * texte à plat détruit. Le plafond n'est pas une prudence, c'est une décision : au-delà, ce
 * n'est plus « quelques pages difficiles », c'est un document scanné — et il relève alors du
 * chemin complet, pas d'un rattrapage page par page.
 */
export const MAX_VISION_PAGES = 12;

export function selectVisionPages(f: RouteFacts): string[] {
  const wanted = [...new Set([...(f.unreadablePages ?? []), ...(f.tablePages ?? [])])];
  if (!wanted.length) return [];
  // Un document majoritairement illisible n'est pas un document « avec quelques pages difficiles ».
  if (f.pages && wanted.length > Math.max(MAX_VISION_PAGES, f.pages * 0.6)) return [];
  return wanted.slice(0, MAX_VISION_PAGES);
}

/**
 * FAUT-IL ESCALADER VERS TERRA ? — §7 et §22.
 *
 * Deux motifs, et deux seulement :
 *   • Luna n'était pas sûr de lui (confiance sous le seuil) ;
 *   • le document est objectivement complexe (beaucoup de pages illisibles ET des tableaux).
 *
 * Tout le reste s'arrête à Luna. Escalader « au cas où » reviendrait à payer le barreau le plus
 * cher par défaut, ce qui vide l'échelle de son sens.
 */
export function shouldEscalate(f: { confidence?: number | null; reasons?: RouteReason[] }): boolean {
  const c = f.confidence;
  if (typeof c === "number" && verdictOf(c) === "escalate") return true;
  const r = f.reasons ?? [];
  return r.includes("ocr_unreliable") && r.includes("table_heavy");
}

/**
 * PEUT-ON ÉCRIRE CETTE VALEUR dans un champ structuré ? — §22, la règle qui protège les données.
 *
 * Une extraction incertaine ne remplit JAMAIS silencieusement un champ critique. Elle est
 * proposée pour vérification, ou marquée pour revue — jamais recopiée comme un fait.
 */
export function acceptsIntoStructuredField(confidence: number, critical: boolean): boolean {
  if (critical) return confidence >= CONFIDENCE_ACCEPT;
  return confidence >= CONFIDENCE_VERIFY;
}

/** Le moyen le plus cher employé sur un élément — sert au rapport de coût (§26). */
export function highestUsed(used: ExtractedBy[]): ExtractedBy {
  return used.reduce<ExtractedBy>(
    (max, b) => (EXTRACTION_RANK[b] > EXTRACTION_RANK[max] ? b : max),
    "metadata",
  );
}
