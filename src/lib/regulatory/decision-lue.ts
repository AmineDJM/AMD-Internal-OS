import { dateLue } from "@/lib/pieces-lues/entetes";
import { analyserNombre } from "@/lib/pieces-lues/montants";
import { TYPES_PRIX, type TypePrix } from "@/lib/products/fiche-360";
import { finDeduite, jourUtc, ymd, type SourceDate } from "@/lib/regulatory/validite-enregistrement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'IA LIT SUR UNE DÉCISION D'ENREGISTREMENT ET UNE ATTESTATION DE PRIX — la forme imposée au
 * modèle, la relecture de sa réponse, et la PROPOSITION gardée sur le dossier. Pur.
 *
 * Le modèle RECOPIE (numéro, dates telles qu'imprimées, prix en DZD) avec la phrase qui les dit ;
 * notre code lit les dates (`dateLue`) et les nombres (`analyserNombre`), et DÉDUIT la fin
 * (début + 5 ans) quand elle n'est pas imprimée — marquée « déduite », jamais présentée comme lue.
 * Rien de ceci n'est un fait : une personne confirme d'un clic, et peut toujours corriger.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_PIECE_ENREGISTREMENT = ["DECISION", "PRIX"] as const;
export type NaturePieceEnregistrement = (typeof NATURES_PIECE_ENREGISTREMENT)[number];

/** La catégorie de la pièce typée, et son libellé. */
export const PIECE_ENREGISTREMENT: Record<NaturePieceEnregistrement, { categorie: "REGISTRATION_DECISION" | "PRICE_ATTESTATION"; libelle: string }> = {
  DECISION: { categorie: "REGISTRATION_DECISION", libelle: "Décision d'enregistrement" },
  PRIX: { categorie: "PRICE_ATTESTATION", libelle: "Attestation de prix" },
};

/** L'étape ANPP qui range les deux pièces (« Décision d'enregistrement + attestation de prix »). */
export const ETAPE_DECISION = "decision";

export function estNaturePiece(v: unknown): v is NaturePieceEnregistrement {
  return typeof v === "string" && (NATURES_PIECE_ENREGISTREMENT as readonly string[]).includes(v);
}

const EXTRAIT_MAX = 240;
const NUMERO_MAX = 80;
const PRIX_MAX_LIGNES = TYPES_PRIX.length;

const texte = (description: string) => ({ type: "string", description });
const avecExtrait = (quoi: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["valeur", "extrait"],
  properties: {
    valeur: texte(`${quoi} ; vide si le document ne le dit pas.`),
    extrait: texte("La phrase du document qui le dit, recopiée telle quelle ; vide si la valeur est vide."),
  },
});

export const SCHEMA_DECISION_LUE = {
  name: "decision_enregistrement_lue",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["numero", "dateDecision", "debutValidite", "finValidite"],
    properties: {
      numero: avecExtrait("Le numéro de la décision d'enregistrement, tel qu'imprimé"),
      dateDecision: avecExtrait("La date de la décision (signature), telle qu'imprimée (JJ/MM/AAAA)"),
      debutValidite: avecExtrait("La date de début de validité si elle est IMPRIMÉE, telle qu'imprimée (JJ/MM/AAAA)"),
      finValidite: avecExtrait("La date de fin de validité ou d'expiration si elle est IMPRIMÉE (JJ/MM/AAAA) — jamais calculée"),
    },
  },
} as const;

export const SCHEMA_ATTESTATION_LUE = {
  name: "attestation_prix_lue",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["date", "prix"],
    properties: {
      date: avecExtrait("La date de l'attestation (ou de prise d'effet du prix), telle qu'imprimée (JJ/MM/AAAA)"),
      prix: {
        type: "array",
        description: "Les prix en dinars algériens (DA, DZD) que l'attestation fixe — jamais un prix en devise (FOB en USD/EUR).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "montant", "extrait"],
          properties: {
            type: { type: "string", enum: [...TYPES_PRIX], description: "PPA = prix public algérien ; SHP = prix de cession / sortie d'usine ; TARIF_REFERENCE = tarif de référence (remboursement) ; PRIX_HOPITAL = prix hôpital / PCH." },
            montant: texte("Le montant en DZD, EN TEXTE, tel qu'imprimé (« 1 234,50 »)."),
            extrait: texte("La phrase ou la ligne du document qui le dit, recopiée telle quelle."),
          },
        },
      },
    },
  },
} as const;

// ─────────────────────────── La proposition gardée sur le dossier ───────────────────────────

export interface ChampPropose<T> {
  valeur: T;
  /** La phrase du document — la preuve que l'écran montre ; `null` pour une valeur déduite sans phrase. */
  extrait: string | null;
  source: Extract<SourceDate, "LUE_IA" | "DEDUITE">;
}

interface EnteteLecture {
  documentId: string;
  nomFichier: string;
  /** Instant de la lecture (ISO). */
  luLe: string;
  /** « OCR 71 % », « texte natif » — la note courte de la méthode, écrite par notre code. */
  methode: string;
  /** Pourquoi l'IA n'a rien proposé (coupée, désactivée, illisible…) — la saisie reste ouverte. */
  erreur: string | null;
}

export interface PropositionDecision extends EnteteLecture {
  numero: ChampPropose<string> | null;
  dateDecision: ChampPropose<string> | null;
  debut: ChampPropose<string> | null;
  fin: ChampPropose<string> | null;
}

export interface PrixPropose extends ChampPropose<number> { type: TypePrix }

export interface PropositionPrix extends EnteteLecture {
  date: ChampPropose<string> | null;
  prix: PrixPropose[];
}

export interface LecturesEnregistrement {
  decision?: PropositionDecision | null;
  prix?: PropositionPrix | null;
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function chaine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function lu<T>(brut: unknown, lire: (v: unknown) => T | null): ChampPropose<T> | null {
  if (!estObjet(brut)) return null;
  const valeur = lire(brut.valeur);
  const extrait = chaine(brut.extrait, EXTRAIT_MAX);
  // Une valeur sans la phrase qui la dit n'est pas reprise : rien ne la prouve.
  return valeur !== null && extrait ? { valeur, extrait, source: "LUE_IA" } : null;
}

const dateIso = (v: unknown): string | null => {
  const d = dateLue(v);
  return d && jourUtc(d) ? d : null;
};

export interface DecisionLue {
  numero: ChampPropose<string> | null;
  dateDecision: ChampPropose<string> | null;
  debut: ChampPropose<string> | null;
  fin: ChampPropose<string> | null;
}

/** La réponse du modèle, relue ; `null` si elle n'a pas la forme imposée. */
export function lireDecisionModele(brut: unknown): DecisionLue | null {
  if (!estObjet(brut)) return null;
  return {
    numero: lu(brut.numero, (v) => chaine(v, NUMERO_MAX)),
    dateDecision: lu(brut.dateDecision, dateIso),
    debut: lu(brut.debutValidite, dateIso),
    fin: lu(brut.finValidite, dateIso),
  };
}

/** La réponse du modèle pour une attestation, relue : les prix en DZD lisibles et positifs, un par type. */
export function lireAttestationModele(brut: unknown): { date: ChampPropose<string> | null; prix: PrixPropose[] } | null {
  if (!estObjet(brut) || !Array.isArray(brut.prix)) return null;
  const prix: PrixPropose[] = [];
  for (const l of brut.prix.slice(0, PRIX_MAX_LIGNES * 2)) {
    if (!estObjet(l) || typeof l.type !== "string" || !(TYPES_PRIX as readonly string[]).includes(l.type)) continue;
    if (prix.some((p) => p.type === l.type)) continue;
    const n = analyserNombre(l.montant, { devise: true }).valeur;
    const extrait = chaine(l.extrait, EXTRAIT_MAX);
    if (n === null || !(n > 0) || !extrait) continue;
    prix.push({ type: l.type as TypePrix, valeur: Math.round(n * 100) / 100, extrait, source: "LUE_IA" });
  }
  return { date: lu(brut.date, dateIso), prix: prix.slice(0, PRIX_MAX_LIGNES) };
}

/**
 * LES DATES PROPOSÉES : celles lues, puis — le début manquant reprend la date de la décision, la fin
 * manquante est DÉDUITE (début + 5 ans), sans phrase du document puisqu'aucune ne la dit.
 */
export function proposerDates(l: DecisionLue | null): Pick<PropositionDecision, "numero" | "dateDecision" | "debut" | "fin"> {
  const numero = l?.numero ?? null;
  const dateDecision = l?.dateDecision ?? null;
  const debut = l?.debut ?? (dateDecision ? { ...dateDecision } : null);
  let fin = l?.fin ?? null;
  if (!fin && debut) fin = { valeur: ymd(finDeduite(jourUtc(debut.valeur)!)), extrait: null, source: "DEDUITE" };
  return { numero, dateDecision, debut, fin };
}

/** La proposition gardée sur le dossier, relue avec méfiance (JSON en base). */
export function lecturesDuDossier(brut: unknown): LecturesEnregistrement {
  if (!estObjet(brut)) return {};
  const out: LecturesEnregistrement = {};
  if (estObjet(brut.decision) && typeof brut.decision.documentId === "string") out.decision = brut.decision as unknown as PropositionDecision;
  if (estObjet(brut.prix) && typeof brut.prix.documentId === "string") out.prix = brut.prix as unknown as PropositionPrix;
  return out;
}

/** Ce que la personne fait quand l'IA n'a rien proposé — la saisie reste ouverte, rien ne bloque. */
export function phraseSansLecture(raison: string | null, cause: string | null, nature: NaturePieceEnregistrement): string | null {
  const remede = nature === "DECISION" ? "saisissez le numéro et les dates depuis la décision." : "saisissez le prix depuis l'attestation.";
  const c = cause?.trim().replace(/[.\s]+$/, "");
  switch (raison) {
    case "IA_COUPEE": return `${c || "L'IA est coupée par l'interrupteur général"} — ${remede}`;
    case "DESACTIVEE": return `Lecture des pièces par l'IA désactivée (Administration › Contrôle de l'IA) — ${remede}`;
    case "NON_CONFIGUREE": return `${c || "La clé du fournisseur d'IA n'est pas configurée"} — ${remede}`;
    case "CONFIDENTIELLE": return `Dossier confidentiel : la pièce n'est pas envoyée à l'IA — ${remede}`;
    case "TEXTE_ILLISIBLE": return `Le texte lu est trop court ou trop abîmé pour être compris — ${remede}`;
    default: return null;
  }
}
