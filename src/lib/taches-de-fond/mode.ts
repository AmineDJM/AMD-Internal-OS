/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTERRUPTEUR DES TÂCHES DE FOND (refonte V2-F) — qui porte le battement.
 *
 *   TACHES_DE_FOND=web        le processus Next.js bat seul (défaut : la production d'avant V2-F)
 *   TACHES_DE_FOND=worker     seul le service `worker` (`npm run worker`) bat ; le web se tait
 *   TACHES_DE_FOND=les-deux   les deux battent ; le bail par tâche (`bail.ts`) garantit qu'UN seul
 *                             exécutant tient chaque tâche — c'est le mode de bascule
 *
 * Chaque service lit SA variable : la bascule pose `les-deux` sur les deux, vérifie que le worker
 * prend les tâches (`/api/health/worker`), puis pose `worker` sur le web. Le retour arrière est le
 * même geste à l'envers — aucune ligne de code, aucun redéploiement d'image.
 *
 * Une valeur inconnue (faute de frappe) retombe sur `web` : c'est le seul choix qui ne puisse pas
 * laisser la production SANS battement — un web qui se tairait sur une coquille arrêterait les
 * rappels, la paie notifiée et les missions sans que personne ne le voie.
 *
 * Module PUR : il n'importe rien, le Diagnostic et la route de santé le lisent sans tirer la
 * chaîne des tâches.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MODES_TACHES_DE_FOND = ["web", "worker", "les-deux"] as const;
export type ModeTachesDeFond = (typeof MODES_TACHES_DE_FOND)[number];

/** Les deux points d'entrée capables d'exécuter les tâches. */
export type Executeur = "web" | "worker";

export const MODE_PAR_DEFAUT: ModeTachesDeFond = "web";

/** Lit l'interrupteur — tolérant à la casse et aux espaces, `web` sur toute valeur inconnue. */
export function lireModeTachesDeFond(valeur: string | undefined = process.env.TACHES_DE_FOND): ModeTachesDeFond {
  const v = (valeur ?? "").trim().toLowerCase();
  return (MODES_TACHES_DE_FOND as readonly string[]).includes(v) ? (v as ModeTachesDeFond) : MODE_PAR_DEFAUT;
}

/** Vrai quand une valeur est posée mais ne correspond à aucun mode — à signaler, pas à deviner. */
export function modeInconnu(valeur: string | undefined = process.env.TACHES_DE_FOND): boolean {
  const v = (valeur ?? "").trim().toLowerCase();
  return v !== "" && !(MODES_TACHES_DE_FOND as readonly string[]).includes(v);
}

/** Cet exécutant a-t-il le droit de battre sous ce mode ? */
export function executeurAutorise(mode: ModeTachesDeFond, executeur: Executeur): boolean {
  return mode === "les-deux" || mode === executeur;
}

/**
 * LE RÔLE DU PROCESSUS COURANT. Le worker importe la même chaîne que le web (`scheduled.ts`), dont
 * le chargement arme le battement web : il se déclare donc AVANT de l'importer, et ce module-ci
 * est la seule mémoire partagée entre les deux.
 */
let roleDuProcessus: Executeur = "web";

export function declarerProcessusWorker(): void {
  roleDuProcessus = "worker";
}

export function executeurDuProcessus(): Executeur {
  return roleDuProcessus;
}

/**
 * Le battement WEB (`setInterval` de `scheduled.ts`) doit-il s'armer ? Pur : l'environnement et le
 * rôle du processus en entrée.
 */
export function battementWebArme(env: NodeJS.ProcessEnv = process.env, executeur: Executeur = executeurDuProcessus()): boolean {
  if (executeur !== "web") return false; // le worker a sa propre boucle (`taches-de-fond/worker.ts`)
  if (env.SCHEDULER_DISABLED === "1") return false; // soupape, sans redéploiement de code
  // Jamais pendant les TESTS (chaque fichier importerait ce module et lancerait le planificateur
  // complet sur la base de test), ni pendant la COMPILATION (le build importe les modules serveur
  // pour pré-rendre les pages : il n'a aucune tâche de fond à exécuter).
  if (env.VITEST || env.NODE_ENV === "test") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  return executeurAutorise(lireModeTachesDeFond(env.TACHES_DE_FOND), "web");
}
