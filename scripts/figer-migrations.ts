/**
 * Fige la liste des migrations présentes (src/lib/derive-schema/migrations-figees.ts), après une intégration verte :
 * celles-ci sortent du jugement « une neuve dépasse les anciennes » (voir ordre-migrations.test.ts).
 */
import { readdirSync, writeFileSync } from "node:fs";

const noms = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
const entete = `/**
 * LES MIGRATIONS DÉJÀ INTÉGRÉES — figées. Leur ordre d'ajout est de l'histoire : la production les a appliquées, et le
 * relire dans git dépend de la profondeur du clone (CI et sessions en profondeur 50, historique complet en local) — le
 * même dépôt rendait trois verdicts. Une migration NEUVE (absente d'ici) est jugée sans git : son nom doit dépasser la
 * plus grande de cette liste. Ne pas éditer à la main : la liste ne s'allonge que par \`npm run migrations:figer\`
 * après une intégration verte.
 */
`;
writeFileSync(
  "src/lib/derive-schema/migrations-figees.ts",
  `${entete}export const MIGRATIONS_FIGEES: readonly string[] = [\n${noms.map((n) => `  "${n}",`).join("\n")}\n];\n`,
);
console.log(`${noms.length} migrations figées — la plus grande : ${noms.at(-1)}`);
