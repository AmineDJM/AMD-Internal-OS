/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFIRMATION D'UNE PIÈCE LUE — ce qu'une personne a fait de chaque ligne proposée (lot D2, P7).
 *
 * Une lecture PROPOSE (§118.152 i) ; une personne CONFIRME, ligne à ligne, en comparant au papier.
 * Ce module dit, sans base, ce que la confirmation contient et ce qu'elle exige :
 *
 *   • le VERDICT de chaque ligne — CONFIRMEE (soumise telle que lue), CORRIGEE (venue de la lecture
 *     et changée), AJOUTEE (saisie à la main), ECARTEE (lue, et retirée du formulaire). Les prix se
 *     comparent AU CENTIME et les quantités au millième : 0,1 + 0,2 lu contre 0,30 soumis est la
 *     même valeur, pas une correction — un artefact de virgule flottante n'est pas un geste humain ;
 *   • le REFUS qui nomme tout ce qui manque, en une fois (§118.18) : une ligne venue de la lecture
 *     et non cochée « vérifiée », le total non coché, une ligne lue que le formulaire désigne sans
 *     qu'elle existe ou qu'il désigne deux fois (un formulaire forgé ne choisit pas une ligne) ;
 *   • la PHRASE d'audit — « lignes lues par OCR (71 %), confirmées une à une : … ».
 *
 * Une ligne ÉCARTÉE n'exige pas de case : la retirer est déjà une décision. C'est une ligne GARDÉE
 * et venue de la lecture qui doit être cochée — sans quoi une proposition de machine entrerait
 * dans un devis sans que personne ait dit l'avoir comparée au papier.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les écritures qu'une confirmation peut accompagner — vocabulaire fermé (`LecturePieceConfirmation.cibleType`). */
export const CIBLES_LECTURE = ["PROMO_QUOTE", "PROMO_FACTURE", "LEGAL_DOCUMENT", "DEPARTMENT_EXPENSE"] as const;
export type CibleLecture = (typeof CIBLES_LECTURE)[number];

export const VERDICTS_LIGNE = ["CONFIRMEE", "CORRIGEE", "AJOUTEE", "ECARTEE"] as const;
export type VerdictLigne = (typeof VERDICTS_LIGNE)[number];

/** Une ligne telle que la lecture l'a PROPOSÉE à l'écran (celle que la personne a vue, pas la sortie brute). */
export interface LigneProposee {
  /** Le rang de la ligne lue (`LigneLue.rang`, 1-indexé) — l'identifiant que le formulaire renvoie. */
  rang: number;
  designation: string;
  /** `null` : non proposée (illisible, ou volontairement laissée à la personne). */
  quantite: number | null;
  prixUnitaire: number | null;
}

/** Une ligne telle que le formulaire la SOUMET. */
export interface LigneSoumise {
  /** Le rang de la ligne lue dont elle vient ; `null` : saisie à la main. */
  lue: number | null;
  /** La case « vérifiée » — n'a de sens que pour une ligne venue de la lecture. */
  verifiee: boolean;
  designation: string;
  quantite: number;
  prixUnitaire: number;
}

export type ChampLigne = "designation" | "quantite" | "prixUnitaire";

export interface ValeursLigne {
  designation: string;
  quantite: number | null;
  prixUnitaire: number | null;
}

export interface VerdictDeLigne {
  verdict: VerdictLigne;
  /** Le rang de la ligne lue ; `null` pour une ligne ajoutée. */
  rang: number | null;
  /** La place de la ligne dans le formulaire, 1-indexée ; `null` pour une ligne écartée (absente du formulaire). */
  position: number | null;
  lue: ValeursLigne | null;
  soumise: ValeursLigne | null;
  /** Ce que la personne a changé (CORRIGEE) — vide sinon. */
  champs: ChampLigne[];
}

const espaces = (s: string): string => s.replace(/\s+/g, " ").trim();
const centimes = (x: number): number => Math.round(x * 100);
const memePrix = (a: number | null, b: number | null): boolean => a !== null && b !== null && centimes(a) === centimes(b);
const memeQuantite = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < 0.0005;
const court = (s: string): string => {
  const t = espaces(s);
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

/** Les rangs que le formulaire désigne mal : inconnus de la lecture, ou désignés deux fois. */
function rangsFautifs(proposees: readonly LigneProposee[], soumises: readonly LigneSoumise[]): { inconnus: number[]; doubles: number[] } {
  const connus = new Set(proposees.map((p) => p.rang));
  const vus = new Set<number>();
  const inconnus: number[] = [];
  const doubles: number[] = [];
  for (const s of soumises) {
    if (s.lue === null) continue;
    if (!connus.has(s.lue)) { if (!inconnus.includes(s.lue)) inconnus.push(s.lue); continue; }
    if (vus.has(s.lue)) { if (!doubles.includes(s.lue)) doubles.push(s.lue); continue; }
    vus.add(s.lue);
  }
  return { inconnus, doubles };
}

/**
 * CE QUI EMPÊCHE DE CONFIRMER — tout, en une phrase ; `null` quand rien ne manque. L'état d'abord :
 * un formulaire qui désigne une ligne lue inexistante est refusé avant qu'on parle de cases.
 */
export function refusDeConfirmation(
  proposees: readonly LigneProposee[],
  soumises: readonly LigneSoumise[],
  totalVerifie: boolean,
  /** `caseGlobale` : l'écran atteste d'UNE case (son libellé) — le refus nomme cette case, une seule fois. */
  opts: { caseGlobale?: string } = {},
): string | null {
  const { inconnus, doubles } = rangsFautifs(proposees, soumises);
  if (inconnus.length > 0 || doubles.length > 0) {
    const quoi = [
      inconnus.length > 0 ? `une ligne lue qui n'existe pas (rang ${inconnus.join(", ")})` : null,
      doubles.length > 0 ? `la même ligne lue deux fois (rang ${doubles.join(", ")})` : null,
    ].filter(Boolean).join(" et ");
    return `Le formulaire désigne ${quoi} : rien n'a été enregistré — relisez le scan, puis reprenez la saisie.`;
  }
  const nonCochees = soumises
    .map((s, i) => ({ s, position: i + 1 }))
    .filter(({ s }) => s.lue !== null && !s.verifiee);
  if (opts.caseGlobale && (nonCochees.length > 0 || !totalVerifie)) {
    return `Lecture non confirmée : cochez « ${opts.caseGlobale} » après avoir comparé les lignes lues au papier. Rien n'a été enregistré.`;
  }
  const manques: string[] = [];
  if (nonCochees.length > 0) {
    const noms = nonCochees.map(({ s, position }) => `ligne ${position} (« ${court(s.designation)} »)`).join(", ");
    manques.push(`cochez « vérifiée » sur chaque ligne venue de la lecture, après l'avoir comparée au papier — ${nonCochees.length > 1 ? "restent" : "reste"} : ${noms}`);
  }
  if (!totalVerifie) manques.push("cochez « total vérifié » après avoir comparé le total HT au papier");
  return manques.length > 0 ? `Lecture non confirmée : ${manques.join(" ; ")}. Rien n'a été enregistré.` : null;
}

/**
 * LE VERDICT DE CHAQUE LIGNE. Suppose le formulaire bien formé (`refusDeConfirmation` passé) : une
 * ligne désignée deux fois ne reçoit qu'un verdict de lecture, la seconde est comptée ajoutée.
 */
export function verdictsDeConfirmation(proposees: readonly LigneProposee[], soumises: readonly LigneSoumise[]): VerdictDeLigne[] {
  const parRang = new Map(proposees.map((p) => [p.rang, p]));
  const pris = new Set<number>();
  const out: VerdictDeLigne[] = [];
  soumises.forEach((s, i) => {
    const soumise: ValeursLigne = { designation: espaces(s.designation), quantite: s.quantite, prixUnitaire: s.prixUnitaire };
    const p = s.lue !== null && !pris.has(s.lue) ? parRang.get(s.lue) : undefined;
    if (!p) {
      out.push({ verdict: "AJOUTEE", rang: null, position: i + 1, lue: null, soumise, champs: [] });
      return;
    }
    pris.add(p.rang);
    const lue: ValeursLigne = { designation: espaces(p.designation), quantite: p.quantite, prixUnitaire: p.prixUnitaire };
    const champs: ChampLigne[] = [];
    if (lue.designation !== soumise.designation) champs.push("designation");
    if (!memeQuantite(lue.quantite, soumise.quantite)) champs.push("quantite");
    if (!memePrix(lue.prixUnitaire, soumise.prixUnitaire)) champs.push("prixUnitaire");
    out.push({ verdict: champs.length === 0 ? "CONFIRMEE" : "CORRIGEE", rang: p.rang, position: i + 1, lue, soumise, champs });
  });
  for (const p of proposees) {
    if (pris.has(p.rang)) continue;
    out.push({
      verdict: "ECARTEE", rang: p.rang, position: null,
      lue: { designation: espaces(p.designation), quantite: p.quantite, prixUnitaire: p.prixUnitaire }, soumise: null, champs: [],
    });
  }
  return out;
}

const pluriel = (n: number, mot: string): string => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** D'où viennent les lignes, en une locution : « par OCR (71 %) », « dans le texte du fichier ». */
function provenance(f: { methode: "texte" | "ocr"; confiance: number | null }): string {
  if (f.methode === "texte") return "dans le texte du fichier";
  return typeof f.confiance === "number" && Number.isFinite(f.confiance) ? `par OCR (${Math.round(f.confiance)} %)` : "par OCR";
}

/**
 * LA PHRASE D'AUDIT : comment la pièce a été lue, et ce que la personne a fait des lignes. Elle va au
 * journal à côté de l'écriture métier — l'audit doit pouvoir dire qu'un prix vient d'une lecture
 * de machine confirmée par une personne, et non d'une saisie.
 */
export function phraseAuditConfirmation(
  faits: { methode: "texte" | "ocr"; confiance: number | null },
  verdicts: readonly VerdictDeLigne[],
  /** L'écran a attesté d'UNE case pour toutes les lignes lues : l'audit ne prétend pas « une à une ». */
  attestationGlobale = false,
): string {
  const n = (v: VerdictLigne) => verdicts.filter((x) => x.verdict === v).length;
  const lues = verdicts.filter((x) => x.verdict !== "AJOUTEE").length;
  const par = provenance(faits);
  if (lues === 0) {
    return `en-tête et totaux lus ${par} ; ${pluriel(n("AJOUTEE"), "ligne")} ${n("AJOUTEE") > 1 ? "saisies" : "saisie"} à la main`;
  }
  const detail = [
    `${n("CONFIRMEE")} telle${n("CONFIRMEE") > 1 ? "s" : ""} que lue${n("CONFIRMEE") > 1 ? "s" : ""}`,
    `${n("CORRIGEE")} corrigée${n("CORRIGEE") > 1 ? "s" : ""}`,
    `${n("AJOUTEE")} ajoutée${n("AJOUTEE") > 1 ? "s" : ""}`,
    `${n("ECARTEE")} écartée${n("ECARTEE") > 1 ? "s" : ""}`,
  ].join(", ");
  return `lignes lues ${par}, ${attestationGlobale ? "comparées au papier (attestation globale)" : "confirmées une à une"} : ${detail}`;
}
