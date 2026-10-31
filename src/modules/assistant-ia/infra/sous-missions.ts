import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { sansBloquer } from "@/lib/journal";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import {
  annulerTravail, demarrerDOffice, enfantsVivants, lireCarnet, planSansGeste, proposerTravail, signatureTableau, tableauDesTravaux,
  type MissionTableau, type PersonaTravaux,
} from "./travaux";
import { deposerSynthese } from "./fil/service";
import { outilLancerUnTravail, type OutilTravail } from "@/platform/ia/travaux/outil";
import { genererTexte } from "./generer";
import { auNomDe } from "./consommation";
import { cleDeTitre, extraitDuLivrable, phraseSynthese, reglageDOffice, statutFini, type IssueSousMission } from "../domaine/sous-missions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SOUS-MISSIONS (K3, décision 0033) — « quand une tâche est longue, il la fait en arrière-plan et je continue de
 * discuter avec lui ; autant de sous-missions qu'il faut ; leurs résultats reviennent dans la conversation ».
 *
 *   • L'OUTIL, par tour : chaque appel de `lancer_un_travail` est une sous-mission DE PLUS — sauf `remplace` (l'id d'un
 *     plan de CE tour) ou un titre identique à un plan de ce tour (le garde-fou de « un tour, un plan » : le modèle qui
 *     reformule ne laisse plus cinq doublons). `parent` range la sous-mission sous un travail existant de la personne.
 *   • DÉMARRER D'OFFICE : un plan SANS GESTE (lecture, analyse, livrable) part sans clic quand la personne l'a réglé
 *     (préférence) — défaut de la console (rôle, personne), sinon OUI pour le Super Admin, NON pour les autres.
 *   • LE RETOUR : les sous-missions lancées par un tour sont gardées sur ce tour (`AssistantIaTour.travaux`, la carte
 *     qui se met à jour). Quand la DERNIÈRE se termine, une réponse de SYNTHÈSE s'écrit dans la conversation (unique par
 *     tour : `syntheseDe`), et la personne est notifiée. Rattrapage par la tâche `assistant.sous-missions`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La personne fait-elle démarrer d'office ses plans sans geste ? Préférence > console (personne, rôle) > défaut du rôle. */
export async function travauxDOfficePour(user: Pick<CurrentUser, "id" | "role">): Promise<boolean> {
  const [pref, parPersonne, parRole] = await Promise.all([
    prisma.assistantIaPreference.findUnique({ where: { userId: user.id }, select: { travauxDOffice: true } }),
    prisma.assistantIaAcces.findUnique({ where: { userId: user.id }, select: { travauxDOffice: true } }),
    prisma.assistantIaAcces.findUnique({ where: { role: user.role as never }, select: { travauxDOffice: true } }),
  ]);
  return reglageDOffice({ preference: pref?.travauxDOffice ?? null, personne: parPersonne?.travauxDOffice ?? null, role: parRole?.travauxDOffice ?? null, superAdmin: user.role === "SUPER_ADMIN" });
}

/** La préférence de la personne (null = le défaut de la console), et ce défaut — pour l'écran des réglages. */
export async function lirePreferenceDOffice(user: Pick<CurrentUser, "id" | "role">): Promise<{ preference: boolean | null; effectif: boolean }> {
  const pref = await prisma.assistantIaPreference.findUnique({ where: { userId: user.id }, select: { travauxDOffice: true } });
  return { preference: pref?.travauxDOffice ?? null, effectif: await travauxDOfficePour(user) };
}

export async function reglerPreferenceDOffice(userId: string, valeur: boolean | null): Promise<void> {
  await prisma.assistantIaPreference.upsert({ where: { userId }, create: { userId, travauxDOffice: valeur }, update: { travauxDOffice: valeur } });
}

/**
 * L'OUTIL « lancer_un_travail » DU TOUR — `lances` reçoit les travaux lancés (la carte du tour). Construit à chaque tour
 * (`fil/tour.ts`) : la mémoire « ce tour » est la fermeture.
 */
export function outilSousMissionsPour(user: CurrentUser, persona: PersonaTravaux, lances: string[] = [], demarrage: "immediat" | "fin-du-tour" = "immediat"): OutilTravail {
  const duTour: { id: string; cle: string }[] = [];
  return outilLancerUnTravail(user.id, async (plan) => {
    const e = plan && typeof plan === "object" ? (plan as Record<string, unknown>) : {};
    const cle = cleDeTitre(e.titre);
    // REFORMULER ≠ LANCER UNE AUTRE : `remplace` explicite, ou le même titre qu'un plan de ce tour (le modèle qui « corrige »).
    const explicite = typeof e.remplace === "string" ? duTour.find((p) => p.id === e.remplace) : undefined;
    const cible = explicite ?? (cle ? duTour.find((p) => p.cle === cle) : undefined);
    const parentId = typeof e.parent === "string" && e.parent.trim() ? e.parent.trim().slice(0, 64) : null;
    const r = await proposerTravail(user.id, persona, plan, { origine: "assistant-ia:conversation", parentId });
    if (!r.ok) return r;
    if (cible) {
      await annulerTravail(cible.id, user.id);
      duTour.splice(duTour.indexOf(cible), 1);
      const i = lances.indexOf(cible.id);
      if (i >= 0) lances.splice(i, 1);
    }
    duTour.push({ id: r.travailId, cle });
    lances.push(r.travailId);
    // D'OFFICE — à la FIN DU TOUR dans la conversation (banc réel du 31/10 : le modèle qui reformule faisait tourner pour
    // rien des plans aussitôt remplacés) : le plan reste en attente le temps du tour, `demarrerSousMissionsDuTour` le lance.
    let demarre = false;
    if (planSansGeste(r.plan, r.gestes) && (await travauxDOfficePour(user))) {
      demarre = demarrage === "fin-du-tour" ? true : (await demarrerDOffice(r.travailId, user.id, persona)).ok;
    }
    return { ok: true, travailId: r.travailId, etapes: r.plan.etapes.length, gestes: r.gestes.map((g) => g.libelle), plafondUsd: r.plafondUsd, demarre, remplace: cible?.id ?? null };
  }, "LECTURE : le nom exact d'un de tes outils de lecture ; GESTE : le nom exact d'un de tes outils « preparer_… » / de relance / de rendez-vous.");
}

/**
 * LA FIN DU TOUR : les sous-missions du tour encore en attente, SANS GESTE, démarrent d'office (réglage relu) ; les autres
 * attendent l'accord de la personne (la carte du fil). Rend le nombre démarré.
 */
export async function demarrerSousMissionsDuTour(user: Pick<CurrentUser, "id" | "role">, ids: readonly string[], persona: PersonaTravaux): Promise<number> {
  if (!ids.length || !(await travauxDOfficePour(user))) return 0;
  let n = 0;
  for (const id of ids) if ((await demarrerDOffice(id, user.id, persona).catch(sansBloquer("sous-missions.demarrer", { ok: false as const, erreur: "" }))).ok) n += 1;
  return n;
}

// ─────────────────────────────── Le retour dans la conversation ───────────────────────────────

const CONSIGNE_SYNTHESE = "Tu es l'assistant d'Adventum Pharma. Plusieurs sous-missions lancées en arrière-plan viennent de se terminer. En français, en 3 à 6 phrases sobres, dis ce qu'elles ont trouvé ensemble et ce que la personne peut faire ensuite. N'invente rien : seulement ce qui est écrit ci-dessous. Pas de titre, pas de liste.";

const idsDe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * LA SYNTHÈSE des sous-missions d'un tour, quand la DERNIÈRE se termine. Idempotente (`syntheseDe` unique) : la fin
 * de chaque sous-mission, une annulation, et le rattrapage peuvent tous l'appeler — une seule réponse s'écrit.
 */
export async function conclureSousMissions(travailId: string): Promise<"ecrite" | "attente" | "rien"> {
  const tour = await prisma.assistantIaTour.findFirst({
    where: { role: "assistant", syntheseDe: null, travaux: { array_contains: [travailId] } },
    select: { id: true, filId: true, userId: true, travaux: true },
  });
  return tour ? conclureTour(tour) : "rien";
}

async function conclureTour(tour: { id: string; filId: string; userId: string; travaux: unknown }): Promise<"ecrite" | "attente" | "rien"> {
  const ids = idsDe(tour.travaux);
  if (!ids.length) return "rien";
  if (await prisma.assistantIaTour.count({ where: { syntheseDe: tour.id } })) return "rien";
  const ms = await prisma.mission.findMany({
    where: { id: { in: ids }, principalId: tour.userId, kind: "TRAVAIL" },
    select: { id: true, title: true, status: true, costUsd: true, carnet: true, startedAt: true, updatedAt: true },
  });
  if (ms.some((m) => !statutFini(m.status))) return "attente";
  if (!ms.length || ms.every((m) => m.status === "CANCELLED")) return "rien";
  const issues: IssueSousMission[] = ms.map((m) => {
    const c = lireCarnet(m.carnet);
    const livrable = c.livrables[c.livrables.length - 1];
    return {
      titre: m.title, statut: m.status, coutUsd: m.costUsd,
      extrait: censurerTexte(extraitDuLivrable(livrable?.contenu ?? c.trouvailles.slice(-3).map((t) => t.texte).join("\n"))).texte,
      document: livrable?.document ? { nom: livrable.document.nom, lien: livrable.document.lien } : null,
      dureeMs: m.startedAt ? m.updatedAt.getTime() - m.startedAt.getTime() : null,
    };
  });
  // EN BREF : une phrase de synthèse par le modèle rapide quand plusieurs ont abouti — un échec n'empêche pas la réponse.
  let enBref: string | null = null;
  const abouties = issues.filter((i) => i.statut === "COMPLETED" && i.extrait);
  if (abouties.length >= 2) {
    const texte = abouties.map((i) => `## ${i.titre}\n${i.extrait}`).join("\n\n");
    const r = await auNomDe(tour.userId, () => genererTexte(CONSIGNE_SYNTHESE, texte, 45_000, { role: "rapide" }), tour.filId).catch(sansBloquer("sous-missions.synthese", null));
    if (r?.ok) enBref = r.texte.trim().slice(0, 1_500);
  }
  const contenu = phraseSynthese(issues, enBref);
  const faites = issues.filter((i) => i.statut === "COMPLETED").length;
  const ecrite = await deposerSynthese({
    syntheseDe: tour.id, filId: tour.filId, userId: tour.userId, contenu, travaux: ids,
    titre: `Assistant IA : ${issues.length > 1 ? `${faites}/${issues.length} sous-missions terminées` : `mission terminée — « ${issues[0]!.titre} »`}`,
    corps: (enBref ?? issues.map((i) => i.titre).join(" · ")).replace(/[#*_`>]/g, ""),
  });
  if (!ecrite) return "rien";
  return "ecrite";
}

/**
 * ANNULER UNE MISSION — et ses sous-missions encore vivantes ; si c'était la dernière d'un groupe lancé par un message,
 * la synthèse s'écrit dans la conversation (ce qui a abouti n'est pas perdu).
 */
export async function annulerMissionEtSousMissions(travailId: string, userId: string): Promise<{ ok: true; message: string } | { ok: false; erreur: string }> {
  const r = await annulerTravail(travailId, userId);
  if (!r.ok) return r;
  const enfants = await enfantsVivants(travailId, userId);
  for (const e of enfants) await annulerTravail(e, userId);
  for (const x of [travailId, ...enfants]) await conclureSousMissions(x);
  return { ok: true, message: enfants.length ? `Mission annulée, avec ${enfants.length} sous-mission${enfants.length > 1 ? "s" : ""}.` : "Mission annulée." };
}

/** LE RATTRAPAGE (tâche `assistant.sous-missions`) : une synthèse manquée (processus tué, annulation) s'écrit. */
export async function balayerSousMissions(maintenant = new Date(), limite = 30): Promise<{ ecrites: number }> {
  const tours = await prisma.assistantIaTour.findMany({
    where: { role: "assistant", syntheseDe: null, travaux: { not: Prisma.DbNull }, createdAt: { gte: new Date(maintenant.getTime() - 14 * 24 * 3600_000) } },
    select: { id: true, filId: true, userId: true, travaux: true },
    orderBy: { createdAt: "desc" },
    take: limite * 3,
  });
  const sans = new Set((await prisma.assistantIaTour.findMany({ where: { syntheseDe: { in: tours.map((t) => t.id) } }, select: { syntheseDe: true } })).map((t) => t.syntheseDe));
  let ecrites = 0;
  for (const t of tours.filter((x) => !sans.has(x.id)).slice(0, limite)) if ((await conclureTour(t).catch(sansBloquer("sous-missions.balayer", "rien" as const))) === "ecrite") ecrites += 1;
  return { ecrites };
}

// ─────────────────────────────── Le tableau de bord ───────────────────────────────

export interface MissionDuTableau extends MissionTableau {
  /** La conversation qui l'a lancée (et le tour) : les sous-missions lancées ensemble se regroupent. */
  conversation: { id: string; titre: string | null; tourId: string } | null;
}

export interface TableauDesMissions { missions: MissionDuTableau[]; enCours: number; aApprouver: number; signature: string; lu: string }

/** LE TABLEAU d'une personne, avec la conversation d'origine de chaque mission. */
export async function tableauDesMissions(userId: string, maintenant = new Date()): Promise<TableauDesMissions> {
  const [missions, signature] = await Promise.all([tableauDesTravaux(userId, maintenant), signatureTableau(userId, maintenant)]);
  const tours = missions.length ? await prisma.assistantIaTour.findMany({
    where: { userId, role: "assistant", syntheseDe: null, travaux: { not: Prisma.DbNull }, createdAt: { gte: new Date(maintenant.getTime() - 30 * 24 * 3600_000) } },
    select: { id: true, filId: true, travaux: true, fil: { select: { titre: true } } },
    orderBy: { createdAt: "desc" }, take: 200,
  }) : [];
  const origine = new Map<string, MissionDuTableau["conversation"]>();
  for (const t of tours) for (const id of idsDe(t.travaux)) if (!origine.has(id)) origine.set(id, { id: t.filId, titre: t.fil.titre, tourId: t.id });
  const avec = missions.map((m) => ({ ...m, conversation: origine.get(m.id) ?? null }));
  return {
    missions: avec, signature, lu: maintenant.toISOString(),
    enCours: avec.filter((m) => ["EN_COURS", "EN_ATTENTE", "BUDGET_HOLD"].includes(m.etat)).length,
    aApprouver: avec.filter((m) => m.etat === "A_APPROUVER").length,
  };
}

export { signatureTableau };
