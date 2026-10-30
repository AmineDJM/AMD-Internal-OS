/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA CARTE MONTRE DE LA SIMULATION (lot J7, décision 0029) — pur, zéro import (l'écran le lit).
 *
 * Avant de confirmer une capacité R1–R4 SIMULABLE, la personne voit le diff RÉEL : l'action a été jouée dans une
 * transaction annulée (`lib/effets/simulation.ts`), et la carte dit ce qu'elle a écrit — « 3 champs modifiés sur la
 * demande X, 1 notification à Karim, 1 pièce déposée ». Une capacité non prouvée simulable le DIT (« non simulable :
 * … ») : jamais un diff vide présenté comme « rien ne change ».
 *
 * La forme est STRUCTURELLE (le diff du socle — `DiffSimulation` — s'y range sans import) : le module garde sa
 * frontière, l'écran ne tire rien du serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VueSimulation {
  statut: "SIMULE" | "ECHEC" | "NON_SIMULABLE";
  raison?: string;
  resume: string;
  lignes: { nature: string; operation: string; titre: string; phrase: string; champs: { champ: string; avant: string; apres: string }[] }[];
  effets: { phrase: string }[];
  /** L'empreinte de ce que la simulation a écrit — rejouée et comparée à la confirmation. Vide si non simulé. */
  empreinte: string;
}

/** Les lignes que la carte détaille, au plus (le résumé dit tout ; la liste se lit). */
export const LIGNES_MAX_CARTE = 6;

/** La vue d'une capacité qui ne se simule pas — elle reste confirmable, et la carte le dit. */
export function vueNonSimulable(raison: string): VueSimulation {
  return { statut: "NON_SIMULABLE", raison, resume: `Non simulable : ${raison}. La carte montre ce qui est proposé, pas ce qui sera écrit.`, lignes: [], effets: [], empreinte: "" };
}

/** Une vue relue sur une intention (charge JSON) — `null` si elle n'en a pas la forme. */
export function lireVueSimulation(v: unknown): VueSimulation | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<VueSimulation>;
  if (o.statut !== "SIMULE" && o.statut !== "ECHEC" && o.statut !== "NON_SIMULABLE") return null;
  if (typeof o.resume !== "string" || typeof o.empreinte !== "string") return null;
  return {
    statut: o.statut, resume: o.resume, empreinte: o.empreinte, ...(typeof o.raison === "string" ? { raison: o.raison } : {}),
    lignes: Array.isArray(o.lignes) ? o.lignes.slice(0, 50) : [], effets: Array.isArray(o.effets) ? o.effets.slice(0, 50) : [],
  };
}

/** La vue, réduite à ce que la carte porte (et que l'intention garde). */
export function vueDeCarte(d: VueSimulation): VueSimulation {
  return {
    statut: d.statut, resume: d.resume, empreinte: d.empreinte, ...(d.raison ? { raison: d.raison } : {}),
    lignes: d.lignes.slice(0, LIGNES_MAX_CARTE).map((l) => ({ nature: l.nature, operation: l.operation, titre: l.titre, phrase: l.phrase, champs: l.champs.slice(0, 8) })),
    effets: d.effets.slice(0, LIGNES_MAX_CARTE).map((f) => ({ phrase: f.phrase })),
  };
}

/**
 * LA RÈGLE DE LA CONFIRMATION : ce qui va s'exécuter doit être ce que la carte a montré. La simulation est rejouée ;
 * une empreinte différente — ou une simulation qui n'aboutit plus — et rien ne s'exécute : la carte se remontre.
 */
export function ecartAvecLaCarte(montree: VueSimulation, rejouee: VueSimulation): string | null {
  if (montree.statut !== "SIMULE") return null;
  if (rejouee.statut !== "SIMULE") return `la simulation n'aboutit plus (${rejouee.raison ?? "raison inconnue"})`;
  if (rejouee.empreinte === montree.empreinte) return null;
  const detail = rejouee.lignes.flatMap((l) => l.champs.map((c) => (c.avant ? `${c.champ} : ${c.avant} → ${c.apres}` : `${c.champ} : ${c.apres}`))).slice(0, 6);
  return `ce geste ne ferait plus exactement ce que la carte montrait. Maintenant : ${rejouee.resume}${detail.length ? ` (${detail.join(" ; ")})` : ""}`;
}
