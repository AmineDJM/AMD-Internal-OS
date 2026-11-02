"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { filtreDuPerimetre } from "@/lib/adventum/perimetre";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { aiModel, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { aiFeatureEnabled, logAiUsage } from "@/lib/ai-settings";
import { runAssistant, type ProposedAction } from "@/lib/assistant";
import { retrieve, toContext } from "@/lib/knowledge/retrieve";
import { createTaskRecord } from "@/lib/tasks/create-core";
import { genererBriefing } from "@/lib/brain-briefing";
import type { AutopilotPayload, RiskAction } from "@/lib/adventum/risks";
import type { HistoryEntry } from "@/lib/adventum/lifecycle-rules";
import { THRESHOLD_FIELDS, DEFAULT_THRESHOLDS } from "@/lib/adventum/risk-settings";
import { fdDate, fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";

const DENIED: ActionResult = { ok: false, error: "Réservé au Super Admin." };
const PAGE = "/adventum-brain";

type Acteur = Awaited<ReturnType<typeof requireUser>>;

/** Livre une relance (personne nommée, sinon rôle). `true` si quelqu'un a été prévenu. */
async function livrerRelance(p: Extract<AutopilotPayload, { kind: "notify" }>): Promise<boolean> {
  const title = p.title?.trim();
  if (!title) return false;
  if (p.userId) {
    const u = await prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, isActive: true } });
    if (u?.isActive) { await notifyUser({ userId: u.id, type: "GENERIC", title, body: (p.body ?? "").trim(), link: p.link }); return true; }
  }
  if (p.role) { await notifyRoles([p.role], { type: "GENERIC", title, body: (p.body ?? "").trim(), link: p.link }); return true; }
  return false;
}

/** Crée la tâche par le CŒUR canonique (statut de demande, notifications, audit). */
async function creerTache(user: Acteur, p: Extract<AutopilotPayload, { kind: "task" }>, extra: { description?: string | null; assigneeId?: string | null } = {}): Promise<{ id: string; assignedToId: string } | null> {
  const title = p.title?.trim();
  if (!title) return null;
  let assignedToId = user.id;
  const voulu = extra.assigneeId ?? p.assigneeId;
  if (voulu) {
    const u = await prisma.user.findUnique({ where: { id: voulu }, select: { id: true, isActive: true } });
    if (u?.isActive) assignedToId = u.id;
  }
  const priority = (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).includes(p.priority as never) ? p.priority! : "HIGH";
  const t = await createTaskRecord(user.id, { title, description: extra.description ?? null, assignedToId, priority, module: p.module ?? "Adventum Brain" }, { module: "Adventum Brain", suffix: " — via Adventum Brain" });
  return { id: t.id, assignedToId };
}

/**
 * Autopilot — exécute une action PROPOSÉE après confirmation. Ne crée que des objets existants (Tâche par le
 * cœur canonique, Notification) : aucun nouveau workflow. Toujours ré-autorisé (Super Admin) et journalisé.
 */
export async function runAutopilot(payload: AutopilotPayload): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return DENIED;

  if (payload.kind === "task") {
    const t = await creerTache(user, payload);
    if (!t) return { ok: false, error: "Intitulé de tâche manquant." };
    revalidatePath("/mon-espace");
    return { ok: true, id: t.id };
  }
  if (payload.kind === "notify") {
    if (!payload.title?.trim()) return { ok: false, error: "Titre de notification manquant." };
    if (!(await livrerRelance(payload))) return { ok: false, error: "Destinataire introuvable." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Adventum Brain", summary: `Relance via Autopilot : ${payload.title}` });
    return { ok: true };
  }
  return { ok: false, error: "Action inconnue." };
}

// ───────────────────────────── La vie d'un risque ─────────────────────────────

const gestesDe = (detail: unknown): RiskAction[] => {
  const a = (detail as { actions?: unknown } | null)?.actions;
  return Array.isArray(a) ? (a as RiskAction[]) : [];
};
const histoireDe = (h: unknown): HistoryEntry[] => (Array.isArray(h) ? (h as HistoryEntry[]) : []);

/**
 * UN GESTE SUR UN RISQUE — `geste` ∈ agir | prendre | relancer | ignorer | resoudre.
 *
 *   • agir      : le geste RECOMMANDÉ (le premier proposé par le détecteur) — une tâche ⇒ « prendre », une relance ⇒ « relancer » ;
 *   • prendre   : une tâche est créée pour la personne choisie (`assigneeId`) ; le risque passe « pris en charge » ;
 *   • relancer  : la personne qui tient l'étape (ou celle qui a la tâche) reçoit une notification ;
 *   • ignorer   : jusqu'au `jusquau`, avec un `motif` — il revient seul à cette date s'il est toujours là ;
 *   • resoudre  : marqué résolu (`motif` facultatif) — il revient s'il est encore vu le lendemain.
 */
export async function agirSurRisque(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // HORS SUPER ADMIN (Direction, 08/10) : qui a « Modifier » sur Adventum Brain agit sur les risques de SON périmètre —
  // la même règle que la lecture (`adventum/perimetre.ts`), relue ci-dessous sur le risque visé.
  const superAdmin = user.role === "SUPER_ADMIN";
  if (!superAdmin && !userCan(user, "ADVENTUM_BRAIN", "UPDATE")) return DENIED;
  const riskId = fdStr(formData, "riskId");
  let geste = fdStr(formData, "geste");
  const assigneeId = fdStr(formData, "assigneeId");
  const jusquau = fdDate(formData, "jusquau");
  const motif = fdStr(formData, "motif");
  if (!riskId || !geste) return { ok: false, error: "Geste incomplet." };

  const risk = await prisma.brainRisk.findUnique({ where: { id: riskId } });
  if (!risk || !filtreDuPerimetre(superAdmin)({ category: risk.category, module: risk.module })) return { ok: false, error: "Ce risque n'existe plus." };
  const gestes = gestesDe(risk.detail);
  const tache = gestes.find((a) => a.payload?.kind === "task")?.payload as Extract<AutopilotPayload, { kind: "task" }> | undefined;
  const relance = gestes.find((a) => a.payload?.kind === "notify")?.payload as Extract<AutopilotPayload, { kind: "notify" }> | undefined;
  if (geste === "agir") {
    const premier = gestes.find((a) => a.payload)?.payload;
    if (!premier) return { ok: false, error: "Aucun geste proposé pour ce risque : prenez-le en charge." };
    geste = premier.kind === "task" ? "prendre" : "relancer";
  }

  const at = new Date();
  const entree = (kind: HistoryEntry["kind"], note?: string | null): Prisma.InputJsonValue =>
    [...histoireDe(risk.history), { at: at.toISOString(), kind, by: user.name ?? null, note: note ?? null }] as unknown as Prisma.InputJsonValue;
  const auditer = (summary: string) => recordAudit({ actorId: user.id, action: "UPDATE", module: "Adventum Brain", entityId: risk.id, summary: `${summary} — ${risk.title} (${risk.object})` });

  if (geste === "prendre") {
    if (risk.status === "RESOLU") return { ok: false, error: "Ce risque est déjà résolu." };
    const description = [risk.recommendation, ...((risk.detail as { evidence?: string[] } | null)?.evidence ?? [])].filter(Boolean).join("\n");
    const t = await creerTache(user, tache ?? { kind: "task", title: `${risk.title} — ${risk.object}`, priority: risk.level === "critical" ? "CRITICAL" : "HIGH", module: risk.module }, { description, assigneeId });
    if (!t) return { ok: false, error: "La tâche n'a pas pu être créée." };
    const nom = (await prisma.user.findUnique({ where: { id: t.assignedToId }, select: { name: true } }))?.name ?? null;
    await prisma.brainRisk.update({ where: { id: risk.id }, data: { status: "PRIS_EN_CHARGE", assigneeId: t.assignedToId, taskId: t.id, snoozedUntil: null, history: entree("pris_en_charge", nom ? `Tâche pour ${nom}` : null) } });
    await auditer(`Risque pris en charge${nom ? ` (tâche pour ${nom})` : ""}`);
  } else if (geste === "relancer") {
    let ok = relance ? await livrerRelance(relance) : false;
    if (!ok && risk.assigneeId) {
      await notifyUser({ userId: risk.assigneeId, type: "GENERIC", title: "Relance (Adventum Brain)", body: `${risk.title} — ${risk.object}`, link: risk.href ?? undefined });
      ok = true;
    }
    if (!ok) return { ok: false, error: "Personne à relancer : prenez le risque en charge pour nommer quelqu'un." };
    await prisma.brainRisk.update({ where: { id: risk.id }, data: { history: entree("relance", relance?.title ?? null) } });
    await auditer("Relance envoyée");
  } else if (geste === "ignorer") {
    if (!jusquau || jusquau.getTime() <= at.getTime()) return { ok: false, error: "Choisissez une date à venir." };
    if (!motif) return { ok: false, error: "Le motif est obligatoire." };
    await prisma.brainRisk.update({ where: { id: risk.id }, data: { status: "IGNORE", snoozedUntil: jusquau, note: motif, history: entree("ignore", `${motif} (jusqu'au ${jusquau.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })})`) } });
    await auditer(`Risque ignoré jusqu'au ${jusquau.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })} : ${motif}`);
  } else if (geste === "resoudre") {
    await prisma.brainRisk.update({ where: { id: risk.id }, data: { status: "RESOLU", resolvedAt: at, resolvedAuto: false, snoozedUntil: null, note: motif ?? risk.note, history: entree("resolu", motif) } });
    await auditer(`Risque marqué résolu${motif ? ` : ${motif}` : ""}`);
  } else {
    return { ok: false, error: "Geste inconnu." };
  }
  revalidatePath(PAGE);
  return { ok: true };
}

// ───────────────────────────── Le briefing ─────────────────────────────

/** « Régénérer » le briefing du jour (le modèle, sinon les règles). */
export async function regenererBriefing(): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return DENIED;
  const r = await genererBriefing({ userId: user.id });
  if (!r.ok) return { ok: false, error: r.error };
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Adventum Brain", summary: `Briefing du matin régénéré (${r.source === "ia" ? "modèle" : "règles"})` });
  revalidatePath(PAGE);
  return { ok: true, message: r.source === "ia" ? undefined : "Briefing écrit à partir des règles (modèle indisponible)." };
}

// ───────────────────────────── Demander ─────────────────────────────

export interface BrainSource { label: string; href: string | null }
export interface BrainAnswer {
  ok: boolean;
  reply: string;
  sources: BrainSource[];
  proposals: ProposedAction[];
  error?: string;
}

function lienDeSource(sourceType: string, sourceId: string): string | null {
  if (sourceType === "drive_file") return `/drive?node=${sourceId}`;
  return null;
}

/**
 * LA QUESTION LIBRE — l'assistant (mêmes outils de lecture, mêmes gardes), ANCRÉ dans la base de connaissance
 * de la plateforme (documents indexés) et dans les risques ouverts. Les sources reviennent en puces ; une action
 * proposée revient en BOUTON qui passe par la confirmation canonique de l'assistant (`executeAssistantAction`) —
 * elle ne se perd plus. La question et sa réponse sont gardées pour l'Historique.
 */
export async function askBrain(question: string): Promise<BrainAnswer> {
  const vide = (error: string): BrainAnswer => ({ ok: false, reply: "", sources: [], proposals: [], error });
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return vide("Réservé au Super Admin.");
  const q = (question ?? "").trim().slice(0, 2000);
  if (!q) return vide("Question vide.");
  if (!(await aiFeatureEnabled("brain"))) return vide("Adventum Brain (IA) est désactivé dans le Centre de contrôle IA.");

  // 1. Les documents — le Super Admin voit tout ; l'identité entre quand même dans la clé de cache.
  const docs = await retrieve({ question: q, force: true, limit: 5, scopeKey: user.id }, async (items) => new Set(items.map((i) => i.itemId))).catch(sansBloquer("adventum-actions.askBrain.retrieve", null));
  const items = docs?.hits.length
    ? await prisma.knowledgeItem.findMany({ where: { id: { in: docs.hits.map((h) => h.itemId) } }, select: { id: true, sourceType: true, sourceId: true, title: true } })
    : [];
  const parItem = new Map(items.map((i) => [i.id, i]));
  // 2. Les risques ouverts.
  const risques = await prisma.brainRisk.findMany({
    where: { status: { in: ["NOUVEAU", "PRIS_EN_CHARGE"] } }, orderBy: { lastSeenAt: "desc" }, take: 25,
    select: { title: true, object: true, module: true, level: true, owner: true, href: true },
  });

  const contexte = [
    docs && docs.hits.length ? `Documents indexés de la plateforme (extraits numérotés) :\n${toContext(docs, 900)}` : "",
    risques.length ? `Risques ouverts détectés par Adventum Brain :\n${risques.map((r) => `- [${r.level}] ${r.module} — ${r.title} : ${r.object} (chez ${r.owner})`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const message = contexte ? `${q}\n\n---\nContexte fourni par Adventum Brain (à citer s'il sert, à ignorer sinon) :\n${contexte}` : q;

  const t0 = Date.now();
  const r = await runAssistant(user, [{ role: "user", content: message }]);
  await logAiUsage({
    feature: "brain", userId: user.id, model: aiModel(), ok: r.ok, latencyMs: Date.now() - t0, errorCode: r.ok ? null : r.error ?? "error",
    turnId: r.turn?.turnId ?? null, llmCalls: r.turn?.llmCalls ?? null, inputTokens: r.turn?.inputTokens ?? null, outputTokens: r.turn?.outputTokens ?? null, costUsd: r.turn?.costUsd ?? null,
  });
  if (!r.configured) return vide(phraseIaNonConfiguree(cleModeleRequise(), "Adventum Brain"));

  const reply = (r.reply ?? "").trim() || (r.proposal ? "J'ai préparé une action à confirmer." : "Pas de réponse.");
  const sources: BrainSource[] = [];
  for (const h of docs?.hits ?? []) {
    const it = parItem.get(h.itemId);
    const label = [h.title ?? it?.title ?? "Document", h.label ?? h.locator].filter(Boolean).join(" · ");
    if (!sources.some((s) => s.label === label)) sources.push({ label, href: it ? lienDeSource(it.sourceType, it.sourceId) : null });
  }
  const bas = reply.toLowerCase();
  for (const x of risques) {
    if (x.object && x.object.length > 3 && bas.includes(x.object.toLowerCase())) sources.push({ label: `${x.module} · ${x.object}`, href: x.href });
  }
  const proposals = r.proposals?.length ? r.proposals : r.proposal ? [r.proposal] : [];

  await prisma.brainQuestion.create({
    data: {
      userId: user.id, question: q, answer: reply, ok: r.ok,
      sources: sources.slice(0, 10) as unknown as Prisma.InputJsonValue,
      proposals: proposals.map((p) => ({ title: p.title, fields: p.fields })) as unknown as Prisma.InputJsonValue,
    },
  }).catch((e) => console.error("[brain] question non gardée", e));

  return { ok: r.ok, reply, sources: sources.slice(0, 10), proposals, error: r.ok ? undefined : r.error };
}

// ───────────────────────────── Réglages ─────────────────────────────

/** Réglage des seuils du Risk Radar — Super Admin. Valeurs bornées (min/max). */
export async function updateRiskThresholds(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return DENIED;
  const data: Record<string, number> = {};
  for (const f of THRESHOLD_FIELDS) {
    let v = Math.round(fdNum(formData, f.key) ?? DEFAULT_THRESHOLDS[f.key]);
    if (Number.isNaN(v)) v = DEFAULT_THRESHOLDS[f.key];
    data[f.key] = Math.max(f.min, Math.min(f.max, v));
  }
  await prisma.riskSetting.upsert({
    where: { id: "global" },
    create: { id: "global", ...data, updatedById: user.id },
    update: { ...data, updatedById: user.id },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Adventum Brain", summary: "Réglage des seuils du Risk Radar" });
  revalidatePath(PAGE);
  return { ok: true };
}
