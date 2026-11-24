/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JOURNAL « PROPOSITION D'IA → DÉCISION HUMAINE » — la part PURE.
 *
 * Une IA propose (des définitions de KPI, une cible, une justification d'écart, une nature de dépense, des postes, les
 * champs lus dans un contrat, un conseil de rangement) ; un humain retient tel quel, corrige, ou écarte. On ne gardait
 * ni la proposition ni la décision : impossible de dire si une fonction d'IA sert. Ici :
 *   • `empreinteProposition` — l'identité d'une proposition (un rejeu le même jour ne double pas la ligne) ;
 *   • `verdictProposition` — ACCEPTE / MODIFIE / REJETE en comparant ce qui a été proposé à ce qui a été retenu ;
 *   • `tauxAcceptation` — par fonction : retenues telles quelles, corrigées, écartées, restées sans suite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { cleDeCible, type StatutSignal } from "./signaux";

export type Verdict = Extract<StatutSignal, "ACCEPTE" | "MODIFIE" | "REJETE">;

/** Au-delà, une proposition qu'aucun geste n'a suivie compte « sans suite » (une forme de refus silencieux). */
export const DELAI_SANS_SUITE_JOURS = 14;

/** Le geste humain se rattache à la DERNIÈRE proposition ouverte de la même personne, sur la même cible, dans ce délai. */
export const FENETRE_DECISION_JOURS = 7;

/** Forme canonique d'une valeur : minuscules, espaces simples, clés triées — deux écritures du même contenu sont égales. */
export function canonique(v: unknown): unknown {
  if (typeof v === "string") return v.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
  if (Array.isArray(v)) return v.map(canonique);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonique((v as Record<string, unknown>)[k])]));
  }
  return v ?? null;
}

const egal = (a: unknown, b: unknown): boolean => JSON.stringify(canonique(a)) === JSON.stringify(canonique(b));
const vide = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)
  || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** FNV-1a 32 bits, deux passes — une empreinte courte et stable, sans `crypto` (un domaine n'importe pas Node). */
export function empreinteProposition(v: unknown): string {
  const s = JSON.stringify(canonique(v)) ?? "";
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** LA CLÉ D'UNE PROPOSITION : la personne, la cible, l'empreinte du contenu. */
export function cleProposition(auteurId: string, cible: { type: string; id: string } | null, propose: unknown): string {
  return cleDeCible(cible ? `${cible.type}:${cible.id}` : "sans-cible", auteurId, empreinteProposition(propose));
}

/** Les mots d'un texte (≥ 3 lettres), pour mesurer qu'une rédaction a été reprise en partie. */
function mots(s: string): Set<string> {
  return new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((m) => m.length >= 3));
}

/** Part des mots de la proposition présents dans le texte retenu (0–1). */
export function reprise(propose: string, retenu: string): number {
  const p = mots(propose);
  if (p.size === 0) return 0;
  const r = mots(retenu);
  let n = 0;
  for (const m of p) if (r.has(m)) n += 1;
  return n / p.size;
}

/** Au moins cette part des mots proposés reprise : la rédaction a été CORRIGÉE ; en deçà, l'humain a écrit la sienne. */
export const SEUIL_REPRISE = 0.5;

export interface DetailVerdict {
  verdict: Verdict;
  /** Éléments proposés retenus tels quels, retenus modifiés, écartés ; éléments ajoutés par l'humain. */
  retenus: number;
  modifies: number;
  ecartes: number;
  ajoutes: number;
}

const detail = (verdict: Verdict, retenus: number, modifies: number, ecartes: number, ajoutes: number): DetailVerdict =>
  ({ verdict, retenus, modifies, ecartes, ajoutes });

/** Le verdict d'un ensemble d'éléments (déjà comptés). */
function verdictDesElements(retenus: number, modifies: number, ecartes: number, ajoutes: number): DetailVerdict {
  if (retenus + modifies === 0) return detail("REJETE", 0, 0, ecartes, ajoutes);
  if (modifies === 0 && ecartes === 0 && ajoutes === 0) return detail("ACCEPTE", retenus, 0, 0, 0);
  return detail("MODIFIE", retenus, modifies, ecartes, ajoutes);
}

/**
 * LE VERDICT : comparer ce qui a été PROPOSÉ à ce qui a été RETENU.
 *   • rien de retenu → REJETE ;
 *   • un TEXTE : identique → ACCEPTE ; repris en partie (≥ 50 % des mots) → MODIFIE ; sinon → REJETE ;
 *   • une LISTE : élément par élément (égalité canonique) — tout retenu sans ajout → ACCEPTE ; au moins un → MODIFIE ;
 *   • un OBJET (champ → valeur) : champ par champ, sur les champs PROPOSÉS — tous gardés → ACCEPTE ; au moins un gardé →
 *     MODIFIE ; aucun gardé tel quel (chaque valeur remplacée ou retirée) → REJETE ;
 *   • sinon, l'égalité canonique.
 */
export function verdictProposition(propose: unknown, retenu: unknown): DetailVerdict {
  if (vide(retenu)) return detail("REJETE", 0, 0, 1, 0);
  if (typeof propose === "string" && typeof retenu === "string") {
    if (egal(propose, retenu)) return detail("ACCEPTE", 1, 0, 0, 0);
    return reprise(propose, retenu) >= SEUIL_REPRISE ? detail("MODIFIE", 0, 1, 0, 0) : detail("REJETE", 0, 0, 1, 0);
  }
  if (Array.isArray(propose) && Array.isArray(retenu)) {
    const restants = retenu.map((r) => JSON.stringify(canonique(r)));
    let retenus = 0;
    for (const p of propose) {
      const i = restants.indexOf(JSON.stringify(canonique(p)));
      if (i >= 0) { retenus += 1; restants.splice(i, 1); }
    }
    return verdictDesElements(retenus, 0, propose.length - retenus, restants.length);
  }
  if (propose && retenu && typeof propose === "object" && typeof retenu === "object" && !Array.isArray(propose) && !Array.isArray(retenu)) {
    const p = propose as Record<string, unknown>; const r = retenu as Record<string, unknown>;
    let retenus = 0; let modifies = 0; let ecartes = 0;
    for (const k of Object.keys(p)) {
      if (!(k in r) || vide(r[k])) ecartes += 1;
      else if (egal(p[k], r[k])) retenus += 1;
      else modifies += 1;
    }
    // Aucun champ gardé tel quel : la proposition n'a pas servi — chaque valeur a été remplacée ou retirée.
    if (retenus === 0) return detail("REJETE", 0, modifies, ecartes, 0);
    return verdictDesElements(retenus, modifies, ecartes, 0);
  }
  return egal(propose, retenu) ? detail("ACCEPTE", 1, 0, 0, 0) : detail("MODIFIE", 0, 1, 0, 0);
}

export interface PropositionLue {
  source: string;
  nature: string;
  statut: string;
  producteur: string;
  creeLe: Date;
}

export interface TauxFonction {
  source: string;
  nature: string;
  proposees: number;
  acceptees: number;
  modifiees: number;
  rejetees: number;
  sansSuite: number;
  enAttente: number;
  /** Acceptées telles quelles / propositions closes (décidées + sans suite) ; `null` tant qu'aucune n'est close. */
  taux: number | null;
  /** (Acceptées + modifiées) / closes : l'IA a servi, même corrigée. */
  tauxUtile: number | null;
}

/** LE TAUX D'ACCEPTATION par fonction et par nature de proposition. Une proposition ouverte trop vieille compte sans suite. */
export function tauxAcceptation(lignes: readonly PropositionLue[], maintenant: Date, delaiJours = DELAI_SANS_SUITE_JOURS): TauxFonction[] {
  const limite = maintenant.getTime() - delaiJours * 86_400_000;
  const parCle = new Map<string, TauxFonction>();
  for (const l of lignes) {
    const k = `${l.source}|${l.nature}`;
    const t = parCle.get(k) ?? { source: l.source, nature: l.nature, proposees: 0, acceptees: 0, modifiees: 0, rejetees: 0, sansSuite: 0, enAttente: 0, taux: null, tauxUtile: null };
    t.proposees += 1;
    if (l.statut === "ACCEPTE") t.acceptees += 1;
    else if (l.statut === "MODIFIE") t.modifiees += 1;
    else if (l.statut === "REJETE") t.rejetees += 1;
    else if (l.creeLe.getTime() < limite) t.sansSuite += 1;
    else t.enAttente += 1;
    parCle.set(k, t);
  }
  return [...parCle.values()].map((t) => {
    const closes = t.acceptees + t.modifiees + t.rejetees + t.sansSuite;
    return { ...t, taux: closes ? t.acceptees / closes : null, tauxUtile: closes ? (t.acceptees + t.modifiees) / closes : null };
  }).sort((a, b) => a.source.localeCompare(b.source) || a.nature.localeCompare(b.nature));
}
