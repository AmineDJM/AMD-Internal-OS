/**
 * `npm run capacites:classement` — réécrit le CLICHÉ du classement des capacités (lot J6, décision 0020).
 *
 * Le classement est DÉRIVÉ (`src/platform/ia/capacites/classement.ts`) ; le cliché, versionné, est ce qu'une personne
 * a RELU. `registre.test.ts` échoue tant qu'une action du contrat n'y figure pas, ou qu'elle y figure autrement que la
 * dérivation la classe : une action nouvelle se classe ici, et la revue lit le diff du cliché.
 *
 * À lancer après `npm run actions:contrat`.
 */
import fs from "node:fs";
import { CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import { interdictionGenerique } from "@/lib/actions/generique";
import { classerGeste } from "@/lib/annulation/reversibilite";
import { MODULE_LABELS } from "@/lib/labels";
import { deriverRegistre } from "@/platform/ia/capacites/registre";
import { CHEMIN_CLICHE, clicheDuRegistre } from "@/platform/ia/capacites/cliche";

const cliche = clicheDuRegistre(deriverRegistre(CONTRATS_ACTIONS, { interdiction: interdictionGenerique, classerGeste, modules: MODULE_LABELS }));
fs.writeFileSync(CHEMIN_CLICHE, `${JSON.stringify(cliche, null, 1)}\n`);
const compte = (k: "risque" | "simulable" | "annulation") =>
  Object.values(cliche).reduce<Record<string, number>>((m, c) => ({ ...m, [c[k]]: (m[c[k]] ?? 0) + 1 }), {});
console.log(`${Object.keys(cliche).length} actions classées → ${CHEMIN_CLICHE}`);
console.log("risque", compte("risque"), "· simulable", compte("simulable"), "· annulation", compte("annulation"));
