import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { avancement, type Critere, type Jalon, type Objectif, type Risque } from "@/lib/objectif/modele";
import { estimer, type Estimation } from "@/lib/objectif/probabilite";
import { auditer, chemins, propager, raconterChemin, type Lien } from "@/lib/objectif/causal";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PONT DES OBJECTIFS (mandat 6 §47) — ce qui SURVIT aux missions.
 *
 * ── POURQUOI UNE TABLE, ICI, ALORS QU'AILLEURS ON A REFUSÉ D'EN CRÉER ───────────────────
 *
 * §17 interdit un SECOND registre de la même chose. Un objectif durable n'est la même chose que
 * rien : une mission se ferme, un objectif non. Le confondre avec une mission ferait déclarer
 * victoire à chaque mission close — et laisserait l'objectif dériver en silence, ce qui est
 * exactement le défaut que ce lot existe pour empêcher.
 *
 * Le lien est explicite dans l'autre sens : `missionIds` dit quelles missions ont été lancées
 * POUR cet objectif. Elles s'y ajoutent ; elles ne le remplacent pas.
 *
 * ── CE QUE LE PONT NE FAIT PAS ──────────────────────────────────────────────────────────
 *
 * Il ne met à jour aucun critère tout seul. « Le dossier est déposé » se CONSTATE — par une
 * personne, ou par une mission qui rapporte sa preuve. Un pont qui déduirait l'état des critères
 * de l'état des missions ferait passer un objectif au vert parce que le travail a été fait, pas
 * parce que le résultat est là. Ce sont deux choses différentes, et le mandat insiste dessus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le siège exécutif : un objectif d'entreprise se tient à la direction. */
const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const dateOu = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

interface Ligne {
  id: string; ownerId: string; statement: string; reformulation: string | null; status: string;
  horizon: Date | null; criteria: unknown; milestones: unknown; risks: unknown; links: unknown;
  missionIds: string[]; createdAt: Date;
}

/** La ligne de base → l'objectif du moteur pur. Les listes sont validées, jamais crues sur parole. */
function versObjectif(l: Ligne): Objectif {
  const criteres: Critere[] = (Array.isArray(l.criteria) ? l.criteria : []).map((x, i) => {
    const c = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(c.id ?? `c${i + 1}`),
      enonce: String(c.enonce ?? ""),
      mesurable: c.mesurable === true,
      etat: (["ATTEINT", "EN_COURS", "NON_ATTEINT", "INCONNU"].includes(String(c.etat)) ? String(c.etat) : "INCONNU") as Critere["etat"],
      preuve: typeof c.preuve === "string" && c.preuve.trim() ? c.preuve : null,
      constateLe: dateOu(c.constateLe),
    };
  });
  const jalons: Jalon[] = (Array.isArray(l.milestones) ? l.milestones : []).map((x, i) => {
    const j = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(j.id ?? `j${i + 1}`),
      libelle: String(j.libelle ?? ""),
      echeance: dateOu(j.echeance),
      etat: (["FAIT", "EN_COURS", "EN_RETARD", "PAS_COMMENCE", "ABANDONNE"].includes(String(j.etat)) ? String(j.etat) : "PAS_COMMENCE") as Jalon["etat"],
      dependDe: Array.isArray(j.dependDe) ? (j.dependDe as unknown[]).map(String) : [],
      missionId: typeof j.missionId === "string" ? j.missionId : null,
      proprietaire: typeof j.proprietaire === "string" ? j.proprietaire : null,
    };
  });
  const risques: Risque[] = (Array.isArray(l.risks) ? l.risks : []).map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? `r${i + 1}`),
      quoi: String(r.quoi ?? ""),
      vraisemblance: typeof r.vraisemblance === "number" ? r.vraisemblance : 0.5,
      impact: typeof r.impact === "number" ? r.impact : 0.5,
      parade: typeof r.parade === "string" && r.parade.trim() ? r.parade : null,
    };
  });
  return {
    id: l.id, enonce: l.statement, reformulation: l.reformulation, proprietaire: l.ownerId,
    echeance: l.horizon,
    etat: (["ACTIF", "ATTEINT", "COMPROMIS", "ABANDONNE"].includes(l.status) ? l.status : "ACTIF") as Objectif["etat"],
    criteres, jalons, risques, missions: l.missionIds, creeLe: l.createdAt,
  };
}

export function liensDe(l: { links: unknown }): Lien[] {
  return (Array.isArray(l.links) ? l.links : []).map((x) => {
    const n = (x ?? {}) as Record<string, unknown>;
    return {
      de: String(n.de ?? ""), vers: String(n.vers ?? ""),
      direction: n.direction === "RENFORCE" ? "RENFORCE" : "FREINE",
      intensite: typeof n.intensite === "number" ? n.intensite : 0.5,
      confiance: typeof n.confiance === "number" ? n.confiance : 0.5,
      hypothese: String(n.hypothese ?? ""),
      preuves: Array.isArray(n.preuves) ? (n.preuves as unknown[]).map(String) : [],
    } satisfies Lien;
  }).filter((n) => n.de && n.vers);
}

export type Refus = { erreur: string; suite?: string };

export async function creerObjectif(user: CurrentUser, o: {
  enonce: string; reformulation?: string | null; horizon?: Date | null;
  criteres?: unknown[]; jalons?: unknown[]; risques?: unknown[]; liens?: unknown[];
}): Promise<{ id: string } | Refus> {
  if (!EXEC(user)) return { erreur: "Un objectif d'entreprise se tient à la direction." };
  if (!o.enonce.trim()) return { erreur: "L'objectif doit être énoncé." };
  const row = await prisma.executiveObjective.create({
    data: {
      ownerId: user.id,
      statement: o.enonce.slice(0, 1_000),
      reformulation: o.reformulation ?? null,
      horizon: o.horizon ?? null,
      criteria: (o.criteres ?? []) as never,
      milestones: (o.jalons ?? []) as never,
      risks: (o.risques ?? []) as never,
      links: (o.liens ?? []) as never,
    },
    select: { id: true },
  });
  return { id: row.id };
}

async function lire(user: CurrentUser, id: string): Promise<Ligne | null> {
  // LE CLOISONNEMENT EST PAR REQUÊTE — `ownerId` dans le `where`, comme le registre des décisions.
  // Un objectif d'un autre n'est pas « introuvable par erreur » : il est hors de portée par
  // construction, et aucun identifiant deviné n'y donne accès.
  return prisma.executiveObjective.findFirst({
    where: { id, ownerId: user.id },
    select: {
      id: true, ownerId: true, statement: true, reformulation: true, status: true, horizon: true,
      criteria: true, milestones: true, risks: true, links: true, missionIds: true, createdAt: true,
    },
  }) as Promise<Ligne | null>;
}

export async function listerObjectifs(user: CurrentUser, opts: { actifsSeulement?: boolean; limite?: number } = {}) {
  if (!EXEC(user)) return { erreur: "Un objectif d'entreprise se tient à la direction." } satisfies Refus;
  const lignes = await prisma.executiveObjective.findMany({
    where: { ownerId: user.id, ...(opts.actifsSeulement === false ? {} : { status: "ACTIF" }) },
    select: {
      id: true, ownerId: true, statement: true, reformulation: true, status: true, horizon: true,
      criteria: true, milestones: true, risks: true, links: true, missionIds: true, createdAt: true,
    },
    orderBy: [{ horizon: "asc" }, { createdAt: "desc" }],
    take: Math.min(50, Math.max(1, opts.limite ?? 20)),
  }) as Ligne[];
  const maintenant = new Date();
  return {
    objectifs: lignes.map((l) => {
      const o = versObjectif(l);
      const e = estimer(o, maintenant);
      const a = avancement(o, maintenant);
      return { objectif: o, estimation: e, avancement: a };
    }),
  };
}

export interface EtatObjectifLu {
  objectif: Objectif;
  estimation: Estimation;
  avancement: ReturnType<typeof avancement>;
  causal: { audit: ReturnType<typeof auditer>; liens: Lien[] };
}

export async function etatObjectif(user: CurrentUser, id: string): Promise<EtatObjectifLu | Refus> {
  if (!EXEC(user)) return { erreur: "Un objectif d'entreprise se tient à la direction." };
  const l = await lire(user, id);
  if (!l) return { erreur: `Aucun objectif « ${id} » qui vous appartienne.`, suite: "Utilisez « lister » pour retrouver son identifiant." };
  const o = versObjectif(l);
  const maintenant = new Date();
  const e = estimer(o, maintenant);

  // ON MÉMORISE L'ESTIMATION, pas pour la croire plus tard, mais pour VOIR SA DÉRIVE : « 78 %
  // il y a un mois, 61 % aujourd'hui » dit quelque chose que 61 % tout seul ne dit pas.
  await prisma.executiveObjective.update({
    where: { id: l.id },
    data: { lastProbability: e.probabilite, lastFactors: e.facteurs as never, lastAssessedAt: maintenant },
  }).catch(sansBloquer("objectif.etatObjectif.executiveObjective"));

  const liens = liensDe(l);
  return { objectif: o, estimation: e, avancement: avancement(o, maintenant), causal: { audit: auditer(liens), liens } };
}

/** Met à jour ce qui se CONSTATE — critères, jalons, risques, liens, état. Jamais déduit. */
export async function majObjectif(user: CurrentUser, id: string, patch: {
  criteres?: unknown[]; jalons?: unknown[]; risques?: unknown[]; liens?: unknown[];
  etat?: string; horizon?: Date | null; missionId?: string | null;
}): Promise<{ ok: true } | Refus> {
  if (!EXEC(user)) return { erreur: "Un objectif d'entreprise se tient à la direction." };
  const l = await lire(user, id);
  if (!l) return { erreur: `Aucun objectif « ${id} » qui vous appartienne.` };
  await prisma.executiveObjective.update({
    where: { id: l.id },
    data: {
      ...(patch.criteres ? { criteria: patch.criteres as never } : {}),
      ...(patch.jalons ? { milestones: patch.jalons as never } : {}),
      ...(patch.risques ? { risks: patch.risques as never } : {}),
      ...(patch.liens ? { links: patch.liens as never } : {}),
      ...(patch.etat && ["ACTIF", "ATTEINT", "COMPROMIS", "ABANDONNE"].includes(patch.etat) ? { status: patch.etat } : {}),
      ...(patch.horizon !== undefined ? { horizon: patch.horizon } : {}),
      // UNE MISSION S'AJOUTE À L'OBJECTIF, elle ne le remplace pas : `missionIds` ne se réécrit
      // jamais en entier depuis un appel, sinon la deuxième mission effacerait la première.
      ...(patch.missionId && !l.missionIds.includes(patch.missionId) ? { missionIds: [...l.missionIds, patch.missionId] } : {}),
    },
  });
  return { ok: true };
}

/** « Que se passe-t-il si X change ? » — la propagation dans le graphe causal de CET objectif. */
export async function simuler(user: CurrentUser, id: string, choc: { noeud: string; ampleur: number }) {
  if (!EXEC(user)) return { erreur: "Un objectif d'entreprise se tient à la direction." } satisfies Refus;
  const l = await lire(user, id);
  if (!l) return { erreur: `Aucun objectif « ${id} » qui vous appartienne.` } satisfies Refus;
  const liens = liensDe(l);
  if (liens.length === 0) {
    return { erreur: "Cet objectif n'a aucun lien causal déclaré : il n'y a rien à propager.", suite: "Déclarez les dépendances (« le retard du dossier freine le packaging ») avant de simuler." } satisfies Refus;
  }
  const impacts = propager(liens, choc);
  return {
    impacts,
    // LES CHEMINS, pour contester une flèche et pas la conclusion.
    chemins: impacts.slice(0, 5).flatMap((i) => chemins(liens, choc.noeud, i.noeud).slice(0, 1).map(raconterChemin)),
    audit: auditer(liens),
  };
}
