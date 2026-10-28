/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MEETING INTELLIGENCE, côté plateforme (mandat 4 §32) — le brief avant réunion à TROIS niveaux.
 *
 *   LIGHT           contexte, ordre du jour, tâches ouvertes entre vous et chaque participant
 *   STANDARD        + notes de la dernière réunion, décisions liées, actions issues du dernier
 *                   compte rendu et leur sort, responsables, échéances, engagements suivis
 *   CHIEF_OF_STAFF  + historique des réunions, personnes (fonction, département), dossiers
 *                   concernés, décisions à obtenir, risques calculés, contradictions à trancher,
 *                   engagements en retard, questions ouvertes, suivi jusqu'à la réunion suivante
 *
 * Le niveau est APPRIS (Teach Adam, clé `niveauReunion`) ou, sans règle, déduit du rôle ; le
 * calcul est dans `lib/meetings/niveau.ts` (pur). Le niveau ne change pas ce qui est VRAI — il
 * change ce qu'on lit : un brief léger ne coûte pas les lectures d'un brief de chef de cabinet.
 *
 * Cloisonnement : seules VOS réunions (organisées ou sur invitation), les tâches qui vous lient
 * aux participants, VOS engagements et VOS décisions, VOS validations en attente, VOS missions.
 * Les risques et contradictions viennent de l'intelligence métier, lue sous VOS droits. Rien
 * n'est inventé : sans compte rendu, pas de « notes » ; sans signal, pas de « risque ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { reglesEnVigueurPour } from "@/platform/in-process/teach/store";
import { intelligenceComplete } from "@/platform/in-process/intelligence";
import { resoudreEntitesDe } from "@/lib/fabric";
import { auMoins, CONTENU_PAR_NIVEAU, LIBELLE_NIVEAU, niveauDepuisRegles, niveauParDefaut, NIVEAUX, type NiveauReunion } from "@/lib/meetings/niveau";
import type { Signal } from "@/lib/utils/signaux";
import { sansBloquer } from "@/lib/journal";
import { plier } from "@/lib/utils";

export { auMoins, CONTENU_PAR_NIVEAU, LIBELLE_NIVEAU, NIVEAUX, RANG_NIVEAU, type NiveauReunion } from "@/lib/meetings/niveau";

const JOUR = 86_400_000;

/** Date lisible à l'heure d'Alger (UTC+1), comme les autres outils exécutifs. */
const frDate = (d: Date | null | undefined): string | null => {
  if (!d) return null;
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
};

/** Les mots SIGNIFIANTS d'un titre (≥ 4 lettres, hors mots vides) — pour retrouver la réunion précédente du même sujet. */
function motsDe(titre: string): string[] {
  const vides = new Set(["point", "reunion", "avec", "pour", "dans", "sans", "sous", "cette", "banc", "comite", "hebdo", "mensuel", "suivi"]);
  return [...new Set(plier(titre).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((m) => m.length >= 4 && !vides.has(m)))].slice(0, 6);
}

const prenom = (nom: string): string => nom.trim().split(/\s+/)[0] ?? nom;

// ─────────────────────────── Le niveau : appris, sinon par défaut ───────────────────────────

export interface NiveauResolu { niveau: NiveauReunion; source: string; regleId?: string }

/** LE NIVEAU de la personne : la règle enseignée d'abord (clé `niveauReunion`, ou une phrase qui parle du brief), sinon le défaut du rôle. */
export async function niveauReunionPour(user: Pick<CurrentUser, "id" | "role">): Promise<NiveauResolu> {
  const { resolution } = await reglesEnVigueurPour(user.id).catch(sansBloquer("meetings.niveauReunionPour.reglesEnVigueurPour", { resolution: { enVigueur: [] as { params: Record<string, unknown> | null; statement: string; id: string }[] } }));
  const appris = niveauDepuisRegles(resolution.enVigueur.map((r) => ({ params: r.params, statement: r.statement, id: r.id })));
  if (appris) return { niveau: appris.niveau, source: `règle enseignée : « ${appris.statement.slice(0, 160)} »`, regleId: appris.id };
  const niveau = niveauParDefaut(user.role);
  return { niveau, source: `défaut du rôle ${user.role} (aucune règle enseignée — « pour mes réunions, je veux un brief de chef de cabinet » le change)` };
}

// ─────────────────────────── Le brief ───────────────────────────

export interface OptionsBrief {
  /** Titre (ou morceau du titre) ; sans lui, la PROCHAINE réunion. */
  titre?: string | null;
  /** Un niveau imposé pour ce brief seulement — sinon le niveau appris. */
  niveau?: NiveauReunion | null;
  maintenant?: Date;
}

export type ResultatBrief = { ok: true; brief: Record<string, unknown>; niveau: NiveauReunion; ms: number } | { ok: false; message: string };

const STATUTS_TACHE_OUVERTE = ["REQUESTED", "TODO", "IN_PROGRESS"] as const;

/** LE BRIEF : la réunion, puis ce que le niveau demande — et rien de plus. */
export async function composerBriefReunion(user: CurrentUser, opts: OptionsBrief = {}): Promise<ResultatBrief> {
  const t0 = Date.now();
  const maintenant = opts.maintenant ?? new Date();
  const q = (opts.titre ?? "").trim();
  const meetings = await prisma.meeting.findMany({
    where: {
      status: { in: ["SCHEDULED", "LIVE"] },
      OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }],
      ...(q ? { title: { contains: q, mode: "insensitive" } } : { scheduledAt: { gte: new Date(maintenant.getTime() - 3_600_000) } }),
    },
    orderBy: { scheduledAt: "asc" },
    take: 3,
    include: {
      organizer: { select: { id: true, name: true } },
      participants: { include: { user: { select: { id: true, name: true, title: true, department: { select: { name: true } } } } } },
    },
  });
  if (meetings.length === 0) {
    return { ok: false, message: q ? `Aucune réunion à venir dont le titre contient « ${q} » parmi les vôtres.` : "Aucune réunion à venir parmi les vôtres — rien à préparer." };
  }
  const resolu = opts.niveau && (NIVEAUX as readonly string[]).includes(opts.niveau) ? { niveau: opts.niveau, source: "niveau demandé pour ce brief" } : await niveauReunionPour(user);
  const niveau = resolu.niveau;
  const m = meetings[0];
  const autres = m.participants.filter((p) => p.userId !== user.id).slice(0, 8);
  const idsParticipants = autres.map((p) => p.userId);
  const nomsParticipants = autres.map((p) => p.user.name);

  // ── LIGHT : par participant, les tâches vivantes entre nous (dans les deux sens) ──
  // ── STANDARD : + les engagements suivis le concernant ──
  const participants = await Promise.all(autres.map(async (p) => {
    const [taches, engagements] = await Promise.all([
      prisma.task.findMany({
        where: { status: { in: [...STATUTS_TACHE_OUVERTE] }, OR: [{ createdById: user.id, assignedToId: p.userId }, { createdById: p.userId, assignedToId: user.id }] },
        orderBy: { createdAt: "desc" }, take: 5, select: { title: true, status: true, dueDate: true },
      }).catch(sansBloquer("meetings.composerBriefReunion.task", [])),
      auMoins(niveau, "STANDARD")
        ? prisma.executiveCommitment.findMany({
          where: { ownerId: user.id, status: { in: ["OPEN", "BROKEN"] }, OR: [{ who: { contains: p.user.name, mode: "insensitive" } }, { toWhom: { contains: p.user.name, mode: "insensitive" } }] },
          orderBy: { createdAt: "desc" }, take: 4, select: { who: true, what: true, status: true, dueAt: true },
        }).catch(sansBloquer("meetings.composerBriefReunion.executiveCommitment", []))
        : Promise.resolve([]),
    ]);
    return {
      nom: p.user.name,
      reponse: p.response,
      ...(auMoins(niveau, "CHIEF_OF_STAFF") ? { fonction: p.user.title ?? null, departement: p.user.department?.name ?? null } : {}),
      ...(taches.length > 0 ? { tachesEntreNous: taches.map((t) => ({ titre: t.title, statut: t.status, echeance: frDate(t.dueDate) })) } : {}),
      ...(engagements.length > 0 ? { engagements: engagements.map((c) => ({ qui: c.who, quoi: c.what, statut: c.status, echeance: frDate(c.dueAt), enRetard: !!(c.dueAt && c.dueAt < maintenant && c.status === "OPEN") })) } : {}),
    };
  }));

  const brief: Record<string, unknown> = {
    niveau, niveauLibelle: LIBELLE_NIVEAU[niveau], niveauSource: resolu.source,
    contenu: CONTENU_PAR_NIVEAU[niveau],
    reunion: {
      titre: m.title, quand: frDate(m.scheduledAt), statut: m.status, organisateur: m.organizer.name,
      ...(m.inPerson ? { lieu: m.location ?? "présentiel" } : {}),
      ...(m.description ? { ordreDuJour: m.description.slice(0, 600) } : {}),
    },
    participants,
  };

  // ── STANDARD : la dernière réunion du même sujet (notes, actions et leur sort), les décisions liées ──
  if (auMoins(niveau, "STANDARD")) {
    const mots = motsDe(m.title);
    const precedentes = await prisma.meeting.findMany({
      where: {
        status: "ENDED", id: { not: m.id },
        OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }],
        AND: [{ OR: [
          ...mots.map((mot) => ({ title: { contains: mot, mode: "insensitive" as const } })),
          ...(idsParticipants.length ? [{ participants: { some: { userId: { in: idsParticipants } } } }] : []),
        ] }],
      },
      orderBy: [{ endedAt: "desc" }, { scheduledAt: "desc" }],
      take: auMoins(niveau, "CHIEF_OF_STAFF") ? 3 : 1,
      include: {
        participants: { include: { user: { select: { name: true } } } },
        proposals: { include: { assignee: { select: { name: true } } } },
      },
    }).catch(sansBloquer("meetings.composerBriefReunion.meeting", []));
    const idsTaches = precedentes.flatMap((r) => r.proposals.map((p) => p.createdTaskId).filter((x): x is string => !!x));
    const tachesCreees = idsTaches.length
      ? await prisma.task.findMany({ where: { id: { in: idsTaches } }, select: { id: true, status: true, dueDate: true, assignedTo: { select: { name: true } } } }).catch(sansBloquer("meetings.composerBriefReunion.task", []))
      : [];
    const parTache = new Map(tachesCreees.map((t) => [t.id, t]));
    const vueReunion = (r: (typeof precedentes)[number]) => ({
      titre: r.title,
      quand: frDate(r.endedAt ?? r.scheduledAt),
      participants: r.participants.map((p) => p.user.name),
      ...(r.summary ? { notes: r.summary.slice(0, 1200) } : { notes: null, note: "aucun compte rendu enregistré pour cette réunion" }),
      actions: r.proposals.map((p) => {
        const t = p.createdTaskId ? parTache.get(p.createdTaskId) : undefined;
        const sort = p.status === "DISMISSED" ? "écartée" : p.status === "PROPOSED" ? "proposée, jamais tranchée" : t ? (t.status === "DONE" ? "faite" : t.status === "CANCELLED" ? "annulée" : `en cours (${t.status})`) : "acceptée";
        return { titre: p.title, responsable: t?.assignedTo?.name ?? p.assignee?.name ?? null, echeance: frDate(t?.dueDate ?? null), sort };
      }),
    });
    brief.derniereReunion = precedentes.length ? vueReunion(precedentes[0]) : null;
    if (!precedentes.length) brief.derniereReunionNote = "aucune réunion terminée sur ce sujet ou avec ces participants";
    if (auMoins(niveau, "CHIEF_OF_STAFF") && precedentes.length > 1) brief.historique = precedentes.slice(1).map(vueReunion);

    const depuis = new Date(maintenant.getTime() - 120 * JOUR);
    const decisions = await prisma.executiveDecision.findMany({
      where: { ownerId: user.id, status: { not: "ABANDONED" }, createdAt: { gte: depuis } },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { title: true, decision: true, status: true, decidedAt: true, reviewDate: true, entities: true },
    }).catch(sansBloquer("meetings.composerBriefReunion.executiveDecision", []));
    const prenoms = nomsParticipants.map((n) => plier(prenom(n))).filter((p) => p.length >= 3);
    const liees = decisions.filter((d) => {
      const texte = plier(`${d.title} ${d.decision ?? ""} ${JSON.stringify(d.entities ?? "")}`);
      return mots.some((mot) => texte.includes(mot)) || prenoms.some((p) => texte.includes(p));
    }).slice(0, 8);
    brief.decisions = liees.map((d) => ({ titre: d.title, decision: d.decision, statut: d.status, decideeLe: frDate(d.decidedAt), revueLe: frDate(d.reviewDate) }));
  }

  // ── CHIEF OF STAFF : dossiers, décisions à obtenir, risques, contradictions, engagements en retard, questions ouvertes, suivi ──
  if (auMoins(niveau, "CHIEF_OF_STAFF")) {
    const texteReunion = `${m.title} ${m.description ?? ""}`;
    const [entites, validations, missionsEnAttente, engagementsRetard, intelligence] = await Promise.all([
      resoudreEntitesDe(texteReunion).catch(sansBloquer("meetings.composerBriefReunion.resoudreEntitesDe", [])),
      prisma.validationStep.findMany({
        where: { validatorId: user.id, status: "PENDING", request: { status: "PENDING" } },
        orderBy: { createdAt: "asc" }, take: 12,
        select: { request: { select: { reference: true, title: true, module: true, amount: true, deadline: true, requester: { select: { name: true } } } } },
      }).catch(sansBloquer("meetings.composerBriefReunion.validationStep", [])),
      prisma.missionStep.findMany({
        where: { status: "WAITING", supersededAt: null, mission: { ownerId: user.id, status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] } } },
        orderBy: { updatedAt: "desc" }, take: 12,
        select: { title: true, waitFor: true, mission: { select: { title: true } } },
      }).catch(sansBloquer("meetings.composerBriefReunion.missionStep", [])),
      prisma.executiveCommitment.findMany({
        where: { ownerId: user.id, status: "OPEN", dueAt: { lt: maintenant } },
        orderBy: { dueAt: "asc" }, take: 12, select: { who: true, what: true, dueAt: true, relatedRef: true },
      }).catch(sansBloquer("meetings.composerBriefReunion.executiveCommitment", [])),
      intelligenceComplete(user, { maintenant, leger: true }).catch(sansBloquer("meetings.composerBriefReunion.intelligenceComplete", { signaux: [] as Signal[] })),
    ]);

    const cles = [...entites.map((e) => plier(e.label)), ...nomsParticipants.map(plier), ...motsDe(m.title)].filter((c) => c.length >= 4);
    const concerne = (s: Signal): boolean => {
      const texte = plier(`${s.titre} ${s.detail} ${s.entite?.ref ?? ""}`);
      return cles.some((c) => texte.includes(c));
    };
    const signauxLies = intelligence.signaux.filter(concerne);
    const CODES_CONTRADICTION = new Set(["ecart_facture_bc", "prevision_incoherente", "contrat_echu_actif"]);
    const vueSignal = (s: Signal) => ({ gravite: s.gravite, titre: s.titre, detail: s.detail, calcul: s.calcul ?? null, echeance: s.echeance ?? null, domaine: s.domaine ?? null, lien: s.href ?? null });
    const contradictions = signauxLies.filter((s) => CODES_CONTRADICTION.has(s.code)).slice(0, 8);
    const risques = signauxLies.filter((s) => !CODES_CONTRADICTION.has(s.code)).slice(0, 10);
    // Sans entité ni participant nommé dans un signal, on montre quand même le sommet CRITIQUE — un chef de cabinet le dirait.
    const critiquesGenerales = signauxLies.length === 0 ? intelligence.signaux.filter((s) => s.gravite === "CRITIQUE").slice(0, 3) : [];

    brief.dossiers = entites.slice(0, 10).map((e) => ({ type: e.type, nom: e.label }));
    brief.decisionsAObtenir = [
      ...validations.map((v) => ({ type: "validation", reference: v.request.reference, titre: v.request.title, module: v.request.module, montant: v.request.amount ? Number(v.request.amount) : null, echeance: frDate(v.request.deadline), demandeur: v.request.requester.name })),
      ...missionsEnAttente.map((s) => ({ type: "mission", mission: s.mission.title, etape: s.title, attend: s.waitFor ?? null })),
    ];
    brief.risques = [...risques, ...critiquesGenerales].map(vueSignal);
    brief.contradictions = contradictions.map(vueSignal);
    brief.engagementsEnRetard = engagementsRetard.map((c) => ({ qui: c.who, quoi: c.what, echeance: frDate(c.dueAt), retardJours: c.dueAt ? Math.floor((maintenant.getTime() - c.dueAt.getTime()) / JOUR) : null, reference: c.relatedRef ?? null }));

    // Les QUESTIONS OUVERTES : ce que le dossier laisse sans réponse — calculées, jamais rédigées.
    const questions: string[] = [];
    for (const p of participants) {
      if (p.reponse === "INVITED" || p.reponse === "TENTATIVE") questions.push(`${p.nom} n'a pas confirmé sa présence (${p.reponse}).`);
      for (const t of p.tachesEntreNous ?? []) if (t.statut === "REQUESTED") questions.push(`La demande « ${t.titre} » à ${p.nom} n'a pas été acceptée.`);
    }
    const derniere = brief.derniereReunion as { actions?: { titre: string; sort: string }[] } | null;
    for (const a of derniere?.actions ?? []) if (/proposée|en cours/.test(a.sort)) questions.push(`Action de la dernière réunion « ${a.titre} » : ${a.sort}.`);
    for (const d of (brief.decisions as { titre: string; statut: string }[])) if (d.statut === "PROPOSED") questions.push(`Décision « ${d.titre} » toujours à l'état de proposition.`);
    if (!m.description) questions.push("La réunion n'a pas d'ordre du jour écrit.");
    brief.questionsOuvertes = questions.slice(0, 12);

    // Le SUIVI jusqu'à la réunion suivante : la prochaine occurrence si elle existe, et ce qu'il faudra y rapporter.
    const suivante = await prisma.meeting.findFirst({
      where: { status: "SCHEDULED", id: { not: m.id }, scheduledAt: { gt: m.scheduledAt ?? maintenant }, OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }], AND: [{ OR: motsDe(m.title).map((mot) => ({ title: { contains: mot, mode: "insensitive" as const } })) }] },
      orderBy: { scheduledAt: "asc" }, select: { title: true, scheduledAt: true },
    }).catch(sansBloquer("meetings.composerBriefReunion.meeting", null));
    brief.suiviJusquaProchaine = {
      prochaineOccurrence: suivante ? `${suivante.title} (${frDate(suivante.scheduledAt)})` : null,
      aRapporter: [
        ...engagementsRetard.slice(0, 5).map((c) => `Engagement en retard : ${c.who} — ${c.what}`),
        ...participants.flatMap((p) => (p.tachesEntreNous ?? []).map((t) => `Tâche ouverte avec ${p.nom} : ${t.titre}${t.echeance ? ` (échéance ${t.echeance})` : ""}`)),
      ].slice(0, 10),
      conseil: "À la fin de la réunion : dicter le compte rendu (résumé + actions acceptées) pour que le prochain brief reparte de là.",
    };
  }

  if (meetings.length > 1) brief.autresReunionsTrouvees = meetings.slice(1).map((x) => `${x.title} (${frDate(x.scheduledAt)})`);
  brief.rappel = "Points calculés sur l'ERP (tâches, engagements, comptes rendus, décisions, validations, signaux métier) — l'ordre du jour est la description de la réunion, rien n'est inventé.";
  return { ok: true, brief, niveau, ms: Date.now() - t0 };
}
