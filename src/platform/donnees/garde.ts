import { contexteDonnees, evaluateurDonnees, type VerdictDonnees } from "./contexte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GARDE DES DONNÉES (lots D3-D4, décision 0057) — UN seul point de passage, dans le relais `prisma`.
 *
 * Masquer des menus ne suffit pas : une donnée sort aussi par un export, une recherche, l'assistant, une API ou la
 * JOINTURE d'un autre écran. Toute l'application lisant par `prisma`, la question « cette base est-elle ouverte à
 * cette personne ? » se pose une fois, pour les ~6 400 lectures du code. L'extension Prisma qui applique le plan vit
 * dans `src/lib/prisma.ts` (le seul à connaître Prisma) ; ici, rien que la règle, sans dépendance ERP.
 *
 * D3 — OBSERVATION : l'évaluateur COMPTE ce qu'il aurait refusé. D4 — STRICT, seulement si le Super Admin l'a activé
 * (`AppSetting.accesBasesStrict`, désactivé par défaut) : le verdict porte `applique`, et le PLAN dit quoi faire :
 *   • la table demandée est fermée → REFUS (une erreur qui porte son empreinte : l'écran dit « base fermée ») ;
 *     sauf une lecture qui ne demande que des colonnes de RÉFÉRENCE (nom, poste — décision de la Direction n° 7) ;
 *     sauf ses PROPRES données quand la base le permet (n° 6) : les lignes d'autrui sont retirées du résultat ;
 *   • une table JOINTE (include / select) est fermée → la requête passe, mais ses lignes jointes sont réduites à leurs
 *     colonnes de référence : la demande Ad & Pro garde le nom et le poste du salarié, jamais sa paie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LECTURES = new Set(["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"]);
const LECTURES_DE_LIGNES = new Set(["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow"]);

/** Modèle → (champ de relation → modèle lié). */
export type Relations = (modele: string) => ReadonlyMap<string, string>;

/** L'erreur d'un refus appliqué. `digest` est gardé tel quel par Next en production : l'écran d'erreur le reconnaît. */
export class AccesBaseRefuse extends Error {
  readonly digest: string;
  constructor(message: string, digest: string) {
    super(message);
    this.name = "AccesBaseRefuse";
    this.digest = digest;
  }
}

/** Les modèles touchés par une requête : celui demandé, plus ceux que `include` / `select` tirent avec lui. */
export function modelesTouches(modele: string, args: unknown, relations: Relations, profondeur = 0): string[] {
  return [modele, ...joints(modele, args, relations, [], profondeur).map((j) => j.modele)];
}

interface Joint { modele: string; chemin: string[]; args: unknown }
function joints(modele: string, args: unknown, relations: Relations, chemin: string[], profondeur: number): Joint[] {
  if (profondeur > 3 || !args || typeof args !== "object") return [];
  const champs = relations(modele);
  if (!champs.size) return [];
  const out: Joint[] = [];
  for (const cle of ["include", "select"] as const) {
    const bloc = (args as Record<string, unknown>)[cle];
    if (!bloc || typeof bloc !== "object") continue;
    for (const [nom, valeur] of Object.entries(bloc as Record<string, unknown>)) {
      const lie = champs.get(nom);
      if (!lie || valeur === false || valeur == null) continue;
      const sous = valeur === true ? null : valeur;
      out.push({ modele: lie, chemin: [...chemin, nom], args: sous }, ...joints(lie, sous, relations, [...chemin, nom], profondeur + 1));
    }
  }
  return out;
}

/** Les colonnes demandées par un `select` (scalaires seulement), ou null si toutes. */
function colonnesDemandees(args: unknown, relations: ReadonlyMap<string, string>): string[] | null {
  const sel = args && typeof args === "object" ? (args as Record<string, unknown>).select : null;
  if (!sel || typeof sel !== "object") return null;
  return Object.entries(sel as Record<string, unknown>).filter(([k, v]) => v && !relations.has(k)).map(([k]) => k);
}
const queReference = (cols: string[] | null, reference: readonly string[] | undefined) =>
  !!cols && !!reference && cols.every((c) => reference.includes(c));

export interface PlanDeRequete {
  /** Refus de la table demandée : à lever AVANT la requête. */
  refus: AccesBaseRefuse | null;
  /** Ses propres données seulement : filtrer les lignes d'autrui APRÈS la requête. */
  propres: { userId: string; employeId: string | null; refus: AccesBaseRefuse } | null;
  /** Tables jointes fermées : réduire leurs lignes aux colonnes de référence. */
  masques: { chemin: string[]; colonnes: readonly string[] }[];
}

const erreur = (v: VerdictDonnees) => new AccesBaseRefuse(v.refus ?? "Accès refusé.", v.digest ?? "ACCES_BASE");

/**
 * Juge UNE requête : chaque modèle touché passe devant l'évaluateur du module `acces-bases` (branché au démarrage).
 * Sans évaluateur : null, coût nul. Un verdict non appliqué (observation) ne change rien au plan.
 */
export function planDeRequete(modele: string | undefined, operation: string, args: unknown, relations: Relations): PlanDeRequete | null {
  const juge = evaluateurDonnees();
  if (!juge || !modele) return null;
  const geste = LECTURES.has(operation) ? "lecture" : "ecriture";
  const contexte = contexteDonnees();
  const plan: PlanDeRequete = { refus: null, propres: null, masques: [] };

  const racine = juge({ modele, geste, operation, contexte });
  if (racine?.applique) {
    if (geste === "ecriture") plan.refus = erreur(racine);
    else if (queReference(colonnesDemandees(args, relations(modele)), racine.reference)) { /* nom et poste : permis */ }
    else if (racine.propres && LECTURES_DE_LIGNES.has(operation)) plan.propres = { ...racine.propres, refus: erreur(racine) };
    else plan.refus = erreur(racine);
  }
  if (geste === "lecture") {
    for (const j of joints(modele, args, relations, [], 0)) {
      const v = juge({ modele: j.modele, geste, operation, contexte });
      if (v?.applique && !queReference(colonnesDemandees(j.args, relations(j.modele)), v.reference)) {
        plan.masques.push({ chemin: j.chemin, colonnes: v.reference ?? ["id"] });
      }
    }
  }
  return plan.refus || plan.propres || plan.masques.length ? plan : null;
}

/** Une ligne est-elle à la personne ? (son compte, sa fiche RH, ou une ligne rattachée à l'un des deux) */
export function estAElle(ligne: unknown, modele: string, p: { userId: string; employeId: string | null }): boolean {
  if (!ligne || typeof ligne !== "object") return false;
  const l = ligne as Record<string, unknown>;
  if (l.userId === p.userId) return true;
  if (p.employeId && (l.employeeId === p.employeId || (modele === "Employee" && l.id === p.employeId))) return true;
  return modele === "User" && l.id === p.userId;
}

function reduire(obj: unknown, colonnes: readonly string[]): unknown {
  if (Array.isArray(obj)) return obj.map((o) => reduire(o, colonnes));
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([k]) => colonnes.includes(k)));
}

function masquer(obj: unknown, chemin: string[], colonnes: readonly string[]): unknown {
  if (Array.isArray(obj)) return obj.map((o) => masquer(o, chemin, colonnes));
  if (!obj || typeof obj !== "object") return obj;
  const [tete, ...reste] = chemin;
  const o = obj as Record<string, unknown>;
  if (!(tete in o)) return obj;
  return { ...o, [tete]: reste.length ? masquer(o[tete], reste, colonnes) : reduire(o[tete], colonnes) };
}

/** Applique le plan au RÉSULTAT : lignes d'autrui retirées (ses propres données), lignes jointes réduites. */
export function appliquerAuResultat(plan: PlanDeRequete, modele: string, operation: string, resultat: unknown, ajoutees: readonly string[] = []): unknown {
  let r = resultat;
  if (plan.propres) {
    const p = plan.propres;
    if (Array.isArray(r)) r = r.filter((l) => estAElle(l, modele, p));
    else if (r != null && !estAElle(r, modele, p)) throw p.refus;
    if (operation.endsWith("OrThrow") && r == null) throw p.refus;
  }
  for (const m of plan.masques) r = masquer(r, m.chemin, m.colonnes);
  if (ajoutees.length) {
    const retirer = (l: unknown) => (l && typeof l === "object" ? Object.fromEntries(Object.entries(l as Record<string, unknown>).filter(([k]) => !ajoutees.includes(k))) : l);
    r = Array.isArray(r) ? r.map(retirer) : retirer(r);
  }
  return r;
}
