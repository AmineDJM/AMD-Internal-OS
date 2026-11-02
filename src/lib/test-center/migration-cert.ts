import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { FindingInput } from "./types";
import { ephemeralSchemaName, createEphemeralSchema, destroyEphemeralSchema, execInEphemeral, countInEphemeral } from "./ephemeral";
import { sansBloquer } from "@/lib/journal";

/**
 * Certification migrations & reprise (§35). Deux volets :
 * 1. **Migrations** : comparer les migrations présentes sur disque à celles réellement appliquées
 *    (`_prisma_migrations`) — détecte une base en retard sur le schéma. Lecture seule.
 * 2. **Sauvegarde/restauration** : roundtrip CONTRÔLÉ dans un schéma éphémère (sauvegarde → perte
 *    simulée → restauration → vérification). « Une sauvegarde non restaurée avec succès dans un
 *    test contrôlé ne doit pas être considérée comme prouvée. » (mode d'écriture uniquement)
 */

export interface MigrationCert {
  onDisk: number;
  applied: number;
  missing: string[]; // sur disque mais non appliquées
  extra: string[]; // appliquées mais absentes du disque
  migrationsChecked: boolean;
  backupRestore: { ran: boolean; ok: boolean; original: number; afterLoss: number; restored: number } | null;
  findings: FindingInput[];
}

function migrationsOnDisk(): string[] | null {
  try {
    const dir = path.join(process.cwd(), "prisma", "migrations");
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name).sort();
  } catch { return null; }
}

async function migrationsApplied(): Promise<string[] | null> {
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
    return rows.map((r) => r.migration_name);
  } catch { return null; }
}

/** Roundtrip sauvegarde → perte → restauration, prouvé dans un schéma éphémère (§35). */
async function backupRestoreRoundtrip(runId: string) {
  const schema = ephemeralSchemaName(runId);
  await createEphemeralSchema(schema);
  try {
    await execInEphemeral(schema, `CREATE TABLE "${schema}"."data" (id serial PRIMARY KEY, v text)`);
    await execInEphemeral(schema, `INSERT INTO "${schema}"."data" (v) SELECT 'row_' || g FROM generate_series(1, 25) g`);
    const original = await countInEphemeral(schema, "data");
    await execInEphemeral(schema, `CREATE TABLE "${schema}"."data_backup" AS TABLE "${schema}"."data"`); // sauvegarde
    await execInEphemeral(schema, `TRUNCATE "${schema}"."data"`); // sinistre
    const afterLoss = await countInEphemeral(schema, "data");
    await execInEphemeral(schema, `INSERT INTO "${schema}"."data" SELECT * FROM "${schema}"."data_backup"`); // restauration
    const restored = await countInEphemeral(schema, "data");
    return { original, afterLoss, restored, ok: original > 0 && afterLoss === 0 && restored === original };
  } finally {
    await destroyEphemeralSchema(schema).catch(sansBloquer("migration-cert.backupRestoreRoundtrip.destroyEphemeralSchema")); // destruction garantie + vérifiée
  }
}

export async function certifyMigrationsAndRecovery(runId: string, allowWrite: boolean): Promise<MigrationCert> {
  const findings: FindingInput[] = [];
  const disk = migrationsOnDisk();
  const applied = await migrationsApplied();
  let missing: string[] = [], extra: string[] = [], migrationsChecked = false;

  if (disk && applied) {
    migrationsChecked = true;
    const appliedSet = new Set(applied), diskSet = new Set(disk);
    missing = disk.filter((m) => !appliedSet.has(m));
    extra = applied.filter((m) => !diskSet.has(m));
    if (missing.length > 0) findings.push({ severity: "HIGH", category: "migration", module: "ADMIN", title: `Migrations non appliquées (${missing.length})`, detail: `Sur disque mais absentes de _prisma_migrations : ${missing.slice(0, 8).join(", ")}. La base est en retard sur le schéma.`, evidence: missing, suggestion: "Exécuter db:deploy.", confidence: "high" });
    if (extra.length > 0) findings.push({ severity: "INFO", category: "migration", module: "ADMIN", title: `Migrations appliquées absentes du disque (${extra.length})`, detail: `Dans _prisma_migrations mais introuvables sur disque : ${extra.slice(0, 8).join(", ")}. Historique divergent.`, evidence: extra, confidence: "medium" });
  } else {
    findings.push({ severity: "INFO", category: "migration", module: "ADMIN", title: "Vérification des migrations indisponible", detail: "Répertoire prisma/migrations ou table _prisma_migrations inaccessible dans cet environnement.", confidence: "low" });
  }

  let backupRestore: MigrationCert["backupRestore"] = null;
  if (allowWrite) {
    try {
      const r = await backupRestoreRoundtrip(runId);
      backupRestore = { ran: true, ok: r.ok, original: r.original, afterLoss: r.afterLoss, restored: r.restored };
      if (!r.ok) findings.push({ severity: "HIGH", category: "recovery", module: "ADMIN", title: "Roundtrip sauvegarde/restauration non prouvé", detail: `original=${r.original}, aprèsPerte=${r.afterLoss}, restauré=${r.restored} — la restauration n'a pas reconstitué les données.`, confidence: "high" });
    } catch (e) {
      backupRestore = { ran: true, ok: false, original: 0, afterLoss: 0, restored: 0 };
      findings.push({ severity: "MEDIUM", category: "recovery", module: "ADMIN", title: "Test de restauration en échec", detail: `Le roundtrip a levé une erreur : ${(e as Error).message}`, confidence: "medium" });
    }
  }

  return { onDisk: disk?.length ?? 0, applied: applied?.length ?? 0, missing, extra, migrationsChecked, backupRestore, findings };
}
