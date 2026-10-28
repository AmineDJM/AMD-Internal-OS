/**
 * `npm run qualite:mort` / `npm run qualite:doublons` — la mesure, lisible, et son verdict.
 * Les plafonds vivent dans `src/platform/qualite-code.ts`, tenus aussi par `qualite-code.test.ts`.
 */
import { ATTEINTS_PAR_LES_TESTS_SEULS, PLAFONDS, mesurerCodeMort, mesurerDoublons } from "@/platform/qualite-code";

const quoi = process.argv[2];

if (quoi === "mort") {
  const m = mesurerCodeMort();
  const nouveaux = m.fichiersTestsSeuls.filter((f) => !(f in ATTEINTS_PAR_LES_TESTS_SEULS));
  console.log(`knip — problèmes : ${m.problemes.length} (plafond : 0)`);
  for (const p of m.problemes) console.log(`  ✗ ${p}`);
  console.log(`knip --production — fichiers atteints par les tests seuls : ${m.fichiersTestsSeuls.length} (nommés : ${Object.keys(ATTEINTS_PAR_LES_TESTS_SEULS).length})`);
  for (const f of m.fichiersTestsSeuls) console.log(`  ${f in ATTEINTS_PAR_LES_TESTS_SEULS ? "·" : "✗"} ${f}`);
  process.exit(m.problemes.length === 0 && nouveaux.length === 0 ? 0 : 1);
} else if (quoi === "doublons") {
  const d = mesurerDoublons();
  console.log(`jscpd — clones : ${d.clones} (plafond ${PLAFONDS.clones}) · lignes dupliquées : ${d.lignesDupliquees} (plafond ${PLAFONDS.lignesDupliquees}) · ${d.pourcentage.toFixed(2)} %`);
  for (const p of d.pires) console.log(`  ${p.lignes} l.  ${p.a}  ↔  ${p.b}`);
  process.exit(d.clones <= PLAFONDS.clones && d.lignesDupliquees <= PLAFONDS.lignesDupliquees ? 0 : 1);
} else {
  console.error("usage : tsx scripts/qualite.ts mort|doublons");
  process.exit(2);
}
