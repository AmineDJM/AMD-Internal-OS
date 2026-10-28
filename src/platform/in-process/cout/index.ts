import { allBindings, bindingFor } from "@/lib/models/registry";
import type { ModelRole } from "@/lib/models/contract";
import { choisir, escalader, northStar, porteDeRegression, type Candidate, type Choix, type Mesure } from "@/lib/cout/choix";
import { plancherDe, type Classe } from "@/lib/cout/plancher";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PONT DE L'OPTIMISEUR (mandat 6 §50) — il branche le moteur pur sur les VRAIS tarifs.
 *
 * ── POURQUOI LES CANDIDATES NE SONT PAS UNE LISTE ÉCRITE À LA MAIN ──────────────────────
 *
 * Parce qu'une liste à la main se périme le jour où la grille change, et qu'elle se périme en
 * SILENCE : le code continue de tourner en croyant que Luna coûte ce qu'il coûtait. Les
 * candidates sont donc construites depuis `allBindings()`, qui lit les tarifs du registre —
 * eux-mêmes remplaçables par variable d'environnement sans redéploiement.
 *
 * Un rôle sans tarif connu ne devient PAS une candidate. C'est la même règle qu'en §50 pour la
 * qualité : une inconnue n'est pas une bonne affaire. Le registre le dit lui-même — « ce ne sont
 * pas des estimations, ce sont des prix affichés, datés ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le profil de jetons d'un appel — sert à convertir un tarif par million en coût d'appel. */
export interface Profil {
  jetonsEntree: number;
  jetonsSortie: number;
  /** La part de l'entrée servie par le cache de prompt (0 à 1). Elle change le coût du simple au double. */
  partCachee?: number;
}

/** Ce que coûte un appel, aux tarifs RÉELS du registre. `null` quand le tarif est inconnu. */
export function coutDe(role: ModelRole, p: Profil): number | null {
  const b = bindingFor(role);
  if (b.priceInPerM === null || b.priceOutPerM === null) return null;
  const part = Math.min(1, Math.max(0, p.partCachee ?? 0));
  const cache = b.priceCachedInPerM ?? b.priceInPerM;
  const entree = (p.jetonsEntree * (1 - part) * b.priceInPerM + p.jetonsEntree * part * cache) / 1_000_000;
  const sortie = (p.jetonsSortie * b.priceOutPerM) / 1_000_000;
  return entree + sortie;
}

/** Les latences OBSERVÉES par rôle, en millisecondes. Mesurées au banc, pas devinées. */
const MS_OBSERVE: Readonly<Record<ModelRole, number>> = {
  orchestrator: 9_000,
  worker: 5_000,
  bulk: 1_800,
  realtime: 700,
};

/**
 * LES CANDIDATES RÉELLES, tarifs du registre à l'appui.
 *
 * `realtime` est exclu : ce rôle ne traite pas de texte asynchrone, et le proposer comme option
 * « moins chère » sur une tâche d'analyse serait une comparaison entre deux choses différentes.
 */
export function candidates(p: Profil): Candidate[] {
  const out: Candidate[] = [];
  for (const b of allBindings()) {
    if (b.role === "realtime") continue;
    const c = coutDe(b.role, p);
    if (c === null) continue; // un tarif inconnu n'est pas une bonne affaire
    out.push({ modele: b.model, effort: b.reasoning as Candidate["effort"], coutUsd: c, msAttendu: MS_OBSERVE[b.role] });
  }
  return out;
}

export interface Decision extends Choix {
  /** Le profil de jetons sur lequel le coût a été estimé — sans lui, le chiffre ne veut rien dire. */
  profil: Profil;
  /** Le plancher exigé, rappelé dans la décision : elle doit pouvoir se relire seule. */
  plancher: { exactitude: number; pourquoi: string; desescaladeAutorisee: boolean };
}

/**
 * DÉCIDE — le pipeline complet, dans l'ordre du mandat.
 *
 * `roleReference` est ce qu'on prendrait sans réfléchir. Tout le travail consiste à savoir si
 * l'on a le DROIT de descendre en dessous, et la réponse par défaut est non.
 */
export function decider(
  classe: Classe,
  roleReference: ModelRole,
  profil: Profil,
  mesures: readonly Mesure[],
  maintenant: Date = new Date(),
): Decision | { erreur: string } {
  const ref = bindingFor(roleReference);
  const coutRef = coutDe(roleReference, profil);
  if (coutRef === null) {
    return { erreur: `aucun tarif connu pour le rôle ${roleReference} : on ne compare pas des coûts qu'on ne connaît pas.` };
  }
  const reference: Candidate = {
    modele: ref.model, effort: ref.reasoning as Candidate["effort"],
    coutUsd: coutRef, msAttendu: MS_OBSERVE[roleReference],
  };
  const p = plancherDe(classe);
  const choix = choisir(classe, reference, candidates(profil), mesures, maintenant);
  return {
    ...choix, profil,
    plancher: { exactitude: p.exactitude, pourquoi: p.pourquoi, desescaladeAutorisee: p.desescaladeAutorisee },
  };
}

export { escalader, northStar, porteDeRegression, plancherDe };
export { CLASSES, PLANCHERS, SANS_DESESCALADE } from "@/lib/cout/plancher";
export { FRAICHEUR_MAX_JOURS, REFUS } from "@/lib/cout/choix";
export type { Bilan, Candidate, Choix, Mesure } from "@/lib/cout/choix";
export type { Classe, Plancher } from "@/lib/cout/plancher";
