/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DOCUMENT LÉGAL TEL QUE LE MODÈLE L'A LU — et la lecture STRICTE de ce qu'il rend.
 *
 * Un contrat, un bail, une police d'assurance n'ont pas de tableau de lignes : ce que la saisie
 * d'un document Legal attend d'eux, c'est sa NATURE, un TITRE, ses DATES (ou sa durée), la PARTIE
 * en face et deux lignes de RÉSUMÉ. Les règles (`entetes.ts`) lisent le numéro, la date d'une
 * facture, les NIF/RC et les totaux ; elles ne savent ni nommer un contrat ni dire quand il prend
 * effet. C'est ce que ce schéma demande au modèle — et rien d'autre : le MONTANT n'y est pas, il
 * reste aux règles, contrôlé au centime (lot D2, P3).
 *
 * ── CE QUE LA LECTURE GARANTIT ───────────────────────────────────────────────────────────
 *
 * - Un objet qui n'en est pas un rend `null` : ce n'est pas une synthèse.
 * - Chaque valeur vient avec son EXTRAIT — la phrase du document qui la porte, bornée. Une valeur
 *   sans extrait n'est pas gardée : ce que l'écran montre doit pouvoir se vérifier sur le papier.
 *   Le titre et le résumé sont des RÉDACTIONS, pas des recopies : ils n'ont pas d'extrait.
 * - Une date se relit par `dateLue` ; une durée par un nombre entier positif et une unité fermée.
 * - Une nature hors du vocabulaire Legal est ignorée, pas devinée.
 * - Le texte du document est une DONNÉE (§104.10) : un titre ou un résumé porteur d'une consigne
 *   est signalé (`suspect`) et l'écran ne le reprend pas.
 *
 * Module PUR (le schéma et la relecture vivent ensemble : deux endroits divergeraient, §118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { scanForInjection } from "@/lib/comms/untrusted";
import { dateLue } from "@/lib/pieces-lues/entetes";
import { normaliserNif, normaliserRc } from "@/lib/pieces-lues/fournisseur";

/** Les natures d'un document Legal, dans l'ordre de `LEGAL_DOC_KIND` (un banc tient l'accord). */
export const NATURES_LEGALES_LUES = [
  "CONTRACT", "QUOTE", "PURCHASE_ORDER", "INVOICE", "AGREEMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "OTHER",
] as const;
export type NatureLegaleLue = (typeof NATURES_LEGALES_LUES)[number];

export const UNITES_DUREE = ["JOUR", "MOIS", "AN"] as const;
export type UniteDuree = (typeof UNITES_DUREE)[number];

export const TITRE_MAX = 140;
export const RESUME_MAX = 400;
export const SURVEILLER_MAX = 300;
const EXTRAIT_MAX = 240;
/** Au-delà de 99 ans, ce n'est plus une durée de contrat qu'on a lue. */
const DUREE_MAX_JOURS = 99 * 366;

export interface ValeurLue<T> {
  valeur: T;
  /** La phrase du document qui porte la valeur — ce que l'écran montre comme preuve. */
  extrait: string;
}

export interface ContrepartieLue {
  nom: string | null;
  nif: string | null;
  rc: string | null;
  adresse: string | null;
}

export interface SyntheseLegale {
  nature: ValeurLue<NatureLegaleLue> | null;
  /** Une RÉDACTION du modèle (« Contrat de maintenance — ClimTech SARL ») : pas d'extrait. */
  titre: string | null;
  dateDebut: ValeurLue<string> | null;
  dateFin: ValeurLue<string> | null;
  duree: ValeurLue<{ nombre: number; unite: UniteDuree }> | null;
  contrepartie: ContrepartieLue;
  resume: string | null;
  /** Préavis, reconduction tacite, pénalités — quand le document en porte. */
  aSurveiller: string | null;
  /** Les champs rédigés qui portent un motif d'injection : signalés, jamais repris. */
  suspects: ("titre" | "resume" | "aSurveiller")[];
}

const texte = (description: string) => ({ type: "string", description });
const AVEC_EXTRAIT = (quoi: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["valeur", "extrait"],
  properties: {
    valeur: texte(`${quoi} ; vide si le document ne le dit pas.`),
    extrait: texte("La phrase du document qui le dit, recopiée telle quelle ; vide si la valeur est vide."),
  },
});

export const SCHEMA_SYNTHESE_LEGALE = {
  name: "document_legal_lu",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["nature", "titre", "dateDebut", "dateFin", "duree", "contrepartie", "resume", "aSurveiller"],
    properties: {
      nature: {
        type: "object",
        additionalProperties: false,
        required: ["valeur", "extrait"],
        properties: {
          valeur: { type: "string", enum: [...NATURES_LEGALES_LUES, ""], description: "La nature du document ; vide si elle ne se lit pas." },
          extrait: texte("Le titre ou la phrase du document qui dit sa nature ; vide sinon."),
        },
      },
      titre: texte(`Un titre court et factuel : ce qu'est le document et avec qui (« Contrat de maintenance des climatiseurs — ClimTech SARL »). ${TITRE_MAX} caractères au plus.`),
      dateDebut: AVEC_EXTRAIT("La date de prise d'effet (contrat) ou d'émission (facture, devis), telle qu'imprimée (JJ/MM/AAAA)"),
      dateFin: AVEC_EXTRAIT("La date de fin ou d'échéance si elle est IMPRIMÉE, telle qu'imprimée (JJ/MM/AAAA) — jamais calculée"),
      duree: {
        type: "object",
        additionalProperties: false,
        required: ["nombre", "unite", "extrait"],
        properties: {
          nombre: texte("La durée ou le délai, en chiffres (« 12 ») ; vide s'il n'y en a pas."),
          unite: { type: "string", enum: [...UNITES_DUREE, ""], description: "L'unité de la durée ; vide sans durée." },
          extrait: texte("La phrase qui dit la durée (« conclu pour une durée de douze mois », « paiement à 30 jours ») ; vide sinon."),
        },
      },
      contrepartie: {
        type: "object",
        additionalProperties: false,
        required: ["nom", "nif", "rc", "adresse"],
        properties: {
          nom: texte("La raison sociale de l'AUTRE partie — jamais l'une de nos sociétés."),
          nif: texte("Son NIF, tel qu'imprimé ; vide sinon."),
          rc: texte("Son RC, tel qu'imprimé ; vide sinon."),
          adresse: texte("Son adresse ; vide sinon."),
        },
      },
      resume: texte(`Une ou deux phrases factuelles : quoi, pour qui, pour combien de temps. ${RESUME_MAX} caractères au plus.`),
      aSurveiller: texte(`Préavis de résiliation, reconduction tacite, pénalités, garanties — seulement ce que le document dit ; vide sinon. ${SURVEILLER_MAX} caractères au plus.`),
    },
  },
} as const;

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Une chaîne utile, sur une ligne, bornée — `null` si vide. */
function chaine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function avecExtrait<T>(brut: unknown, lire: (v: unknown) => T | null): ValeurLue<T> | null {
  if (!estObjet(brut)) return null;
  const valeur = lire(brut.valeur);
  const extrait = chaine(brut.extrait, EXTRAIT_MAX);
  return valeur !== null && extrait ? { valeur, extrait } : null;
}

function nature(v: unknown): NatureLegaleLue | null {
  return typeof v === "string" && (NATURES_LEGALES_LUES as readonly string[]).includes(v) ? (v as NatureLegaleLue) : null;
}

function duree(brut: unknown): SyntheseLegale["duree"] {
  if (!estObjet(brut)) return null;
  const unite = typeof brut.unite === "string" && (UNITES_DUREE as readonly string[]).includes(brut.unite) ? (brut.unite as UniteDuree) : null;
  const n = typeof brut.nombre === "string" && /^\s*\d{1,4}\s*$/.test(brut.nombre) ? Number(brut.nombre) : null;
  const extrait = chaine(brut.extrait, EXTRAIT_MAX);
  if (!unite || !n || !extrait) return null;
  const jours = unite === "JOUR" ? n : unite === "MOIS" ? n * 31 : n * 366;
  return jours <= DUREE_MAX_JOURS ? { valeur: { nombre: n, unite }, extrait } : null;
}

/**
 * RELIRE LA SORTIE DU MODÈLE. `null` quand ce n'est pas un objet ; sinon une synthèse dont chaque
 * valeur recopiée porte son extrait, et dont les rédactions suspectes sont signalées.
 */
export function lireSyntheseModele(brut: unknown): SyntheseLegale | null {
  if (!estObjet(brut)) return null;
  const c = estObjet(brut.contrepartie) ? brut.contrepartie : {};
  const titre = chaine(brut.titre, TITRE_MAX);
  const resume = chaine(brut.resume, RESUME_MAX);
  const aSurveiller = chaine(brut.aSurveiller, SURVEILLER_MAX);
  const suspects: SyntheseLegale["suspects"] = [];
  if (titre && scanForInjection(titre).flags.length > 0) suspects.push("titre");
  if (resume && scanForInjection(resume).flags.length > 0) suspects.push("resume");
  if (aSurveiller && scanForInjection(aSurveiller).flags.length > 0) suspects.push("aSurveiller");
  return {
    nature: avecExtrait(brut.nature, nature),
    titre,
    dateDebut: avecExtrait(brut.dateDebut, dateLue),
    dateFin: avecExtrait(brut.dateFin, dateLue),
    duree: duree(brut.duree),
    contrepartie: {
      nom: chaine(c.nom, 160),
      nif: normaliserNif(chaine(c.nif, 40)),
      rc: normaliserRc(chaine(c.rc, 40)),
      adresse: chaine(c.adresse, 200),
    },
    resume,
    aSurveiller,
    suspects,
  };
}

/** Une synthèse GARDÉE se relit — c'est la nôtre ; une forme inattendue ne se croit pas. */
export function syntheseGardee(v: unknown): SyntheseLegale | null {
  if (!estObjet(v) || !estObjet(v.contrepartie) || !Array.isArray(v.suspects)) return null;
  return v as unknown as SyntheseLegale;
}
