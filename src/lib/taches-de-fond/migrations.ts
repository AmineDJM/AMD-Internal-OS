import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";

/**
 * LE WORKER N'EXÉCUTE PAS DE CODE PLUS RÉCENT QUE LA BASE (refonte V2-F).
 *
 * Sur Render, le web et le worker se déploient EN PARALLÈLE au même commit, et seul le build du web
 * migre la base — après son lint, son typecheck et sa compilation (refonte P0 : rien n'écrit en base
 * avant que tout ce qui peut échouer ait réussi). Le build du worker, lui, ne compile pas Next et
 * finit des minutes plus tôt : sans cette attente, il ferait tourner le code du nouveau commit sur
 * le schéma de l'ancien, et toute tâche touchant une colonne neuve échouerait jusqu'à la migration.
 *
 * Il attend donc que chaque migration de SON dépôt soit appliquée (`_prisma_migrations`). Si le
 * build du web échoue, les migrations ne passent jamais et le worker attend — exactement comme le
 * web, qui continue de servir l'ancien code : les deux restent cohérents avec la base.
 */

/** Les migrations que ce code attend, d'après le dossier livré avec lui. */
export function migrationsAttendues(dossier = path.join(process.cwd(), "prisma", "migrations")): string[] {
  return fs.readdirSync(dossier, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dossier, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

/** Celles qui manquent encore en base (vide = la base est à jour pour ce code). */
export async function migrationsManquantes(attendues: string[] = migrationsAttendues()): Promise<string[]> {
  const appliquees = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const faites = new Set(appliquees.map((m) => m.migration_name));
  return attendues.filter((m) => !faites.has(m));
}
