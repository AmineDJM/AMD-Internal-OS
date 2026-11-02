/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * S1 (décision 0048) — LES PÉRIMÈTRES SENSIBLES DE L'ASSISTANT D'UNE PERSONNE. Règle PURE (aucune base) : le moteur,
 * les bancs et l'écran « Ce que son assistant voit » la lisent.
 *
 * « Absolument AUCUN accès aux autres, quel que soit le truc » (Direction, 02/11). PAR DÉFAUT, chacun ne voit que ses
 * propres données. Une valeur sensible d'AUTRUI (paie, dossier RH) ne s'ouvre que par :
 *   • ROLE      — le droit applicatif que l'écran lui donne déjà (gérer les RH dans la société de la fiche) ;
 *   • AVENANT   — un avenant de DÉLÉGATION à son contrat : une famille, UNE entité, de sa date d'effet à sa fin ;
 *   • CONSOLE   — un droit explicite ET DATÉ que la Direction lui accorde nommément (motif dit).
 * Jamais un réglage de RÔLE de la console, large par nature ; jamais un intitulé de poste en texte libre. Un contrat
 * échu, une fiche inactive : les avenants ne valent plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { FamilleIa } from "@/platform/ia/capacites/familles";

export type OriginePerimetre = "ROLE" | "AVENANT" | "CONSOLE";

export const LIBELLE_ORIGINE: Record<OriginePerimetre | "CONTRAT" | "DEFAUT" | "REGLAGE_ROLE" | "REGLAGE_PERSONNE", string> = {
  ROLE: "Droit applicatif du rôle",
  AVENANT: "Avenant au contrat",
  CONSOLE: "Droit daté de la console",
  CONTRAT: "Contrat de travail",
  DEFAUT: "Droits applicatifs (défaut)",
  REGLAGE_ROLE: "Réglage du rôle (console)",
  REGLAGE_PERSONNE: "Réglage de la personne (console)",
};

/** Un périmètre sur les valeurs sensibles d'autrui : une famille, une entité (NULL = celles qui lui sont ouvertes), des dates. */
export interface PerimetreSensible {
  famille: FamilleIa;
  companyId: string | null;
  /** ISO (AAAA-MM-JJ…) ; NULL = depuis toujours (ROLE). */
  du: string | null;
  /** ISO ; NULL = sans fin. Le jour dit compte encore. */
  au: string | null;
  origine: OriginePerimetre;
  /** L'avenant ou le droit qui l'ouvre — cité au journal. */
  ref: string | null;
  motif: string;
}

const JOUR_MS = 86_400_000;

/** En vigueur à `maintenant` : `du` atteint, `au` pas dépassé (le jour de fin compte en entier). */
export function perimetreEnVigueur(p: Pick<PerimetreSensible, "du" | "au">, maintenant: Date = new Date()): boolean {
  const t = maintenant.getTime();
  if (p.du && Date.parse(p.du) > t) return false;
  if (p.au && Date.parse(p.au.slice(0, 10)) + JOUR_MS <= t) return false;
  return true;
}

/**
 * Le périmètre qui couvre `famille` sur l'entité `companyId` (NULL : une fiche sans entité, ou une question sans
 * entité, comme une masse salariale — seul un périmètre SANS restriction d'entité la couvre). `null` : rien ne couvre.
 */
export function perimetreQuiCouvre(
  perimetres: readonly PerimetreSensible[] | undefined,
  famille: FamilleIa,
  companyId: string | null | undefined,
  maintenant: Date = new Date(),
): PerimetreSensible | null {
  for (const p of perimetres ?? []) {
    if (p.famille !== famille || !perimetreEnVigueur(p, maintenant)) continue;
    if (p.companyId === null || (companyId != null && p.companyId === companyId)) return p;
  }
  return null;
}

/** Un contrat qui fait encore foi : fiche active, pas d'échéance dépassée. Sans fiche : aucun avenant ne vaut. */
export function contratEnVigueur(c: { isActive: boolean; contractEnd: string | Date | null } | null, maintenant: Date = new Date()): boolean {
  if (!c || !c.isActive) return false;
  if (!c.contractEnd) return true;
  const fin = typeof c.contractEnd === "string" ? Date.parse(c.contractEnd) : c.contractEnd.getTime();
  return fin + JOUR_MS > maintenant.getTime();
}

/** Un avenant tel qu'il est lu (base, formulaire). */
export interface AvenantLu {
  id: string;
  objet: string;
  fonction: string | null;
  famille: string | null;
  companyId: string | null;
  effetLe: string;
  finLe: string | null;
  motif: string;
  revoqueLe: string | null;
}


/**
 * Les périmètres que les AVENANTS ouvrent : une DÉLÉGATION en vigueur, d'une famille connue, sur une entité NOMMÉE
 * (un avenant ne délègue jamais « tout »). Contrat échu ou fiche inactive : aucun.
 */
export function perimetresDesAvenants(
  avenants: readonly AvenantLu[],
  contratValide: boolean,
  estFamille: (f: string) => f is FamilleIa,
  maintenant: Date = new Date(),
): PerimetreSensible[] {
  if (!contratValide) return [];
  return avenants
    .filter((a) => a.objet === "DELEGATION" && !a.revoqueLe && !!a.famille && estFamille(a.famille) && !!a.companyId)
    .map((a) => ({ famille: a.famille as FamilleIa, companyId: a.companyId, du: a.effetLe, au: a.finLe, origine: "AVENANT" as const, ref: a.id, motif: a.motif }))
    .filter((p) => perimetreEnVigueur(p, maintenant));
}

/** La fonction exercée aujourd'hui : le dernier avenant de FONCTION en vigueur, sinon le poste du contrat. */
export function fonctionEnVigueur(poste: string | null, avenants: readonly AvenantLu[], maintenant: Date = new Date()): { fonction: string | null; origine: "CONTRAT" | "AVENANT"; ref: string | null } {
  const enCours = avenants
    .filter((a) => a.objet === "FONCTION" && !a.revoqueLe && !!a.fonction?.trim() && perimetreEnVigueur({ du: a.effetLe, au: a.finLe }, maintenant))
    .sort((a, b) => Date.parse(b.effetLe) - Date.parse(a.effetLe));
  const a = enCours[0];
  return a ? { fonction: a.fonction!.trim(), origine: "AVENANT", ref: a.id } : { fonction: poste, origine: "CONTRAT", ref: null };
}
