import { algiersYmd, formatAlgiers } from "@/lib/calendar-tz";
import type { ElementFile } from "@/lib/espace/aujourdhui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCHÉANCES DES MODULES DANS « AUJOURD'HUI » (Super Admin, 24/11/2026) — module PUR.
 *
 * « L'échéancier de conformité réparti dans les modules, OK. Sans que ce soit visible : il faut que ce soit
 * intégré. » Donc AUCUNE page « échéancier » : chaque module déclare les échéances qu'il porte (fin de CDD,
 * fin de contrat Legal, visite médicale du travail…) et elles deviennent des lignes ordinaires de la file
 * « Aujourd'hui », rangées sous le module qui les porte et menant à sa fiche.
 *
 *   · LE RESPONSABLE la voit à J-30 (« Plus tard »), à J-10 elle passe dans « Aujourd'hui » (priorité haute),
 *     dépassée elle est « En retard », en rouge — les trois groupes existants, sans règle neuve.
 *   · LE SOMMET (Super Admin, Direction, DG) ne voit que ce qui est dépassé ou à moins de 10 jours, toutes
 *     sources confondues — sauf ce dont il est NOMMÉMENT responsable (N+1, auteur), qu'il voit comme tout le monde.
 *   · CLOISONNEMENT : une échéance d'une société que la personne ne voit pas ne lui parvient pas, et une pièce
 *     restreinte ne parvient qu'à ses lecteurs désignés (et au Super Admin).
 *
 * Le côté serveur (qui lit les sources et la personne) est `queries/echeances-aujourdhui.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une échéance remonte dans « Aujourd'hui » de ses responsables à J-30… */
export const ECHEANCE_RAPPEL_JOURS = 30;
/** …passe en priorité haute à J-10 — et c'est le seuil du sommet. */
export const ECHEANCE_PROCHE_JOURS = 10;
/** Au-delà, la ligne d'un module renvoie à sa liste (« et N autres… ») : la file reste lisible. */
export const ECHEANCES_PAR_MODULE = 30;

/** Le droit qui fait le responsable « de métier » (droit d'écriture sur le module qui porte l'échéance). */
export interface DroitResponsable {
  module: string;
  action: "VIEW" | "CREATE" | "UPDATE" | "VALIDATE";
}

/** CE QU'UN MODULE DÉCLARE — une échéance, telle qu'il la porte. */
export interface Echeance {
  /** La source (« rh.cdd », « legal.document »…) — avec `id`, l'identité de la ligne. */
  source: string;
  id: string;
  /** Le module, tel que le chapeau de la file le dit (« Ressources humaines », « Legal »). */
  module: string;
  /** « Fin de CDD — Samir Haddad » : se suffit à lui-même. */
  libelle: string;
  /** Ce qui précise sans répéter (« Délégué médical », « Bail · SARL Immo »). */
  detail?: string | null;
  date: Date;
  /** La fiche qui la porte. */
  href: string;
  /** La liste du module — le geste d'un lot de plusieurs échéances. */
  liste?: string | null;
  companyId: string | null;
  /** Les personnes NOMMÉMENT responsables (N+1, auteur, responsable désigné). */
  responsables: readonly string[];
  /** Le droit qui fait les responsables de métier ; `null` = seulement les personnes nommées. */
  droit: DroitResponsable | null;
  /** Pièce restreinte : ses seuls lecteurs (vide = ouverte à qui a le droit). */
  lecteurs?: readonly string[];
}

/**
 * UNE SOURCE D'ÉCHÉANCES — ce qu'un module branche, en une ligne, dans `echeances/registre.ts`.
 * `lire` rend les échéances dont la date est AU PLUS TARD `jusquau` (dépassées comprises, à la discrétion de la
 * source : une période d'essai passée n'est plus rien à faire, un CDD passé l'est encore).
 */
export interface SourceEcheances {
  cle: string;
  lire: (ctx: { maintenant: Date; jusquau: Date }) => Promise<Echeance[]>;
}

/** Qui regarde « Aujourd'hui » — ce que la règle doit savoir de lui, déjà calculé. */
export interface Lecteur {
  id: string;
  /** Super Admin, Direction, DG : seulement l'urgent et le dépassé. */
  sommet: boolean;
  superAdmin: boolean;
  peut: (droit: DroitResponsable) => boolean;
  societePermise: (companyId: string | null) => boolean;
}

const JOUR_MS = 86_400_000;

/** Jours civils d'Alger jusqu'à l'échéance — 0 le jour même, négatif une fois dépassée. */
export function joursAvant(date: Date, maintenant: Date): number {
  const jour = (d: Date) => Date.parse(`${algiersYmd(d)}T00:00:00.000Z`) / JOUR_MS;
  return Math.round(jour(date) - jour(maintenant));
}

/** La borne haute de lecture des sources : la fin du 30ᵉ jour civil. */
export function horizonEcheances(maintenant: Date): Date {
  return new Date(maintenant.getTime() + (ECHEANCE_RAPPEL_JOURS + 1) * JOUR_MS);
}

/**
 * CETTE PERSONNE VOIT-ELLE CETTE ÉCHÉANCE AUJOURD'HUI ?
 * Nommée : à J-30, quelle que soit la société. Sinon il faut la société, puis le sommet (≤ 10 j ou dépassée)
 * ou le droit du module (J-30). Le sommet ne devient pas « responsable de métier » par ses droits étendus :
 * sans cette règle, le Super Admin verrait chaque échéance du groupe un mois à l'avance.
 */
export function echeanceVisible(e: Echeance, l: Lecteur, maintenant: Date): boolean {
  const jours = joursAvant(e.date, maintenant);
  if (jours > ECHEANCE_RAPPEL_JOURS) return false;
  const nomme = e.responsables.includes(l.id);
  if (e.lecteurs && e.lecteurs.length > 0 && !nomme && !l.superAdmin && !e.lecteurs.includes(l.id)) return false;
  if (nomme) return true;
  if (!l.societePermise(e.companyId)) return false;
  if (l.sommet) return jours <= ECHEANCE_PROCHE_JOURS;
  return e.droit !== null && l.peut(e.droit);
}

/** « 15 décembre 2026 » — la date, à l'heure d'Alger. */
const dateLisible = (d: Date) => formatAlgiers(d, { day: "numeric", month: "long", year: "numeric" });

/**
 * LES LIGNES DE LA FILE — une par échéance visible, plus une ligne « et N autres » par module au-delà du plafond.
 * `societes` : le nom court des sociétés, dit sur la ligne quand le groupe en a plusieurs.
 */
export function lignesEcheances(
  echeances: readonly Echeance[],
  lecteur: Lecteur,
  maintenant: Date,
  societes: ReadonlyMap<string, string> = new Map(),
): ElementFile[] {
  const visibles = echeances
    .filter((e) => echeanceVisible(e, lecteur, maintenant))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.libelle.localeCompare(b.libelle, "fr"));

  // Une échéance par objet : deux sources qui en parleraient ne font pas deux lignes.
  const vues = new Set<string>();
  const parModule = new Map<string, Echeance[]>();
  for (const e of visibles) {
    const id = `${e.source}:${e.id}`;
    if (vues.has(id)) continue;
    vues.add(id);
    parModule.set(e.module, [...(parModule.get(e.module) ?? []), e]);
  }

  const lignes: ElementFile[] = [];
  for (const [module, liste] of parModule) {
    for (const e of liste.slice(0, ECHEANCES_PAR_MODULE)) {
      const jours = joursAvant(e.date, maintenant);
      const societe = societes.size > 1 && e.companyId ? societes.get(e.companyId) ?? null : null;
      // « dans N j » seulement au-delà de demain : « échéance aujourd'hui / demain » et le retard, la file les dit déjà.
      const quand = jours >= 2 ? `le ${dateLisible(e.date)} · dans ${jours} j` : jours >= 0 ? `le ${dateLisible(e.date)}` : `depuis le ${dateLisible(e.date)}`;
      lignes.push({
        key: `echeance-${e.source}-${e.id}`,
        objet: `ECHEANCE:${e.source}:${e.id}`,
        title: e.libelle,
        subtitle: [e.detail, societe, quand].filter(Boolean).join(" · "),
        module,
        href: e.href,
        kind: "echeance",
        deadline: e.date.toISOString(),
        depuis: null,
        owner: "",
        statusLabel: null,
        priority: jours <= ECHEANCE_PROCHE_JOURS ? "HIGH" : null,
        liste: e.liste ?? null,
      });
    }
    const reste = liste.length - ECHEANCES_PAR_MODULE;
    if (reste > 0) {
      const lien = liste.find((e) => e.liste)?.liste ?? liste[ECHEANCES_PAR_MODULE].href;
      lignes.push({
        key: `echeance-${module}-reste`, objet: `ECHEANCE:${module}:reste:`,
        title: `Et ${reste} autre${reste > 1 ? "s" : ""} échéance${reste > 1 ? "s" : ""} — tout voir`,
        subtitle: "", module, href: lien, kind: "echeance", deadline: null, depuis: null, owner: "", statusLabel: null,
      });
    }
  }
  return lignes;
}
