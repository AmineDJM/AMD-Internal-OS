/**
 * LE WORKER — les tâches de fond hors du processus web (refonte V2-F).
 *
 *   npm run worker
 *
 * Même code que le web, autre point d'entrée : il exécute la table `TACHES_PLANIFIEES` de
 * `src/lib/scheduled.ts` à chaque battement, chaque tâche sous son bail en base. Il n'exécute
 * rien tant que `TACHES_DE_FOND` ne vaut pas `worker` ou `les-deux` (il attend, sans redémarrer).
 * Avant son premier passage, il attend que la base porte toutes les migrations de son commit (seul
 * le build du web migre — `src/lib/taches-de-fond/migrations.ts`).
 * Procédure d'activation sur Render : `docs/readme/24-deploiement-render.md`.
 *
 * Arrêt propre : SIGTERM (Render, à chaque déploiement) ou SIGINT (Ctrl-C) → plus aucune tâche
 * n'est prise, celle en cours finit et rend son bail, la base est déconnectée, sortie 0. Au-delà
 * de `GRACE_MS`, sortie forcée : le bail de la tâche coupée expire seul et un autre exécutant la
 * reprend.
 */
import { declarerProcessusWorker } from "../src/lib/taches-de-fond/mode";
import { journalConsole, messageErreur } from "../src/lib/taches-de-fond/journal";
import { demarrerWorker } from "../src/lib/taches-de-fond/worker";

/** Render laisse 30 s entre SIGTERM et SIGKILL : on sort avant, en le disant. */
const GRACE_MS = 25_000;

async function main(): Promise<void> {
  // AVANT tout import de la chaîne des tâches : `scheduled.ts` arme le battement WEB à son
  // chargement, sauf dans un processus qui s'est déclaré worker.
  declarerProcessusWorker();

  const controleur = new AbortController();
  const arreter = (signal: NodeJS.Signals) => {
    if (controleur.signal.aborted) return;
    journalConsole("info", "worker.signal", { signal, graceMs: GRACE_MS });
    controleur.abort();
    setTimeout(() => {
      journalConsole("avertissement", "worker.arret-force", { graceMs: GRACE_MS });
      process.exit(1);
    }, GRACE_MS).unref();
  };
  process.once("SIGTERM", arreter);
  process.once("SIGINT", arreter);

  const { executerTachesPlanifiees, identiteDesBaux, TICK_MS } = await import("../src/lib/scheduled");
  const { prisma } = await import("../src/lib/prisma");
  const { migrationsManquantes } = await import("../src/lib/taches-de-fond/migrations");
  const { controlerAuDemarrage } = await import("../src/lib/taches-de-fond/sante");

  const detenteur = identiteDesBaux();

  await demarrerWorker({
    signal: controleur.signal,
    passage: executerTachesPlanifiees,
    detenteur,
    tickMs: TICK_MS,
    suspendu: process.env.SCHEDULER_DISABLED === "1",
    // Le code d'un commit ne tourne pas sur la base du commit d'avant (seul le build du web migre).
    migrationsManquantes: () => migrationsManquantes(),
    // Le CONTRÔLE AU DÉMARRAGE (décision 0019), une fois la base à jour : chaque variable ou pièce du moteur qui manque
    // est dite en clair, dans le journal ET dans Administration › Diagnostic. Il ne bloque pas.
    apresMigrations: () => controlerAuDemarrage({ detenteur }),
  });
  await prisma.$disconnect().catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (e) => {
    journalConsole("erreur", "worker.plantage", { erreur: messageErreur(e) });
    process.exit(1);
  },
);
