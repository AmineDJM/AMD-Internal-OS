import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { callLuna, lunaConfigured, lunaModel, type LunaResult } from "@/lib/openai-luna";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage } from "@/lib/ai-settings";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import { chargerLiensAdPro } from "@/lib/queries/ad-pro-medecins";
import {
  CONSIGNE_INFLUENCE, SCHEMA_INFLUENCE, TEXTE_MAX, enteteRapport, lireReponseInfluence, rapportPorteur, texteEnvoye,
  type MentionLue, type RapportAnalyse,
} from "@/lib/influence/extraction";
import {
  chefsDuService, estPharmacien, indexerPraticiens, relationsStructurelles, resoudreNom,
  type IndexPraticiens, type MembreService, type Resolution,
} from "@/lib/influence/relations";
import { scoreInfluence, type EntreeScore } from "@/lib/influence/score";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GRAPHE D'INFLUENCE — l'analyse (Intelligence terrain, console d'administration, Super Admin seul).
 *
 * Vit en haut de `src/lib` (comme `voix-terrain-luna.ts`) : c'est ici qu'on parle au fournisseur. Consigne, schéma,
 * relecture, liens structurels et score sont PURS, dans `src/lib/influence/`.
 *
 * Une analyse :
 *   1. recalcule les liens STRUCTURELS (hiérarchie du service, pharmacie, co-orateurs) — sans Luna ;
 *   2. lit les rapports NOUVEAUX depuis le filigrane (rapports vocaux, puis comptes rendus écrits des visites), par lots ;
 *      un rapport qui ne nomme aucun confrère est sauté sans appel. Portes : interrupteur général → bascule
 *      (« influence », suit les rapports terrain) → clé → appel borné (25 s) → relecture stricte (citation MOT POUR MOT) →
 *      journal (`logAiUsage`). Un échec ARRÊTE la lecture sans avancer le filigrane : le lot sera relu ;
 *   3. rapproche les noms écrits de l'annuaire (SÛR / À VÉRIFIER) et range chaque mention en lien PROPOSÉ ;
 *   4. recalcule le score de chaque praticien et le met en cache.
 * Planifiée une fois par jour (`scheduled.ts`) et relançable à la main depuis la console.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "influence" as const;
const DELAI_MS = 25_000;
const LOT = 20;
const MAX_LOTS = 5;
const CLE_RAPPORTS = "influence:rapports";
const CLE_VISITES = "influence:visites";
export const CLE_EXECUTION = "influence:execution";

export interface BilanAnalyse {
  le: string;
  structurels: number;
  rapportsLus: number;
  rapportsEnvoyes: number;
  mentions: number;
  liensProposes: number;
  nonRapprochees: number;
  luna: "OK" | "INDISPONIBLE" | "ECHEC" | "RIEN_A_LIRE";
  resteALire: boolean;
  scores: number;
}

async function porteOuverte(): Promise<boolean> {
  try {
    if (await interrupteurIaCoupe()) return false;
    if (!(await aiFeatureEnabled(FONCTION))) return false;
    return lunaConfigured();
  } catch {
    return false;
  }
}

async function extraireParLuna(lot: readonly RapportAnalyse[], userId: string | null): Promise<MentionLue[] | null> {
  const user = lot.map((r) => `${enteteRapport(r)}\n${wrapUntrusted(texteEnvoye(r), { source: r.id, kind: "compte rendu de visite", maxChars: TEXTE_MAX })}`).join("\n\n");
  const t0 = Date.now();
  let r: LunaResult<unknown> | null = null;
  let panne = false;
  try {
    r = await Promise.race([
      callLuna<unknown>({ system: CONSIGNE_INFLUENCE, user: `COMPTES RENDUS (${lot.length}) :\n\n${user}`, jsonSchema: SCHEMA_INFLUENCE as unknown as { name: string; schema: Record<string, unknown> }, maxOutputTokens: 2000, model: lunaModel() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_MS)),
    ]);
  } catch {
    panne = true;
  }
  let data: unknown = r?.data;
  if (r?.ok && data === undefined) { try { data = JSON.parse(r.text); } catch { data = null; } }
  const lu = r?.ok ? lireReponseInfluence(data, lot) : null;
  await logAiUsage({
    feature: FONCTION, provider: "openai", model: lunaModel(), userId, ok: Boolean(lu),
    latencyMs: Date.now() - t0,
    errorCode: panne ? "exception" : r === null ? "timeout" : !r.ok ? (r.error ?? "error").slice(0, 120) : lu ? null : "invalid_json",
    llmCalls: 1, inputTokens: r?.usage.inputTokens ?? null, outputTokens: r?.usage.outputTokens ?? null,
    cachedInputTokens: r?.usage.cachedInputTokens ?? null, costUsd: r?.usage.costUsd ?? null,
  }).catch(sansBloquer("influence-luna.extraireParLuna.logAiUsage"));
  return lu;
}

// ─────────────────────────── Contexte commun (structure + score) ───────────────────────────

const PRIORITE_STATUT: Record<string, number> = { DECIDEUR: 4, INFLUENCEUR: 3, REFERENT: 2, PRESCRIPTEUR: 1 };

export interface ContexteInfluence {
  medecins: { id: string; name: string; lastName: string | null; firstName: string | null; title: string; specialite: string | null; serviceId: string | null; institutionId: string | null }[];
  statutDe: Map<string, string>;
  decideurs: Set<string>;
  serviceDe: Map<string, string | null>;
  membres: MembreService[];
  orateursParAction: Map<string, string[]>;
}

/** L'annuaire actif, les statuts de Segmentation, les décideurs de besoins et les orateurs — lus une fois. */
export async function chargerContexteInfluence(): Promise<ContexteInfluence> {
  const [docs, fiches, besoins, orateurs] = await Promise.all([
    prisma.medicalDoctor.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, lastName: true, firstName: true, title: true, specialty: true, specialtyRef: { select: { name: true } }, serviceId: true, institutionId: true },
    }),
    prisma.segmentationFiche.findMany({ where: { retireeLe: null, statut: { not: null } }, select: { doctorId: true, statut: true } }),
    prisma.besoinAnnuelService.findMany({ where: { decideurId: { not: null } }, select: { decideurId: true, serviceId: true } }),
    prisma.adProMedecin.findMany({ where: { role: "ORATEUR" }, select: { doctorId: true, entityType: true, entityId: true } }),
  ]);
  const statutDe = new Map<string, string>();
  for (const f of fiches) {
    const avant = statutDe.get(f.doctorId);
    if (f.statut && (!avant || (PRIORITE_STATUT[f.statut] ?? 0) > (PRIORITE_STATUT[avant] ?? 0))) statutDe.set(f.doctorId, f.statut);
  }
  const decideurs = new Set<string>();
  const serviceBesoin = new Map<string, string>();
  for (const b of besoins) {
    if (!b.decideurId) continue;
    decideurs.add(b.decideurId);
    if (b.serviceId && !serviceBesoin.has(b.decideurId)) serviceBesoin.set(b.decideurId, b.serviceId);
  }
  const medecins = docs.map((d) => ({
    id: d.id, name: d.name, lastName: d.lastName, firstName: d.firstName, title: String(d.title),
    specialite: d.specialtyRef?.name ?? d.specialty ?? null, serviceId: d.serviceId, institutionId: d.institutionId,
  }));
  // Le décideur d'un besoin de service EST de ce service, même si sa fiche ne le rattache à aucun.
  const serviceDe = new Map(medecins.map((m) => [m.id, m.serviceId ?? serviceBesoin.get(m.id) ?? null]));
  const membres: MembreService[] = medecins.map((m) => ({
    doctorId: m.id, serviceId: serviceDe.get(m.id) ?? null, grade: m.title, statut: statutDe.get(m.id) ?? null,
    decideurBesoin: decideurs.has(m.id), pharmacien: estPharmacien(m.title, m.specialite),
  }));
  const orateursParAction = new Map<string, string[]>();
  for (const o of orateurs) {
    const k = `${o.entityType}:${o.entityId}`;
    orateursParAction.set(k, [...(orateursParAction.get(k) ?? []), o.doctorId]);
  }
  return { medecins, statutDe, decideurs, serviceDe, membres, orateursParAction };
}

/** Les responsables de chaque service (pour « @chef »). */
function chefsParService(ctx: ContexteInfluence): Map<string, string[]> {
  const parService = new Map<string, MembreService[]>();
  for (const m of ctx.membres) if (m.serviceId) parService.set(m.serviceId, [...(parService.get(m.serviceId) ?? []), m]);
  return new Map([...parService].map(([s, l]) => [s, chefsDuService(l)]));
}

// ─────────────────────────── 1. Liens structurels ───────────────────────────

async function recalculerStructure(ctx: ContexteInfluence): Promise<number> {
  const liens = relationsStructurelles(ctx.membres, ctx.orateursParAction);
  const voulus = new Set(liens.map((l) => `${l.from}|${l.to}|${l.type}`));
  const existants = await prisma.praticienRelation.findMany({ select: { id: true, fromDoctorId: true, toDoctorId: true, type: true, source: true, statut: true } });
  const parCle = new Map(existants.map((e) => [`${e.fromDoctorId}|${e.toDoctorId}|${e.type}`, e]));
  // Un lien structurel qui ne tient plus (médecin parti du service, statut changé) disparaît ; les autres sources restent.
  const perimes = existants.filter((e) => e.source === "STRUCTURE" && !voulus.has(`${e.fromDoctorId}|${e.toDoctorId}|${e.type}`)).map((e) => e.id);
  if (perimes.length) await prisma.praticienRelation.deleteMany({ where: { id: { in: perimes } } });
  // Un lien que Luna avait PROPOSÉ et que la structure établit devient confirmé (l'humain n'a plus à trancher).
  const aConfirmer = liens.map((l) => parCle.get(`${l.from}|${l.to}|${l.type}`)).filter((e) => e && e.source !== "STRUCTURE" && e.statut === "PROPOSEE").map((e) => e!.id);
  if (aConfirmer.length) await prisma.praticienRelation.updateMany({ where: { id: { in: aConfirmer } }, data: { statut: "CONFIRMEE", decideLe: new Date() } });
  const nouveaux = liens.filter((l) => !parCle.has(`${l.from}|${l.to}|${l.type}`));
  for (let i = 0; i < nouveaux.length; i += 500) {
    await prisma.praticienRelation.createMany({
      data: nouveaux.slice(i, i + 500).map((l) => ({ fromDoctorId: l.from, toDoctorId: l.to, type: l.type, source: "STRUCTURE", confidence: 1, statut: "CONFIRMEE" })),
      skipDuplicates: true,
    });
  }
  return liens.length;
}

// ─────────────────────────── 2–3. Lecture des rapports ───────────────────────────

interface RapportLu extends RapportAnalyse { le: Date; idSource: string }

type Filigrane = { dernierLe: Date | null; dernierId: string | null };

async function lireFiligrane(cle: string): Promise<Filigrane> {
  const w = await prisma.analyseWatermark.findUnique({ where: { cle }, select: { dernierLe: true, dernierId: true } });
  return { dernierLe: w?.dernierLe ?? null, dernierId: w?.dernierId ?? null };
}

async function avancerFiligrane(cle: string, r: RapportLu): Promise<void> {
  await prisma.analyseWatermark.upsert({
    where: { cle }, update: { dernierLe: r.le, dernierId: r.idSource }, create: { cle, dernierLe: r.le, dernierId: r.idSource },
  });
}

const apres = (f: Filigrane) => (f.dernierLe
  ? { OR: [{ updatedAt: { gt: f.dernierLe } }, { updatedAt: f.dernierLe, id: { gt: f.dernierId ?? "" } }] }
  : {});

async function rapportsVocaux(f: Filigrane, n: number): Promise<RapportLu[]> {
  const rows = await prisma.fieldReport.findMany({
    where: { status: { not: "ARCHIVED" }, ...apres(f) }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: n,
    select: {
      id: true, updatedAt: true, summary: true, transcript: true, doctorId: true, doctorName: true, institution: true,
      doctor: { select: { name: true, institutionId: true, institutionRef: { select: { name: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id, idSource: r.id, le: r.updatedAt,
    texte: [...new Set([r.summary, r.transcript].map((t) => (t ?? "").trim()).filter(Boolean))].join("\n"),
    doctorId: r.doctorId, doctorNom: r.doctor?.name ?? r.doctorName ?? null,
    institutionId: r.doctor?.institutionId ?? null, institutionNom: r.doctor?.institutionRef?.name ?? r.institution ?? null,
  }));
}

async function comptesRendusEcrits(f: Filigrane, n: number): Promise<RapportLu[]> {
  const rows = await prisma.medicalVisit.findMany({
    where: { status: "COMPLETED", report: { not: null }, ...apres(f) }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: n,
    select: {
      id: true, updatedAt: true, report: true, doctorFeedback: true, doctorId: true,
      doctor: { select: { name: true, institutionId: true, institutionRef: { select: { name: true } } } },
    },
  });
  return rows.map((r) => ({
    id: `visite:${r.id}`, idSource: r.id, le: r.updatedAt,
    texte: [r.report, r.doctorFeedback].map((t) => (t ?? "").trim()).filter(Boolean).join("\n"),
    doctorId: r.doctorId, doctorNom: r.doctor?.name ?? null,
    institutionId: r.doctor?.institutionId ?? null, institutionNom: r.doctor?.institutionRef?.name ?? null,
  }));
}

function resoudre(nom: string, r: RapportAnalyse, index: IndexPraticiens, chefs: Map<string, string[]>, serviceDe: Map<string, string | null>): Resolution | null {
  const n = nom.trim().toLowerCase();
  if (n === "@visite") return r.doctorId ? { statut: "SUR", doctorId: r.doctorId } : null;
  if (n === "@chef") {
    const s = r.doctorId ? serviceDe.get(r.doctorId) : null;
    const c = s ? (chefs.get(s) ?? []).filter((id) => id !== r.doctorId) : [];
    return c.length === 1 ? { statut: "SUR", doctorId: c[0] } : null;
  }
  return resoudreNom(nom, index, r.institutionId);
}

async function rangerMentions(mentions: readonly MentionLue[], lot: readonly RapportAnalyse[], ctx: ContexteInfluence, index: IndexPraticiens, chefs: Map<string, string[]>): Promise<{ ranges: number; nonRapprochees: number }> {
  const parId = new Map(lot.map((r) => [r.id, r]));
  let ranges = 0, nonRapprochees = 0;
  for (const m of mentions) {
    const r = parId.get(m.rapportId);
    if (!r) continue;
    const de = resoudre(m.influenceur, r, index, chefs, ctx.serviceDe);
    const vers = resoudre(m.influence, r, index, chefs, ctx.serviceDe);
    const fromId = de?.doctorId ?? null;
    const toId = vers?.doctorId ?? null;
    if (!fromId || !toId || fromId === toId) { nonRapprochees++; continue; }
    const sur = de!.statut === "SUR" && vers!.statut === "SUR";
    const confidence = Math.round(m.confiance * (sur ? 1 : 0.6) * 100) / 100;
    // Un lien co-orateur / comité n'a pas de sens : rangé une fois, plus petit identifiant d'abord.
    const [a, b] = m.type === "CO_ORATEUR" || m.type === "COMITE" ? [fromId, toId].sort() : [fromId, toId];
    const existant = await prisma.praticienRelation.findUnique({
      where: { fromDoctorId_toDoctorId_type: { fromDoctorId: a, toDoctorId: b, type: m.type } },
      select: { id: true, statut: true, source: true, confidence: true },
    });
    if (!existant) {
      await prisma.praticienRelation.create({
        data: { fromDoctorId: a, toDoctorId: b, type: m.type, source: "LUNA", confidence, evidence: m.citation, reportId: m.rapportId, rapprochement: sur ? "SUR" : "A_VERIFIER", statut: "PROPOSEE" },
      });
      ranges++;
    } else if (existant.statut === "PROPOSEE" && existant.source === "LUNA" && confidence > existant.confidence) {
      // Une seconde mention plus nette renforce la proposition (et sa preuve devient la plus nette).
      await prisma.praticienRelation.update({ where: { id: existant.id }, data: { confidence, evidence: m.citation, reportId: m.rapportId, rapprochement: sur ? "SUR" : "A_VERIFIER" } });
    }
    // Confirmé ou rejeté : l'humain a tranché, Luna ne revient pas dessus.
  }
  return { ranges, nonRapprochees };
}

// ─────────────────────────── 4. Scores ───────────────────────────

/** Recalcule et met en cache le score de chaque praticien (seuls les scores > 0 sont gardés). Renvoie leur nombre. */
export async function recalculerScoresInfluence(ctxDonne?: ContexteInfluence): Promise<number> {
  const ctx = ctxDonne ?? (await chargerContexteInfluence());
  const depuis = new Date(Date.now() - 365 * 86_400_000);
  const moisDepuis = new Date(Date.UTC(depuis.getUTCFullYear(), depuis.getUTCMonth(), 1));
  const orateurIds = [...new Set([...ctx.orateursParAction.values()].flat())];
  const [relations, volumes, liensOrateurs] = await Promise.all([
    prisma.praticienRelation.findMany({ where: { statut: { not: "REJETEE" } }, select: { fromDoctorId: true, toDoctorId: true, source: true, statut: true, confidence: true } }),
    prisma.pchVenteLigne.groupBy({ by: ["institutionId"], where: { institutionId: { not: null }, mois: { gte: moisDepuis } }, _sum: { qteLivree: true } }),
    chargerLiensAdPro(orateurIds, depuis),
  ]);
  const volumeDe = new Map(volumes.map((v) => [v.institutionId!, v._sum.qteLivree ?? 0]));
  const orateurDe = new Map<string, { nom: string }[]>();
  for (const l of liensOrateurs) if (l.role === "ORATEUR") orateurDe.set(l.doctorId, [...(orateurDe.get(l.doctorId) ?? []), { nom: l.nom }]);
  const confirmees = new Map<string, number>();
  const proposees = new Map<string, number[]>();
  const reseau = new Map<string, Set<string>>();
  for (const r of relations) {
    for (const [x, y] of [[r.fromDoctorId, r.toDoctorId], [r.toDoctorId, r.fromDoctorId]] as const) {
      (reseau.get(x) ?? reseau.set(x, new Set()).get(x)!).add(y);
    }
    if (r.source === "STRUCTURE") continue; // la hiérarchie compte déjà comme rôle : pas deux fois
    if (r.statut === "CONFIRMEE") confirmees.set(r.fromDoctorId, (confirmees.get(r.fromDoctorId) ?? 0) + 1);
    else proposees.set(r.fromDoctorId, [...(proposees.get(r.fromDoctorId) ?? []), r.confidence]);
  }
  const effectifService = new Map<string, number>();
  for (const m of ctx.membres) if (m.serviceId) effectifService.set(m.serviceId, (effectifService.get(m.serviceId) ?? 0) + 1);

  const lignes: Prisma.InfluenceScoreCreateManyInput[] = [];
  const maintenant = new Date();
  for (const m of ctx.medecins) {
    const service = ctx.serviceDe.get(m.id) ?? null;
    const e: EntreeScore = {
      grade: m.title, statut: ctx.statutDe.get(m.id) ?? null, decideurBesoin: ctx.decideurs.has(m.id),
      nbCollegues: service ? Math.max(0, (effectifService.get(service) ?? 1) - 1) : 0,
      orateur: orateurDe.get(m.id) ?? [], citationsConfirmees: confirmees.get(m.id) ?? 0, citationsProposees: proposees.get(m.id) ?? [],
      volumeEtablissement: m.institutionId && volumeDe.has(m.institutionId) ? volumeDe.get(m.institutionId)! : null,
      tailleReseau: reseau.get(m.id)?.size ?? 0,
    };
    const s = scoreInfluence(e);
    if (s.score > 0) lignes.push({ doctorId: m.id, score: s.score, raisons: s.raisons as unknown as Prisma.InputJsonValue, computedAt: maintenant });
  }
  await prisma.$transaction(async (tx) => {
    await tx.influenceScore.deleteMany({});
    for (let i = 0; i < lignes.length; i += 1000) await tx.influenceScore.createMany({ data: lignes.slice(i, i + 1000) });
  }, { timeout: 60_000 });
  return lignes.length;
}

// ─────────────────────────── L'analyse ───────────────────────────

let enCours = false;

/** Une analyse complète (structure, nouveaux rapports par Luna, scores). Ne lève jamais : le bilan dit ce qui a manqué. */
export async function analyserInfluence(opts: { userId: string | null }): Promise<BilanAnalyse> {
  const bilan: BilanAnalyse = {
    le: new Date().toISOString(), structurels: 0, rapportsLus: 0, rapportsEnvoyes: 0, mentions: 0, liensProposes: 0,
    nonRapprochees: 0, luna: "RIEN_A_LIRE", resteALire: false, scores: 0,
  };
  if (enCours) return bilan;
  enCours = true;
  try {
    const ctx = await chargerContexteInfluence();
    bilan.structurels = await recalculerStructure(ctx);
    const index = indexerPraticiens(ctx.medecins);
    const chefs = chefsParService(ctx);
    const ouverte = await porteOuverte();
    let lotsRestants = MAX_LOTS;
    for (const [cle, lire] of [[CLE_RAPPORTS, rapportsVocaux], [CLE_VISITES, comptesRendusEcrits]] as const) {
      if (bilan.luna === "ECHEC") break;
      const f = await lireFiligrane(cle);
      const rapports = await lire(f, LOT * MAX_LOTS);
      if (rapports.length === LOT * MAX_LOTS) bilan.resteALire = true;
      for (let i = 0; i < rapports.length; i += LOT) {
        const lot = rapports.slice(i, i + LOT);
        const porteurs = lot.filter((r) => r.texte && rapportPorteur(r.texte));
        if (porteurs.length > 0) {
          if (!ouverte) { bilan.luna = "INDISPONIBLE"; bilan.resteALire = true; break; }
          if (lotsRestants <= 0) { bilan.resteALire = true; break; }
          lotsRestants--;
          bilan.rapportsEnvoyes += porteurs.length;
          const mentions = await extraireParLuna(porteurs, opts.userId);
          if (!mentions) { bilan.luna = "ECHEC"; bilan.resteALire = true; break; }
          bilan.luna = "OK";
          bilan.mentions += mentions.length;
          const r = await rangerMentions(mentions, porteurs, ctx, index, chefs);
          bilan.liensProposes += r.ranges;
          bilan.nonRapprochees += r.nonRapprochees;
        }
        bilan.rapportsLus += lot.length;
        await avancerFiligrane(cle, lot[lot.length - 1]);
      }
      if (bilan.luna === "INDISPONIBLE") break;
    }
    bilan.scores = await recalculerScoresInfluence(ctx);
  } catch (e) {
    console.error("[influence] analyse", e);
  } finally {
    enCours = false;
    await prisma.analyseWatermark.upsert({
      where: { cle: CLE_EXECUTION },
      update: { derniereExecution: new Date(), bilan: bilan as unknown as Prisma.InputJsonValue },
      create: { cle: CLE_EXECUTION, derniereExecution: new Date(), bilan: bilan as unknown as Prisma.InputJsonValue },
    }).catch(sansBloquer("influence-luna.analyserInfluence.analyseWatermark"));
  }
  return bilan;
}

/** Le passage planifié : une analyse par jour au plus (le filigrane fait qu'elle ne relit que le nouveau). */
export async function analyserInfluenceSiDu(maintenant = new Date()): Promise<void> {
  const w = await prisma.analyseWatermark.findUnique({ where: { cle: CLE_EXECUTION }, select: { derniereExecution: true } }).catch(sansBloquer("influence-luna.analyserInfluenceSiDu.analyseWatermark", null));
  const jour = (d: Date) => d.toISOString().slice(0, 10);
  if (w?.derniereExecution && jour(w.derniereExecution) === jour(maintenant)) return;
  await analyserInfluence({ userId: null });
}
