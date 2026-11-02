import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import type { StepContext, StepOutcome } from "@/lib/missions/runtime/engine";
import { journaliser } from "@/lib/missions/runtime/store";
import { LIBELLE_NIVEAU } from "@/lib/missions/policy/guard";
import { nonCouvertes, perimetre, type PerimetreApprobation } from "@/lib/missions/approval/scope";
import type { CompiledMission } from "@/lib/missions/compiler/compile";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'APPROBATION — et la notification qui va la chercher (§31-38).
 *
 * ── LA RÉUTILISATION, DITE FRANCHEMENT ───────────────────────────────────────────────────
 *
 * Aucun système de notification n'est créé ici. `notifyUser` existe, écrit une `Notification`
 * en base ET pousse sur les appareils via le VAPID déjà en place (`src/lib/push.ts`). Un second
 * système donnerait deux boîtes de réception, deux réglages, et un jour deux vérités sur ce que
 * le PDG a vu (§34).
 *
 * ── CE QUE LA PORTE FAIT, EXACTEMENT ─────────────────────────────────────────────────────
 *
 * Elle regarde s'il existe un accord ACCORDÉ qui couvre son étape. S'il y en a un, elle passe.
 * S'il n'y en a pas, elle en CRÉE un en attente — une seule fois — puis elle attend. Elle ne
 * s'ouvre jamais d'elle-même : le défaut d'une porte est d'être fermée.
 *
 * ── LE POINT LE PLUS FACILE À RATER ──────────────────────────────────────────────────────
 *
 * La demande est créée UNE fois. Sans cette précaution, chaque tour du moteur en créerait une
 * nouvelle, et le PDG recevrait une notification toutes les quelques secondes pour la même
 * décision — ce qui est la façon la plus sûre de rendre les notifications invisibles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le niveau d'attention (§36) — quatre valeurs, pas dix, pour qu'elles restent distinctes. */
export type NiveauAttention = "INFO" | "IMPORTANT" | "CRITICAL" | "APPROVAL_REQUIRED";

/**
 * CRÉE OU RETROUVE LA DEMANDE D'APPROBATION D'UN PÉRIMÈTRE.
 *
 * Rend l'identifiant de la demande. La recherche porte sur l'EMPREINTE, pas sur la mission :
 * deux périmètres différents de la même mission sont deux décisions différentes, et un
 * périmètre inchangé ne redemande rien même après un replan.
 */
export async function demanderApprobation(
  missionId: string,
  p: PerimetreApprobation,
  ownerId: string,
  titreMission: string,
): Promise<string> {
  const existante = await prisma.missionApproval.findFirst({
    where: { missionId, scopeHash: p.scopeHash, status: { in: ["PENDING", "GRANTED"] } },
    select: { id: true, status: true },
  });
  if (existante) return existante.id;

  // UN NOUVEAU PÉRIMÈTRE PÉRIME LES ANCIENS EN ATTENTE. Laisser traîner une demande qui porte
  // sur un plan qui n'existe plus, c'est offrir au PDG d'autoriser quelque chose qui n'aura
  // jamais lieu — et lui faire croire qu'il a débloqué la mission.
  await prisma.missionApproval.updateMany({
    where: { missionId, status: "PENDING" },
    data: { status: "SUPERSEDED" },
  });

  const demande = await prisma.missionApproval.create({
    data: {
      missionId,
      scope: "MISSION",
      summary: p.resume,
      scopeHash: p.scopeHash,
      stepKeys: p.stepKeys,
      level: p.niveau,
      status: "PENDING",
      sample: p.echantillon as never,
    },
    select: { id: true },
  });

  await journaliser(missionId, "APPROVAL_REQUESTED",
    `Autorisation demandée — ${LIBELLE_NIVEAU[p.niveau]}. ${p.resume}`,
    { scopeHash: p.scopeHash, stepKeys: p.stepKeys, level: p.niveau });

  await notifyUser({
    userId: ownerId,
    type: "VALIDATION_REQUIRED",
    title: `Adam attend votre accord — ${titreMission}`,
    body: p.resume,
    link: `/missions/${missionId}`,
    // Une demande d'accord RESTE affichée : c'est une décision, pas une information qui passe.
    push: { tag: `mission-approval-${missionId}`, requireInteraction: true },
  });

  return demande.id;
}

/**
 * UN PLAN A CHANGÉ : QU'EST-CE QUI N'EST PLUS COUVERT ? (§8, §33)
 *
 * ── LE TROU QUE CETTE FONCTION FERME ────────────────────────────────────────────────────
 *
 * Une mission approuvée peut être REPLANIFIÉE — parce qu'une étape a échoué sans recours, parce
 * que le monde a changé. Le nouveau plan porte alors des étapes que personne n'a autorisées, et
 * l'accord d'hier, lui, est toujours `GRANTED` en base. Sans ce contrôle, la porte d'approbation
 * le laisse passer : elle cherche un accord qui couvre la clé de l'étape, et elle en trouve un.
 *
 * ── CE QU'ELLE NE FAIT PAS, ET C'EST TOUT L'ENJEU ──────────────────────────────────────
 *
 * Elle ne redemande PAS l'accord pour l'ensemble. Une empreinte globale différente dit seulement
 * « quelque chose a bougé » ; `nonCouvertes` dit QUOI. Rouvrir les trente-trois envois parce que
 * le trente-quatrième a été ajouté serait revenir aux quatre-vingt-dix-neuf confirmations par un
 * autre chemin — ce que §8 interdit en toutes lettres.
 *
 * Rend `null` quand rien n'a changé matériellement, ou quand aucun accord n'avait été donné (le
 * chemin normal de `perimetre` s'applique alors).
 */
export async function reouvrirSiChange(
  missionId: string,
  mission: CompiledMission,
  ownerId: string,
  titreMission: string,
): Promise<{ approvalId: string; stepKeys: string[] } | null> {
  const accorde = await prisma.missionApproval.findFirst({
    where: { missionId, status: "GRANTED" },
    select: { scopeHash: true, stepKeys: true },
    orderBy: { createdAt: "desc" },
  });
  if (!accorde) return null;

  const decouvertes = nonCouvertes(mission, accorde);
  if (decouvertes.length === 0) return null;

  const complet = perimetre(mission);
  if (!complet) return null;

  // LE PÉRIMÈTRE RESTREINT — même niveau, même échantillon, mais LES SEULES clés nouvelles.
  // L'empreinte reste celle du plan complet : c'est elle qui dit « cet accord porte sur CE
  // plan-là », et la réutiliser telle quelle est ce qui rend le prochain contrôle juste.
  const restreint: PerimetreApprobation = {
    ...complet,
    stepKeys: decouvertes,
    resume: `Le plan a changé : ${decouvertes.length} étape(s) ne sont pas couvertes par votre accord `
      + `précédent. ${complet.resume}`,
    echantillon: complet.echantillon.filter((e) => decouvertes.includes(e.stepKey)).slice(0, 5),
  };

  // LES PORTES CONCERNÉES REPASSENT EN ATTENTE. Sans cela, une porte déjà franchie sous
  // l'ancien plan resterait `DONE` et le nouveau lot partirait sans que personne n'ait rien vu.
  await prisma.missionStep.updateMany({
    where: { missionId, key: { in: decouvertes }, nodeType: "APPROVAL" },
    data: { status: "WAITING" },
  });

  await journaliser(missionId, "APPROVAL_REOPENED",
    `Le plan a changé : ${decouvertes.length} étape(s) rouvertes à votre accord.`,
    { stepKeys: decouvertes, ancienScope: accorde.scopeHash, nouveauScope: complet.scopeHash });

  const id = await demanderApprobation(missionId, restreint, ownerId, titreMission);
  return { approvalId: id, stepKeys: decouvertes };
}

/**
 * LA DÉCISION HUMAINE.
 *
 * `decidedById` n'est pas décoratif : c'est ce qui rend l'audit capable de répondre à « qui a
 * autorisé cet envoi ? » (§30). Une approbation sans auteur ne vaut rien le jour où la question
 * se pose vraiment.
 */
export async function decider(
  approvalId: string,
  decision: "GRANTED" | "REFUSED",
  decidedById: string,
): Promise<boolean> {
  const r = await prisma.missionApproval.updateMany({
    where: { id: approvalId, status: "PENDING" },
    data: { status: decision, decidedById, decidedAt: new Date() },
  });
  if (r.count !== 1) return false;

  const a = await prisma.missionApproval.findUnique({
    where: { id: approvalId },
    select: { missionId: true, summary: true, stepKeys: true },
  });
  if (a) {
    // ── LA DÉCISION RÉVEILLE LA PORTE ──────────────────────────────────────────────────
    //
    // Exactement comme un événement métier réveille une attente. Sans cela, la porte resterait
    // « en attente » alors que l'accord est donné, et le moteur ne repasserait jamais dessus :
    // la mission serait bloquée par une décision déjà prise. On la remet en file plutôt que de
    // la conclure ici — c'est la porte qui relit l'accord, et elle seule.
    await prisma.missionStep.updateMany({
      where: {
        missionId: a.missionId,
        key: { in: a.stepKeys },
        nodeType: "APPROVAL",
        status: "WAITING",
      },
      data: { status: "READY" },
    });

    await journaliser(a.missionId,
      decision === "GRANTED" ? "APPROVAL_GRANTED" : "APPROVAL_REFUSED",
      decision === "GRANTED" ? `Autorisation accordée : ${a.summary}` : `Autorisation refusée : ${a.summary}`,
      { stepKeys: a.stepKeys }, decidedById);
  }
  return true;
}

/**
 * LA PORTE, telle que le moteur l'appelle.
 *
 * Elle a besoin du périmètre pour pouvoir le DEMANDER si personne ne l'a fait. On le lui donne
 * en fermeture plutôt que de le recalculer ici : le périmètre est celui du plan COMPILÉ, et le
 * recalculer depuis la base risquerait de faire approuver autre chose que ce qui tournera.
 */
export function porteApprobation(
  p: PerimetreApprobation | null,
  titreMission: string,
): (ctx: StepContext) => Promise<StepOutcome> {
  return async (ctx: StepContext): Promise<StepOutcome> => {
    const accord = await prisma.missionApproval.findFirst({
      where: {
        missionId: ctx.mission.id,
        status: "GRANTED",
        stepKeys: { has: ctx.step.key },
      },
      select: { id: true, decidedById: true, scopeHash: true },
      orderBy: { createdAt: "desc" },
    });
    if (accord) {
      return { status: "DONE", result: { approbation: accord.id, par: accord.decidedById } };
    }

    const refus = await prisma.missionApproval.findFirst({
      where: { missionId: ctx.mission.id, status: "REFUSED", stepKeys: { has: ctx.step.key } },
      select: { id: true },
    });
    if (refus) {
      // UN REFUS EST DÉFINITIF POUR CETTE ÉTAPE, et non rejouable : réessayer trois fois une
      // autorisation refusée serait harceler quelqu'un qui a déjà dit non.
      return {
        status: "FAILED",
        error: "autorisation refusée",
        errorKind: "APPROVAL_REFUSED",
        retryable: false,
      };
    }

    if (p && p.stepKeys.includes(ctx.step.key)) {
      await demanderApprobation(ctx.mission.id, p, ctx.mission.ownerId, titreMission);
    }
    return { status: "WAITING", raison: "attend votre accord" };
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM VOUS ÉCRIT DE LUI-MÊME (§35-36).
 *
 * Pas parce qu'il a fini d'exécuter, mais parce qu'il a quelque chose à dire. Le niveau
 * d'attention décide de l'insistance — et il n'y en a que quatre, pour qu'ils gardent un sens :
 * si tout est important, plus rien ne l'est.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function prevenir(opts: {
  missionId: string;
  ownerId: string;
  niveau: NiveauAttention;
  titre: string;
  message: string;
}): Promise<void> {
  await journaliser(opts.missionId, "NOTIFIED", `${opts.niveau} — ${opts.titre} : ${opts.message}`,
    { niveau: opts.niveau });

  await notifyUser({
    userId: opts.ownerId,
    type: opts.niveau === "APPROVAL_REQUIRED" ? "VALIDATION_REQUIRED" : "GENERIC",
    title: opts.titre,
    body: opts.message,
    link: `/missions/${opts.missionId}`,
    push: {
      // Un tag par mission ET par niveau : deux informations du même niveau se remplacent
      // (la plus récente vaut), une décision ne remplace jamais une information.
      tag: `mission-${opts.missionId}-${opts.niveau}`,
      requireInteraction: opts.niveau === "CRITICAL" || opts.niveau === "APPROVAL_REQUIRED",
    },
  });
}

/** Les demandes en attente d'un propriétaire — ce que l'écran affiche, et ce qu'Adam sait relancer. */
export async function approbationsEnAttente(ownerId: string) {
  return prisma.missionApproval.findMany({
    where: { status: "PENDING", mission: { ownerId, status: { notIn: ["COMPLETED", "CANCELLED"] } } },
    select: {
      id: true, missionId: true, summary: true, level: true, stepKeys: true,
      sample: true, createdAt: true,
      mission: { select: { title: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}
