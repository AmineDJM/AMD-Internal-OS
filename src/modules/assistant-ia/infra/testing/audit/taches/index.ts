/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — L'INDEX DES DOMAINES DE TÂCHES. Chaque domaine vit dans SON fichier (aucun conflit
 * entre lots) ; l'index les agrège, pose `domaine` sur chaque tâche, et enchaîne leurs semis après le semis commun.
 *
 *   socle               — les 65 tâches du lot Q1 (tâche, message, mail, Ad & Pro, BC, export, analyse…)
 *   documents           — lot T1 : documents, juridique, Drive (DOC-)
 *   annuaire-marketing  — lot T2 : annuaires, marketing, terrain (ANN-, MKT-, TER-)
 *   dossiers-mg-adpro   — lot T3 : dossiers par Excel, moyens généraux, Ad & Pro hôtel-voyage (DOS-, MG-, ADP-)
 *   mails               — lot P1 bis : mails (ML-)
 *   transverse          — lot Q1 : RH salarié, finances, congrès, réglementaire, routines, notes, multi-étapes, voix (TR-)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { SEMIS_ANNUAIRE_MARKETING, TACHES_ANNUAIRE_MARKETING } from "./annuaire-marketing";
import { SEMIS_DOCUMENTS, TACHES_DOCUMENTS } from "./documents";
import { SEMIS_DOSSIERS_MG_ADPRO, TACHES_DOSSIERS_MG_ADPRO } from "./dossiers-mg-adpro";
import { SEMIS_MAILS, TACHES_MAILS } from "./mails";
import { TACHES_SOCLE } from "./socle";
import { SEMIS_TRANSVERSE, TACHES_TRANSVERSE } from "./transverse";
import type { Domaine, PieceSemee, SemisDeDomaine, Tache } from "./types";

export { CATEGORIES_TACHE } from "./socle";
export type { Domaine, ObjetAttendu, Tache } from "./types";

export const DOMAINES: Domaine[] = [
  { nom: "socle", taches: TACHES_SOCLE },
  { nom: "documents", taches: TACHES_DOCUMENTS, semer: SEMIS_DOCUMENTS },
  { nom: "annuaire-marketing", taches: TACHES_ANNUAIRE_MARKETING, semer: SEMIS_ANNUAIRE_MARKETING },
  { nom: "dossiers-mg-adpro", taches: TACHES_DOSSIERS_MG_ADPRO, semer: SEMIS_DOSSIERS_MG_ADPRO },
  { nom: "mails", taches: TACHES_MAILS, semer: SEMIS_MAILS },
  { nom: "transverse", taches: TACHES_TRANSVERSE, semer: SEMIS_TRANSVERSE },
];

/** Toutes les tâches, chacune portant son domaine. */
export const TACHES: Tache[] = DOMAINES.flatMap((d) => d.taches.map((x) => ({ ...x, domaine: d.nom })));

/** Les semis des domaines, dans l'ordre ; une clé de pièce posée deux fois est une erreur (deux domaines se marchent dessus). */
export async function semerDomaines(c: Parameters<SemisDeDomaine>[0]): Promise<Record<string, PieceSemee>> {
  const out: Record<string, PieceSemee> = {};
  for (const d of DOMAINES) {
    if (!d.semer) continue;
    for (const [k, v] of Object.entries(await d.semer(c))) {
      if (out[k]) throw new Error(`banc d'audit : la pièce « ${k} » est semée par deux domaines`);
      out[k] = v;
    }
  }
  return out;
}
