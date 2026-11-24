import { askModelJson } from "@/lib/models/gateway";
import type { ModelReply } from "@/lib/models/contract";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage, type AiUsageInput } from "@/lib/ai-settings";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { encadrantDuDelegue } from "@/lib/queries/equipe-delegue";
import {
  CONSIGNE_PV_VISITE, LIBELLE_PV, SCHEMA_PV_VISITE, appelleUnHumain, lireLecturePv, texteAAnalyser, type LecturePv,
} from "@/lib/sfe/rapport-visite";
import { lienRelireRapport, lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { ignoree, bilan, type BilanTexte, type TacheIgnoree } from "@/lib/taches-de-fond/executer";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPTE RENDU D'UNE VISITE LU PAR L'IA — la part SERVEUR (Visite médicale, Super Admin 11/2026) : la passerelle
 * unique (`askModelJson`), la relecture (`lireLecturePv`, pure), le journal (`logAiUsage`), puis les deux personnes à
 * prévenir. Hors de tout domaine, comme `natures-depenses-ia.ts` : un domaine ne parle pas aux fournisseurs.
 *
 * ── HORS DU CHEMIN CRITIQUE, PAR CONSTRUCTION ───────────────────────────────────────────────
 *
 * `rapporterVisite` et `ajouterVisiteImprevue` n'appellent RIEN ici : un rapport enregistré porte `analyseIaLe = null`,
 * et c'est la TÂCHE DE FOND (`terrain.pv-visites`, `scheduled.ts` — le mécanisme qui lit déjà les comptes rendus pour
 * le graphe d'influence) qui les reprend, quelques-uns par passage. Une IA lente, en panne ou coupée ne peut donc ni
 * ralentir ni faire échouer l'enregistrement d'un délégué : elle n'est pas sur son chemin.
 *
 * ── L'ORDRE DES PORTES ────────────────────────────────────────────────────────────────────
 *
 *   interrupteur général → bascule `visite_pv_detection` (COUPÉE par défaut) → clé → appel → relecture → journal.
 *   Fermé : la tâche s'abstient et ne touche à rien — rallumer reprend les rapports de la fenêtre.
 *
 * ── CE QUE L'IA NE FAIT JAMAIS ────────────────────────────────────────────────────────────
 *
 * Créer un cas de pharmacovigilance. Elle PRÉVIENT : le délégué (« Signaler », formulaire prérempli avec la visite) et
 * son superviseur (« à relire en priorité »). Un humain confirme toujours.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "visite_pv_detection" as const;
const SORTIE_MAX = 600;
/** Rapports lus par passage (une minute) : borné, pour qu'un retard de l'IA ne fasse pas une avalanche d'appels. */
export const LOT_PV_VISITES = 10;
/** Un rapport plus ancien n'est plus lu : allumer la bascule ne relit pas l'historique (et ne le facture pas). */
export const FENETRE_ANALYSE_JOURS = 7;
/** Après un échec de l'appel, le rapport se relit au plus tôt une heure plus tard. */
export const REESSAI_MS = 60 * 60_000;

export interface DependancesPvVisite {
  coupee: () => Promise<boolean>;
  fonctionActive: () => Promise<boolean>;
  configure: () => boolean;
  cle: () => string | null;
  appeler: <T>(
    role: "worker",
    prompt: string,
    schema: { name: string; schema: Record<string, unknown> },
    opts: { system: string; maxOutputTokens: number; verbosity: "low" },
  ) => Promise<{ data: T | null; reply: ModelReply }>;
  journaliser: (u: AiUsageInput) => Promise<void>;
}

const REELLES: DependancesPvVisite = {
  coupee: () => interrupteurIaCoupe(),
  fonctionActive: () => aiFeatureEnabled(FONCTION),
  configure: () => aiConfigured(),
  cle: () => cleModeleRequise(),
  appeler: (role, prompt, schema, opts) => askModelJson(role, prompt, schema, opts),
  journaliser: (u) => logAiUsage(u),
};

export type LectureCompteRendu =
  | { ok: true; lecture: LecturePv }
  | { ok: false; raison: "NON_CONFIGUREE" | "ECHEC" | "INEXPLOITABLE" };

/** UN COMPTE RENDU, UN APPEL : prompt sous `wrapUntrusted`, relecture stricte, journal — ne lève jamais. */
export async function lireCompteRendu(
  e: { visitId: string; texte: string; userId: string | null },
  deps: DependancesPvVisite = REELLES,
): Promise<LectureCompteRendu> {
  const prompt = [
    "Compte rendu de visite à lire (écrit par le délégué) :",
    "",
    wrapUntrusted(e.texte, { source: `visite ${e.visitId}`, kind: "compte rendu de visite médicale", maxChars: e.texte.length + 64 }),
    "",
    "Classe ce compte rendu dans la forme imposée.",
  ].join("\n");

  const t0 = Date.now();
  let resultat: { data: unknown; reply: ModelReply } | null = null;
  let panne = false;
  try {
    resultat = await deps.appeler<unknown>("worker", prompt, SCHEMA_PV_VISITE as unknown as { name: string; schema: Record<string, unknown> }, {
      system: CONSIGNE_PV_VISITE, maxOutputTokens: SORTIE_MAX, verbosity: "low",
    });
  } catch {
    panne = true;
  }
  const reply = resultat?.reply ?? null;
  const usage = reply?.usage;
  const lecture = reply?.ok && resultat?.data != null ? lireLecturePv(resultat.data, e.texte) : null;
  const errorCode: string | null = panne ? "exception"
    : !reply?.ok ? (reply?.error ?? "error").slice(0, 120)
    : resultat?.data == null ? "invalid_json"
    : lecture === null ? "relecture"
    : null;

  // LA RELECTURE AVANT LE JOURNAL : une réponse hors forme est un échec de la fonction, pas un succès muet (§118.51).
  await deps.journaliser({
    feature: FONCTION,
    provider: usage?.provider ?? (deps.cle()?.startsWith("ANTHROPIC") ? "anthropic" : "openai"),
    model: usage?.model ?? null,
    userId: e.userId,
    ok: errorCode === null,
    latencyMs: Date.now() - t0,
    errorCode,
    llmCalls: 1,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    costUsd: usage?.costUsd ?? null,
  }).catch(sansBloquer("visite-pv-ia.lireCompteRendu.journaliser"));

  if (lecture) return { ok: true, lecture };
  if (reply && !reply.ok && !reply.configured) return { ok: false, raison: "NON_CONFIGUREE" };
  return { ok: false, raison: panne || !reply?.ok ? "ECHEC" : "INEXPLOITABLE" };
}

interface VisiteLue {
  id: string;
  date: Date;
  delegateId: string | null;
  doctorId: string | null;
  doctor: { name: string } | null;
  delegate: { name: string } | null;
  _count: { casPharmacovigilance: number };
}

/** PRÉVENIR — le délégué (s'il n'a pas déjà signalé depuis cette visite) et son encadrant. Best-effort, ne lève pas. */
async function prevenir(v: VisiteLue, l: LecturePv): Promise<void> {
  const jour = v.date.toLocaleDateString("fr-FR");
  const qui = v.doctor?.name ?? "praticien non précisé";
  const citation = l.extrait ? ` : « ${l.extrait} »` : "";
  if (v.delegateId && v._count.casPharmacovigilance === 0) {
    await notifyUser({
      userId: v.delegateId, type: "GENERIC",
      title: "Votre compte rendu évoque peut-être un effet indésirable — Signaler",
      body: `Visite du ${jour} — ${qui}${citation}. Si c'est un cas, signalez-le : le formulaire arrive prérempli. Sinon, rien à faire.`,
      link: lienSignalerPv(v.doctorId, v.id),
    }).catch(sansBloquer("visite-pv-ia.prevenir.delegue"));
  }
  const encadrant = v.delegateId ? await encadrantDuDelegue(v.delegateId).catch(sansBloquer("visite-pv-ia.prevenir.encadrant", null)) : null;
  if (encadrant && encadrant !== v.delegateId) {
    await notifyUser({
      userId: encadrant, type: "GENERIC",
      title: `Rapport à relire en priorité — ${v.delegate?.name ?? "un délégué"} (${LIBELLE_PV[l.pv].toLowerCase()})`,
      body: `Visite du ${jour} — ${qui}. ${l.raison}${citation}`,
      link: lienRelireRapport(v.id),
    }).catch(sansBloquer("visite-pv-ia.prevenir.encadrant"));
  }
}

/**
 * LA TÂCHE DE FOND — les comptes rendus récents que l'IA n'a pas lus (ou dont la lecture a échoué il y a plus d'une
 * heure), quelques-uns par passage. Le résultat s'écrit SOUS CONDITION : si le délégué a corrigé son compte rendu entre
 * la lecture et l'écriture, la lecture (devenue fausse) est jetée — le passage suivant relira le nouveau texte.
 */
export async function analyserComptesRendusEnAttente(
  /** `delegues` borne le balayage à ces délégués (un banc, un rattrapage ciblé) ; absent, toute la fenêtre. */
  o: { maintenant?: Date; max?: number; deps?: DependancesPvVisite; delegues?: readonly string[] } = {},
): Promise<TacheIgnoree | BilanTexte> {
  const deps = o.deps ?? REELLES;
  const maintenant = o.maintenant ?? new Date();
  if (await deps.coupee()) return ignoree("IA coupée par l'interrupteur général");
  if (!(await deps.fonctionActive())) return ignoree("bascule « Visite médicale — pharmacovigilance » coupée");
  if (!deps.configure()) return ignoree("IA non configurée sur ce serveur");

  const visites = await prisma.medicalVisit.findMany({
    where: {
      status: "COMPLETED", report: { not: null },
      ...(o.delegues ? { delegateId: { in: [...o.delegues] } } : {}),
      date: { gte: new Date(maintenant.getTime() - FENETRE_ANALYSE_JOURS * 86_400_000) },
      OR: [{ analyseIaLe: null }, { pvIa: null, analyseIaLe: { lt: new Date(maintenant.getTime() - REESSAI_MS) } }],
    },
    orderBy: { date: "desc" },
    take: o.max ?? LOT_PV_VISITES,
    select: {
      id: true, date: true, delegateId: true, doctorId: true, report: true, doctorFeedback: true, followUpActions: true,
      doctor: { select: { name: true } }, delegate: { select: { name: true } },
      _count: { select: { casPharmacovigilance: true } },
    },
  });

  let lues = 0, signalees = 0, echecs = 0;
  for (const v of visites) {
    const texte = texteAAnalyser(v);
    const r = await lireCompteRendu({ visitId: v.id, texte, userId: v.delegateId }, deps);
    if (!r.ok) {
      echecs += 1;
      // L'échec se date : le rapport se relit dans une heure, pas à chaque minute.
      await prisma.medicalVisit.updateMany({ where: { id: v.id, report: v.report }, data: { analyseIaLe: maintenant, pvIa: null } })
        .catch(sansBloquer("visite-pv-ia.analyser.echec"));
      if (r.raison === "NON_CONFIGUREE") break;
      continue;
    }
    const l = r.lecture;
    const ecrit = await prisma.medicalVisit.updateMany({
      where: { id: v.id, report: v.report },
      data: { pvIa: l.pv, pvIaRaison: l.raison, pvIaExtrait: l.extrait, prioriteIa: l.priorite, analyseIaLe: maintenant },
    }).catch(sansBloquer("visite-pv-ia.analyser.ecrire", { count: 0 }));
    if (ecrit.count === 0) continue;
    lues += 1;
    if (appelleUnHumain(l.pv)) {
      signalees += 1;
      await prevenir(v, l);
    }
  }
  return bilan(`${visites.length} examiné(s), ${lues} lu(s), ${signalees} à signaler, ${echecs} échec(s)`);
}
