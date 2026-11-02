import type { Registre } from "./registre";
import type { Annulation, Risque, Simulable } from "./types";
import type { FamilleIa } from "./familles";

/**
 * LE CLICHÉ DU CLASSEMENT (lot J6, décision 0020) — ce qu'une personne a RELU de la dérivation. Pur.
 *
 * `classement.genere.json` (réécrit par `npm run capacites:classement`) garde, pour chaque action du contrat, son
 * risque, ses familles, sa simulabilité, son annulation et si elle est appelable. `registre.test.ts` exige qu'il
 * recouvre EXACTEMENT la dérivation : une action nouvelle non classée, ou un classement qui change sans revue, échoue.
 */
export const CHEMIN_CLICHE = "src/platform/ia/capacites/classement.genere.json";

export interface LigneCliche {
  risque: Risque;
  familles: FamilleIa[];
  simulable: Simulable;
  annulation: Annulation;
  appelable: boolean;
}

export function clicheDuRegistre(r: Registre): Record<string, LigneCliche> {
  const out: Record<string, LigneCliche> = {};
  for (const c of [...r.capacites].filter((x) => x.source === "action").sort((a, b) => a.id.localeCompare(b.id))) {
    out[c.id] = { risque: c.risque, familles: c.familles, simulable: c.simulable, annulation: c.annulation, appelable: c.appelable };
  }
  return out;
}
