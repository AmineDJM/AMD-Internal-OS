import type { LunaCallInput } from "@/lib/openai-luna";

/**
 * EXTRACTION STRUCTURÉE D'UNE LETTRE DE RÉSERVES ANPP.
 *
 * Une lettre de réserves est un texte administratif : numérotée ou non, en français ou
 * partiellement en arabe, souvent scannée, parfois transmise en tableau Excel ou collée dans
 * un courriel. On en tire des fiches exploitables — mais **jamais reformulées** : le `verbatim`
 * doit rester le texte EXACT, sinon la preuve ne vaut plus rien devant l'ANPP.
 *
 * Le schéma JSON est **strict** : le modèle ne peut pas rendre autre chose que cette forme.
 * C'est ce qui met fin aux « réponse IA non exploitable ».
 *
 * Ce fichier ne fait AUCUN appel réseau : il construit la consigne et analyse la réponse.
 * C'est ce qui le rend testable sans clé d'API ni dépense.
 */

/** Catégories de reproche, telles qu'on les rencontre réellement dans les lettres ANPP. */
export const RESERVE_CATEGORIES = [
  "DOCUMENT_MANQUANT",
  "DOCUMENT_NON_CONFORME",
  "DONNEE_INCOHERENTE",
  "SPECIFICATION",
  "METHODE_ANALYTIQUE",
  "VALIDATION",
  "STABILITE",
  "BIOEQUIVALENCE",
  "ETIQUETAGE_RCP_NOTICE",
  "GMP_SITE",
  "PHARMACOVIGILANCE",
  "TRADUCTION_LANGUE",
  "SIGNATURE_LEGALISATION",
  "AUTRE",
] as const;
export type ReserveCategory = (typeof RESERVE_CATEGORIES)[number];

export type ReserveSeverity = "CRITICAL" | "MAJOR" | "MINOR";

/** Une réserve telle que le modèle doit la rendre. */
export interface ExtractedReserve {
  ordinal: number;
  verbatim: string;
  category: ReserveCategory;
  severity: ReserveSeverity;
  ctdModule: string | null;
  ctdSection: string | null;
  targetDocument: string | null;
  legalBasis: string | null;
  requestedAction: string | null;
  evidencePage: number | null;
  evidenceExcerpt: string | null;
  confidence: number;
}

export interface ExtractedLetter {
  productName: string | null;
  dci: string | null;
  pharmaForm: string | null;
  dosage: string | null;
  procedureType: string | null;
  supplier: string | null;
  reserves: ExtractedReserve[];
}

/** Schéma JSON strict imposé au modèle. */
export const RESERVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["productName", "dci", "pharmaForm", "dosage", "procedureType", "supplier", "reserves"],
  properties: {
    productName: { type: ["string", "null"] },
    dci: { type: ["string", "null"] },
    pharmaForm: { type: ["string", "null"] },
    dosage: { type: ["string", "null"] },
    procedureType: { type: ["string", "null"], description: "INITIAL_REGISTRATION | VARIATION | RENEWAL | AUTRE" },
    supplier: { type: ["string", "null"] },
    reserves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ordinal", "verbatim", "category", "severity", "ctdModule", "ctdSection",
          "targetDocument", "legalBasis", "requestedAction", "evidencePage", "evidenceExcerpt", "confidence",
        ],
        properties: {
          ordinal: { type: "integer" },
          verbatim: { type: "string" },
          category: { type: "string", enum: [...RESERVE_CATEGORIES] },
          severity: { type: "string", enum: ["CRITICAL", "MAJOR", "MINOR"] },
          ctdModule: { type: ["string", "null"] },
          ctdSection: { type: ["string", "null"] },
          targetDocument: { type: ["string", "null"] },
          legalBasis: { type: ["string", "null"] },
          requestedAction: { type: ["string", "null"] },
          evidencePage: { type: ["integer", "null"] },
          evidenceExcerpt: { type: ["string", "null"] },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

const SYSTEM = `Tu extrais les RÉSERVES d'une lettre de l'ANPP (Agence nationale des produits pharmaceutiques, Algérie),
adressée à un laboratoire au sujet d'un dossier d'enregistrement, de modification ou de renouvellement.

RÈGLES ABSOLUES
1. "verbatim" = le texte EXACT de la réserve, copié tel quel, sans reformulation, sans correction
   d'orthographe, sans traduction. C'est une PIÈCE : le réécrire lui ôte toute valeur.
2. N'INVENTE RIEN. Si une information n'est pas dans le document, mets null. Ne déduis un module
   ou une section CTD que si le document les mentionne ou qu'ils sont évidents d'après le sujet.
3. Une réserve = un reproche. Une lettre qui liste 12 points donne 12 réserves, dans l'ordre.
4. "evidencePage" = le numéro de page où figure la réserve, si le document est paginé.
   "evidenceExcerpt" = une phrase de contexte autour de la réserve, copiée telle quelle.
5. "confidence" entre 0 et 1 : ta certitude sur CETTE fiche. Sois honnête — une extraction peu
   sûre sera relue par un humain, une extraction faussement sûre passera à travers.

SÉVÉRITÉ
- CRITICAL : bloque l'enregistrement (donnée absente, étude manquante, non-conformité majeure).
- MAJOR : exige une correction documentée.
- MINOR : forme, présentation, coquille.

CATÉGORIE : choisis la plus précise de la liste imposée.`;

/** Consigne d'extraction pour une lettre en TEXTE (PDF numérique, Word, courriel, tableur). */
export function buildTextExtraction(rawText: string, filename: string): LunaCallInput {
  return {
    system: SYSTEM,
    user:
      `Document : « ${filename} ».\n\n` +
      `Contenu :\n"""\n${rawText.slice(0, 400_000)}\n"""\n\n` +
      `Extrais l'en-tête produit et TOUTES les réserves.`,
    jsonSchema: { name: "anpp_reserves", schema: RESERVE_SCHEMA as unknown as Record<string, unknown> },
    maxOutputTokens: 16_000,
    temperature: 0,
  };
}

/**
 * Consigne d'extraction pour une lettre SCANNÉE : on envoie les pages en IMAGE.
 *
 * C'est là que le multimodal change tout. Sur un scan de mauvaise qualité, l'OCR rend un texte
 * approximatif — et un verbatim approximatif ne vaut rien. Le modèle qui REGARDE la page lit
 * les tampons, les tableaux, les annotations manuscrites et la numérotation que l'OCR perd.
 */
export function buildVisionExtraction(
  images: { buffer: Buffer; mime?: string }[],
  filename: string,
  ocrHint?: string,
): LunaCallInput {
  return {
    system: SYSTEM,
    user:
      `Document scanné : « ${filename} » (${images.length} page(s) fournie(s) en image).\n\n` +
      (ocrHint ? `Un OCR approximatif est joint à titre d'AIDE — en cas de désaccord, c'est l'IMAGE qui fait foi :\n"""\n${ocrHint.slice(0, 120_000)}\n"""\n\n` : "") +
      `Lis les pages et extrais l'en-tête produit et TOUTES les réserves. ` +
      `Numérote "evidencePage" selon l'ordre des images fournies (la première est la page 1).`,
    images,
    jsonSchema: { name: "anpp_reserves", schema: RESERVE_SCHEMA as unknown as Record<string, unknown> },
    maxOutputTokens: 16_000,
    temperature: 0,
  };
}

const CATEGORIES = new Set<string>(RESERVE_CATEGORIES);
const SEVERITIES = new Set(["CRITICAL", "MAJOR", "MINOR"]);

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
};

/**
 * Valide et assainit la réponse du modèle.
 *
 * Même avec un schéma strict, on ne fait pas confiance aveuglément : une réserve SANS verbatim
 * est inutilisable et donc écartée, une catégorie inconnue retombe sur « AUTRE », une confiance
 * hors bornes est ramenée dans [0, 1]. Fonction PURE — c'est elle qui est testée.
 */
export function parseExtraction(raw: unknown): ExtractedLetter {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.reserves) ? o.reserves : [];

  const reserves: ExtractedReserve[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const verbatim = str(r.verbatim);
    if (!verbatim) continue; // sans texte exact, la fiche n'a aucune valeur probante

    const category = typeof r.category === "string" && CATEGORIES.has(r.category) ? (r.category as ReserveCategory) : "AUTRE";
    const severity = typeof r.severity === "string" && SEVERITIES.has(r.severity) ? (r.severity as ReserveSeverity) : "MAJOR";
    const confidenceRaw = Number(r.confidence);
    const page = Number(r.evidencePage);

    reserves.push({
      ordinal: Number.isFinite(Number(r.ordinal)) ? Math.max(0, Math.round(Number(r.ordinal))) : reserves.length + 1,
      verbatim,
      category,
      severity,
      ctdModule: normalizeModule(str(r.ctdModule)),
      ctdSection: str(r.ctdSection),
      targetDocument: str(r.targetDocument),
      legalBasis: str(r.legalBasis),
      requestedAction: str(r.requestedAction),
      evidencePage: Number.isFinite(page) && page > 0 ? Math.round(page) : null,
      evidenceExcerpt: str(r.evidenceExcerpt),
      confidence: Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5,
    });
  }

  // Renumérotation stable : l'ordre du document prime sur ce que le modèle a écrit.
  reserves.forEach((r, i) => { r.ordinal = i + 1; });

  return {
    productName: str(o.productName),
    dci: str(o.dci),
    pharmaForm: str(o.pharmaForm),
    dosage: str(o.dosage),
    procedureType: str(o.procedureType),
    supplier: str(o.supplier),
    reserves,
  };
}

/** « module 3 », « M3 », « 3 » → « M3 ». Rend les statistiques par module exploitables. */
export function normalizeModule(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.toUpperCase().match(/\b(?:MODULE\s*)?M?\s*([1-5])\b/);
  return m ? `M${m[1]}` : null;
}
