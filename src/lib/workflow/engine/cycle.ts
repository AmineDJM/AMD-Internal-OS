/**
 * Moteur de workflow — LE CYCLE DE VIE (hors avance) : modification après avis, fermeture et
 * clôture du circuit, réouverture en appel.
 */
import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { toNumber } from "@/lib/utils";
import { estIgnoree } from "../parcours";
import { getAppSettings } from "@/lib/settings";
import { auteursDAvis, etapeDeReprise } from "../renvoi";
import { CATEGORY_LABELS, entityToCategory, type WorkflowCategory } from "../types";
import { sansBloquer } from "@/lib/journal";
import { autoSkipEligible, chargerDefinition, franchiesParMontant, type LoadedStep, orderedSteps, stepBySlug, type Viewer } from "./definitions";
import { entityPath, loadEntity, recordEvent } from "./entites";
import { argsPrise, argsRendre, prendreLeCircuitEnAttendant } from "./prise";
import { projectPose } from "./projections";
import { prevenirEtapeAtteinte, prevenirLaPose } from "./notifications";

// ───────────────────────────── Révision : resoumettre, rouvrir, relancer, fermer ─────────────────────────────

export type ResultatRevision = { ok: true; category: WorkflowCategory; etape: string } | { ok: false; error: string };

/**
 * APRÈS UNE MODIFICATION DE LA DEMANDE EN COURS DE CIRCUIT (audit 360°, R15 — §118.186).
 *
 * Une correction faite après un premier avis ne rouvrait rien et ne prévenait personne : la
 * personne qui avait approuvé 200 000 DZD n'apprenait jamais qu'on en demandait 400 000, et une
 * porte du DG franchie sous le seuil restait franchie pour une demande qui l'avait dépassé.
 *   • une porte franchie PAR LE MONTANT et que le montant ne franchit plus se ROUVRE — la demande
 *     y retourne (même règle que la resoumission, `etapeDeReprise`) ;
 *   • si quelqu'un a DÉJÀ donné un avis, l'étape courante et les auteurs d'avis sont prévenus de ce
 *     qui a changé. Avant tout avis, on ne prévient personne : nul n'a encore rien regardé, et une
 *     notification par faute de frappe corrigée serait du bruit qu'on cesse de lire (§118.32).
 * Une demande À CORRIGER n'est pas concernée : la resoumission fera les deux.
 */
export async function apresModificationDeLaDemande(input: { viewer: Viewer; entityType: EntityType; entityId: string; changes: readonly string[] }): Promise<{ porteRouverte: string | null }> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { porteRouverte: null };
  const lu = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { id: true, status: true } });
  if (!lu || lu.status !== "IN_PROGRESS") return { porteRouverte: null };
  // Un geste en cours — une approbation qui part — se termine d'abord : la porte se juge sur
  // l'étape où il aura laissé la demande, pas sur celle qu'on a lue avant lui. La modification est
  // déjà enregistrée ; c'est sa SUITE qui attend son tour, quelques secondes au plus.
  const prise = await prendreLeCircuitEnAttendant(lu.id, { status: "IN_PROGRESS" }, 5_000);
  if (!prise) return { porteRouverte: null };
  try {
    // RELUE sous la prise : le geste qu'on a attendu a pu déplacer l'étape.
    const instance = await prisma.workflowInstance.findUnique({ where: { id: lu.id } });
    if (!instance || instance.status !== "IN_PROGRESS") return { porteRouverte: null };
    const def = await chargerDefinition(instance);
    const courante = def ? stepBySlug(def, instance.currentSlug) : null;
    const summary = await loadEntity(entityType, entityId);
    if (!def || !courante || !summary) return { porteRouverte: null };
    const ignorees = instance.skippedSlugs ?? [];
    const link = entityPath(entityType, entityId);

    const montant = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const seuilDgGlobal = await getAppSettings().then((st) => st.adProDgThreshold).catch(sansBloquer("workflow-engine.apresModificationDeLaDemande.getAppSettings", null));
    const reprise = etapeDeReprise(orderedSteps(def), courante, await franchiesParMontant(instance.id), (e) => autoSkipEligible(e, montant, seuilDgGlobal), ignorees);

    let porteRouverte: string | null = null;
    let etapeAPrevenir = courante;
    if (reprise.slug !== courante.slug) {
      const pris = await prisma.workflowInstance.updateMany({
        where: { id: instance.id, status: "IN_PROGRESS", currentSlug: courante.slug },
        data: { currentSlug: reprise.slug },
      });
      if (pris.count > 0) {
        porteRouverte = reprise.title;
        etapeAPrevenir = reprise;
        await projectPose(entityType, entityId, def, reprise, ignorees, viewer);
        await recordEvent(instance.id, reprise, "REOPEN", viewer, `Montant porté à ${montant} DZD : « ${reprise.title} » n'est plus franchie sous le seuil — la demande y revient.`, null);
        await prevenirLaPose(entityType, entityId, instance, reprise, summary.requesterId, `${CATEGORY_LABELS[category]} — ${reprise.title} (montant relevé)`, summary.name);
      }
    }

    const historique = await prisma.workflowStepEvent.findMany({ where: { instanceId: instance.id }, select: { action: true, actorId: true }, orderBy: { createdAt: "asc" } });
    const auteurs = auteursDAvis(historique, [viewer.id, summary.requesterId]);
    if (auteurs.length > 0 && input.changes.length > 0) {
      const corps = `${summary.name} — ${input.changes.join(" · ")}`;
      for (const userId of auteurs) {
        await notifyUser({ userId, type: "VALIDATION_REQUIRED", title: `${CATEGORY_LABELS[category]} — demande modifiée après votre avis`, body: corps, link });
      }
      // L'étape courante, si la porte rouverte ne l'a pas déjà prévenue : elle décidera sur la version
      // modifiée, et doit savoir ce qui a changé depuis les avis qu'elle lit.
      if (!porteRouverte) {
        await prevenirEtapeAtteinte(entityType, entityId, etapeAPrevenir, { title: `${CATEGORY_LABELS[category]} — ${etapeAPrevenir.title} (demande modifiée)`, body: corps, link }, summary.requesterId);
      }
    }
    return { porteRouverte };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(lu.id, prise)).catch(sansBloquer("workflow-engine.apresModificationDeLaDemande.workflowInstance"));
  }
}

/**
 * FERMER LE CIRCUIT D'UNE DEMANDE RETIRÉE, ANNULÉE OU TRANSFÉRÉE.
 *
 * L'annulation et le transfert écrivaient le statut de l'ENTITÉ et laissaient l'instance « en
 * cours » : le panneau proposait encore « Approuver » sur une demande annulée, et l'approuver
 * aurait émis l'argent d'une demande que son auteur avait retirée. Une demande close ferme son
 * circuit, en une écriture conditionnelle (rien à fermer = rien d'écrit), avec sa raison au journal.
 */
export async function fermerInstance(input: { viewer: Viewer; entityType: EntityType; entityId: string; motif: string }): Promise<boolean> {
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } } });
  if (!instance) return false;
  // Toujours la SUITE d'une décision déjà écrite (un transfert a déplacé les pièces) : on attend
  // qu'un geste en cours se termine plutôt que de laisser le circuit de la source ouvert.
  const prise = await prendreLeCircuitEnAttendant(instance.id, { status: { in: ["IN_PROGRESS", "RETURNED"] } }, 5_000);
  if (!prise) return false;
  try {
    const def = await chargerDefinition(instance);
    const etape = def ? stepBySlug(def, instance.currentSlug) : null;
    const pris = await prisma.workflowInstance.updateMany(clotureDuCircuit(instance.id));
    if (pris.count === 0) return false;
    await prisma.workflowStepEvent.create(evenementDeCloture(instance.id, etape, input.viewer, input.motif));
    return true;
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.fermerInstance.workflowInstance"));
  }
}

/**
 * LA CLÔTURE D'UN CIRCUIT — ses ARGUMENTS, partagés par ses deux écrivains (`fermerInstance`,
 * `retirerDemande`), qui gardent chacun l'APPEL Prisma dans leur propre corps.
 *
 * Pourquoi pas une seule fonction qui écrit : la dérivation des contrats d'action ne suit qu'UN
 * niveau de délégation (`faitsEcritureImportes`). Quand `retirerDemande` déléguait sa clôture à
 * `fermerInstance`, les deux actions qui l'appellent — annuler un congrès, retirer une demande —
 * se décrivaient « n'écrit rien », et la carte de confirmation aurait annoncé une lecture. C'est
 * le partage de §118.137 : la partie qu'on ne veut pas voir diverger (la condition, l'état écrit,
 * la ligne d'historique) vit une fois ; l'écriture reste visible là où elle a lieu.
 */
function clotureDuCircuit(instanceId: string) {
  return {
    where: { id: instanceId, status: { in: ["IN_PROGRESS", "RETURNED"] } },
    data: { status: "CANCELLED", currentSlug: null },
  } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

function evenementDeCloture(instanceId: string, etape: LoadedStep | null, viewer: Viewer, motif: string) {
  return {
    data: {
      instanceId, stepSlug: etape?.slug ?? "__cancel__", stepTitle: etape?.title ?? "Demande close",
      action: "CANCEL", actorId: viewer.id, actorName: viewer.name ?? null, note: motif,
    },
  } satisfies Prisma.WorkflowStepEventCreateArgs;
}

/**
 * L'APPEL D'UNE DÉCISION ROUVRE LE CIRCUIT À L'ÉTAPE QUI A TRANCHÉ (audit 360°, R04 — §118.186).
 *
 * Il rouvrait sur la première étape à portée « personne désignée », sinon la DEUXIÈME étape — la
 * porte du DG depuis l'inversion du circuit : sans franchissement ni notification, le dossier
 * attendait un Directeur Général qui n'avait rien à juger, pendant que l'écran promettait « un
 * nouvel examen de la Direction Marketing ». L'appel conteste une DÉCISION ; il revient à qui l'a
 * rendue — la borne du parcours, sinon la dernière étape de sa route —, qui est prévenu.
 *
 * Rend le titre de cette étape, pour que l'écran et la notification disent la vérité.
 */
export async function reopenInstance(entityType: EntityType, entityId: string, viewer?: Viewer, motif?: string | null): Promise<{ etape: string | null; rolesPrevenus: string[] }> {
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) return { etape: null, rolesPrevenus: [] };
  const def = await chargerDefinition(instance);
  if (!def) return { etape: null, rolesPrevenus: [] };
  const etapes = orderedSteps(def);
  const ignorees = instance.skippedSlugs ?? [];
  const decision = (instance.finalSlug ? stepBySlug(def, instance.finalSlug) : null)
    ?? [...etapes].reverse().find((s) => !estIgnoree(s.slug, ignorees))
    ?? etapes[etapes.length - 1];
  if (!decision) return { etape: null, rolesPrevenus: [] };
  // Seule une décision RENDUE se conteste : deux appels simultanés n'en rouvrent qu'un.
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["APPROVED", "REJECTED"] } }, prise));
  if (posee.count === 0) return { etape: null, rolesPrevenus: [] };
  try {
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: decision.slug, status: "IN_PROGRESS" } });
    if (viewer) {
      await recordEvent(instance.id, decision, "APPEAL", viewer, motif?.trim() || null, null);
      const summary = await loadEntity(entityType, entityId);
      const category = entityToCategory(entityType);
      if (summary && category) {
        await prevenirLaPose(entityType, entityId, instance, decision, summary.requesterId, `${CATEGORY_LABELS[category]} — appel à réexaminer (${decision.title})`, motif?.trim() ? `${summary.name} — ${motif.trim()}` : summary.name);
      }
    }
    // Les rôles que l'étape qui tranche vient de prévenir : l'appelant qui INFORME d'autres rôles
    // (la Direction, pour un appel) ne les prévient pas une seconde fois.
    return { etape: decision.title, rolesPrevenus: viewer ? [...(decision.notifyRoles ?? [])] : [] };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.reopenInstance.workflowInstance"));
  }
}
