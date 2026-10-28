import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";

/**
 * LES MIGRATIONS SONT-ELLES TOUTES APPLIQUÉES ? (audit 27/10, INFRA-05 « évolution »)
 *
 * Le tableau de bord Render peut porter sa PROPRE commande de build (§118.208) : si elle a perdu
 * `prisma migrate deploy`, la production sert le nouveau code sur un schéma en retard, et chaque
 * écran qui lit une colonne neuve tombe dans son repli. La sonde `/api/health` compare donc les
 * dossiers de `prisma/migrations/` (le dépôt complet est présent au runtime :
 * `outputFileTracing: false`) aux migrations TERMINÉES de `_prisma_migrations` — et répond 503
 * s'il en manque : le déploiement ÉCHOUE au lieu de servir du code sur un schéma en retard.
 *
 * Une réponse « à jour » est mémorisée pour la vie du processus (une migration appliquée ne se
 * désapplique pas) : la sonde ne relit ni le disque ni la table à chaque appel.
 */

export type EtatMigrations =
  | { etat: "a-jour"; appliquees: number }
  | { etat: "en-retard"; manquantes: string[] }
  /** Dossier illisible (image sans `prisma/`) : on ne sait pas, et on ne bloque pas pour autant. */
  | { etat: "inconnu" };

/** Pur : les dossiers du dépôt qui n'ont pas de migration terminée en base. */
export function migrationsManquantes(dossiers: readonly string[], appliquees: readonly string[]): string[] {
  const faites = new Set(appliquees);
  return dossiers.filter((d) => !faites.has(d)).sort();
}

let aJour: EtatMigrations | null = null;

export async function verifierMigrations(racine = process.cwd()): Promise<EtatMigrations> {
  if (aJour) return aJour;
  const entrees = await readdir(join(racine, "prisma", "migrations"), { withFileTypes: true })
    .catch(attendu("image de production sans le dossier prisma/ : contrôle impossible, pas une panne", null));
  if (!entrees) return { etat: "inconnu" };
  const dossiers = entrees.filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name)).map((e) => e.name);

  // Une erreur ici remonte à l'appelant : la sonde la lit comme « base injoignable ».
  const lignes = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`;
  const manquantes = migrationsManquantes(dossiers, lignes.map((l) => l.migration_name));
  if (manquantes.length > 0) return { etat: "en-retard", manquantes };
  aJour = { etat: "a-jour", appliquees: dossiers.length };
  return aJour;
}

/** Pour les tests : oublier le « à jour » mémorisé. */
export function oublierEtatMigrations(): void {
  aJour = null;
}
