import { prisma } from "@/lib/prisma";
import { MODULES, userCan, type Module } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/labels";
import { corrigerContenu, lireContenu, signatureContenu, type ContenuRecette } from "../domaine/contenu";
import { correspondance } from "../domaine/correspondance";
import { estResponsable, peutDesigner, statutDeLaRecette, SEUIL_OCCURRENCES_MIN, type Designation, type StatutRecette, type StatutVersion } from "../domaine/etats";
import { ecartsALaDemande, ecartsAuPlan, phraseValidation, planDeLaRecette, signaturePlan, type PlanRecette, type Validation } from "../domaine/plan";
import { decrireCircuit, estProcessus, LIBELLE_PROCESSUS, type Processus } from "../domaine/processus";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RECETTES — LIRE, TRANCHER, SERVIR (J10, décision 0028).
 *
 *   • LIRE : une recette ne se montre qu'à qui voit le module de son circuit (`voitLeCircuit`) ;
 *   • TRANCHER : seul le responsable du processus valide, corrige (une version de plus), rejette ou retire ;
 *   • SERVIR : `recettePour` ne rend que la version VALIDÉE — jamais une proposition — et note l'usage (plan proposé),
 *     dont l'acceptation se LIT ensuite au travail lancé (même plan, approuvé = accepté sans retouche).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULES_CONNUS = new Set<string>(MODULES);
/** Ce que la règle de visibilité lit d'une personne (une session suffit : le menu n'a pas de `CurrentUser`). */
type Lecteur = Pick<CurrentUser, "id" | "role" | "secondaryRole" | "access">;
const libelleRole = (r: string) => ROLE_LABELS[r] ?? r;

/** La règle de visibilité d'une recette : voir au moins un des modules qui servent les dossiers de son circuit. */
export function voitLeCircuit(user: Lecteur, circuit: string): boolean {
  const d = decrireCircuit(circuit);
  if (!d) return false;
  if (d.superAdminSeul) return user.role === "SUPER_ADMIN";
  const modules = d.modules.filter((m) => MODULES_CONNUS.has(m));
  const portes = modules.length ? modules : circuit.startsWith("VAL:") ? ["VALIDATIONS"] : [];
  return portes.some((m) => userCan(user, m as Module, "VIEW"));
}

export async function designationsParProcessus(): Promise<Map<string, Designation & { seuilOccurrences: number | null }>> {
  const lignes = await prisma.recetteResponsable.findMany({ select: { processus: true, role: true, userId: true, seuilOccurrences: true } });
  return new Map(lignes.map((l) => [l.processus, { role: l.role, userId: l.userId, seuilOccurrences: l.seuilOccurrences }]));
}

/** Les noms des personnes (validateurs, auteurs, responsables désignés) — pour l'écran, jamais pour le contenu d'une recette. */
async function nomsDe(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const voulus = [...new Set(ids)].filter((x): x is string => typeof x === "string" && x.length > 0);
  const lignes = voulus.length ? await prisma.user.findMany({ where: { id: { in: voulus } }, select: { id: true, name: true } }) : [];
  return lignes.reduce((m, u) => m.set(u.id, u.name), new Map<string, string>());
}

/**
 * L'ENTRÉE « RECETTES » DU MENU : la Direction (qui désigne), un responsable désigné, ou qui voit au moins un circuit
 * ayant une recette. Une entrée qui ouvrirait une page vide n'est pas envoyée.
 */
export async function voitDesRecettes(user: Lecteur): Promise<boolean> {
  if (peutDesigner(user)) return true;
  const designations = await designationsParProcessus();
  if ([...designations.values()].some((d) => estResponsable(user, d))) return true;
  const lignes = await prisma.recette.findMany({ where: { statut: { in: ["PROPOSEE", "VALIDEE"] } }, select: { circuit: true }, take: 500 });
  return lignes.some((r) => voitLeCircuit(user, r.circuit));
}

// ───────────────────────────── Statistiques d'usage ─────────────────────────────

export interface StatsUsage {
  utilisations: number;
  lances: number;
  sansRetouche: number;
  retouches: number;
  /** sans retouche / (sans retouche + retouchés) — nul tant qu'aucun plan n'a été tranché. */
  taux: number | null;
  dernieresRetouches: string[][];
}

/** Deux heures après la proposition : un travail lancé par la même personne est celui de la recette. */
const FENETRE_MS = 2 * 3_600_000;

/**
 * L'ACCEPTATION SE LIT AU TRAVAIL : pour chaque usage, le premier travail de la même personne lancé dans les deux
 * heures. Même signature de plan et plan approuvé → accepté sans retouche ; autre plan → retouché (les écarts sont
 * dits) ; pas encore approuvé → ni l'un ni l'autre.
 */
export async function statsUsages(recetteIds: readonly string[]): Promise<Map<string, StatsUsage>> {
  const out = new Map<string, StatsUsage>();
  if (!recetteIds.length) return out;
  const usages = await prisma.recetteUsage.findMany({
    where: { recetteId: { in: [...recetteIds] } }, orderBy: { createdAt: "asc" },
    select: { id: true, recetteId: true, versionId: true, userId: true, intention: true, planSignature: true, createdAt: true },
  });
  const debut = usages[0]?.createdAt;
  const travaux = debut ? await prisma.mission.findMany({
    where: { kind: "TRAVAIL", principalId: { in: [...new Set(usages.map((u) => u.userId))] }, createdAt: { gte: debut } },
    orderBy: { createdAt: "asc" }, select: { id: true, principalId: true, createdAt: true, carnet: true, planApprouveLe: true },
  }) : [];
  const versions = new Map((await prisma.recetteVersion.findMany({ where: { id: { in: [...new Set(usages.map((u) => u.versionId))] } }, select: { id: true, numero: true, contenu: true, decideLe: true } })).map((v) => [v.id, v]));
  const pris = new Set<string>();
  for (const id of recetteIds) out.set(id, { utilisations: 0, lances: 0, sansRetouche: 0, retouches: 0, taux: null, dernieresRetouches: [] });
  for (const u of usages) {
    const s = out.get(u.recetteId)!;
    s.utilisations++;
    const planDe = (m: (typeof travaux)[number]) => (m.carnet as { plan?: { etapes?: unknown } } | null)?.plan ?? null;
    const fenetre = travaux.filter((m) => !pris.has(m.id) && m.principalId === u.userId && m.createdAt >= u.createdAt && m.createdAt.getTime() - u.createdAt.getTime() <= FENETRE_MS);
    if (!fenetre.length) continue;
    const meme = (m: (typeof travaux)[number]) => !!u.planSignature && signaturePlan(planDe(m)) === u.planSignature;
    // Le plan de la recette APPROUVÉ tel quel l'emporte ; sinon un plan retouché ; sinon le plan de la recette en attente.
    const t = fenetre.find((m) => meme(m) && m.planApprouveLe) ?? fenetre.find((m) => !meme(m)) ?? fenetre[0];
    pris.add(t.id);
    s.lances++;
    const plan = planDe(t);
    if (meme(t)) {
      if (t.planApprouveLe) s.sansRetouche++;
    } else {
      s.retouches++;
      const v = versions.get(u.versionId);
      const c = v ? lireContenu(v.contenu) : null;
      const gabarit = c && v ? planDeLaRecette(c, { version: v.numero, par: "", le: (v.decideLe ?? new Date()).toISOString() }, u.intention) : null;
      if (gabarit && plan) s.dernieresRetouches = [ecartsAuPlan(gabarit, plan), ...s.dernieresRetouches].slice(0, 3);
    }
  }
  for (const s of out.values()) s.taux = s.sansRetouche + s.retouches > 0 ? s.sansRetouche / (s.sansRetouche + s.retouches) : null;
  return out;
}

// ───────────────────────────── L'écran ─────────────────────────────

export interface VersionLue {
  id: string;
  numero: number;
  statut: StatutVersion;
  origine: string;
  occurrences: number;
  auteur: string | null;
  decidePar: string | null;
  decideLe: string | null;
  motif: string | null;
  contenu: ContenuRecette | null;
}

export interface RecetteLue {
  id: string;
  circuit: string;
  processus: Processus;
  libelleProcessus: string;
  titre: string;
  statut: StatutRecette;
  validee: VersionLue | null;
  /** La proposition en attente (la plus récente), s'il y en a une. */
  proposition: VersionLue | null;
  versions: VersionLue[];
  responsable: boolean;
  stats: StatsUsage;
}

export interface EcranRecettes {
  recettes: RecetteLue[];
  designations: { processus: Processus; libelle: string; role: string | null; libelleRole: string | null; personne: string | null; seuil: number | null; moi: boolean }[];
  peutDesigner: boolean;
}

export async function lireEcranRecettes(user: CurrentUser): Promise<EcranRecettes> {
  const [lignes, designations] = await Promise.all([
    prisma.recette.findMany({
      orderBy: [{ processus: "asc" }, { titre: "asc" }],
      select: {
        id: true, circuit: true, processus: true, titre: true, statut: true, versionValideeId: true,
        versions: { orderBy: { numero: "desc" }, select: { id: true, numero: true, statut: true, origine: true, occurrences: true, auteurId: true, decideParId: true, decideLe: true, motif: true, contenu: true } },
      },
    }),
    designationsParProcessus(),
  ]);
  const visibles = lignes.filter((r) => estProcessus(r.processus) && voitLeCircuit(user, r.circuit));
  const noms = await nomsDe([...visibles.flatMap((r) => r.versions.flatMap((v) => [v.auteurId, v.decideParId])), ...[...designations.values()].map((d) => d.userId)]);
  const stats = await statsUsages(visibles.map((r) => r.id));
  const lire = (v: (typeof lignes)[number]["versions"][number]): VersionLue => ({
    id: v.id, numero: v.numero, statut: v.statut as StatutVersion, origine: v.origine, occurrences: v.occurrences,
    auteur: v.auteurId ? noms.get(v.auteurId) ?? null : null, decidePar: v.decideParId ? noms.get(v.decideParId) ?? null : null,
    decideLe: v.decideLe?.toISOString() ?? null, motif: v.motif, contenu: lireContenu(v.contenu),
  });
  return {
    recettes: visibles.map((r) => {
      const versions = r.versions.map(lire);
      const processus = r.processus as Processus;
      return {
        id: r.id, circuit: r.circuit, processus, libelleProcessus: LIBELLE_PROCESSUS[processus], titre: r.titre, statut: r.statut as StatutRecette,
        validee: versions.find((v) => v.id === r.versionValideeId) ?? null,
        proposition: versions.find((v) => v.statut === "PROPOSEE") ?? null,
        versions,
        responsable: estResponsable(user, designations.get(processus)),
        stats: stats.get(r.id)!,
      };
    }),
    designations: (Object.keys(LIBELLE_PROCESSUS) as Processus[]).map((p) => {
      const d = designations.get(p);
      return {
        processus: p, libelle: LIBELLE_PROCESSUS[p], role: d?.role ?? null, libelleRole: d?.role ? libelleRole(d.role) : null,
        personne: d?.userId ? noms.get(d.userId) ?? null : null, seuil: d?.seuilOccurrences ?? null, moi: estResponsable(user, d),
      };
    }),
    peutDesigner: peutDesigner(user),
  };
}

// ───────────────────────────── Trancher ─────────────────────────────

export type Issue = { ok: true; message: string; recetteId: string } | { ok: false; erreur: string };

async function versionPourResponsable(user: CurrentUser, versionId: string): Promise<{ erreur: string } | { v: NonNullable<Awaited<ReturnType<typeof lireVersion>>> }> {
  const v = await lireVersion(versionId);
  if (!v || !voitLeCircuit(user, v.recette.circuit)) return { erreur: "Recette introuvable." };
  const designations = await designationsParProcessus();
  if (!estResponsable(user, designations.get(v.recette.processus))) {
    return { erreur: `Seul le responsable du processus « ${LIBELLE_PROCESSUS[v.recette.processus as Processus] ?? v.recette.processus} » tranche une recette — la Direction le désigne dans l'écran Recettes.` };
  }
  return { v };
}

function lireVersion(versionId: string) {
  return prisma.recetteVersion.findUnique({
    where: { id: versionId },
    select: { id: true, numero: true, statut: true, contenu: true, recetteId: true, recette: { select: { id: true, circuit: true, processus: true, statut: true } } },
  });
}

async function recalculerStatut(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], recetteId: string, retiree = false) {
  const versions = await tx.recetteVersion.findMany({ where: { recetteId }, select: { id: true, statut: true } });
  const validee = versions.find((x) => x.statut === "VALIDEE");
  await tx.recette.update({
    where: { id: recetteId },
    data: { statut: statutDeLaRecette(versions as { statut: StatutVersion }[], retiree), versionValideeId: retiree ? null : validee?.id ?? null },
  });
}

/** Valider une proposition telle qu'elle est : elle devient la version en usage ; l'ancienne est remplacée. */
export async function validerVersion(user: CurrentUser, versionId: string): Promise<Issue> {
  const r = await versionPourResponsable(user, versionId);
  if ("erreur" in r) return { ok: false, erreur: r.erreur };
  if (r.v.statut !== "PROPOSEE") return { ok: false, erreur: "Seule une proposition se valide." };
  await prisma.$transaction(async (tx) => {
    await tx.recetteVersion.updateMany({ where: { recetteId: r.v.recetteId, statut: { in: ["VALIDEE", "RETIREE"] } }, data: { statut: "REMPLACEE" } });
    await tx.recetteVersion.updateMany({ where: { recetteId: r.v.recetteId, statut: "PROPOSEE", numero: { lt: r.v.numero } }, data: { statut: "REMPLACEE" } });
    await tx.recetteVersion.update({ where: { id: r.v.id }, data: { statut: "VALIDEE", decideParId: user.id, decideLe: new Date() } });
    await recalculerStatut(tx, r.v.recetteId);
  });
  return { ok: true, message: `Version ${r.v.numero} validée : l'assistant s'en servira désormais.`, recetteId: r.v.recetteId };
}

/** Corriger puis valider : une VERSION DE PLUS, écrite par le responsable — la version d'origine reste lisible. */
export async function corrigerEtValider(user: CurrentUser, versionId: string, correction: unknown): Promise<Issue> {
  const r = await versionPourResponsable(user, versionId);
  if ("erreur" in r) return { ok: false, erreur: r.erreur };
  if (r.v.statut === "REMPLACEE" || r.v.statut === "RETIREE") return { ok: false, erreur: "Cette version n'est plus en cours : corrigez la plus récente." };
  const base = lireContenu(r.v.contenu);
  if (!base) return { ok: false, erreur: "Contenu illisible." };
  const c = corrigerContenu(base, correction);
  if (!c.ok) return { ok: false, erreur: c.fautes.join(" ") };
  const numero = await prisma.$transaction(async (tx) => {
    const max = await tx.recetteVersion.aggregate({ where: { recetteId: r.v.recetteId }, _max: { numero: true } });
    const n = (max._max.numero ?? 0) + 1;
    await tx.recetteVersion.updateMany({ where: { recetteId: r.v.recetteId, statut: { in: ["VALIDEE", "PROPOSEE", "RETIREE"] } }, data: { statut: "REMPLACEE" } });
    await tx.recetteVersion.create({
      data: {
        recetteId: r.v.recetteId, numero: n, statut: "VALIDEE", contenu: c.contenu as never, signature: signatureContenu(c.contenu),
        occurrences: c.contenu.observation.occurrences, origine: "CORRECTION", auteurId: user.id, decideParId: user.id, decideLe: new Date(),
      },
    });
    await tx.recette.update({ where: { id: r.v.recetteId }, data: { titre: c.contenu.titre } });
    await recalculerStatut(tx, r.v.recetteId);
    return n;
  });
  return { ok: true, message: `Version ${numero} (corrigée) validée.`, recetteId: r.v.recetteId };
}

export async function rejeterVersion(user: CurrentUser, versionId: string, motif: string): Promise<Issue> {
  const m = motif.trim().slice(0, 500);
  if (m.length < 3) return { ok: false, erreur: "Dites pourquoi : le motif guide la prochaine extraction." };
  const r = await versionPourResponsable(user, versionId);
  if ("erreur" in r) return { ok: false, erreur: r.erreur };
  if (r.v.statut !== "PROPOSEE") return { ok: false, erreur: "Seule une proposition se rejette." };
  await prisma.$transaction(async (tx) => {
    await tx.recetteVersion.update({ where: { id: r.v.id }, data: { statut: "REJETEE", decideParId: user.id, decideLe: new Date(), motif: m } });
    await recalculerStatut(tx, r.v.recetteId);
  });
  return { ok: true, message: `Version ${r.v.numero} rejetée.`, recetteId: r.v.recetteId };
}

/** Retirer une recette validée : l'assistant cesse de s'en servir, l'extraction ne la repropose pas. */
export async function retirerRecette(user: CurrentUser, versionId: string, motif: string): Promise<Issue> {
  const r = await versionPourResponsable(user, versionId);
  if ("erreur" in r) return { ok: false, erreur: r.erreur };
  if (r.v.statut !== "VALIDEE") return { ok: false, erreur: "Seule la version en usage se retire." };
  await prisma.$transaction(async (tx) => {
    await tx.recetteVersion.update({ where: { id: r.v.id }, data: { statut: "RETIREE", decideParId: user.id, decideLe: new Date(), motif: motif.trim().slice(0, 500) || null } });
    await tx.recetteVersion.updateMany({ where: { recetteId: r.v.recetteId, statut: "PROPOSEE" }, data: { statut: "REMPLACEE" } });
    await recalculerStatut(tx, r.v.recetteId, true);
  });
  return { ok: true, message: "Recette retirée : l'assistant ne la proposera plus.", recetteId: r.v.recetteId };
}

/** La Direction désigne le responsable d'un processus (un rôle, ou une personne) et règle son seuil d'occurrences. */
export async function designerResponsable(
  user: CurrentUser, processus: string, d: { role?: string | null; userId?: string | null; seuil?: number | null },
): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!peutDesigner(user)) return { ok: false, erreur: "Réservé à la Direction." };
  if (!estProcessus(processus)) return { ok: false, erreur: "Processus inconnu." };
  const role = d.role && d.role in ROLE_LABELS ? d.role : null;
  const userId = d.userId ? (await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true } }))?.id ?? null : null;
  if (d.userId && !userId) return { ok: false, erreur: "Personne introuvable." };
  const seuil = typeof d.seuil === "number" && Number.isFinite(d.seuil) ? Math.max(SEUIL_OCCURRENCES_MIN, Math.round(d.seuil)) : null;
  await prisma.recetteResponsable.upsert({
    where: { processus },
    create: { processus, role: role as never, userId, seuilOccurrences: seuil, designeParId: user.id },
    update: { role: role as never, userId, seuilOccurrences: seuil, designeParId: user.id },
  });
  return { ok: true };
}

// ───────────────────────────── Servir l'assistant ─────────────────────────────

export type ReponseRecette =
  | { statut: "AUCUNE"; note: string }
  | { statut: "AMBIGU"; question: string; candidates: { titre: string; processus: string }[] }
  | {
    statut: "RECETTE";
    selon: string;
    recette: Record<string, unknown>;
    plan: PlanRecette | null;
    ecarts: string[];
    consigne: string;
  };

/**
 * LA RECETTE D'UNE DEMANDE — la version VALIDÉE ou rien. `exclus` : les processus que la console ferme à cette
 * personne (familles). `plan` : un plan déjà préparé, à comparer au gabarit (les écarts sont rendus, rien n'est noté).
 */
export async function recettePour(user: CurrentUser, intention: string, opts: { exclus?: readonly string[]; plan?: unknown } = {}): Promise<ReponseRecette> {
  const exclus = new Set(opts.exclus ?? []);
  const lignes = await prisma.recette.findMany({
    where: { statut: "VALIDEE", versionValideeId: { not: null } },
    select: { id: true, circuit: true, processus: true, titre: true, versionValideeId: true },
  });
  const visibles = lignes.filter((r) => !exclus.has(r.processus) && voitLeCircuit(user, r.circuit));
  const versions = new Map((await prisma.recetteVersion.findMany({
    where: { id: { in: visibles.map((r) => r.versionValideeId!) }, statut: "VALIDEE" },
    select: { id: true, recetteId: true, numero: true, contenu: true, decideParId: true, decideLe: true },
  })).map((v) => [v.recetteId, v]));
  const candidates = visibles.flatMap((r) => {
    const v = versions.get(r.id);
    const c = v ? lireContenu(v.contenu) : null;
    return v && c ? [{ r, v, c }] : [];
  });
  const corr = correspondance(intention, candidates.map(({ r, c }) => ({ id: r.id, titre: c.titre, motsCles: c.motsCles })));
  if (corr.verdict === "AUCUNE") {
    return { statut: "AUCUNE", note: "Aucune recette VALIDÉE ne correspond à cette demande : prépare le plan toi-même, sans dire qu'il vient d'une recette." };
  }
  if (corr.verdict === "AMBIGU") {
    const amb = candidates.filter((x) => corr.ids.includes(x.r.id));
    return {
      statut: "AMBIGU",
      question: `Plusieurs façons de faire correspondent : ${amb.map((x) => `« ${x.c.titre} »`).join(" ou ")} ? Pose la question, puis rappelle l'outil avec une intention plus précise.`,
      candidates: amb.map((x) => ({ titre: x.c.titre, processus: LIBELLE_PROCESSUS[x.r.processus as Processus] ?? x.r.processus })),
    };
  }
  const { r, v, c } = candidates.find((x) => x.r.id === corr.id)!;
  const par = (await nomsDe([v.decideParId])).get(v.decideParId ?? "") ?? "le responsable du processus";
  const validation: Validation = { version: v.numero, par, le: (v.decideLe ?? new Date()).toISOString() };
  const plan = planDeLaRecette(c, validation, intention);
  const ecarts = [...ecartsALaDemande(c, intention), ...(opts.plan && plan ? ecartsAuPlan(plan, opts.plan as { etapes?: unknown }) : [])];
  if (!opts.plan) {
    await prisma.recetteUsage.create({ data: { recetteId: r.id, versionId: v.id, userId: user.id, intention: intention.slice(0, 1000), planSignature: signaturePlan(plan) } });
  }
  return {
    statut: "RECETTE",
    selon: phraseValidation(c.titre, validation),
    recette: {
      titre: c.titre,
      processus: LIBELLE_PROCESSUS[r.processus as Processus],
      resume: c.resume,
      etapes: c.etapes.map((e) => ({
        etape: e.libelle, valide: e.validateurs.map(libelleRole).join(" ou ") || null, condition: e.condition,
        duree_mediane_jours: e.dureeMedianeJours === null ? null : Math.round(e.dureeMedianeJours * 10) / 10, note: e.note ?? null,
      })),
      pieces_habituelles: c.pieces.map((p) => p.nature),
      decision_finale: c.validationFinale ? `${c.validationFinale.libelle}${c.validationFinale.validateurs.length ? ` (${c.validationFinale.validateurs.map(libelleRole).join(" ou ")})` : ""}` : null,
      seuils: c.seuils.map((s) => s.texte),
      duree_mediane_jours: c.duree.medianeJours === null ? null : Math.round(c.duree.medianeJours * 10) / 10,
      pieges: c.pieges.map((p) => p.texte),
      tiree_de: `${c.observation.occurrences} dossiers réels (${c.observation.du} → ${c.observation.au})`,
      note_du_responsable: c.note ?? null,
    },
    plan,
    ecarts,
    consigne: plan
      ? "Propose CE plan tel quel : lancer_un_travail avec le `titre`, l'`objectif` et les `etapes` du `plan`, inchangés ; dis d'où il vient avec la phrase `selon`. Signale chaque écart de la liste `ecarts` ; ne retouche le plan que si la personne le demande, et dis ce que tu changes."
      : "Cette recette n'a pas de plan de travail : décris les étapes et cite la phrase `selon`. Signale chaque écart.",
  };
}
