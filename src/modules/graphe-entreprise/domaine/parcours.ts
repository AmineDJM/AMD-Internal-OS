/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS PAR CHEMINS BORNÉS (J9, décision 0021) — règle PURE (deux ports asynchrones, aucun import d'infra).
 *
 * « Qu'est-ce qui dépend de ce fournisseur ? », « qui a travaillé sur ce dossier ? », « quels documents parlent de ce
 * produit ? » : un parcours en largeur, saut par saut, depuis UN nœud.
 *
 * LES DROITS PASSENT AVANT LE PARCOURS, PAS APRÈS. À chaque saut, les nœuds atteints sont soumis à `autoriser` AVANT
 * d'entrer dans la frontière : un nœud refusé n'est ni rendu ni TRAVERSÉ — on ne passe jamais par un dossier qu'on ne
 * peut pas voir pour atteindre ce qui est derrière. Le départ lui-même est jugé. `etendre` ne reçoit que des nœuds
 * autorisés ; l'appelant restreint en plus les types interrogés (un type fermé n'est même pas lu).
 *
 * BORNES : profondeur ≤ 3, nœuds par saut, arêtes au total. Un parcours borné le DIT (`tronque`), il ne prétend pas
 * avoir tout vu. La date (`aLaDate`) écarte les arêtes qui n'étaient pas valides ce jour-là : le graphe tel qu'il était.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { cleArete, typeDe, valideA, type AreteDatee, type TypeNoeud } from "./noeuds";

export const PROFONDEUR_MAX = 3;
export const NOEUDS_PAR_SAUT_MAX = 200;
export const ARETES_MAX = 2_000;

export interface OptionsParcours {
  profondeur?: number;
  /** Ne suivre que ces relations (vide = toutes). */
  relations?: readonly string[];
  /** Ne RENDRE que ces types (le parcours traverse les autres types autorisés pour les atteindre). */
  typesVises?: readonly TypeNoeud[];
  /** Le graphe tel qu'il était à cette date. */
  aLaDate?: Date | null;
  noeudsParSaut?: number;
  aretesMax?: number;
}

export interface PortsParcours {
  /** Les arêtes qui touchent ces nœuds (dans les deux sens). */
  etendre: (refs: string[]) => Promise<AreteDatee[]>;
  /** Parmi ces nœuds, ceux que la personne peut voir. Appelé AVANT toute traversée. */
  autoriser: (refs: string[]) => Promise<Set<string>>;
}

export interface ResultatParcours {
  depart: string;
  /** Les nœuds atteints, avec leur distance au départ. */
  noeuds: Map<string, number>;
  aretes: AreteDatee[];
  /** Pour chaque nœud atteint, l'arête par laquelle on y est arrivé (le chemin se recompose). */
  parent: Map<string, AreteDatee>;
  tronque: boolean;
  refuse: boolean;
}

export async function parcourir(depart: string, ports: PortsParcours, o: OptionsParcours = {}): Promise<ResultatParcours> {
  const profondeur = Math.max(1, Math.min(PROFONDEUR_MAX, Math.trunc(o.profondeur ?? 2)));
  const parSaut = o.noeudsParSaut ?? NOEUDS_PAR_SAUT_MAX;
  const aretesMax = o.aretesMax ?? ARETES_MAX;
  const relations = o.relations?.length ? new Set(o.relations) : null;
  const res: ResultatParcours = { depart, noeuds: new Map(), aretes: [], parent: new Map(), tronque: false, refuse: false };
  if (!(await ports.autoriser([depart])).has(depart)) { res.refuse = true; return res; }
  res.noeuds.set(depart, 0);
  const vues = new Set<string>();
  let frontiere = [depart];
  for (let d = 1; d <= profondeur && frontiere.length; d++) {
    const brutes = await ports.etendre(frontiere);
    const dansFrontiere = new Set(frontiere);
    const retenues = brutes.filter((a) =>
      (dansFrontiere.has(a.de) || dansFrontiere.has(a.a))
      && (!relations || relations.has(a.relation))
      && (!o.aLaDate || valideA(a, o.aLaDate)));
    const nouveaux = [...new Set(retenues.flatMap((a) => [a.de, a.a]).filter((r) => !res.noeuds.has(r)))];
    const ok = nouveaux.length ? await ports.autoriser(nouveaux) : new Set<string>();
    const prochaine: string[] = [];
    for (const a of retenues) {
      const k = cleArete(a);
      if (vues.has(k)) continue;
      const autre = dansFrontiere.has(a.de) ? a.a : a.de;
      const connu = res.noeuds.has(autre);
      if (!connu && !ok.has(autre)) continue;
      if (res.aretes.length >= aretesMax) { res.tronque = true; break; }
      if (!connu) {
        if (prochaine.length >= parSaut) { res.tronque = true; continue; }
        res.noeuds.set(autre, d);
        res.parent.set(autre, a);
        prochaine.push(autre);
      }
      vues.add(k);
      res.aretes.push(a);
    }
    frontiere = prochaine;
  }
  return res;
}

/** Le chemin du départ jusqu'à ce nœud, arête par arête. */
export function cheminVers(r: ResultatParcours, cible: string): AreteDatee[] {
  const out: AreteDatee[] = [];
  let c = cible;
  for (let garde = 0; c !== r.depart && garde <= PROFONDEUR_MAX; garde++) {
    const a = r.parent.get(c);
    if (!a) return [];
    out.unshift(a);
    c = a.de === c ? a.a : a.de;
  }
  return c === r.depart ? out : [];
}

/** Les nœuds à RENDRE : tous sauf le départ, restreints aux types visés, du plus proche au plus lointain. */
export function noeudsRendus(r: ResultatParcours, typesVises?: readonly TypeNoeud[]): string[] {
  const vises = typesVises?.length ? new Set<string>(typesVises) : null;
  return [...r.noeuds.entries()]
    .filter(([ref]) => ref !== r.depart && (!vises || vises.has(typeDe(ref) ?? "")))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([ref]) => ref);
}
