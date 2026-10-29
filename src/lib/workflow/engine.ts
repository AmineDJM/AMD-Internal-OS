/**
 * Moteur de workflow configurable (Ad & Pro). Une **définition** (par catégorie)
 * décrit une suite d'**étapes** ; chaque étape déclare qui agit et ses pouvoirs.
 * Une **instance** suit une demande précise à travers ces étapes. Le moteur assure
 * le gating, la progression et les effets (désignation, émission d'ordre de dépense
 * / déclaration d'information médicale), tout en **projetant** le statut « legacy »
 * de l'entité source pour ne rien casser des frises/badges/queries existants.
 *
 * Découpé par responsabilité — voir le dossier `engine/` : `definitions.ts` (définitions, étapes,
 * droit d'agir), `entites.ts` (lecture/écriture de l'entité source, journal), `prise.ts` (verrou du
 * circuit), `montants.ts` (postes et montant déclaré), `projections.ts` (statut legacy projeté),
 * `notifications.ts` (étape atteinte, pose), `cycle.ts` (modification, fermeture, réouverture),
 * `gestes.ts` (forme d'une avance, renvoi pour correction). Ce fichier garde ce qui s'enchaîne aux
 * franchissements automatiques : l'instance et son avance, le geste, ses effets financiers, la
 * projection d'une approbation, et les relances du cycle (resoumettre, retirer, relancer, ouvrir).
 */
import { Prisma, type EntityType, type UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { createMedicalInfoDeclaration, pharmacienAssigne } from "@/lib/medical-info";
import { createExpenseOrder } from "@/modules/finances/api";
import { toNumber } from "@/lib/utils";
import { parcoursEffectif, seuilFranchissement, SLUG_MARKETING } from "./parcours";
import { adProOriginRank } from "./origin";
import { getAppSettings } from "@/lib/settings";
import { statutDepuisCircuit, PARENT_COLONNE, type AdProParent } from "@/modules/ad-pro/partage";
import { issueTerminaleSponsoring } from "./issue-sponsoring";
import { etapeDeReprise, peutResoumettre } from "./renvoi";
import { CATEGORY_LABELS, entityToCategory, type ActorScope } from "./types";
import { sansBloquer } from "@/lib/journal";
import { autoSkipEligible, canActOnStep, chargerDefinition, franchiesParMontant, getDefinition, lectureDeLApprobation, type LoadedDefinition, type LoadedInstance, type LoadedStep, nextStepAfter, orderedSteps, stepBySlug, type Viewer } from "./engine/definitions";
import { auditModule, entityPath, type EntitySummary, LEGACY_FIELD, loadEntity, positionFromLegacy, premiereEtapeTraversee, recordEvent, updateEntity } from "./engine/entites";
import { argsPrise, argsRendre, CIRCUIT_PRIS } from "./engine/prise";
import { type AdvanceInput, type AdvanceResult, type ContexteGeste, renvoyerPourCorrection } from "./engine/gestes";
import { countAdProItems, montantADeclarer } from "./engine/montants";
import { projectPose, projectReject } from "./engine/projections";
import { notifyStepManager, prevenirEtapeAtteinte, prevenirLaPose } from "./engine/notifications";
import type { ResultatRevision } from "./engine/cycle";

export { stepCreate, getDefinition, orderedSteps, stepBySlug, lectureDeLApprobation, canActOnStep, type LoadedInstance } from "./engine/definitions";
export type { AdvanceInput } from "./engine/gestes";
export { postesPortantLaDepense, montantADeclarer, reporterLesPostesSurLaDeclaration } from "./engine/montants";
export { apresModificationDeLaDemande, fermerInstance, reopenInstance } from "./engine/cycle";

/**
 * Franchissements AUTOMATIQUES d'étapes intermédiaires (anti-bureaucratie configurable).
 * À partir de l'étape où l'instance vient d'arriver (`landing`), tant qu'elle est éligible,
 * elle est franchie SANS action humaine — tracé, avec projection legacy sur l'étape réelle
 * de repos. Deux motifs, tous deux opt-in par étape :
 *   • SEUIL DE MONTANT — montant de travail ≤ `autoSkipMaxAmount` → « AUTO_SKIP ».
 *   • AUTORITÉ DU DEMANDEUR — le demandeur détient déjà le rôle/la portée de l'étape
 *     (`autoApproveIfRequester`) → « AUTO_APPROVE_REQUESTER » (on ne fait pas valider quelqu'un
 *     sa propre demande).
 * Ne franchit JAMAIS une désignation (ASSIGN), une émission financière, ni la décision finale
 * (dernière étape sans successeur) : un humain tranche toujours l'accord définitif.
 * Retourne l'étape de repos.
 */
async function settleAutoSkips(
  entityType: EntityType, entityId: string, def: LoadedDefinition,
  instanceId: string, amount: number, requesterId: string | null, landing: LoadedStep | null, viewer: Viewer,
  borne: string | null, ignorees: readonly string[],
): Promise<LoadedStep | null> {
  let current = landing;
  let guard = 0;
  // LE SEUIL GLOBAL, lu UNE fois pour tout l'enchaînement (mis en cache par requête). Illisible
  // (base indisponible) ⇒ `null` ⇒ aucune porte du DG franchie automatiquement : sous l'incertitude
  // on garde la validation de plus, jamais de moins.
  const seuilDgGlobal = await getAppSettings().then((s) => s.adProDgThreshold).catch(sansBloquer("workflow-engine.settleAutoSkips.getAppSettings", null));
  // Rôle du demandeur — chargé paresseusement (uniquement si une étape « auto-accord si autorité » l'exige).
  let reqRole: { role: UserRole; secondaryRole: UserRole | null } | null | undefined = undefined;
  const requesterHoldsAuthority = async (step: LoadedStep): Promise<boolean> => {
    if (!step.autoApproveIfRequester || !requesterId) return false;
    if (step.powers.includes("ASSIGN") || step.emitDeclaration || step.emitExpenseOrder) return false;
    const scope = step.actorScope as ActorScope;
    if (scope === "REQUESTER") return true;
    if (scope !== "ROLE") return false; // GLOBAL_VIEW / ASSIGNEE : pas d'auto-accord demandeur
    if (reqRole === undefined) {
      const u = await prisma.user.findUnique({ where: { id: requesterId }, select: { role: true, secondaryRole: true } });
      reqRole = u ? { role: u.role, secondaryRole: u.secondaryRole ?? null } : null;
    }
    if (!reqRole) return false;
    const asViewer = { id: requesterId, role: reqRole.role, secondaryRole: reqRole.secondaryRole };
    return step.actorRoles.some((r) => hasRole(asViewer, r as UserRole));
  };

  while (current && guard++ < 50) {
    const byAmount = autoSkipEligible(current, amount, seuilDgGlobal);
    const byRequester = !byAmount && (await requesterHoldsAuthority(current));
    if (!byAmount && !byRequester) break;
    const after = nextStepAfter(def, current, borne, ignorees);
    if (!after) break; // pas de successeur (décision finale) → on ne franchit pas
    const action = byAmount ? "AUTO_SKIP" : "AUTO_APPROVE_REQUESTER";
    const reason = byAmount
      ? `Montant ${amount} DZD ≤ seuil ${seuilFranchissement(current.slug, current.autoSkipMaxAmount == null ? null : toNumber(current.autoSkipMaxAmount), seuilDgGlobal)} DZD — étape franchie automatiquement.`
      : "Le demandeur détient déjà l'autorité de cette étape — approuvée automatiquement en son nom.";
    await projectApprove(entityType, entityId, current, after, {
      viewer, note: reason, amount: null, assigneeId: null, emitResult: null,
      nextLegacyStatus: after.legacyStatus ?? null, emitStep: false,
    });
    await recordEvent(instanceId, current, action, viewer, reason, null);
    current = after;
  }
  return current;
}

/** Crée l'instance si absente (idempotent), positionnée d'après le statut legacy courant. */
export async function ensureInstance(entityType: EntityType, entityId: string): Promise<LoadedInstance | null> {
  const category = entityToCategory(entityType);
  if (!category) return null;
  const existing = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (existing) return existing;
  const def = await getDefinition(category);
  const summary = await loadEntity(entityType, entityId);
  const { currentSlug, status } = positionFromLegacy(orderedSteps(def), summary?.legacyStatus ?? null);
  // LA BORNE ET LE TAMIS DU PARCOURS, fixés MAINTENANT et jamais recalculés.
  //
  // Ils se lisent sur le DEMANDEUR et sur la NATURE de la demande (`parcoursAdPro` : le rang et
  // le métier de son auteur, et le sponsoring d'un KAM qui traverse aussi la Direction des
  // opérations). On les fige à la naissance de l'instance
  // parce qu'un KAM promu National Sales en cours de circuit ne doit pas voir sa chaîne
  // changer — et surtout parce qu'un National Sales redevenu KAM ne doit pas PERDRE la
  // validation de la Direction qui lui était promise. Le parcours est un fait de la DEMANDE.
  //
  // Demandeur inconnu (demande sans auteur) ⇒ `null` ⇒ chaîne complète : on n'ampute jamais un
  // circuit sur une absence de donnée, le sens sûr étant celui qui garde une validation de plus.
  const demandeur = summary?.requesterId
    ? await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { role: true, secondaryRole: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null))
    : null;
  //
  // LES DEUX FAITS SE LISENT D'UN SEUL APPEL. Ils viennent de la même branche : en tirer un sans
  // l'autre laisserait une demande s'arrêter là où la vue annonce qu'elle continue (§118.5).
  const parcours = demandeur
    ? parcoursEffectif(demandeur, orderedSteps(def).map((st) => st.slug), adProOriginRank(demandeur), category)
    : null;
  const finalSlug = parcours?.decision ?? null;
  const skippedSlugs = parcours ? [...parcours.ignorees] : [];
  // L'ÉTAPE DE POSE NE PEUT PAS ÊTRE HORS DU PARCOURS (27/10/2026). Le statut legacy d'entrée
  // (« préliminaire faite ») désigne la PREMIÈRE étape qui le porte — la porte du DG, qui n'est plus
  // sur la route : la demande s'y serait posée devant un DG qui n'a rien à valider. On avance donc
  // jusqu'à la première étape réellement traversée.
  const pose = status === "IN_PROGRESS" ? premiereEtapeTraversee(def, currentSlug, skippedSlugs) : currentSlug;
  // SEULE LA COURSE SE RATTRAPE (audit 27/10/2026, ADPRO-11). Un `catch {}` couvrait la création ET
  // toute la suite : une vraie panne devenait « Impossible d'initialiser le circuit » sans trace, ou
  // rendait l'instance d'un autre geste comme la sienne. Un doublon (P2002 — un autre geste vient de
  // la créer) rend l'existante ; toute autre erreur de création remonte.
  let created: LoadedInstance;
  try {
    created = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType, entityId, category, currentSlug: pose, status, finalSlug, skippedSlugs },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
    }
    throw e;
  }
  // LA SUITE (journal, prévalidation d'office, franchissements) ne défait pas l'instance posée : une
  // panne y est JOURNALISÉE et l'instance relue par SON identifiant — jamais celle d'un autre.
  try {
    // LA PREMIÈRE LIGNE DE L'HISTORIQUE : QUI a demandé, et QUAND.
    //
    // L'historique ne commençait qu'à la première validation : on lisait « approuvé par X à
    // 14 h 12 » sans jamais savoir qui avait demandé, ni à quelle heure. On horodate donc à
    // l'instant EXACT de création de la demande (`summary.createdAt`), et non à celui où
    // l'instance est ouverte — elle l'est paresseusement, parfois des jours plus tard.
    if (summary?.requesterId) {
      const requester = await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { name: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
      await prisma.workflowStepEvent
        .create({
          data: {
            instanceId: created.id,
            stepSlug: "__created__",
            stepTitle: "Demande créée",
            action: "CREATE",
            actorId: summary.requesterId,
            actorName: requester?.name ?? null,
            note: summary.label,
            createdAt: summary.createdAt ?? created.createdAt,
          },
        })
        .catch((e) => console.error("[workflow] ligne de création non journalisée (non bloquant)", e));
    }
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // LES FRANCHISSEMENTS AUTOMATIQUES S'APPLIQUENT AUSSI À L'ÉTAPE D'ENTRÉE (§118.138).
    //
    // Ils ne se réglaient qu'EN TRANSIT, après une approbation. Une demande qui ENTRE sur une
    // étape franchissable y restait donc posée pour toujours : c'est exactement le cas d'un
    // demandeur non-KAM depuis l'inversion du circuit — il entre par la porte du Directeur
    // Général, qui doit s'ouvrir seule sous le seuil. Sans cette ligne, sa demande attendrait un
    // DG qui n'a rien à valider, sans une seule étape en échec et sans que rien ne le dise.
    //
    // L'ACTEUR est le DEMANDEUR, faute de quoi rien n'est franchi : c'est lui qui vient de
    // soumettre, et attribuer le franchissement à personne rendrait la ligne d'historique
    // illisible. Sans demandeur connu, on ne franchit rien — un montant qu'on ne sait pas
    // rattacher ne doit pas ouvrir une porte de contrôle.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // PRÉVALIDÉE D'OFFICE (27/10/2026) : la demande de la Direction Marketing n'attend personne. L'étape
    // de prévalidation est franchie maintenant, AU NOM de sa créatrice, par le même geste que l'écran
    // (déclaration, statut, notifications compris) — et le journal dit pourquoi.
    if (parcours?.dOffice && summary?.requesterId && status === "IN_PROGRESS" && pose === SLUG_MARKETING) {
      const creatrice = await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { name: true, role: true, secondaryRole: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
      if (creatrice) {
        const r = await advanceWorkflowInstance({
          viewer: { id: summary.requesterId, role: creatrice.role, secondaryRole: creatrice.secondaryRole, name: creatrice.name },
          entityType, entityId, action: "APPROVE",
          note: "Prévalidée d'office — demande de la Direction Marketing (règle du 27/10/2026).",
        }).catch((e) => ({ ok: false as const, error: String(e) }));
        if (!r.ok) console.error("[workflow] prévalidation d'office non appliquée", entityType, entityId, r.error);
      }
      return prisma.workflowInstance.findUnique({ where: { id: created.id } });
    }
    if (summary?.requesterId && pose) {
      const depart = stepBySlug(def, pose);
      const montant = summary.estimatedAmount ?? 0;
      if (depart && montant > 0) {
        const demandeur = await prisma.user
          .findUnique({ where: { id: summary.requesterId }, select: { name: true, role: true, secondaryRole: true } })
          .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
        if (demandeur) {
          const repos = await settleAutoSkips(
            entityType, entityId, def, created.id, montant, summary.requesterId, depart,
            { id: summary.requesterId, role: demandeur.role, secondaryRole: demandeur.secondaryRole, name: demandeur.name },
            finalSlug, skippedSlugs,
          );
          if (repos && repos.slug !== pose) {
            const avance = await prisma.workflowInstance.update({ where: { id: created.id }, data: { currentSlug: repos.slug } });
            return avance;
          }
        }
      }
    }
    return created;
  } catch (e) {
    console.error("[workflow] ouverture du circuit : suite en échec", entityType, entityId, e);
    return prisma.workflowInstance.findUnique({ where: { id: created.id } });
  }
}

export async function advanceWorkflowInstance(input: AdvanceInput): Promise<AdvanceResult> {
  const { viewer, entityType, entityId, action } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };

  const instance = await ensureInstance(entityType, entityId);
  if (!instance) return { ok: false, error: "Impossible d'initialiser le circuit." };
  // UNE DEMANDE À CORRIGER N'EST PAS UN CIRCUIT CLOS : elle est chez son demandeur. Le dire, au lieu
  // de « déjà clôturé », évite qu'un validateur croie la décision prise par quelqu'un d'autre.
  if (instance.status === "RETURNED") {
    return { ok: false, error: "La demande est chez son demandeur, pour correction : elle reviendra à cette étape quand il l'aura resoumise." };
  }
  if (instance.status !== "IN_PROGRESS") return { ok: false, error: "Ce circuit est déjà clôturé." };

  const def = await prisma.workflowDefinition.findUnique({ where: { id: instance.definitionId }, include: { steps: { orderBy: { position: "asc" } } } });
  if (!def) return { ok: false, error: "Définition de workflow introuvable." };
  const step = stepBySlug(def, instance.currentSlug);
  if (!step) return { ok: false, error: "Étape courante introuvable." };

  const summary = await loadEntity(entityType, entityId);
  if (!summary) return { ok: false, error: "Demande introuvable." };

  if (!(await canActOnStep(viewer, step, instance, { requesterId: summary.requesterId }))) {
    return { ok: false, error: "Vous n'êtes pas habilité à agir à cette étape." };
  }

  const note = input.note?.trim() || null;

  // LA BORNE DE SORTIE DU PARCOURS de cette demande — lue UNE fois, pour les trois gestes.
  //
  // Elle est hissée ici et non au moment de l'approbation, parce que le REFUS et le SAUT en
  // dépendent tout autant : un refus à l'étape qui TRANCHE est définitif (le laisser passer en
  // « avis défavorable » enverrait la demande refusée d'un KAM attendre une Direction qu'elle
  // n'atteindra jamais), et l'étape qui tranche ne se saute pas.
  const borne = instance.finalSlug ?? null;
  // LE TAMIS, gelé à la naissance lui aussi. Une instance née avant la règle du 22/09/2026 porte
  // une liste VIDE — donc exactement la chaîne qui lui avait été promise, sans étape retirée
  // rétroactivement. Amputer un circuit en vol ferait atteindre la décision à une demande dont
  // l'écran annonçait qu'un validateur la verrait encore (§118.16).
  const ignorees = instance.skippedSlugs ?? [];

  // COMMENT : simple trace + commentaire sur l'entité, sans avancer.
  if (action === "COMMENT") {
    if (!step.powers.includes("COMMENT")) return { ok: false, error: "Le commentaire n'est pas autorisé à cette étape." };
    if (!note) return { ok: false, error: "Commentaire vide." };
    await prisma.comment.create({ data: { entityType, entityId, body: note, authorId: viewer.id } });
    await recordEvent(instance.id, step, "COMMENT", viewer, note, null);
    return { ok: true, category };
  }

  // UN GESTE À LA FOIS : le circuit est PRIS avant le premier effet et rendu à la fin
  // (`prendreLeCircuit`). Le commentaire, qui ne fait pas avancer, n'en a pas besoin.
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: "IN_PROGRESS", currentSlug: step.slug }, prise));
  if (posee.count === 0) return { ok: false, error: CIRCUIT_PRIS };
  try {
    return await appliquerLeGeste({ input, action, viewer, entityType, entityId, category, instance, def, step, summary, note, borne, ignorees });
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.advanceWorkflowInstance.workflowInstance"));
  }
}

/**
 * LES GESTES QUI FONT AVANCER LE CIRCUIT — renvoyer, refuser, sauter, approuver. Jamais appelés
 * directement : `advanceWorkflowInstance` valide l'acteur et l'étape, puis PREND le circuit.
 */
async function appliquerLeGeste(ctx: ContexteGeste): Promise<AdvanceResult> {
  const { input, action, viewer, entityType, entityId, category, instance, def, step, summary, note, borne, ignorees } = ctx;

  // RENVOYER POUR CORRECTION (audit 360°, R02 — §118.186) : le geste et ses gardes vivent dans
  // `engine/gestes.ts` (`renvoyerPourCorrection`).
  if (action === "RETURN") return renvoyerPourCorrection(ctx);

  if (action === "REJECT") {
    if (!step.powers.includes("REJECT")) return { ok: false, error: "Le refus n'est pas autorisé à cette étape." };
    if (!note) return { ok: false, error: "Le motif du refus est obligatoire." };
    const next = nextStepAfter(def, step, borne, ignorees);

    if (next) {
      // Étape INTERMÉDIAIRE (National Sales, Direction Marketing…) : le refus n'est PAS
      // éliminatoire — c'est un AVIS DÉFAVORABLE. Il est consigné et le circuit
      // continue vers l'étape suivante (la décision finale reste à la Direction).
      const assigneeId = input.assigneeId?.trim() || null;
      // Montant révisé OPTIONNEL joint à l'avis défavorable : uniquement si l'étape porte le
      // pouvoir « fixer un montant » (SET_AMOUNT, ex. analyse Direction Marketing) et qu'un montant
      // positif est fourni. Sinon on reste sur le comportement actuel (aucun montant).
      const revisedAmount = step.powers.includes("SET_AMOUNT") && input.amount != null && input.amount > 0 ? input.amount : null;
      if (step.powers.includes("ASSIGN")) {
        if (!assigneeId) return { ok: false, error: "Même en cas d'avis défavorable, désignez la personne en charge de l'étape suivante." };
        const okUser = await prisma.user.count({ where: { id: assigneeId, isActive: true } });
        if (okUser === 0) return { ok: false, error: "La personne désignée est introuvable ou inactive." };
        await prisma.workflowInstance.update({ where: { id: instance.id }, data: { assigneeId } });
      }
      await projectApprove(entityType, entityId, step, next, {
        viewer, note, amount: revisedAmount, assigneeId, emitResult: null,
        nextLegacyStatus: next.legacyStatus ?? null, emitStep: false,
      });
      // ENCHAÎNE LES FRANCHISSEMENTS AUTOMATIQUES, exactement comme une approbation et un saut
      // (§118.138). L'avis défavorable était le SEUL des trois gestes d'avance à ne pas les
      // régler : la demande se posait alors sur une étape franchissable — la porte du Directeur
      // Général sous le seuil — et y restait, à attendre quelqu'un qui n'a rien à valider. Une
      // porte gardée à côté d'une porte ouverte, et c'est la même chose qui passe (§118.71).
      const montantApresAvis = revisedAmount ?? (toNumber(instance.amount) || (summary.estimatedAmount ?? 0));
      const apresAvis = (await settleAutoSkips(entityType, entityId, def, instance.id, montantApresAvis, summary.requesterId, next, viewer, borne, ignorees)) ?? next;
      // Le montant révisé devient le montant de TRAVAIL de l'instance (proposition portée à la
      // décision + base des franchissements auto par seuil en aval).
      const rejectInst: Prisma.WorkflowInstanceUpdateInput = { currentSlug: apresAvis.slug, status: "IN_PROGRESS" };
      if (revisedAmount != null) rejectInst.amount = revisedAmount;
      await prisma.workflowInstance.update({ where: { id: instance.id }, data: rejectInst });
      await recordEvent(instance.id, step, "OPINION_AGAINST", viewer, note, revisedAmount);
      // ON PRÉVIENT L'ÉTAPE OÙ L'ON SE POSE, pas la suivante nominale : après un franchissement
      // automatique, notifier `next` alerterait quelqu'un qui n'a plus rien à faire, et
      // laisserait le vrai destinataire sans signal.
      if (assigneeId && apresAvis.actorScope === "ASSIGNEE") {
        await notifyUser({ userId: assigneeId, type: "ASSIGNMENT", title: `${CATEGORY_LABELS[category]} — ${apresAvis.title} (avis défavorable en amont)`, body: summary.name, link: entityPath(entityType, entityId) });
      }
      await notifyStepManager(apresAvis, summary.requesterId, `${CATEGORY_LABELS[category]} — ${apresAvis.title}`, `${summary.name} — avis défavorable en amont`, entityPath(entityType, entityId));
      await prevenirEtapeAtteinte(entityType, entityId, apresAvis, { title: `${CATEGORY_LABELS[category]} — ${apresAvis.title}`, body: `${summary.name} — avis défavorable en amont`, link: entityPath(entityType, entityId) }, summary.requesterId);
      await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Avis défavorable (${step.title}) — ${summary.name}` });
      return { ok: true, category };
    }

    // DERNIÈRE étape (décision de la Direction) : le refus est définitif.
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { status: "REJECTED", currentSlug: null } });
    await projectReject(entityType, entityId, viewer, note);
    await recordEvent(instance.id, step, "REJECT", viewer, note, null);
    if (summary.requesterId) {
      // LE MOTIF VOYAGE AVEC LE REFUS (R03) : « demande refusée » sans dire pourquoi obligeait le
      // demandeur à chercher une explication qu'aucun écran ne lui montrait.
      await notifyUser({ userId: summary.requesterId, type: "GENERIC", title: `${CATEGORY_LABELS[category]} — demande refusée`, body: `${summary.name} — ${step.title} : ${note}`, link: `${entityPath(entityType, entityId)}` });
    }
    await recordAudit({ actorId: viewer.id, action: "REFUSE", module: auditModule(entityType), entityType, entityId, summary: `Refus définitif (${step.title}) — ${summary.name}` });
    return { ok: true, category };
  }

  // SKIP : sauter une étape INTERMÉDIAIRE, à la main, avec RAISON OBLIGATOIRE (anti-bureaucratie).
  // C'est tracé (WorkflowStepEvent « SKIP » + audit) et notifié à l'étape suivante. Interdit sur la
  // décision finale (pas d'étape suivante) et sur une étape de désignation (sinon plus personne en charge).
  if (action === "SKIP") {
    const next = nextStepAfter(def, step, borne, ignorees);
    if (!next) return { ok: false, error: "L'étape de décision finale ne peut pas être sautée." };
    if (step.powers.includes("ASSIGN")) return { ok: false, error: "Cette étape désigne le responsable de la suite : elle ne peut pas être sautée." };
    if (!note) return { ok: false, error: "Indiquez la raison du saut d'étape (elle est tracée et notifiée)." };

    // Avance sans approuver ni émettre : on projette uniquement le statut de l'étape suivante.
    await projectApprove(entityType, entityId, step, next, {
      viewer, note, amount: null, assigneeId: null, emitResult: null,
      nextLegacyStatus: next.legacyStatus ?? null, emitStep: false,
    });
    // Enchaîne d'éventuels franchissements automatiques par seuil de montant.
    const skipKnownAmount = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const landed = (await settleAutoSkips(entityType, entityId, def, instance.id, skipKnownAmount, summary.requesterId, next, viewer, borne, ignorees)) ?? next;
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: landed.slug, status: "IN_PROGRESS" } });
    await recordEvent(instance.id, step, "SKIP", viewer, note, null);

    const skipTitle = `${CATEGORY_LABELS[category]} — ${landed.title} (étape « ${step.title} » sautée)`;
    if (landed.actorScope === "ASSIGNEE" && instance.assigneeId) {
      await notifyUser({ userId: instance.assigneeId, type: "ASSIGNMENT", title: skipTitle, body: summary.name, link: entityPath(entityType, entityId) });
    }
    await notifyStepManager(landed, summary.requesterId, skipTitle, summary.name, entityPath(entityType, entityId));
    await prevenirEtapeAtteinte(entityType, entityId, landed, { title: skipTitle, body: summary.name, link: entityPath(entityType, entityId) }, summary.requesterId);
    await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Étape sautée : « ${step.title} » — ${summary.name} (raison : ${note})` });
    return { ok: true, category };
  }

  // action === APPROVE
  if (!step.powers.includes("APPROVE")) return { ok: false, error: "Cette étape ne permet pas d'approuver." };

  // L'ÉTAPE SUIVANTE, LUE ICI ET UNE SEULE FOIS — c'est elle qui dit si cette étape CONCLUT.
  //
  // Elle était calculée plus bas, et l'héritage d'émission se gouvernait sur la BORNE
  // (`estDecisionnaire`). Depuis que le parcours est un TAMIS, les deux ne coïncident plus : un
  // KAM n'a AUCUNE borne (Direction Marketing est la dernière étape de la définition) et saute
  // pourtant la Direction des opérations. Un Super Admin qui aurait posé l'ordre de dépense sur
  // cette étape-là aurait vu l'émission se perdre — budget accordé, rien d'engagé, aucune étape
  // en échec, exactement le silence que l'héritage existe pour fermer.
  //
  // « Y a-t-il une suite ? » est déjà l'unique lecture qui réunit la borne ET le tamis. On s'en
  // sert donc, au lieu d'en écrire une seconde qui divergerait (§118.5, §118.61) — et l'écran lit
  // la MÊME réponse (`lectureDeLApprobation`), pour proposer exactement les champs jugés ici.
  //
  // L'ÉMISSION HÉRITÉE DE TOUT CE QUI N'EST PAS ATTEINT — la queue coupée ET le tamis.
  //
  // Une demande de KAM s'arrête à Direction Marketing ; l'émission financière peut être déclarée
  // sur une étape qu'elle n'atteindra jamais. Sans cet héritage, la demande sort APPROUVÉE avec
  // son budget accordé écrit en base et Finance ne reçoit RIEN : l'argent est accordé, rien n'est
  // engagé, et aucune étape n'est en échec. On ne réécrit pas la définition pour autant (§118.5)
  // — le Super Admin a posé ses drapeaux où il les voulait ; c'est l'EXÉCUTION qui hérite, et
  // seulement à l'étape qui CONCLUT, une fois qu'il est sûr que rien d'autre ne viendra.
  //
  // LES POUVOIRS D'ARGENT SUIVENT LE MÊME CHEMIN, et c'est ce qui manquait (`pouvoirs-argent.ts`).
  // Hériter l'émission sans hériter le montant ne servait à rien : `emitFinancials` ne part pas
  // sans montant fixé, et la Direction des opérations, qui conclut la route d'un rang 2, n'avait
  // aucun moyen d'en fixer un — 12 demandes sur 12 sortaient approuvées sans budget ni dépense.
  // `etape` est donc l'étape TELLE QU'ELLE DÉCIDE : c'est elle qu'on juge (montant, catégorie) et
  // dont on lit l'issue ; `step` reste l'étape de la définition, pour tout le reste.
  const { next, conclut, nonAtteintes, etape } = lectureDeLApprobation(def, step, borne, ignorees);
  const emitDeclarationDue = step.emitDeclaration || nonAtteintes.some((s) => s.emitDeclaration);
  const emitExpenseOrderDue = step.emitExpenseOrder || nonAtteintes.some((s) => s.emitExpenseOrder);
  const emitStep = emitDeclarationDue || emitExpenseOrderDue;
  // UN SPONSORING DONT CETTE ÉTAPE PRÉ-VALIDE LA TENUE (§118.151) : l'argent se décidera APRÈS,
  // poste par poste puis à la clôture. La déclaration d'information médicale ne peut pas attendre
  // jusque-là — la clôture vient une fois l'événement passé, trop tard pour le déclarer.
  //
  // L'ISSUE SE LIT SUR L'ÉTAPE TELLE QU'ELLE DÉCIDE : sur le circuit par défaut, l'étape décisive
  // du sponsoring ne fixe aucun argent, donc rien n'est hérité et la tenue reste pré-validée. Sur
  // un circuit dont le Super Admin a laissé l'argent à Direction Marketing, l'étape qui conclut une
  // route coupée hérite ce pouvoir — et ACCORDE, exactement comme l'étape dont elle tient la place.
  //
  // DEPUIS LE 27/10/2026, C'EST LA RÈGLE DE TOUTES LES NATURES : la Direction Marketing PRÉVALIDE (le
  // fond de la demande et le montant demandé), puis l'argent se décide poste par poste, et le DG valide
  // le total au-dessus du seuil (`ad-pro/porte-dg.ts`). Un circuit dont l'étape qui conclut fixe encore
  // un montant (remodelé à la main) garde son comportement d'avant.
  const argentDecideApres = conclut && issueTerminaleSponsoring(etape) === "PRE_VALIDATED";
  const amount = input.amount ?? null;
  const budgetCategoryId = input.budgetCategoryId?.trim() || null;
  const assigneeId = input.assigneeId?.trim() || null;

  // Contrôles des champs requis par l'étape — telle qu'elle décide.
  if (step.powers.includes("ASSIGN") && !assigneeId) return { ok: false, error: "Désignez la personne en charge de l'étape suivante." };
  if (etape.requireAmount && !(amount != null && amount > 0)) return { ok: false, error: "Le montant est obligatoire à cette étape." };
  if (step.requireNote && !note) return { ok: false, error: "Un commentaire est obligatoire à cette étape." };
  if (etape.requireCategory && !budgetCategoryId) return { ok: false, error: "La (sous-)catégorie budgétaire est obligatoire à cette étape." };
  if (budgetCategoryId) {
    const okCat = await prisma.budgetCategoryLine.count({ where: { id: budgetCategoryId } });
    if (okCat === 0) return { ok: false, error: "La (sous-)catégorie budgétaire choisie est introuvable." };
  }
  if (assigneeId) {
    const okUser = await prisma.user.count({ where: { id: assigneeId, isActive: true } });
    if (okUser === 0) return { ok: false, error: "La personne désignée est introuvable ou inactive." };
  }

  // Effets sur l'instance : désignation, montant « accordé » (uniquement à l'étape
  // d'émission — sinon le montant est une PROPOSITION portée par la projection),
  // (sous-)catégorie budgétaire.
  const instData: Prisma.WorkflowInstanceUpdateInput = {};
  if (assigneeId) instData.assigneeId = assigneeId;
  if (budgetCategoryId) instData.budgetCategoryId = budgetCategoryId;
  // Le montant d'une étape « Fixer un montant » (proposition) OU de l'étape d'émission (accordé)
  // devient le montant de TRAVAIL de l'instance : base des franchissements auto par seuil en aval.
  if (amount != null && (emitStep || etape.powers.includes("SET_AMOUNT"))) instData.amount = amount;
  if (Object.keys(instData).length) await prisma.workflowInstance.update({ where: { id: instance.id }, data: instData });

  const refreshed = await prisma.workflowInstance.findUnique({ where: { id: instance.id } });
  const liveInstance = refreshed ?? instance;

  // Émission financière (à l'étape marquée) : information médicale (PRIM) ou, à défaut
  // de pharmacien, ordre de dépense direct → Finances.
  let emitResult: { declarationId: string | null; orderId: string | null } | null = null;
  if (emitStep) {
    emitResult = await emitFinancials(entityType, entityId,
      { emitDeclaration: emitDeclarationDue, emitExpenseOrder: emitExpenseOrderDue, argentDecideApres },
      liveInstance, summary, viewer);
  }

  // Projection « legacy » : écrit les champs de l'entité source attendus par l'UI. L'étape TELLE
  // QU'ELLE DÉCIDE, ici aussi : l'issue d'un sponsoring s'y relit (§118.151), et elle doit être la
  // même que celle que `argentDecideApres` vient de juger.
  await projectApprove(entityType, entityId, etape, next, {
    viewer, note, amount, assigneeId, emitResult,
    nextLegacyStatus: next?.legacyStatus ?? null,
    emitStep,
    // LE MONTANT ACCORDÉ EST CELUI DE L'INSTANCE, pas la saisie de l'étape qui conclut.
    //
    // La Direction n'a plus le pouvoir « fixer un montant » : elle accorde ce que Direction
    // Marketing a arbitré. Sans ce repli, son approbation écrivait `amountGranted = undefined`
    // — la demande passait APPROUVÉE, l'ordre de dépense partait avec 87 500 DZD, et la fiche
    // n'affichait aucun budget accordé.
    montantDeTravail: toNumber(liveInstance.amount) || null,
  });

  // Franchissements AUTOMATIQUES par seuil de montant (anti-bureaucratie) à partir de l'étape suivante.
  // Montant de référence : montant de travail de l'instance, à défaut l'estimation du demandeur.
  const knownAmount = toNumber(liveInstance.amount) || (summary.estimatedAmount ?? 0);
  const landed = await settleAutoSkips(entityType, entityId, def, instance.id, knownAmount, summary.requesterId, next, viewer, borne, ignorees);

  // Avance l'instance (ou clôture).
  await prisma.workflowInstance.update({
    where: { id: instance.id },
    data: { currentSlug: landed ? landed.slug : null, status: landed ? "IN_PROGRESS" : "APPROVED" },
  });

  await recordEvent(instance.id, step, "APPROVE", viewer, note, emitStep ? amount : amount);

  // Notifications d'entrée de l'étape où l'on se pose réellement (après d'éventuels franchissements auto).
  if (landed) {
    if (assigneeId && landed.actorScope === "ASSIGNEE") {
      await notifyUser({ userId: assigneeId, type: "ASSIGNMENT", title: `${CATEGORY_LABELS[category]} — ${landed.title}`, body: summary.name, link: entityPath(entityType, entityId) });
    }
    await notifyStepManager(landed, summary.requesterId, `${CATEGORY_LABELS[category]} — ${landed.title}`, summary.name, entityPath(entityType, entityId));
    await prevenirEtapeAtteinte(entityType, entityId, landed, { title: `${CATEGORY_LABELS[category]} — ${landed.title}`, body: summary.name, link: entityPath(entityType, entityId) }, summary.requesterId);
  } else if (summary.requesterId) {
    // « Pris en charge » annoncerait un financement : une tenue PRÉ-VALIDÉE n'en accorde aucun
    // encore. Le demandeur doit lire ce qui l'attend — les postes, puis la clôture (§118.151).
    const titreFin = argentDecideApres
      ? `${CATEGORY_LABELS[category]} — prévalidée : les postes se préparent`
      : `${CATEGORY_LABELS[category]} — pris en charge`;
    await notifyUser({ userId: summary.requesterId, type: "GENERIC", title: titreFin, body: summary.name, link: entityPath(entityType, entityId) });
  }

  await recordAudit({ actorId: viewer.id, action: next ? "UPDATE" : "VALIDATE", module: auditModule(entityType), entityType, entityId, summary: `${step.title} — ${summary.name}${emitResult?.orderId ? " (ordre de dépense émis)" : emitResult?.declarationId ? " (déclaration info médicale)" : ""}` });
  return { ok: true, category };
}

// ───────────────────────────── Effets & projection ─────────────────────────────

async function emitFinancials(
  entityType: EntityType,
  entityId: string,
  /**
   * Les émissions DUES à cette approbation — celles de l'étape, plus celles héritées de la queue
   * coupée — et `argentDecideApres` : l'étape décide la TENUE, pas l'argent (§118.151).
   */
  step: { emitDeclaration: boolean; emitExpenseOrder: boolean; argentDecideApres?: boolean },
  instance: LoadedInstance,
  summary: EntitySummary,
  viewer: Viewer,
): Promise<{ declarationId: string | null; orderId: string | null } | null> {
  const amount = toNumber(instance.amount);
  // SANS MONTANT FIXÉ, RIEN NE PART — sauf la déclaration d'une tenue pré-validée.
  //
  // La règle d'avant tient pour tout ce qui ENGAGE de l'argent : aucun ordre de dépense sur un
  // montant que personne n'a décidé (§118.16). Mais une tenue pré-validée n'engage rien encore, et
  // l'événement doit être déclaré AVANT d'avoir lieu : attendre la clôture, qui vient après
  // l'événement, reviendrait à ne jamais le déclarer à temps. La déclaration part donc sans
  // montant fixé, avec l'estimation que portent ses postes — une information, pas un engagement :
  // son montant ne sert qu'à l'ordre global que la Direction émettait à la validation de la
  // déclaration, et cet ordre-là n'est plus émis quand des postes portent la dépense
  // (`validateDeclarationByDirection`).
  if (!(amount > 0) && !step.argentDecideApres) return null;
  const budgetCategoryId = instance.budgetCategoryId ?? null;
  const requestedById = summary.requesterId ?? viewer.id;

  // Le pharmacien désigné — le plus ancien actif, déterministe (`pharmacienAssigne`).
  const pharmacist = await pharmacienAssigne();
  if (pharmacist && step.emitDeclaration) {
    const montantDeclare = await montantADeclarer(entityType, entityId, amount);
    const decl = await createMedicalInfoDeclaration({
      sourceType: entityType, sourceId: entityId, label: summary.label,
      beneficiary: summary.beneficiary, amount: montantDeclare, requesterId: requestedById, budgetCategoryId,
    });
    return { declarationId: decl.id, orderId: null };
  }
  // SANS PHARMACIEN : le paiement part comme avant — rien n'est bloqué ni débloqué ici.
  const paiement = await (async (): Promise<{ declarationId: string | null; orderId: string | null } | null> => {
    // Un ordre de dépense n'est JAMAIS émis sur un montant que personne n'a fixé.
    if (!(amount > 0)) return null;
    if (step.emitExpenseOrder) {
      // ANTI-DOUBLE COMPTAGE : si l'opération est VENTILÉE EN POSTES, chaque poste émet sa propre
      // pièce (bénéficiaires distincts : l'organisateur, l'agence, le prestataire). Émettre EN PLUS
      // un ordre global ferait payer la même dépense deux fois — c'est exactement ce qu'on voyait
      // dans « À régler » : un ordre de sponsoring de 53 350 DZD à côté de l'ordre du poste
      // « Prestation : Webinar » de 53 000 DZD, pour une seule et même dépense.
      const itemCount = await countAdProItems(entityType, entityId);
      if (itemCount > 0) {
        console.info(`[workflow] ${entityType} ${entityId} : ordre global NON émis — ${itemCount} poste(s) portent déjà la dépense.`);
        return { declarationId: null, orderId: null };
      }
      const order = await createExpenseOrder({
        label: summary.label, amount, category: "EVENEMENT", beneficiary: summary.beneficiary,
        sourceType: entityType, sourceId: entityId, requestedById, budgetCategoryId,
      });
      return { declarationId: null, orderId: order.id };
    }
    return null;
  })();
  // …MAIS LA DÉCLARATION NAÎT QUAND MÊME, non assignée (Direction, 10/2026). L'événement reste à déclarer
  // au ministère : sans pharmacien, il ne l'était jamais, et personne ne le voyait. Elle porte l'ordre déjà
  // parti, que la validation finale ne double pas (`ordreGlobalALaValidation`) ; elle n'est pas rendue à
  // l'appelant, dont le statut suit le paiement comme avant. Best-effort : le paiement est fait.
  if (step.emitDeclaration) {
    await createMedicalInfoDeclaration({
      sourceType: entityType, sourceId: entityId, label: summary.label, beneficiary: summary.beneficiary,
      amount: await montantADeclarer(entityType, entityId, amount), requesterId: requestedById, budgetCategoryId,
      expenseOrderId: paiement?.orderId ?? null,
    }).catch((e) => console.error("[workflow] déclaration non assignée non créée", e));
  }
  return paiement;
}

interface ProjectApproveCtx {
  viewer: Viewer;
  note: string | null;
  amount: number | null;
  assigneeId: string | null;
  emitResult: { declarationId: string | null; orderId: string | null } | null;
  nextLegacyStatus: string | null;
  emitStep: boolean;
  /** Le montant de travail de l'instance — repli quand l'étape qui conclut n'en fixe pas. */
  montantDeTravail?: number | null;
}

/** Écrit les champs « legacy » de l'entité source attendus par les frises/vues détail. */
async function projectApprove(entityType: EntityType, entityId: string, step: LoadedStep, next: LoadedStep | null, ctx: ProjectApproveCtx) {
  const now = new Date();
  const data: Record<string, unknown> = { updatedById: ctx.viewer.id };
  const statusField = LEGACY_FIELD[entityType] ?? "status";

  // Désignation (pouvoir ASSIGN) → Direction Marketing + méta préliminaire.
  if (ctx.assigneeId) {
    data.productManagerId = ctx.assigneeId;
    data.preliminaryById = ctx.viewer.id;
    data.preliminaryAt = now;
    data.preliminaryNote = ctx.note;
  }
  // Montant proposé (SET_AMOUNT hors étape d'émission) → budget Direction Marketing.
  if (!ctx.emitStep && step.powers.includes("SET_AMOUNT") && ctx.amount != null) {
    data.productManagerBudget = ctx.amount;
    data.productManagerNotes = ctx.note;
  }

  if (next) {
    // Étape intermédiaire : projeter le statut de l'étape suivante (si mappé).
    if (ctx.nextLegacyStatus) data[statusField] = ctx.nextLegacyStatus;
  } else {
    // Étape terminale : approbation définitive.
    const accorde = ctx.amount ?? ctx.montantDeTravail ?? null;
    if (entityType === "SPONSORING") {
      // LA TENUE, OU L'ARGENT (§118.151) — ce que l'étape qui conclut a réellement décidé.
      //
      // Pré-validée, la demande n'a encore AUCUN montant accordé ni validation signée : écrire
      // l'un ou l'autre ferait lire un budget accordé là où il n'y a qu'un accord de principe.
      // Le montant et la validation s'écriront à la CLÔTURE, sur le total des postes accordés.
      const issue = issueTerminaleSponsoring(step);
      data.status = issue;
      data.finalDecision = ctx.note;
      data.finalById = ctx.viewer.id;
      data.finalAt = now;
      if (issue === "APPROVED") {
        data.amountGranted = accorde ?? undefined;
        data.validatedBy = ctx.viewer.name ?? null;
        data.validationDate = now;
      }
      if (ctx.emitResult?.orderId) data.expenseOrderId = ctx.emitResult.orderId;
    } else {
      data.requestStatus = "APPROVED";
      data.status = "VALIDATED";
      data.finalById = ctx.viewer.id;
      data.finalAt = now;
      data.finalNote = ctx.note;
      if (accorde != null) data.finalAmount = accorde;
      if (ctx.emitResult?.orderId) data.expenseOrderId = ctx.emitResult.orderId;
    }
  }
  // L'ÉVÉNEMENT PORTE DEUX CHAMPS, et l'un cessait de suivre l'autre (§118.138).
  //
  // `requestStatus` est la décision du CIRCUIT ; `status` est l'état de vie de l'événement, et il
  // se tapait à la main dans « Modifier » — d'où des événements affichés « Validé » qu'aucune
  // étape n'avait validés. Le formulaire ne peut plus écrire ces deux valeurs-là
  // (`lib/events/statut.ts`) ; il fallait donc que le circuit, lui, les écrive : sans cette
  // ligne, un événement validé serait resté « Brouillon » pour toujours — un refus à tort, plus
  // coûteux que le défaut corrigé (§118.27). Une seule lecture, celle que `data` vient d'écrire,
  // pour que les deux branches (intermédiaire et terminale) ne puissent pas diverger.
  if (entityType === "EVENT") {
    const impose = statutDepuisCircuit(typeof data.requestStatus === "string" ? data.requestStatus : null);
    if (impose) data.status = impose;
  }

  // Étape d'émission NON terminale : consigner tout de même le montant accordé.
  if (ctx.emitStep && next) {
    if (entityType === "SPONSORING") data.amountGranted = ctx.amount ?? undefined;
    else if (ctx.amount != null) data.finalAmount = ctx.amount;
  }

  await updateEntity(entityType, entityId, data);
}

/**
 * RESOUMETTRE UNE DEMANDE RENVOYÉE POUR CORRECTION (audit 360°, R02 et R15 — §118.186).
 *
 * La demande revient à l'étape qui l'a renvoyée — la personne qui a demandé la correction juge la
 * correction — sauf si le montant corrigé ne franchit plus une porte qu'il avait franchie sous le
 * seuil : la porte se rouvre, et la demande reprend là (`etapeDeReprise`). Puis les
 * franchissements automatiques s'enchaînent depuis cette étape, exactement comme à la naissance :
 * un montant revu à la baisse ouvre seul la porte du DG que la version d'avant lui faisait garder.
 *
 * L'écriture est CONDITIONNELLE (`status: "RETURNED"`) : deux clics simultanés ne resoumettent
 * qu'une fois, et le second le dit.
 */
export async function resubmitWorkflowInstance(input: { viewer: Viewer; entityType: EntityType; entityId: string; note?: string | null }): Promise<ResultatRevision> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) return { ok: false, error: "Circuit introuvable." };
  if (instance.status !== "RETURNED") return { ok: false, error: "Cette demande n'est pas à corriger : il n'y a rien à resoumettre." };
  const summary = await loadEntity(entityType, entityId);
  if (!summary) return { ok: false, error: "Demande introuvable." };
  if (!peutResoumettre({ id: viewer.id, vueGlobale: hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN" }, summary.requesterId)) {
    return { ok: false, error: "Seul le demandeur (ou la Direction) resoumet une demande renvoyée pour correction." };
  }
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: "RETURNED" }, prise));
  if (posee.count === 0) return { ok: false, error: "La demande a déjà été resoumise, ou quelqu'un agit dessus au même instant." };
  try {
    const def = await chargerDefinition(instance);
    if (!def) return { ok: false, error: "Définition de workflow introuvable." };
    const retour = stepBySlug(def, instance.currentSlug);
    if (!retour) return { ok: false, error: "L'étape qui a renvoyé la demande n'existe plus dans le circuit : la Direction doit la reprendre." };
    const borne = instance.finalSlug ?? null;
    const ignorees = instance.skippedSlugs ?? [];
    const note = input.note?.trim() || null;

    const montant = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const seuilDgGlobal = await getAppSettings().then((st) => st.adProDgThreshold).catch(sansBloquer("workflow-engine.resubmitWorkflowInstance.getAppSettings", null));
    const reprise = etapeDeReprise(orderedSteps(def), retour, await franchiesParMontant(instance.id), (e) => autoSkipEligible(e, montant, seuilDgGlobal), ignorees);

    const pris = await prisma.workflowInstance.updateMany({
      where: { id: instance.id, status: "RETURNED" },
      data: { status: "IN_PROGRESS", currentSlug: reprise.slug },
    });
    if (pris.count === 0) return { ok: false, error: "La demande a déjà été resoumise." };

    await projectPose(entityType, entityId, def, reprise, ignorees, viewer);
    const pose = (await settleAutoSkips(entityType, entityId, def, instance.id, montant, summary.requesterId, reprise, viewer, borne, ignorees)) ?? reprise;
    if (pose.slug !== reprise.slug) await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: pose.slug } });

    const porteRouverte = reprise.slug !== retour.slug;
    const trace = porteRouverte
      ? `${note ? `${note} — ` : ""}le montant (${montant} DZD) ne franchit plus « ${reprise.title} » : la demande y reprend.`
      : note;
    await recordEvent(instance.id, pose, "RESUBMIT", viewer, trace, null);

    const titre = `${CATEGORY_LABELS[category]} — ${pose.title} (corrigée et resoumise)`;
    const corps = note ? `${summary.name} — ${note}` : summary.name;
    await prevenirLaPose(entityType, entityId, instance, pose, summary.requesterId, titre, corps);
    // CELUI QUI A DEMANDÉ LA CORRECTION l'attend. Quand la demande revient à SON étape, la notification
    // de l'étape le prévient déjà (il en porte le rôle, puisqu'il y a agi) ; quand une porte rouverte la
    // fait reprendre AVANT son étape, personne d'autre ne le lui dirait.
    const renvoi = porteRouverte
      ? await prisma.workflowStepEvent.findFirst({ where: { instanceId: instance.id, action: "RETURN" }, orderBy: { createdAt: "desc" }, select: { actorId: true } })
      : null;
    if (renvoi?.actorId && renvoi.actorId !== viewer.id) {
      await notifyUser({ userId: renvoi.actorId, type: "VALIDATION_REQUIRED", title: titre, body: corps, link: entityPath(entityType, entityId) });
    }
    await recordAudit({
      actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId,
      summary: `Corrigée et resoumise — ${summary.name}${porteRouverte ? ` (porte « ${reprise.title} » rouverte)` : ""}`,
    });
    return { ok: true, category, etape: pose.title };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.resubmitWorkflowInstance.workflowInstance"));
  }
}

/**
 * RETIRER UNE DEMANDE QUI N'EST PAS ENCORE TRANCHÉE (audit 360°, R24 — §118.186).
 *
 * Le demandeur ne pouvait pas retirer sa propre demande : l'action existait pour les congrès, sans
 * écran, et n'existait pas pour le sponsoring ni l'événement. Retirer est un geste qui RÉDUIT
 * (§118.15) : il ne touche à rien de ce qui a quitté l'ERP, et c'est la condition qu'on vérifie —
 * un poste qui engage déjà la dépense (bon de commande demandé, ordre émis) l'interdit, avec le
 * geste qui débloque. Le motif est obligatoire (règle commune des gestes définitifs, R17) ; la
 * permission est vérifiée par l'APPELANT, qui seul connaît la session.
 *
 * RETIRER, C'EST SUPPRIMER (Direction, 05/10) : « quand je retire une demande Ad&Pro, elle doit être
 * TOTALEMENT supprimée — évidemment toujours récupérable depuis la corbeille par le Super Admin ».
 * Le moteur ne fait plus que JUGER si la demande se retire (état du circuit, postes engagés) et tient
 * la prise du circuit pendant que l'APPELANT supprime : la suppression est le cœur réversible de la
 * corbeille (`supprimerReversible`, un lot, une transaction), qui emporte avec la demande son circuit,
 * ses validations, ses ordres non réglés, ses postes et ses pièces — et refuse ce qui a quitté l'ERP.
 * Fermer le circuit AVANT de supprimer aurait laissé, sur un refus du lot, une demande « annulée »
 * qu'on n'a pas supprimée : l'ordre inverse (juger, supprimer, rien d'autre) ne laisse jamais un
 * état à moitié. Le cœur de la suppression n'est pas importé ici — le domaine du circuit ne lit pas
 * celui de la corbeille —, il arrive en argument, et il est appelé APRÈS tous les refus.
 */
export async function retirerDemande(input: {
  viewer: Viewer; entityType: EntityType; entityId: string; motif: string;
  supprimer: (nom: string) => Promise<{ ok: boolean; error?: string; redirect?: string }>;
}): Promise<ResultatRevision & { redirect?: string }> {
  const { entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const motif = input.motif.trim();
  if (!motif) return { ok: false, error: "Dites pourquoi vous retirez la demande : le motif reste au journal." };
  const instance = await ensureInstance(entityType, entityId);
  if (!instance) return { ok: false, error: "Circuit introuvable." };
  if (instance.status !== "IN_PROGRESS" && instance.status !== "RETURNED") {
    return { ok: false, error: "La demande est déjà tranchée ou close : elle ne se retire plus." };
  }
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["IN_PROGRESS", "RETURNED"] } }, prise));
  if (posee.count === 0) return { ok: false, error: CIRCUIT_PRIS };
  try {
    const colonne = PARENT_COLONNE[entityType as AdProParent];
    if (colonne) {
      const engages = await prisma.adProItem.count({
        where: { [colonne]: entityId, OR: [{ expenseOrderId: { not: null } }, { orderStage: { in: ["REQUESTED", "DIRECTION_OK", "ISSUED"] } }] },
      });
      if (engages > 0) {
        return { ok: false, error: `${engages} poste(s) de cette demande engagent déjà la dépense (bon de commande demandé ou ordre émis) : retirez ou annulez d'abord ces postes.` };
      }
    }
    const summary = await loadEntity(entityType, entityId);
    if (!summary) return { ok: false, error: "Demande introuvable." };
    // LA SUPPRESSION, sous la prise : plus personne ne décide, approuve ou renvoie cette demande pendant
    // qu'elle part. Un refus du lot (de l'argent est parti, une pièce est signée) rend la demande telle
    // qu'elle était — la prise est rendue plus bas, rien n'a été écrit.
    const supprime = await input.supprimer(summary.name);
    if (!supprime.ok) return { ok: false, error: supprime.error ?? "La demande n'a pas pu être supprimée." };
    return { ok: true, category, etape: "", redirect: supprime.redirect };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.retirerDemande.workflowInstance"));
  }
}

/**
 * UN NOUVEAU CYCLE POUR UNE DEMANDE REFUSÉE OU ANNULÉE (audit 360°, R01 — §118.186).
 *
 * Un événement refusé ne pouvait JAMAIS être resoumis : l'instance de circuit est unique par
 * demande, et elle restait close. On la ROUVRE plutôt que d'en créer une seconde — l'historique du
 * premier cycle reste lisible, motif du refus compris — sur l'étape d'entrée que le statut
 * fraîchement écrit désigne (`positionFromLegacy`, la même lecture qu'à la naissance), puis les
 * franchissements automatiques s'enchaînent comme à la naissance.
 */
export async function relancerCycle(input: {
  viewer: Viewer; entityType: EntityType; entityId: string; note: string;
  /** L'écriture de la demande relancée, faite SOUS la prise — avant que le circuit relise son statut d'entrée. */
  preparer?: () => Promise<void>;
}): Promise<ResultatRevision> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) {
    // Jamais ouverte : la première lecture la créera à la bonne étape, d'après la demande écrite.
    if (input.preparer) await input.preparer();
    const neuve = await ensureInstance(entityType, entityId);
    return neuve ? { ok: true, category, etape: neuve.currentSlug ?? "" } : { ok: false, error: "Impossible d'ouvrir le circuit." };
  }
  if (instance.status !== "REJECTED" && instance.status !== "CANCELLED") return { ok: false, error: "Cette demande n'est ni refusée ni annulée : son circuit est toujours ouvert." };
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["REJECTED", "CANCELLED"] } }, prise));
  if (posee.count === 0) return { ok: false, error: "La demande vient d'être relancée, ou quelqu'un agit dessus au même instant." };
  try {
    // La demande s'écrit d'abord, sous la prise : l'étape d'entrée se lit sur son statut FRAIS.
    if (input.preparer) await input.preparer();
    const def = await chargerDefinition(instance);
    const summary = await loadEntity(entityType, entityId);
    if (!def || !summary) return { ok: false, error: "Demande introuvable." };
    const { currentSlug } = positionFromLegacy(orderedSteps(def), summary.legacyStatus);
    const depart = stepBySlug(def, premiereEtapeTraversee(def, currentSlug, instance.skippedSlugs ?? []));
    if (!depart) return { ok: false, error: "Le circuit n'a pas d'étape d'entrée pour cette demande." };
    const pris = await prisma.workflowInstance.updateMany({
      where: { id: instance.id, status: { in: ["REJECTED", "CANCELLED"] } },
      data: { status: "IN_PROGRESS", currentSlug: depart.slug, assigneeId: null, amount: null },
    });
    if (pris.count === 0) return { ok: false, error: "La demande vient d'être relancée." };
    const montant = summary.estimatedAmount ?? 0;
    const pose = montant > 0
      ? (await settleAutoSkips(entityType, entityId, def, instance.id, montant, summary.requesterId, depart, viewer, instance.finalSlug ?? null, instance.skippedSlugs ?? [])) ?? depart
      : depart;
    if (pose.slug !== depart.slug) await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: pose.slug } });
    await recordEvent(instance.id, pose, "RESUBMIT", viewer, `Nouveau cycle — ${input.note}`, null);
    await prevenirLaPose(entityType, entityId, instance, pose, summary.requesterId, `${CATEGORY_LABELS[category]} — ${pose.title} (nouvelle demande après refus)`, `${summary.name} — ${input.note}`);
    return { ok: true, category, etape: pose.title };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.relancerCycle.workflowInstance"));
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OUVRIR LE CIRCUIT À LA CRÉATION — et prévenir CHAQUE acteur (décision #1, Direction 27/10/2026).
 *
 * « À la création, ça doit notifier tous les acteurs concernés, puis chaque personne à son tour. »
 * L'instance naissait paresseusement, à la première ouverture de la fiche : personne n'était prévenu
 * par le circuit, et les actions de création prévenaient des rôles écrits à la main (la Direction pour
 * une demande que le Directeur des opérations devait voir). Désormais :
 *   • l'instance naît avec la demande (son parcours est figé à cet instant, comme avant) ;
 *   • l'acteur de l'étape où elle se pose reçoit « à vous d'agir » ;
 *   • les acteurs des étapes SUIVANTES de SON parcours sont prévenus pour information ;
 *   • chacun recevra ensuite « à vous d'agir » quand son tour viendra (`prevenirEtapeAtteinte`).
 * Une demande prévalidée d'office n'a plus personne à attendre : son créateur a déjà été notifié par
 * le geste qui l'a prévalidée. Ne lève jamais : la demande est créée, quoi qu'il arrive ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function ouvrirLeCircuit(entityType: EntityType, entityId: string): Promise<void> {
  try {
    const category = entityToCategory(entityType);
    if (!category) return;
    const avant = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { id: true } });
    const inst = await ensureInstance(entityType, entityId);
    if (!inst || avant || inst.status !== "IN_PROGRESS") return;
    const [def, summary] = await Promise.all([chargerDefinition(inst), loadEntity(entityType, entityId)]);
    if (!def || !summary) return;
    const courante = stepBySlug(def, inst.currentSlug);
    if (!courante) return;
    const link = entityPath(entityType, entityId);
    await prevenirLaPose(entityType, entityId, inst, courante, summary.requesterId, `${CATEGORY_LABELS[category]} — ${courante.title} : à vous d'agir`, summary.name);
    // LES ÉTAPES SUIVANTES DE CE PARCOURS (le tamis gelé exclu), pour information — par le même
    // point unique, pour que les référents de la gamme l'apprennent aussi quand le marketing est sur la route.
    const ignorees = inst.skippedSlugs ?? [];
    const route = orderedSteps(def).filter((s) => !ignorees.includes(s.slug));
    const ici = route.findIndex((s) => s.slug === courante.slug);
    const dejaPrevenus = new Set<string>(courante.notifyRoles);
    const roles = new Set<UserRole>();
    for (const s of route.slice(ici + 1)) {
      for (const r of s.notifyRoles) if (!dejaPrevenus.has(r) && r !== "SUPER_ADMIN") roles.add(r as UserRole);
    }
    const suivante = route[ici + 1];
    if (roles.size && suivante) {
      await prevenirEtapeAtteinte(entityType, entityId, { ...suivante, notifyRoles: [...roles] }, {
        title: `${CATEGORY_LABELS[category]} — nouvelle demande (pour information)`,
        body: `${summary.name} — elle vous parviendra après « ${courante.title} ».`,
        link,
      }, summary.requesterId, "GENERIC");
    }
  } catch (e) {
    console.error("[workflow] ouverture du circuit à la création (non bloquant)", entityType, entityId, e);
  }
}
