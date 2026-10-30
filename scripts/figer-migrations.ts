/**
 * Fige la liste des migrations présentes (prisma/migrations-figees.json), après une intégration verte : celles-ci
 * sortent du jugement « une neuve dépasse les anciennes » (voir src/lib/derive-schema/ordre-migrations.test.ts).
 *
 * LES MIGRATIONS DÉJÀ INTÉGRÉES — figées. Leur ordre d'ajout est de l'histoire : la production les a appliquées, et le
 * relire dans git dépend de la profondeur du clone (CI et sessions en profondeur 50, historique complet en local) — le
 * même dépôt rendait trois verdicts. Une migration NEUVE (absente de la liste) est jugée sans git : son nom doit
 * dépasser la plus grande figée. Ne pas éditer la liste à la main. Une donnée (JSON), pas du code de `src/lib/`.
 */
import { readdirSync, writeFileSync } from "node:fs";

const noms = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
writeFileSync("prisma/migrations-figees.json", `${JSON.stringify(noms, null, 2)}\n`);
console.log(`${noms.length} migrations figées — la plus grande : ${noms.at(-1)}`);
