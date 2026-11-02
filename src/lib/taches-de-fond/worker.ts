import { journalConsole, messageErreur, type Journal } from "./journal";
import { executeurAutorise, lireModeTachesDeFond, modeInconnu, type ModeTachesDeFond } from "./mode";
import type { BilanPassage, ContexteExecution } from "./executer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BOUCLE DU WORKER (refonte V2-F) — le même passage que le web, dans un processus à lui.
 *
 * Le point d'entrée est `scripts/worker.ts` (`npm run worker`) ; il ne fait que déclarer le
 * processus, brancher SIGTERM sur un `AbortSignal` et appeler cette boucle. Elle est ici pour se
 * tester sans processus : un signal, un passage factice, un journal en mémoire.
 *
 * ── LE RYTHME ─────────────────────────────────────────────────────────────────────────────
 *
 * Un passage au démarrage, puis un passage toutes les `tickMs` mesurées DÉPART À DÉPART : un
 * passage de 20 s suivi d'une sieste de 40 s, pas de 60. Un passage plus long que `tickMs`
 * enchaîne après une respiration d'une seconde — jamais deux passages en même temps.
 *
 * ── L'ARRÊT PROPRE ────────────────────────────────────────────────────────────────────────
 *
 * Le signal coupe la sieste aussitôt, et le passage en cours s'arrête ENTRE deux tâches
 * (`doitSArreter`) : la tâche commencée finit et rend son bail. Si elle dépasse la grâce de
 * l'hébergeur, le processus est tué — son bail expire seul (`BAIL_TACHE_MS`) et un autre
 * exécutant la reprend : c'est la reprise après plantage, et elle ne demande rien.
 *
 * ── L'INTERRUPTEUR ────────────────────────────────────────────────────────────────────────
 *
 * Sous `TACHES_DE_FOND=web`, le worker démarre et ATTEND sans rien exécuter : sortir ferait
 * redémarrer le service en boucle par l'hébergeur. Il le dit une fois, en avertissement.
 * `SCHEDULER_DISABLED=1` (la soupape historique du battement web) le met aussi en attente.
 *
 * ── LA BASE D'ABORD ───────────────────────────────────────────────────────────────────────
 *
 * Avant le premier passage, le worker attend que la base porte toutes les migrations de son code
 * (`migrations.ts` dit pourquoi : seul le build du web migre, et il finit après celui du worker).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type OptionsWorker = {
  signal: AbortSignal;
  /** Le passage à faire — en production, `executerTachesPlanifiees` de `scheduled.ts`. */
  passage: (ctx: ContexteExecution) => Promise<BilanPassage>;
  detenteur: string;
  tickMs: number;
  mode?: ModeTachesDeFond;
  suspendu?: boolean;
  journal?: Journal;
  /** Les migrations que ce code attend et que la base n'a pas encore ; absent = pas d'attente. */
  migrationsManquantes?: () => Promise<string[]>;
  /** Délai entre deux vérifications de la base. */
  attenteMigrationsMs?: number;
  /** Appelé une fois la base à jour, avant le premier passage (le contrôle au démarrage, décision 0019). Ne bloque jamais. */
  apresMigrations?: () => Promise<unknown>;
};

export const ATTENTE_MIGRATIONS_MS = 30_000;

export type BilanWorker = { passages: number; enAttente: boolean };

/** Dort `ms`, ou moins si le signal tombe. Ne lève jamais. */
export function dormir(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const fin = () => { clearTimeout(minuteur); signal.removeEventListener("abort", fin); resolve(); };
    const minuteur = setTimeout(fin, ms);
    signal.addEventListener("abort", fin, { once: true });
  });
}

/** Attend que la base porte les migrations de ce code (ou que l'arrêt soit demandé). */
async function attendreLaBase(manquantes: () => Promise<string[]>, signal: AbortSignal, journal: Journal, delaiMs: number): Promise<void> {
  let essais = 0;
  while (!signal.aborted) {
    try {
      const reste = await manquantes();
      if (reste.length === 0) {
        if (essais > 0) journal("info", "worker.base-a-jour", { essais });
        return;
      }
      // Une ligne à la première vérification, puis toutes les dix : l'attente se voit sans noyer le journal.
      if (essais % 10 === 0) journal("avertissement", "worker.attente-migrations", { manquantes: reste.slice(0, 5), nombre: reste.length });
    } catch (e) {
      if (essais % 10 === 0) journal("erreur", "worker.base-injoignable", { erreur: messageErreur(e) });
    }
    essais += 1;
    await dormir(delaiMs, signal);
  }
}

/** La boucle. Rend la main quand le signal tombe et que le passage en cours a fini. */
export async function demarrerWorker(o: OptionsWorker): Promise<BilanWorker> {
  const journal = o.journal ?? journalConsole;
  const mode = o.mode ?? lireModeTachesDeFond();

  if (modeInconnu()) {
    journal("avertissement", "worker.mode-inconnu", { valeur: process.env.TACHES_DE_FOND, retenu: mode });
  }
  if (o.suspendu || !executeurAutorise(mode, "worker")) {
    journal("avertissement", "worker.en-attente", {
      mode,
      raison: o.suspendu ? "SCHEDULER_DISABLED=1" : `TACHES_DE_FOND=${mode} : le battement reste au web`,
    });
    await new Promise<void>((resolve) => {
      if (o.signal.aborted) resolve();
      else o.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { passages: 0, enAttente: true };
  }

  journal("info", "worker.demarrage", { mode, detenteur: o.detenteur, tickMs: o.tickMs });
  if (o.migrationsManquantes) await attendreLaBase(o.migrationsManquantes, o.signal, journal, o.attenteMigrationsMs ?? ATTENTE_MIGRATIONS_MS);
  if (o.apresMigrations && !o.signal.aborted) {
    await o.apresMigrations().catch((e) => journal("avertissement", "worker.apres-migrations", { erreur: messageErreur(e) }));
  }
  let passages = 0;
  while (!o.signal.aborted) {
    const debut = Date.now();
    try {
      await o.passage({
        detenteur: o.detenteur,
        executeur: "worker",
        journal,
        doitSArreter: () => o.signal.aborted,
      });
    } catch (e) {
      // `executerPassage` ne lève pas ; ceci garde la boucle en vie si un passage injecté le fait.
      journal("erreur", "worker.passage-echoue", { erreur: messageErreur(e) });
    }
    passages += 1;
    await dormir(Math.max(1_000, o.tickMs - (Date.now() - debut)), o.signal);
  }
  journal("info", "worker.arret", { passages });
  return { passages, enAttente: false };
}
