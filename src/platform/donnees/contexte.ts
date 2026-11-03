import type { AsyncLocalStorage } from "node:async_hooks";
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
  /** La phrase du refus (dite à l'écran, comptée en observation). */
  refus: string | null;
  /** D4 : le refus est APPLIQUÉ (réglage strict du Super Admin) — sinon il n'est que compté. */
  applique?: boolean;
  /** D4 : l'empreinte reconnue par l'écran d'erreur (`ACCES_BASE:<base>:<niveau>`) — Next la garde en production. */
  digest?: string;
  /** D4 : les colonnes de RÉFÉRENCE (nom, poste…) qui restent lisibles même base fermée. */
  reference?: readonly string[];
  /** D4 : ses propres données restent lisibles (paramètre de la base) — l'identité de la personne et sa fiche RH. */
  propres?: { userId: string; employeId: string | null } | null;
}

export type EvaluateurDonnees = (demande: {
  modele: string;
  geste: "lecture" | "ecriture";
  operation: string;
  contexte: ContexteDonnees | null;
}) => VerdictDonnees | null;

const caseDeRequete = cache((): { ctx: ContexteDonnees | null } => ({ ctx: null }));

/**
 * SANS IMPORT STATIQUE D'UN MODULE NODE (même motif que `effets/magasin.ts`) : `prisma.ts` lit ce contexte, et des écrans
 * client importent (de loin) `prisma.ts`. Côté serveur, Node fournit le constructeur ; côté navigateur, il n'y a ni
 * requête de données ni magasin. UN SEUL état par processus (`globalThis`), même si Next charge deux copies du module :
 * l'évaluateur branché au démarrage doit être vu par toutes.
 */
type ConstructeurAls = typeof AsyncLocalStorage;
/** Le constructeur des magasins asynchrones, sans import statique (partagé avec `effets/magasin.ts`). */
export function constructeurAls(): ConstructeurAls | null {
  const g = globalThis as { AsyncLocalStorage?: ConstructeurAls; process?: { getBuiltinModule?: (n: string) => unknown } };
  if (typeof g.AsyncLocalStorage === "function") return g.AsyncLocalStorage;
  const m = g.process?.getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: ConstructeurAls } | undefined;
  return m?.AsyncLocalStorage ?? null;
}
interface EtatDonnees {
  systeme: AsyncLocalStorage<ContexteSysteme> | null;
  identite: AsyncLocalStorage<IdentiteDonnees> | null;
  evaluateur: EvaluateurDonnees | null;
}
const etat: EtatDonnees = ((globalThis as { __amdGardeDonnees?: EtatDonnees }).__amdGardeDonnees ??= (() => {
  const C = constructeurAls();
  return { systeme: C ? new C<ContexteSysteme>() : null, identite: C ? new C<IdentiteDonnees>() : null, evaluateur: null };
})());

/** La session pose l'identité une fois par requête. Sans elle, la garde ne juge rien (elle ne devine jamais). */
export function poserIdentiteDonnees(identite: IdentiteDonnees): void {
  try {
    caseDeRequete().ctx = identite;
  } catch {
    // Hors rendu et hors action : rien à mémoriser, la garde restera muette pour cette requête.
  }
}

/** Une tâche de fond DÉCLARE son contexte : `enSysteme("battement des missions", () => …)`. */
export function enSysteme<T>(raison: string, corps: () => T | Promise<T>): Promise<T> {
  // ATTENDRE DEDANS : une requête Prisma est paresseuse (elle part à l'`await`) — rendue telle quelle, elle partirait
  // hors du contexte.
  if (!etat.systeme) return Promise.resolve().then(corps);
  return etat.systeme.run({ systeme: true, raison }, async () => await corps());
}

/**
 * Une identité ENVELOPPANTE, hors rendu : une route d'API (qui n'a pas de case par requête), un banc. Prime sur la
 * case de la requête, jamais sur un contexte système qui l'enveloppe.
 */
export function avecIdentiteDonnees<T>(identite: IdentiteDonnees, corps: () => T | Promise<T>): Promise<T> {
  if (!etat.identite) return Promise.resolve().then(corps);
  return etat.identite.run(identite, async () => await corps());
}

/** Le contexte de la requête courante : le système d'abord (il enveloppe), puis une identité enveloppante, puis la case. */
export function contexteDonnees(): ContexteDonnees | null {
  const sys = etat.systeme?.getStore();
  if (sys) return sys;
  const id = etat.identite?.getStore();
  if (id) return id;
  try {
    return caseDeRequete().ctx;
  } catch {
    return null;
  }
}

/** Le module `acces-bases` se branche ici (au démarrage). Rebrancher remplace : un seul juge à la fois. */
export function poserEvaluateurDonnees(fn: EvaluateurDonnees | null): void {
  etat.evaluateur = fn;
}

export const evaluateurDonnees = (): EvaluateurDonnees | null => etat.evaluateur;
