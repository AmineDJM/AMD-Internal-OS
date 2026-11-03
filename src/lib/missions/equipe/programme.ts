import { BRANCHE, CLE, chaine, entierPositif, liste, montant, NOM_DEPOT, objet } from "@/lib/missions/chantiers/plan";
import { perimetresSeRecouvrent } from "@/lib/missions/chantiers/perimetre";
import type { RefDepot } from "@/lib/missions/chantiers/ports-moteur";
import { ressourceValide, ressourcesCommunes, ressourcesDeTache } from "@/lib/missions/equipe/ressources";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN D'UN PROGRAMME ET SON VALIDATEUR DÉTERMINISTE (lot O2, décision 0059 § 3-4) — module PUR.
 *
 * Un programme est une mission PARENTE dont chaque tâche devient un chantier enfant (une session Claude Code, une
 * branche). Le plan vient de MiMo (ou de Terra) : il n'est JAMAIS cru sur parole. Ce validateur refuse :
 *   • un graphe qui boucle (cycle), une dépendance vers une tâche inconnue ou vers soi-même ;
 *   • un périmètre vide, absolu ou qui remonte (« .. ») ; une ressource nommée inconnue ;
 *   • une tâche sans critère d'acceptation, sans commande de vérification, ou au critère vague (« ça marche ») ;
 *   • un budget dépassé par la somme des estimations, ou plus de tâches que de lancements permis ;
 *   • tout DÉPLOIEMENT (un programme ne déploie jamais — un déploiement est un chantier sous carte) ;
 * et SIGNALE (sans refuser) les tâches non ordonnées qui se recouvrent : l'ordonnanceur les sérialisera.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const KIND_PROGRAMME = "PROGRAMME";
export const TAILLES = ["S", "M", "L"] as const;
export type TailleTache = (typeof TAILLES)[number];
export const MOYENS_TRAVAILLEUR = ["claude-code-cloud", "managed-agents"] as const;
export type MoyenTravailleur = (typeof MOYENS_TRAVAILLEUR)[number];

export interface TacheProgramme {
  cle: string;
  titre: string;
  objectif: string;
  perimetre: string[];
  /** Ressources nommées DÉCLARÉES (SCHEMA, CONTRAT, API, DEPENDANCES, GENERES, MODULE:<m>) — complétées par les globs. */
  ressources: string[];
  criteres: string[];
  commandesVerif: string[];
  dependances: string[];
  migrations: boolean;
  taille: TailleTache;
  coutEstimeUsd?: number;
}

export interface PlanProgramme {
  titre: string;
  objectif: string;
  depot: RefDepot;
  /** La branche où le travail s'INTÈGRE (défaut main) — la file d'intégration la sert, une tâche à la fois. */
  cible: string;
  taches: TacheProgramme[];
  budget: { usd?: number; lancements?: number };
  /** Travailleurs en parallèle au plus (défaut 3, borné à 6). */
  concurrence: number;
  travailleur: MoyenTravailleur;
}

export interface ConflitDeclare { a: string; b: string; motif: string }

export const BORNES_PROGRAMME = { taches: 12, concurrence: 6, concurrenceDefaut: 3 } as const;

/** Un critère qu'aucune vérification ne peut trancher. */
const VAGUE = /^(ça|ca|cela|tout)?\s*(marche|fonctionne|est fait|va bien|ok|propre|mieux|comme prévu)\.?$/i;
const critereVerifiable = (c: string) => c.length >= 12 && !VAGUE.test(c.trim());

function lireTache(b: unknown, i: number, fautes: string[]): TacheProgramme | null {
  const t = objet(b);
  const cle = chaine(t?.cle, 48).toLowerCase();
  const ou = `Tâche ${i + 1} « ${cle || "?"} »`;
  if (!t || !CLE.test(cle)) { fautes.push(`${ou} : clé invalide (minuscules, chiffres, - et _).`); return null; }
  if (t.services !== undefined || t.deployer !== undefined) fautes.push(`${ou} : un programme ne déploie pas — un déploiement est un chantier à part, sous carte de la Direction.`);
  const perimetre = liste(t.perimetre, 20, 200);
  if (!perimetre.length) fautes.push(`${ou} : périmètre vide — déclarez les globs que la tâche touche.`);
  if (perimetre.some((g) => g.startsWith("/") || g.includes(".."))) fautes.push(`${ou} : un glob est relatif à la racine du dépôt, sans « .. ».`);
  const ressources = [...new Set(liste(t.ressources, 12, 80).map((r) => (/^module:/i.test(r) ? `MODULE:${r.slice(7).toLowerCase()}` : r.toUpperCase())))];
  for (const r of ressources) if (!ressourceValide(r)) fautes.push(`${ou} : ressource « ${r} » inconnue (SCHEMA, CONTRAT, API, DEPENDANCES, GENERES, MODULE:<module>).`);
  const criteres = liste(t.criteres, 12, 400);
  if (!criteres.length) fautes.push(`${ou} : aucun critère d'acceptation.`);
  for (const c of criteres) if (!critereVerifiable(c)) fautes.push(`${ou} : critère « ${c} » invérifiable — dites ce qui se constate (sortie, statut, test).`);
  const commandesVerif = liste(t.commandesVerif, 12, 300);
  if (!commandesVerif.length) fautes.push(`${ou} : aucune commande de vérification (npm test…) : rien ne prouverait la tâche.`);
  const taille = (chaine(t.taille, 1).toUpperCase() || "M") as TailleTache;
  if (!(TAILLES as readonly string[]).includes(taille)) fautes.push(`${ou} : taille « ${taille} » (S, M ou L).`);
  const objectif = chaine(t.objectif, 4000);
  if (!objectif) fautes.push(`${ou} : objectif manquant.`);
  const cout = montant(t.coutEstimeUsd);
  return {
    cle, titre: chaine(t.titre, 120) || cle, objectif, perimetre, ressources, criteres, commandesVerif,
    dependances: [...new Set(liste(t.dependances, 10, 48).map((x) => x.toLowerCase()))],
    migrations: t.migrations === true, taille, ...(cout ? { coutEstimeUsd: cout } : {}),
  };
}

/** Un cycle dans le graphe des dépendances (algorithme de Kahn) : les clés qui n'ont jamais pu être ordonnées. */
export function cycleDe(taches: readonly Pick<TacheProgramme, "cle" | "dependances">[]): string[] {
  const reste = new Map(taches.map((t) => [t.cle, new Set(t.dependances.filter((d) => taches.some((x) => x.cle === d)))]));
  let avance = true;
  while (avance) {
    avance = false;
    for (const [cle, deps] of reste) {
      if ([...deps].every((d) => !reste.has(d))) { reste.delete(cle); avance = true; }
    }
  }
  return [...reste.keys()].sort();
}

/** `a` précède-t-il `b` (chemin de dépendances de b vers a) ? */
export function precede(taches: readonly Pick<TacheProgramme, "cle" | "dependances">[], a: string, b: string): boolean {
  const vus = new Set<string>();
  const pile = [b];
  while (pile.length) {
    const x = pile.pop()!;
    for (const d of taches.find((t) => t.cle === x)?.dependances ?? []) {
      if (d === a) return true;
      if (!vus.has(d)) { vus.add(d); pile.push(d); }
    }
  }
  return false;
}

/** Deux tâches se gênent-elles ? Périmètres qui se recouvrent, ressource nommée commune, ou deux migrations. */
export function genes(a: TacheProgramme, b: TacheProgramme): string | null {
  const p = perimetresSeRecouvrent(a.perimetre, b.perimetre);
  if (p) return `périmètres « ${p.a} » et « ${p.b} »`;
  const r = ressourcesCommunes(ressourcesDeTache(a), ressourcesDeTache(b));
  if (r.length) return `ressource${r.length > 1 ? "s" : ""} ${r.join(", ")}`;
  if (a.migrations && b.migrations) return "deux migrations (une seule en vol par dépôt)";
  return null;
}

/** Les paires NON ordonnées qui se gênent : l'ordonnanceur les sérialisera (dit au plan, sans refus). */
export function conflitsDeclares(taches: readonly TacheProgramme[]): ConflitDeclare[] {
  const out: ConflitDeclare[] = [];
  for (const [i, a] of taches.entries()) {
    for (const b of taches.slice(i + 1)) {
      if (precede(taches, a.cle, b.cle) || precede(taches, b.cle, a.cle)) continue;
      const motif = genes(a, b);
      if (motif) out.push({ a: a.cle, b: b.cle, motif });
    }
  }
  return out;
}

/**
 * LE PARALLÉLISME VAUT-IL LE COÛT ? Une chaîne de PETITES tâches liées (A → B, toutes deux « S », B ne dépend que de A,
 * A n'a que B pour suite) se fait mieux en UNE session : le contexte partagé vaut plus qu'une session de plus, une
 * intégration de plus, un lancement de plus. Les deux tâches sont fusionnées (objectifs, périmètres, critères).
 */
export function regrouperPetitesTaches(taches: readonly TacheProgramme[]): { taches: TacheProgramme[]; regroupees: string[][] } {
  let courant = [...taches];
  const regroupees: string[][] = [];
  for (let change = true; change;) {
    change = false;
    for (const b of courant) {
      if (b.taille !== "S" || b.dependances.length !== 1) continue;
      const a = courant.find((x) => x.cle === b.dependances[0]);
      if (!a || a.taille !== "S" || courant.filter((x) => x.dependances.includes(a.cle)).length !== 1) continue;
      const fusion: TacheProgramme = {
        ...a, titre: `${a.titre} puis ${b.titre}`.slice(0, 120), objectif: `${a.objectif}\n\nPuis : ${b.objectif}`.slice(0, 4000),
        perimetre: [...new Set([...a.perimetre, ...b.perimetre])], ressources: [...new Set([...a.ressources, ...b.ressources])],
        criteres: [...a.criteres, ...b.criteres].slice(0, 12), commandesVerif: [...new Set([...a.commandesVerif, ...b.commandesVerif])],
        migrations: a.migrations || b.migrations, taille: "M",
        ...(a.coutEstimeUsd || b.coutEstimeUsd ? { coutEstimeUsd: (a.coutEstimeUsd ?? 0) + (b.coutEstimeUsd ?? 0) } : {}),
      };
      courant = courant.filter((x) => x.cle !== b.cle).map((x) => (x.cle === a.cle ? fusion : { ...x, dependances: x.dependances.map((d) => (d === b.cle ? a.cle : d)) }));
      regroupees.push([a.cle, b.cle]);
      change = true;
      break;
    }
  }
  return { taches: courant, regroupees };
}

export type LecturePlan =
  | { ok: true; plan: PlanProgramme; conflits: ConflitDeclare[]; regroupees: string[][] }
  | { ok: false; fautes: string[] };

/** LIT ET VALIDE un plan de programme (de MiMo, de Sol ou de Terra) — rend le plan propre ou ses fautes, en français. */
export function lirePlanProgramme(brut: unknown, o: { plafondUsd?: number; lancementsMax?: number } = {}): LecturePlan {
  const p = objet(brut);
  if (!p) return { ok: false, fautes: ["Le plan doit être un objet { titre, objectif, depot, cible, taches: [...] }."] };
  const fautes: string[] = [];
  const titre = chaine(p.titre, 120);
  const objectif = chaine(p.objectif, 4000);
  const d = objet(p.depot);
  const depot: RefDepot = { proprietaire: chaine(d?.proprietaire, 100), nom: chaine(d?.nom, 100) };
  const cible = chaine(p.cible, 120) || "main";
  if (!titre) fautes.push("Titre manquant.");
  if (!objectif) fautes.push("Objectif manquant.");
  if (!NOM_DEPOT.test(depot.proprietaire) || !NOM_DEPOT.test(depot.nom)) fautes.push("Dépôt invalide : { proprietaire, nom }.");
  if (!BRANCHE.test(cible)) fautes.push(`Branche cible « ${cible} » invalide.`);
  if (p.services !== undefined || p.deployer !== undefined) fautes.push("Un programme ne déploie pas : le déploiement est un chantier à part, sous carte de la Direction.");
  const brutes = Array.isArray(p.taches) ? p.taches : [];
  if (!brutes.length) fautes.push("Aucune tâche.");
  if (brutes.length > BORNES_PROGRAMME.taches) fautes.push(`Au plus ${BORNES_PROGRAMME.taches} tâches par programme (découpez en deux programmes).`);
  const lues: TacheProgramme[] = [];
  for (const [i, b] of brutes.slice(0, BORNES_PROGRAMME.taches).entries()) {
    const t = lireTache(b, i, fautes);
    if (!t) continue;
    if (lues.some((x) => x.cle === t.cle)) { fautes.push(`Tâche « ${t.cle} » en double.`); continue; }
    lues.push(t);
  }
  for (const t of lues) {
    for (const dep of t.dependances) {
      if (dep === t.cle) fautes.push(`« ${t.cle} » dépend d'elle-même.`);
      else if (!lues.some((x) => x.cle === dep)) fautes.push(`« ${t.cle} » dépend de « ${dep} », qui n'est pas une tâche du programme.`);
    }
  }
  const cycle = cycleDe(lues);
  if (cycle.length) fautes.push(`Cycle de dépendances entre : ${cycle.join(", ")}.`);
  const b = objet(p.budget);
  const budget = { ...(montant(b?.usd) ? { usd: Math.min(montant(b?.usd)!, o.plafondUsd ?? Infinity) } : o.plafondUsd ? { usd: o.plafondUsd } : {}), ...(entierPositif(b?.lancements) ? { lancements: entierPositif(b?.lancements) } : {}) };
  const estime = lues.reduce((s, t) => s + (t.coutEstimeUsd ?? 0), 0);
  if (budget.usd !== undefined && estime > budget.usd) fautes.push(`Budget dépassé : ${estime.toFixed(2)} $ estimés pour ${budget.usd.toFixed(2)} $ permis.`);
  const lancementsMax = Math.min(budget.lancements ?? Infinity, o.lancementsMax ?? Infinity);
  if (lues.length > lancementsMax) fautes.push(`${lues.length} tâches pour ${lancementsMax} lancements permis : chaque tâche lance au moins une session.`);
  const travailleur = (chaine(p.travailleur, 30) || "claude-code-cloud") as MoyenTravailleur;
  if (!(MOYENS_TRAVAILLEUR as readonly string[]).includes(travailleur)) fautes.push(`Travailleur « ${travailleur} » inconnu (${MOYENS_TRAVAILLEUR.join(", ")}).`);
  if (fautes.length) return { ok: false, fautes };
  const { taches, regroupees } = regrouperPetitesTaches(lues);
  const concurrence = Math.min(entierPositif(p.concurrence) ?? BORNES_PROGRAMME.concurrenceDefaut, BORNES_PROGRAMME.concurrence);
  return {
    ok: true,
    plan: { titre, objectif, depot, cible, taches, budget, concurrence, travailleur },
    conflits: conflitsDeclares(taches),
    regroupees,
  };
}
