import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI DEMANDE CETTE LECTURE ? (lot D3, décision 0057) — le CONTEXTE des requêtes de données.
 *
 * La garde de l'accès par base vit dans le relais `prisma` (socle). Elle a besoin de deux choses que le socle ne peut
 * pas aller chercher lui-même : QUI demande, et COMMENT juger. D'où ce port, au socle lui aussi :
 *
 *   • `poserIdentiteDonnees` — la session l'appelle UNE fois par requête, quand elle a résolu la personne et ses
 *     droits (`session.ts`). Mémorisé par `cache()` : une case par rendu / par action, jamais partagée entre deux
 *     requêtes. Hors rendu (worker, banc), `cache` est l'identité : la case est unique au processus — c'est pourquoi
 *     une tâche de fond déclare explicitement le contexte SYSTÈME, qui passe par un magasin asynchrone, lui bien isolé.
 *   • `poserEvaluateurDonnees` — le module `acces-bases` s'y branche au démarrage (`instrumentation.ts`). Sans
 *     évaluateur, la garde ne juge RIEN : l'ERP se comporte exactement comme avant (c'est le cas en test).
 *
 * Aucun import de module ici : le socle n'importe aucun module (règle 4 des frontières).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que la garde sait de l'auteur d'une requête. */
export interface IdentiteDonnees {
  userId: string;
  /** Rôle principal et rôle secondaire (celui-ci souvent nul). */
  roles: readonly (string | null | undefined)[];
  /** Ses droits de module réels, déjà résolus (`EffectiveAccess`) — la garde ne relit pas la base. */
  peut: (module: string, geste: string) => boolean;
}

/** Une requête qui n'appartient à personne : tâche de fond, worker, migration, banc. Toujours DÉCLARÉE. */
export interface ContexteSysteme {
  systeme: true;
  raison: string;
}

export type ContexteDonnees = IdentiteDonnees | ContexteSysteme;
export const estSysteme = (c: ContexteDonnees | null): c is ContexteSysteme => !!c && "systeme" in c;

/** Le verdict de la garde pour UNE requête. En observation, `refus` n'est jamais appliqué — il est compté. */
export interface VerdictDonnees {
  refus: string | null;
}

export type EvaluateurDonnees = (demande: {
  modele: string;
  geste: "lecture" | "ecriture";
  operation: string;
  contexte: ContexteDonnees | null;
}) => VerdictDonnees | null;

const caseDeRequete = cache((): { ctx: ContexteDonnees | null } => ({ ctx: null }));
const magasinSysteme = new AsyncLocalStorage<ContexteSysteme>();
const magasinIdentite = new AsyncLocalStorage<IdentiteDonnees>();
let evaluateur: EvaluateurDonnees | null = null;

/** La session pose l'identité une fois par requête. Sans elle, la garde ne juge rien (elle ne devine jamais). */
export function poserIdentiteDonnees(identite: IdentiteDonnees): void {
  try {
    caseDeRequete().ctx = identite;
  } catch {
    // Hors rendu et hors action : rien à mémoriser, la garde restera muette pour cette requête.
  }
}

/** Oublie l'identité de la requête courante (déconnexion, fin de banc). */
export function oublierIdentiteDonnees(): void {
  try {
    caseDeRequete().ctx = null;
  } catch {
    /* rien à oublier */
  }
}

/** Une tâche de fond DÉCLARE son contexte : `enSysteme("battement des missions", () => …)`. */
export function enSysteme<T>(raison: string, corps: () => T | Promise<T>): Promise<T> {
  // ATTENDRE DEDANS : une requête Prisma est paresseuse (elle part à l'`await`) — rendue telle quelle, elle partirait
  // hors du contexte.
  return magasinSysteme.run({ systeme: true, raison }, async () => await corps());
}

/**
 * Une identité ENVELOPPANTE, hors rendu : une route d'API (qui n'a pas de case par requête), un banc. Prime sur la
 * case de la requête, jamais sur un contexte système qui l'enveloppe.
 */
export function avecIdentiteDonnees<T>(identite: IdentiteDonnees, corps: () => T | Promise<T>): Promise<T> {
  return magasinIdentite.run(identite, async () => await corps());
}

/** Le contexte de la requête courante : le système d'abord (il enveloppe), puis une identité enveloppante, puis la case. */
export function contexteDonnees(): ContexteDonnees | null {
  const sys = magasinSysteme.getStore();
  if (sys) return sys;
  const id = magasinIdentite.getStore();
  if (id) return id;
  try {
    return caseDeRequete().ctx;
  } catch {
    return null;
  }
}

/** Le module `acces-bases` se branche ici (au démarrage). Rebrancher remplace : un seul juge à la fois. */
export function poserEvaluateurDonnees(fn: EvaluateurDonnees | null): void {
  evaluateur = fn;
}

export const evaluateurDonnees = (): EvaluateurDonnees | null => evaluateur;
