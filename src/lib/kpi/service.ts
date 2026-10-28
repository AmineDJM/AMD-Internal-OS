import { randomUUID } from "node:crypto";
import type { Prisma, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { loadReportingLine } from "@/lib/departments";
import { managementChainOf, subtreeOf, flattenTree } from "@/modules/rh/partage";
import { sensTendance } from "@/lib/force-de-vente/calculs";
import { BRIQUE_PAR_ID, FREQUENCES, type FrequenceRevue } from "./briques";
import {
  briquesDe, lireLignesDeRevue, paramsDe, phraseCalcul, relireDefinition,
  type DefinitionKpi, type LigneDeRevue, type MesureKpi, type NiveauGrille,
} from "./definition";
import {
  afficherValeur, cibleSurFenetre, clePeriode, couleur, fenetre, fenetreCourante, fenetresPrecedentes, normaliser, proposerCible,
  scoreGlobal, seuilsEffectifs, type Fenetre,
} from "./score";
import { peutCreerPourEquipe, peutGererCatalogue, peutGererPersonne, peutModifierDefinition, peutVoirBilan, type FaitsKpi } from "./droits";
import { ChargeurBriques } from "./briques-calcul";
import { MODULE_FEEDBACK_KPI, resumeProposition, type KpiPourCommentaire, type SourceEvaluation } from "./luna-pur";
import { MOIS_HISTORIQUE_MAX, justificationDeLaRegle, statistiquesCible, type CibleLuna, type EntreeCible, type HistoriqueCible } from "./luna-cible";
import type { ApercuKpi, BilanKpi, ColonneKpi, KpiDuBilan, LigneDetail, LigneKpi, PreuveLuna, TableauKpi } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * KPI & BILANS — le service (couches 2 et 4) : qui a quels KPI, leurs valeurs (mises en cache), le tableau de
 * Mon équipe, le bilan d'une personne, la revue signée, le rafraîchissement quotidien.
 *
 * ── LE CACHE (« bilan en continu ») ─────────────────────────────────────────────────────────
 * Une valeur calculée est rangée dans `KpiValue`. Tant que la période vit, elle se recalcule si elle a plus de
 * `FRAICHEUR_MS` ; une période close se recalcule une dernière fois après sa fin, puis ne bouge plus. Le battement
 * quotidien (`rafraichirKpiSiDu`, depuis `scheduled.ts`) recalcule la période courante de tout le monde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FRAICHEUR_MS = 15 * 60_000;
const TENDANCE = 6;

export interface DefLue {
  id: string;
  famille: string;
  version: number;
  portee: string;
  createdById: string | null;
  def: DefinitionKpi;
}

export interface PersonneKpi {
  userId: string;
  employeeId: string | null;
  nom: string;
  poste: string | null;
  role: UserRole | null;
  depth: number;
}

const SELECT_DEF = {
  id: true, famille: true, version: true, nom: true, description: true, nature: true, params: true, unite: true, sens: true,
  cible: true, seuilVert: true, seuilOrange: true, periode: true, grille: true, portee: true, createdById: true,
} as const;

type LigneDef = Prisma.KpiDefinitionGetPayload<{ select: typeof SELECT_DEF }>;

function lire(l: LigneDef): DefLue | null {
  const def = relireDefinition(l);
  return def ? { id: l.id, famille: l.famille, version: l.version, portee: l.portee, createdById: l.createdById, def } : null;
}

export async function definitionsActives(): Promise<DefLue[]> {
  const rows = await prisma.kpiDefinition.findMany({ where: { statut: "ACTIF" }, select: SELECT_DEF, orderBy: [{ createdAt: "asc" }] });
  return rows.flatMap((r) => { const d = lire(r); return d ? [d] : []; });
}

export async function definitionParId(id: string): Promise<(DefLue & { statut: string }) | null> {
  const r = await prisma.kpiDefinition.findUnique({ where: { id }, select: { ...SELECT_DEF, statut: true } });
  if (!r) return null;
  const d = lire(r);
  return d ? { ...d, statut: r.statut } : null;
}

// ── Le périmètre (l'arbre de Mon équipe) ─────────────────────────────────────────────────────

export async function faitsKpi(user: SessionUser): Promise<{ faits: FaitsKpi; equipe: PersonneKpi[] }> {
  const superAdmin = user.role === "SUPER_ADMIN";
  const gestes = { voir: userCan(user, "KPI", "VIEW"), creer: userCan(user, "KPI", "CREATE"), valider: userCan(user, "KPI", "VALIDATE") };
  const me = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  let noeuds: { employeeId: string; userId: string | null; fullName: string; depth: number }[] = [];
  if (me) {
    const { employees, departments } = await loadReportingLine();
    noeuds = flattenTree(subtreeOf(me.id, employees, departments));
  }
  const userIds = noeuds.map((n) => n.userId).filter((v): v is string => Boolean(v));
  const [users, fiches] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds }, isActive: true }, select: { id: true, name: true, role: true } }),
    prisma.employee.findMany({ where: { id: { in: noeuds.map((n) => n.employeeId) } }, select: { id: true, position: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const poste = new Map(fiches.map((x) => [x.id, x.position]));
  const equipe = noeuds.flatMap((n) => {
    const x = n.userId ? u.get(n.userId) : undefined;
    return x ? [{ userId: x.id, employeeId: n.employeeId, nom: n.fullName || x.name, poste: poste.get(n.employeeId) ?? null, role: x.role, depth: n.depth }] : [];
  });
  return { faits: { superAdmin, moi: user.id, equipe: new Set(equipe.map((e) => e.userId)), gestes }, equipe };
}

async function personne(userId: string): Promise<PersonneKpi | null> {
  const [x, e] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } }),
    prisma.employee.findUnique({ where: { userId }, select: { id: true, fullName: true, position: true } }),
  ]);
  return x ? { userId: x.id, employeeId: e?.id ?? null, nom: e?.fullName ?? x.name, poste: e?.position ?? null, role: x.role, depth: 0 } : null;
}

// ── Les affectations : qui a quels KPI, avec quel poids ─────────────────────────────────────

/**
 * Pour chaque personne : les familles de KPI qui s'appliquent et leur poids. Une affectation PERSONNE l'emporte sur
 * une affectation d'ÉQUIPE (d'un de ses managers, à n'importe quel rang), qui l'emporte sur le modèle de RÔLE.
 */
export async function affectations(personnes: readonly PersonneKpi[]): Promise<Map<string, Map<string, { poids: number; assignmentId: string }>>> {
  const toutes = await prisma.kpiAssignment.findMany({ select: { id: true, famille: true, cible: true, role: true, managerUserId: true, userId: true, poids: true } });
  const parEquipe = toutes.filter((a) => a.cible === "EQUIPE" && a.managerUserId);
  let chaines = new Map<string, Set<string>>();
  if (parEquipe.length) {
    const { employees, departments } = await loadReportingLine();
    chaines = new Map(personnes.map((p) => [p.userId, new Set(p.employeeId ? managementChainOf(p.employeeId, employees, departments).map((m) => m.userId).filter((v): v is string => Boolean(v)) : [])]));
  }
  const rang = { PERSONNE: 3, EQUIPE: 2, ROLE: 1 } as Record<string, number>;
  const out = new Map<string, Map<string, { poids: number; assignmentId: string; rang: number }>>();
  for (const p of personnes) {
    const m = new Map<string, { poids: number; assignmentId: string; rang: number }>();
    for (const a of toutes) {
      const s = a.cible === "PERSONNE" ? a.userId === p.userId
        : a.cible === "EQUIPE" ? Boolean(a.managerUserId && chaines.get(p.userId)?.has(a.managerUserId))
          : a.cible === "ROLE" ? a.role === p.role : false;
      if (!s) continue;
      const r = rang[a.cible] ?? 0;
      const cur = m.get(a.famille);
      if (!cur || r > cur.rang) m.set(a.famille, { poids: a.poids, assignmentId: a.id, rang: r });
    }
    out.set(p.userId, m);
  }
  return out as Map<string, Map<string, { poids: number; assignmentId: string }>>;
}

export async function frequenceDe(managerUserId: string | null): Promise<FrequenceRevue> {
  if (!managerUserId) return "MENSUELLE";
  const r = await prisma.kpiReviewSetting.findUnique({ where: { managerUserId }, select: { frequence: true } });
  return (FREQUENCES as readonly string[]).includes(r?.frequence ?? "") ? (r!.frequence as FrequenceRevue) : "MENSUELLE";
}

// ── Les valeurs ──────────────────────────────────────────────────────────────────────────────

export interface ValeurKpi {
  valeur: number | null;
  numerateur: number | null;
  denominateur: number | null;
  raison: string | null;
  propositionLuna: number | null;
  aValider: number;
}

const cleV = (definitionId: string, userId: string) => `${definitionId}|${userId}`;

async function calculerMesuree(c: ChargeurBriques, d: DefLue, userId: string, f: Fenetre): Promise<Omit<ValeurKpi, "propositionLuna" | "aValider">> {
  const num = d.def.numerateur ? await c.calculer(d.def.numerateur, userId, f) : { valeur: null, raison: "Mesure absente." };
  if (d.def.nature === "CALCULE") return { valeur: num.valeur, numerateur: num.valeur, denominateur: null, raison: num.raison };
  const den = d.def.denominateur ? await c.calculer(d.def.denominateur, userId, f) : { valeur: null, raison: "Dénominateur absent." };
  if (num.valeur === null) return { valeur: null, numerateur: null, denominateur: den.valeur, raison: num.raison };
  if (den.valeur === null) return { valeur: null, numerateur: num.valeur, denominateur: null, raison: den.raison };
  if (den.valeur === 0) return { valeur: null, numerateur: num.valeur, denominateur: 0, raison: `Rien à mesurer sur la période (${BRIQUE_PAR_ID[d.def.denominateur!.brique].libelle.toLowerCase()} : 0).` };
  return { valeur: Math.round((1000 * num.valeur) / den.valeur) / 10, numerateur: num.valeur, denominateur: den.valeur, raison: null };
}

/**
 * LES VALEURS de plusieurs KPI pour plusieurs personnes sur une fenêtre. Calculé/ratio : le cache d'abord, puis le
 * calcul ; évalué : le niveau VALIDÉ (la proposition de Luna ne compte pas) ; déclaré : la somme des déclarations
 * validées ; importé : la valeur du fichier (sommée ou moyennée sur les mois de la fenêtre).
 */
export async function valeursPour(
  defs: readonly DefLue[],
  userIds: readonly string[],
  f: Fenetre,
  opts: { chargeur?: ChargeurBriques; force?: boolean; ecrire?: boolean } = {},
): Promise<Map<string, ValeurKpi>> {
  const out = new Map<string, ValeurKpi>();
  if (defs.length === 0 || userIds.length === 0) return out;
  const c = opts.chargeur ?? new ChargeurBriques();
  const maintenant = c.maintenant;
  const ecrire = opts.ecrire !== false;
  const users = [...userIds];

  const mesures = defs.filter((d) => d.def.nature === "CALCULE" || d.def.nature === "RATIO");
  const evalues = defs.filter((d) => d.def.nature === "EVALUE");
  const declares = defs.filter((d) => d.def.nature === "DECLARE");
  const importes = defs.filter((d) => d.def.nature === "IMPORTE");

  const [cache, evaluations, declarations, imports] = await Promise.all([
    mesures.length && ecrire ? prisma.kpiValue.findMany({ where: { definitionId: { in: mesures.map((d) => d.id) }, userId: { in: users }, periode: f.cle } }) : Promise.resolve([]),
    evalues.length ? prisma.kpiEvaluation.findMany({ where: { definitionId: { in: evalues.map((d) => d.id) }, userId: { in: users }, periode: f.cle } }) : Promise.resolve([]),
    declares.length ? prisma.kpiDeclaration.findMany({ where: { definitionId: { in: declares.map((d) => d.id) }, userId: { in: users }, periode: f.cle }, select: { definitionId: true, userId: true, valeur: true, statut: true } }) : Promise.resolve([]),
    importes.length ? importsDesFamilles(importes, users, f) : Promise.resolve(new Map<string, number | null>()),
  ]);
  const enCache = new Map(cache.map((v) => [cleV(v.definitionId, v.userId), v]));
  const periodeClose = f.fin.getTime() <= maintenant.getTime();

  for (const d of mesures) {
    for (const u of users) {
      const k = cleV(d.id, u);
      const v = enCache.get(k);
      const frais = v && !opts.force && (periodeClose ? v.calculeLe.getTime() >= f.fin.getTime() : maintenant.getTime() - v.calculeLe.getTime() < FRAICHEUR_MS);
      if (v && frais) {
        out.set(k, { valeur: v.valeur, numerateur: v.numerateur, denominateur: v.denominateur, raison: v.sourceManquante, propositionLuna: null, aValider: 0 });
        continue;
      }
      const r = await calculerMesuree(c, d, u, f);
      out.set(k, { ...r, propositionLuna: null, aValider: 0 });
      if (ecrire) {
        await prisma.kpiValue.upsert({
          where: { definitionId_userId_periode: { definitionId: d.id, userId: u, periode: f.cle } },
          create: { definitionId: d.id, userId: u, periode: f.cle, valeur: r.valeur, numerateur: r.numerateur, denominateur: r.denominateur, sourceManquante: r.raison, calculeLe: maintenant },
          update: { valeur: r.valeur, numerateur: r.numerateur, denominateur: r.denominateur, sourceManquante: r.raison, calculeLe: maintenant },
        }).catch((e) => console.error("[kpi] cache non écrit", e));
      }
    }
  }
  for (const d of evalues) {
    for (const u of users) {
      const e = evaluations.find((x) => x.definitionId === d.id && x.userId === u);
      out.set(cleV(d.id, u), {
        valeur: e?.niveau ?? null, numerateur: null, denominateur: null,
        raison: e?.niveau ? null : e?.propositionNiveau ? "Proposition de Luna à valider par le manager." : "Pas encore évalué par le manager.",
        propositionLuna: e?.niveau ? null : e?.propositionNiveau ?? null, aValider: e?.propositionNiveau && !e.niveau ? 1 : 0,
      });
    }
  }
  for (const d of declares) {
    for (const u of users) {
      const ds = declarations.filter((x) => x.definitionId === d.id && x.userId === u);
      const validees = ds.filter((x) => x.statut === "VALIDEE");
      out.set(cleV(d.id, u), {
        valeur: validees.length ? validees.reduce((s, x) => s + x.valeur, 0) : null, numerateur: null, denominateur: null,
        raison: validees.length ? null : ds.length ? "Déclaration(s) en attente de validation." : "Aucune déclaration sur la période.",
        propositionLuna: null, aValider: ds.filter((x) => x.statut === "A_VALIDER").length,
      });
    }
  }
  for (const d of importes) {
    for (const u of users) {
      const v = (imports as Map<string, number | null>).get(cleV(d.famille, u)) ?? null;
      out.set(cleV(d.id, u), { valeur: v, numerateur: null, denominateur: null, raison: v === null ? "Aucune valeur importée pour la période." : null, propositionLuna: null, aValider: 0 });
    }
  }
  return out;
}

/** Les valeurs importées d'une famille : la clé exacte de la fenêtre, sinon ses mois (somme d'un nombre, moyenne d'un taux). */
async function importsDesFamilles(defs: readonly DefLue[], users: readonly string[], f: Fenetre): Promise<Map<string, number | null>> {
  const familles = [...new Set(defs.map((d) => d.famille))];
  const versions = await prisma.kpiDefinition.findMany({ where: { famille: { in: familles } }, select: { id: true, famille: true } });
  const familleDe = new Map(versions.map((v) => [v.id, v.famille]));
  const moisCles = Array.from({ length: f.mois }, (_, i) => { const d = new Date(f.debut.getFullYear(), f.debut.getMonth() + i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const rows = await prisma.kpiValue.findMany({
    where: { definitionId: { in: versions.map((v) => v.id) }, userId: { in: [...users] }, importId: { not: null }, periode: { in: [f.cle, ...moisCles] } },
    select: { definitionId: true, userId: true, periode: true, valeur: true, calculeLe: true }, orderBy: { calculeLe: "desc" },
  });
  const out = new Map<string, number | null>();
  for (const d of defs) {
    for (const u of users) {
      const mine = rows.filter((r) => familleDe.get(r.definitionId) === d.famille && r.userId === u && r.valeur !== null);
      const exacte = mine.find((r) => r.periode === f.cle);
      if (exacte) { out.set(cleV(d.famille, u), exacte.valeur); continue; }
      const parMois = moisCles.flatMap((m) => { const r = mine.find((x) => x.periode === m); return r?.valeur != null ? [r.valeur] : []; });
      if (parMois.length === 0) continue;
      const somme = parMois.reduce((s, v) => s + v, 0);
      out.set(cleV(d.famille, u), d.def.unite === "POURCENT" ? Math.round((somme / parMois.length) * 10) / 10 : somme);
    }
  }
  return out;
}

// ── La note d'une valeur ─────────────────────────────────────────────────────────────────────

function noter(d: DefLue, v: ValeurKpi | undefined, f: Fenetre) {
  const additive = d.def.numerateur ? BRIQUE_PAR_ID[d.def.numerateur.brique].additive && d.def.nature === "CALCULE" : d.def.nature === "DECLARE" || d.def.nature === "IMPORTE";
  const cible = cibleSurFenetre(d.def.cible, { unite: d.def.unite, additive, periode: d.def.periode }, f.mois);
  const niveauMax = d.def.grille?.length ?? null;
  const valeur = v?.valeur ?? null;
  const seuils = seuilsEffectifs({ cible, seuilVert: d.def.seuilVert === null ? null : cibleSurFenetre(d.def.seuilVert, { unite: d.def.unite, additive, periode: d.def.periode }, f.mois), seuilOrange: d.def.seuilOrange === null ? null : cibleSurFenetre(d.def.seuilOrange, { unite: d.def.unite, additive, periode: d.def.periode }, f.mois), sens: d.def.sens, nature: d.def.nature });
  return {
    cible,
    niveauMax,
    note: normaliser({ valeur, cible, sens: d.def.sens, nature: d.def.nature, niveauMax }),
    couleur: couleur(valeur, seuils, d.def.sens),
    affichage: v?.propositionLuna && valeur === null ? `Luna : ${v.propositionLuna} ?` : valeur === null ? (d.def.nature === "IMPORTE" ? "pas de donnée" : "—") : afficherValeur(valeur, d.def.unite, niveauMax),
  };
}

const definitionBrique = (d: DefinitionKpi): string | null =>
  d.numerateur ? [BRIQUE_PAR_ID[d.numerateur.brique].definition, d.denominateur ? `÷ ${BRIQUE_PAR_ID[d.denominateur.brique].definition}` : null].filter(Boolean).join(" ") : null;

// ── Le tableau de Mon équipe ─────────────────────────────────────────────────────────────────

export async function chargerTableauKpi(user: SessionUser, cle?: string | null): Promise<TableauKpi> {
  const { faits, equipe } = await faitsKpi(user);
  const frequence = await frequenceDe(user.id);
  const maintenant = new Date();
  const demandee = cle ? fenetre(cle) : null;
  const f = demandee ?? fenetreCourante(frequence, maintenant);
  const periodes = fenetresPrecedentes(fenetreCourante(f.frequence, maintenant).cle, 6).reverse().map((x) => ({ cle: x.cle, libelle: x.libelle }));

  const affect = await affectations(equipe);
  const familles = new Set([...affect.values()].flatMap((m) => [...m.keys()]));
  const defs = (await definitionsActives()).filter((d) => familles.has(d.famille));
  const userIds = equipe.map((p) => p.userId);
  const [valeurs, revues, propositions] = await Promise.all([
    valeursPour(defs, userIds, f),
    prisma.kpiReview.findMany({ where: { userId: { in: userIds }, periode: f.cle }, select: { userId: true, statut: true, signeeLe: true } }),
    prisma.feedback.findMany({ where: { userId: user.id, module: MODULE_FEEDBACK_KPI }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, message: true, status: true, createdAt: true } }),
  ]);

  const colonnes: ColonneKpi[] = defs.map((d) => {
    const poidsVus = equipe.flatMap((p) => { const a = affect.get(p.userId)?.get(d.famille); return a ? [a.poids] : []; });
    const freq = new Map<number, number>();
    for (const p of poidsVus) freq.set(p, (freq.get(p) ?? 0) + 1);
    const poids = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    return {
      famille: d.famille, definitionId: d.id, version: d.version, nom: d.def.nom, nature: d.def.nature, unite: d.def.unite, sens: d.def.sens,
      poids, cible: d.def.cible, calcul: phraseCalcul(d.def), definitionBrique: definitionBrique(d.def), niveauMax: d.def.grille?.length ?? null,
      modifiable: peutModifierDefinition(faits, d),
    };
  }).sort((a, b) => b.poids - a.poids || a.nom.localeCompare(b.nom, "fr"));

  const lignes: LigneKpi[] = equipe.map((p) => {
    const mes = affect.get(p.userId) ?? new Map();
    const cellules: LigneKpi["cellules"] = {};
    const items: { note: number | null; poids: number }[] = [];
    let aValider = 0;
    for (const d of defs) {
      const a = mes.get(d.famille);
      if (!a) continue;
      const v = valeurs.get(cleV(d.id, p.userId));
      const n = noter(d, v, f);
      cellules[d.famille] = {
        definitionId: d.id, valeur: v?.valeur ?? null, affichage: n.affichage, couleur: n.couleur, note: n.note, poids: a.poids,
        raison: v?.raison ?? null, propositionLuna: v?.propositionLuna ?? null, aValider: v?.aValider ?? 0,
      };
      aValider += v?.aValider ?? 0;
      items.push({ note: n.note, poids: a.poids });
    }
    const s = scoreGlobal(items);
    const r = revues.find((x) => x.userId === p.userId);
    return {
      userId: p.userId, employeeId: p.employeeId, nom: p.nom, poste: p.poste, depth: p.depth, cellules,
      score: s.score, sansDonnee: s.sansDonnee, aValider,
      revue: { statut: (r?.statut === "SIGNEE" ? "SIGNEE" : r ? "BROUILLON" : "AUCUNE") as LigneKpi["revue"]["statut"], signeeLe: r?.signeeLe?.toISOString() ?? null },
    };
  }).filter((l) => Object.keys(l.cellules).length > 0 || equipe.length <= 30);

  return {
    periode: { cle: f.cle, libelle: f.libelle, frequence: f.frequence },
    periodes,
    frequence,
    colonnes,
    lignes,
    droits: { creer: peutCreerPourEquipe(faits), signer: faits.superAdmin || faits.gestes.valider, superAdmin: peutGererCatalogue(faits) },
    propositions: propositions.map((x) => ({ id: x.id, resume: resumeProposition(x.message), statut: x.status, le: x.createdAt.toISOString() })),
  };
}

// ── Le bilan d'une personne ──────────────────────────────────────────────────────────────────

const lirePreuves = (json: unknown): PreuveLuna[] => (Array.isArray(json) ? json.flatMap((p) => {
  const o = (p && typeof p === "object" ? p : null) as Record<string, unknown> | null;
  return o && typeof o.extrait === "string" ? [{ source: String(o.source ?? "Source"), date: typeof o.date === "string" ? o.date : null, extrait: o.extrait }] : [];
}) : []);

async function frequenceDuBilan(cible: PersonneKpi): Promise<FrequenceRevue> {
  if (!cible.employeeId) return "MENSUELLE";
  const { employees, departments } = await loadReportingLine();
  const n1 = managementChainOf(cible.employeeId, employees, departments)[0]?.userId ?? null;
  return frequenceDe(n1);
}

export async function chargerBilanKpi(user: SessionUser, cibleUserId: string, cle?: string | null): Promise<BilanKpi | null> {
  const { faits } = await faitsKpi(user);
  if (!peutVoirBilan(faits, cibleUserId)) return null;
  const cible = await personne(cibleUserId);
  if (!cible) return null;
  const maintenant = new Date();
  const f = (cle ? fenetre(cle) : null) ?? fenetreCourante(await frequenceDuBilan(cible), maintenant);
  const fenetres = fenetresPrecedentes(f.cle, TENDANCE);
  const periodes = fenetresPrecedentes(fenetreCourante(f.frequence, maintenant).cle, 6).reverse().map((x) => ({ cle: x.cle, libelle: x.libelle }));

  const revue = await prisma.kpiReview.findUnique({ where: { userId_periode: { userId: cibleUserId, periode: f.cle } } });
  const signee = revue?.statut === "SIGNEE";
  const figees = signee ? lireLignesDeRevue(revue!.detail) : [];

  // Les définitions : celles FIGÉES par la revue signée (leur version), sinon les actives qui s'appliquent.
  let defs: DefLue[];
  let poidsDe: Map<string, number>;
  if (signee) {
    const rows = await prisma.kpiDefinition.findMany({ where: { id: { in: figees.map((l) => l.definitionId) } }, select: SELECT_DEF });
    defs = rows.flatMap((r) => { const d = lire(r); return d ? [d] : []; });
    poidsDe = new Map(figees.map((l) => [l.famille, l.poids]));
  } else {
    const affect = (await affectations([cible])).get(cibleUserId) ?? new Map();
    defs = (await definitionsActives()).filter((d) => affect.has(d.famille));
    poidsDe = new Map([...affect.entries()].map(([k, v]) => [k, v.poids]));
  }

  const chargeur = new ChargeurBriques(maintenant);
  const parFenetre = new Map<string, Map<string, ValeurKpi>>();
  for (const w of fenetres) parFenetre.set(w.cle, await valeursPour(defs, [cibleUserId], w, { chargeur }));

  const [evaluations, declarations] = await Promise.all([
    prisma.kpiEvaluation.findMany({ where: { userId: cibleUserId, periode: f.cle, definitionId: { in: defs.map((d) => d.id) } } }),
    prisma.kpiDeclaration.findMany({ where: { userId: cibleUserId, periode: f.cle, definitionId: { in: defs.map((d) => d.id) } }, orderBy: { createdAt: "desc" } }),
  ]);

  const kpis: KpiDuBilan[] = defs.map((d) => {
    const fig = figees.find((l) => l.definitionId === d.id);
    const v = parFenetre.get(f.cle)?.get(cleV(d.id, cibleUserId));
    const n = noter(d, v, f);
    const tendance = fenetres.map((w) => noter(d, parFenetre.get(w.cle)?.get(cleV(d.id, cibleUserId)), w).note);
    const e = evaluations.find((x) => x.definitionId === d.id);
    const origine = v && d.def.nature === "RATIO" && v.numerateur !== null && v.denominateur !== null
      ? `${fmt(v.numerateur)} ${court(d.def.numerateur)} · ${fmt(v.denominateur)} ${court(d.def.denominateur)}`
      : v && d.def.nature === "CALCULE" && v.numerateur !== null ? `${fmt(v.numerateur)} ${court(d.def.numerateur)}` : null;
    return {
      famille: d.famille, definitionId: d.id, version: d.version, nom: d.def.nom, nature: d.def.nature, unite: d.def.unite, sens: d.def.sens,
      poids: fig?.poids ?? poidsDe.get(d.famille) ?? 0,
      cible: n.cible, cibleAffichee: n.cible === null ? "—" : afficherValeur(n.cible, d.def.unite, n.niveauMax),
      valeur: fig ? fig.valeur : v?.valeur ?? null,
      affichage: fig ? fig.affichage : n.affichage,
      couleur: n.couleur,
      note: fig ? fig.score : n.note,
      raison: fig ? fig.raison : v?.raison ?? null,
      calcul: phraseCalcul(d.def), definitionBrique: definitionBrique(d.def), tendance, origine,
      drill: d.def.nature === "CALCULE" || d.def.nature === "RATIO",
      grille: d.def.grille as NiveauGrille[] | null,
      evaluation: d.def.nature === "EVALUE" ? {
        propositionNiveau: e?.propositionNiveau ?? null, preuves: lirePreuves(e?.propositionPreuves), justification: e?.justification ?? null,
        niveau: e?.niveau ?? null, commentaire: e?.commentaire ?? null,
      } : null,
      declarations: declarations.filter((x) => x.definitionId === d.id).map((x) => ({ id: x.id, libelle: x.libelle, valeur: x.valeur, statut: x.statut, piece: x.pieceNom, le: x.createdAt.toISOString() })),
    };
  }).sort((a, b) => b.poids - a.poids);

  const s = signee ? { score: revue!.score === null ? null : Math.round(revue!.score), sansDonnee: revue!.kpiSansDonnee } : scoreGlobal(kpis.map((k) => ({ note: k.note, poids: k.poids })));
  const signeePar = revue?.signeeParId ? (await prisma.user.findUnique({ where: { id: revue.signeeParId }, select: { name: true } }))?.name ?? null : null;
  return {
    userId: cible.userId, nom: cible.nom, poste: cible.poste,
    periode: { cle: f.cle, libelle: f.libelle }, periodes,
    score: s.score, sansDonnee: s.sansDonnee, figee: signee,
    revue: {
      statut: signee ? "SIGNEE" : revue ? "BROUILLON" : "AUCUNE", signeeLe: revue?.signeeLe?.toISOString() ?? null, signeePar,
      commentaireManager: revue?.commentaireManager ?? null, commentaireLuna: revue?.commentaireLuna ?? null,
    },
    kpis,
    droits: { manager: peutGererPersonne(faits, cibleUserId), soi: cibleUserId === user.id },
  };
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("fr-FR");
function court(m: MesureKpi | null): string {
  if (!m) return "";
  return BRIQUE_PAR_ID[m.brique].libelle.toLowerCase();
}

/** Ce que Luna lit pour rédiger le commentaire : les seuls chiffres de la plateforme. */
export function kpisPourCommentaire(b: BilanKpi): KpiPourCommentaire[] {
  return b.kpis.map((k) => ({ nom: k.nom, affichage: k.affichage, cible: k.cibleAffichee, note: k.note, tendance: sensTendance(k.tendance.map((t) => (t === null ? null : t / 100))) }));
}

// ── La revue signée ──────────────────────────────────────────────────────────────────────────

export function lignesAFiger(b: BilanKpi): LigneDeRevue[] {
  return b.kpis.map((k) => ({
    famille: k.famille, definitionId: k.definitionId, version: k.version, nom: k.nom, nature: k.nature, unite: k.unite,
    poids: k.poids, valeur: k.valeur, score: k.note, affichage: k.affichage, raison: k.raison,
  }));
}

// ── « D'où vient le chiffre » ───────────────────────────────────────────────────────────────

export async function detailKpi(user: SessionUser, definitionId: string, cibleUserId: string, cle: string): Promise<{ titre: string; lignes: LigneDetail[] }[] | null> {
  const { faits } = await faitsKpi(user);
  if (!peutVoirBilan(faits, cibleUserId)) return null;
  const d = await definitionParId(definitionId);
  const f = fenetre(cle);
  if (!d || !f || (d.def.nature !== "CALCULE" && d.def.nature !== "RATIO")) return null;
  const c = new ChargeurBriques();
  const out: { titre: string; lignes: LigneDetail[] }[] = [];
  for (const m of [d.def.numerateur, d.def.denominateur]) {
    if (!m) continue;
    out.push({ titre: BRIQUE_PAR_ID[m.brique].libelle, lignes: await c.detail(m, cibleUserId, f) });
  }
  return out;
}

// ── Les preuves d'un KPI évalué (ce que Luna lit) ───────────────────────────────────────────

/**
 * LES SOURCES d'une proposition de niveau : rapports écrits des visites, comptes rendus vocaux, fiches de coaching
 * finalisées de la période. Bornées (30 sources, 1 200 caractères chacune) : un modèle noyé ne juge plus.
 */
export async function sourcesEvaluation(userId: string, f: Fenetre): Promise<SourceEvaluation[]> {
  const [visites, rapports, fiches] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: { delegateId: userId, date: { gte: f.debut, lt: f.fin }, status: "COMPLETED", report: { not: null } },
      select: { id: true, date: true, report: true, doctorFeedback: true }, orderBy: { date: "desc" }, take: 15,
    }),
    prisma.fieldReport.findMany({
      where: { delegateId: userId, visitDate: { gte: f.debut, lt: f.fin } },
      select: { id: true, visitDate: true, summary: true, transcript: true }, orderBy: { visitDate: "desc" }, take: 10,
    }),
    prisma.coachingSheet.findMany({
      where: { collaboratorId: userId, status: "FINALIZED", visitDate: { gte: f.debut, lt: f.fin } },
      select: { id: true, visitDate: true, strengths: true, improvements: true }, orderBy: { visitDate: "desc" }, take: 5,
    }),
  ]);
  const borne = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 1200);
  const out: SourceEvaluation[] = [
    ...fiches.flatMap((c) => {
      const t = [c.strengths ? `Points forts : ${c.strengths}` : null, c.improvements ? `À améliorer : ${c.improvements}` : null].filter(Boolean).join(" ");
      return t ? [{ id: `C${c.id.slice(-6)}`, type: "COACHING" as const, date: c.visitDate.toISOString(), texte: borne(t) }] : [];
    }),
    ...visites.flatMap((v) => {
      const t = [v.report, v.doctorFeedback].filter(Boolean).join(" ");
      return t.trim() ? [{ id: `V${v.id.slice(-6)}`, type: "VISITE" as const, date: v.date.toISOString(), texte: borne(t) }] : [];
    }),
    ...rapports.flatMap((r) => {
      const t = r.summary ?? r.transcript ?? "";
      return t.trim() ? [{ id: `R${r.id.slice(-6)}`, type: "RAPPORT" as const, date: r.visitDate.toISOString(), texte: borne(t) }] : [];
    }),
  ];
  return out.slice(0, 30);
}

// ── L'aperçu sur les 3 derniers mois réels (rien n'est enregistré) ──────────────────────────

/** L'année et le mois (1..12) situés `avant` mois avant la date donnée. */
const anneeMois = (maintenant: Date, avant: number): [number, number] => {
  const d = new Date(maintenant.getFullYear(), maintenant.getMonth() - avant, 1);
  return [d.getFullYear(), d.getMonth() + 1];
};

/** Les valeurs MENSUELLES d'un KPI sur les derniers mois complets : la moyenne de l'équipe (échantillon borné) et, si elle est visée, celle d'une personne. */
async function historiqueMensuel(c: ChargeurBriques, d: DefLue, echantillon: readonly PersonneKpi[], pourId: string | null, mois: readonly Fenetre[], libelles: readonly string[]): Promise<HistoriqueCible> {
  const equipe: (number | null)[] = [];
  const personne: (number | null)[] = [];
  for (const f of mois) {
    const ids = [...new Set([...echantillon.map((p) => p.userId), ...(pourId ? [pourId] : [])])];
    const vals = new Map<string, number | null>();
    for (let i = 0; i < ids.length; i += 6) {
      await Promise.all(ids.slice(i, i + 6).map(async (u) => { vals.set(u, (await calculerMesuree(c, d, u, f)).valeur); }));
    }
    const eq = echantillon.map((p) => vals.get(p.userId) ?? null).filter((v): v is number => v !== null);
    equipe.push(eq.length ? Math.round((eq.reduce((s, v) => s + v, 0) / eq.length) * 10) / 10 : null);
    personne.push(pourId ? vals.get(pourId) ?? null : null);
  }
  return { mois: [...libelles], equipe, personne: pourId ? personne : null };
}

/** Une cible proposée pour chaque KPI à cible vide : (historique mensuel par KPI) → Luna, ou null. */
export type ChoisirCibles = (entrees: (EntreeCible | null)[]) => Promise<{ cibles: (CibleLuna | null)[]; note: string | null }>;

export async function apercuDefinitions(
  user: SessionUser,
  defs: readonly DefinitionKpi[],
  opts: { pour?: string | null; cibler?: ChoisirCibles } = {},
): Promise<ApercuKpi> {
  const { equipe } = await faitsKpi(user);
  const personnes = equipe.slice(0, 40);
  const maintenant = new Date();
  const debut = new Date(maintenant.getFullYear(), maintenant.getMonth() - 3, 1);
  const fin = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);
  const f: Fenetre = { cle: "apercu", frequence: "TRIMESTRIELLE", debut, fin, mois: 3, libelle: "3 derniers mois" };
  const c = new ChargeurBriques(maintenant);
  const lues: DefLue[] = defs.map((def, i) => ({ id: `apercu-${i}`, famille: `apercu-${i}`, version: 1, portee: "EQUIPE", createdById: user.id, def }));
  const calculables = lues.filter((d) => d.def.nature === "CALCULE" || d.def.nature === "RATIO");
  const valeurs = new Map<string, number | null>();
  for (const d of calculables) {
    for (const p of personnes) valeurs.set(cleV(d.id, p.userId), (await calculerMesuree(c, d, p.userId, f)).valeur);
  }
  // La règle fixe (repli) : à mi-chemin entre la moyenne et le meilleur de l'équipe, sur la fenêtre de trois mois.
  const regles = lues.map((d) => {
    const additive = d.def.numerateur ? BRIQUE_PAR_ID[d.def.numerateur.brique].additive && d.def.nature === "CALCULE" : false;
    const hist = personnes.map((p) => { const v = valeurs.get(cleV(d.id, p.userId)); return v === undefined || v === null ? null : additive ? v / 3 : v; });
    return calculables.includes(d) ? { prop: proposerCible(hist, d.def.sens, d.def.unite), nb: hist.filter((v) => v !== null).length } : { prop: null, nb: 0 };
  });
  // Luna : l'historique MENSUEL de 3 à 6 mois de l'équipe et de la personne visée, pour les seuls KPI sans cible.
  let luna: (CibleLuna | null)[] = lues.map(() => null);
  let statsLuna: (ReturnType<typeof statistiquesCible> | null)[] = lues.map(() => null);
  let noteCibles: string | null = null;
  const aCibler = lues.map((d, i) => (calculables.includes(d) && d.def.cible === null ? i : -1)).filter((i) => i >= 0);
  if (opts.cibler && aCibler.length > 0) {
    try {
      const pourId = opts.pour && equipe.some((p) => p.userId === opts.pour) ? opts.pour : null;
      const echantillon = personnes.slice(0, 25);
      const mois = Array.from({ length: MOIS_HISTORIQUE_MAX }, (_, k) => fenetre(clePeriode("MENSUELLE", ...anneeMois(maintenant, MOIS_HISTORIQUE_MAX - k)))!);
      const libelles = mois.map((f, k) => `M-${MOIS_HISTORIQUE_MAX - k} · ${f.debut.toLocaleDateString("fr-FR", { month: "long" })}`);
      const entrees: (EntreeCible | null)[] = [];
      for (let i = 0; i < lues.length; i++) {
        const d = lues[i]!;
        entrees.push(aCibler.includes(i)
          ? { nom: d.def.nom, unite: d.def.unite, sens: d.def.sens, periode: d.def.periode, historique: await historiqueMensuel(c, d, echantillon, pourId, mois, libelles) }
          : null);
      }
      const r = await opts.cibler(entrees);
      luna = r.cibles; noteCibles = r.note;
      statsLuna = entrees.map((e) => (e ? statistiquesCible(e.historique, e.sens) : null));
    } catch (e) {
      console.error("[kpi] cibles Luna", e);
      noteCibles = "L'historique mensuel n'a pas pu être lu : la cible suit la règle fixe.";
    }
  }
  const colonnes = lues.map((d, i) => {
    const l = luna[i] ?? null;
    const { prop, nb } = regles[i]!;
    const cibleProposee = d.def.cible ?? l?.cible ?? prop?.cible ?? null;
    return {
      nom: d.def.nom, unite: d.def.unite, cibleProposee,
      moyenne: l ? statsLuna[i]?.moyenneEquipe ?? null : prop?.moyenne ?? null,
      meilleur: l ? statsLuna[i]?.meilleurMoisEquipe ?? null : prop?.meilleur ?? null,
      justification: d.def.cible !== null ? null : l ? l.justification : prop ? justificationDeLaRegle(prop.moyenne, prop.meilleur, d.def.sens, nb) : null,
      parLuna: l !== null,
    };
  });
  return {
    colonnes,
    periodes: [`${debut.toLocaleDateString("fr-FR", { month: "long" })} → ${new Date(fin.getTime() - 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`],
    noteCibles,
    lignes: personnes.map((p) => ({
      nom: p.nom,
      valeurs: lues.map((d, i) => {
        if (!calculables.includes(d)) return { affichage: "—", couleur: "m" as const };
        const v = valeurs.get(cleV(d.id, p.userId)) ?? null;
        const cible = colonnes[i]!.cibleProposee;
        const additive = d.def.numerateur ? BRIQUE_PAR_ID[d.def.numerateur.brique].additive && d.def.nature === "CALCULE" : false;
        const c3 = cible === null ? null : additive ? cible * 3 : cible;
        return { affichage: afficherValeur(v, d.def.unite), couleur: couleur(v, seuilsEffectifs({ cible: c3, seuilVert: null, seuilOrange: null, sens: d.def.sens, nature: d.def.nature }), d.def.sens) };
      }),
    })),
  };
}

// ── Écrire une définition (nouvelle famille, nouvelle version) ──────────────────────────────

export function colonnesDefinition(def: DefinitionKpi) {
  return {
    nom: def.nom, description: def.description, nature: def.nature, briques: briquesDe(def), params: paramsDe(def) as unknown as Prisma.InputJsonValue,
    unite: def.unite, sens: def.sens, cible: def.cible, seuilVert: def.seuilVert, seuilOrange: def.seuilOrange, periode: def.periode,
    grille: (def.grille ?? undefined) as Prisma.InputJsonValue | undefined,
  };
}

export const nouvelleFamille = (): string => `kpi-${randomUUID()}`;

// ── Le battement quotidien ───────────────────────────────────────────────────────────────────

let dernierJour: string | null = null;

/**
 * LE RAFRAÎCHISSEMENT QUOTIDIEN — une fois par jour et par processus : la période COURANTE (mois, et la fenêtre de
 * chaque fréquence de revue choisie) de toutes les personnes qui ont au moins un KPI calculé. Borné, et silencieux
 * en cas d'échec : le calcul à la demande reste là.
 */
export async function rafraichirKpiSiDu(maintenant: Date = new Date()): Promise<void> {
  const jour = maintenant.toISOString().slice(0, 10);
  if (dernierJour === jour) return;
  dernierJour = jour;
  const defs = (await definitionsActives()).filter((d) => d.def.nature === "CALCULE" || d.def.nature === "RATIO");
  if (defs.length === 0) return;
  const assignations = await prisma.kpiAssignment.findMany({ select: { cible: true, role: true, userId: true, managerUserId: true } });
  const roles = [...new Set(assignations.flatMap((a) => (a.cible === "ROLE" && a.role ? [a.role] : [])))] as UserRole[];
  const directs = assignations.flatMap((a) => (a.cible === "PERSONNE" && a.userId ? [a.userId] : []));
  const managers = [...new Set(assignations.flatMap((a) => (a.cible === "EQUIPE" && a.managerUserId ? [a.managerUserId] : [])))];
  const parRole = roles.length ? await prisma.user.findMany({ where: { isActive: true, role: { in: roles } }, select: { id: true } }) : [];
  const ids = new Set([...parRole.map((u) => u.id), ...directs]);
  if (managers.length) {
    const { employees, departments } = await loadReportingLine();
    const mes = await prisma.employee.findMany({ where: { userId: { in: managers } }, select: { id: true } });
    for (const m of mes) for (const n of flattenTree(subtreeOf(m.id, employees, departments))) if (n.userId) ids.add(n.userId);
  }
  const personnes = await prisma.user.findMany({ where: { id: { in: [...ids] }, isActive: true }, select: { id: true, role: true } });
  const emp = await prisma.employee.findMany({ where: { userId: { in: personnes.map((p) => p.id) } }, select: { id: true, userId: true } });
  const empDe = new Map(emp.map((e) => [e.userId, e.id]));
  const pk: PersonneKpi[] = personnes.slice(0, 500).map((p) => ({ userId: p.id, employeeId: empDe.get(p.id) ?? null, nom: "", poste: null, role: p.role, depth: 0 }));
  const affect = await affectations(pk);
  const frequences = new Set<FrequenceRevue>(["MENSUELLE", ...(await prisma.kpiReviewSetting.findMany({ select: { frequence: true } })).map((s) => s.frequence as FrequenceRevue).filter((x) => (FREQUENCES as readonly string[]).includes(x))]);
  const chargeur = new ChargeurBriques(maintenant);
  for (const freq of frequences) {
    const f = fenetreCourante(freq, maintenant);
    for (const p of pk) {
      const siennes = defs.filter((d) => affect.get(p.userId)?.has(d.famille));
      if (siennes.length) await valeursPour(siennes, [p.userId], f, { chargeur, force: true });
    }
  }
}
