import type { EntityType, WorkflowInstance, WorkflowStep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canActOnStep } from "@/lib/workflow/engine";
import { acteurDe } from "@/lib/workflow/frise-circuit";
import { sansBloquer } from "@/lib/journal";
import { AD_PRO_ENTITY_TYPE, type AdProKind, type AdProRequest } from "@/modules/ad-pro/partage";
import { cleDemande, estClose, type AttenteDemande, type LigneAdPro } from "./liste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CHEZ QUI EN EST CHAQUE DEMANDE — une LECTURE d'affichage pour le tableau d'Ad & Pro, rien d'autre.
 *
 * La liste unifiée (`getAdProRequests`) reste telle quelle : ses lignes, sa portée, son ordre. On lit À CÔTÉ,
 * pour les seules demandes qu'elle a rendues, ce que l'écran affiche en plus — l'étape du circuit et qui la
 * tient, depuis quand, la prochaine date, et si c'est à la personne qui regarde. Lecture en LOT (une requête par
 * table, jamais une par ligne), et une panne ici ne vide pas le tableau : il s'affiche sans ces colonnes.
 *
 * « À VOUS » EST LA RÈGLE DU CIRCUIT (`canActOnStep`), celle qui ouvre la carte « À vous » de la fiche : une seule
 * règle, deux écrans. Une seule nuance, celle d'une LISTE : le Super Admin passe partout, et le dire « à vous » sur
 * chaque ligne ne mettrait plus rien en évidence — on ne lui marque que ce qui lui est adressé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les faits d'une demande que la liste n'a pas : son demandeur (l'identifiant), ses dates. */
interface Faits {
  requesterId: string | null;
  echeance: Date | null;
  /** Le dernier renvoi au demandeur, quand le modèle le date. */
  renvoyeeLe: Date | null;
  majLe: Date;
}

/** « le N+1 du demandeur » plutôt que la phrase de l'éditeur de circuits : la colonne n'a la place que d'un nom. */
const QUI_COURT: Record<string, string> = {
  GLOBAL_VIEW: "la Direction",
  REQUESTER: "le demandeur",
  DEPARTMENT_MANAGER: "le N+1 du demandeur",
  DEPARTMENT_HEAD: "le responsable du département",
  ASSIGNEE: "la personne désignée",
};

const idsDe = (rows: readonly AdProRequest[], kind: AdProKind) => rows.filter((r) => r.kind === kind).map((r) => r.id);

async function lireFaits(rows: readonly AdProRequest[]): Promise<Map<string, Faits>> {
  const ids = (k: AdProKind) => idsDe(rows, k);
  const vide = <T,>(k: AdProKind, lire: (ids: string[]) => Promise<T[]>): Promise<T[]> =>
    ids(k).length ? lire(ids(k)).catch(sansBloquer(`ad-pro.liste.faits.${k}`, [] as T[])) : Promise.resolve([]);
  const [spo, intl, nat, evt, promo, cons, autre] = await Promise.all([
    vide("SPONSORING", (id) => prisma.sponsoringRequest.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, updatedAt: true } })),
    vide("CONGRESS_INTERNATIONAL", (id) => prisma.congressInternational.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, startDate: true, updatedAt: true } })),
    vide("CONGRESS_NATIONAL", (id) => prisma.congressNational.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, date: true, updatedAt: true } })),
    vide("EVENT", (id) => prisma.event.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, startDate: true, updatedAt: true } })),
    vide("PROMO_MATERIAL", (id) => prisma.promoMaterial.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, neededBy: true, returnedAt: true, updatedAt: true } })),
    vide("CONSULTING", (id) => prisma.consultingContract.findMany({ where: { id: { in: id }, pole: "AD_PRO" }, select: { id: true, requesterId: true, endDate: true, returnedAt: true, updatedAt: true } })),
    vide("OTHER", (id) => prisma.adProOtherRequest.findMany({ where: { id: { in: id } }, select: { id: true, requesterId: true, updatedAt: true } })),
  ]);
  const out = new Map<string, Faits>();
  const poser = (kind: AdProKind, id: string, f: Faits) => out.set(cleDemande({ kind, id }), f);
  for (const r of spo) poser("SPONSORING", r.id, { requesterId: r.requesterId, echeance: null, renvoyeeLe: null, majLe: r.updatedAt });
  for (const r of intl) poser("CONGRESS_INTERNATIONAL", r.id, { requesterId: r.requesterId, echeance: r.startDate, renvoyeeLe: null, majLe: r.updatedAt });
  for (const r of nat) poser("CONGRESS_NATIONAL", r.id, { requesterId: r.requesterId, echeance: r.date, renvoyeeLe: null, majLe: r.updatedAt });
  for (const r of evt) poser("EVENT", r.id, { requesterId: r.requesterId, echeance: r.startDate, renvoyeeLe: null, majLe: r.updatedAt });
  for (const r of promo) poser("PROMO_MATERIAL", r.id, { requesterId: r.requesterId, echeance: r.neededBy, renvoyeeLe: r.returnedAt, majLe: r.updatedAt });
  for (const r of cons) poser("CONSULTING", r.id, { requesterId: r.requesterId, echeance: r.endDate, renvoyeeLe: r.returnedAt, majLe: r.updatedAt });
  for (const r of autre) poser("OTHER", r.id, { requesterId: r.requesterId, echeance: null, renvoyeeLe: null, majLe: r.updatedAt });
  return out;
}

/** Le circuit de chaque demande qui en a un : l'instance, l'étape en cours, son dernier geste. */
async function lireCircuits(rows: readonly AdProRequest[]) {
  const parType = new Map<EntityType, string[]>();
  for (const r of rows) {
    const t = AD_PRO_ENTITY_TYPE[r.kind];
    (parType.get(t) ?? parType.set(t, []).get(t)!).push(r.id);
  }
  const instances: WorkflowInstance[] = parType.size
    ? await prisma.workflowInstance.findMany({
        where: { OR: [...parType].map(([entityType, ids]) => ({ entityType, entityId: { in: ids } })) },
      }).catch(sansBloquer("ad-pro.liste.circuits", [] as WorkflowInstance[]))
    : [];
  const ouvertes = instances.filter((i) => i.status === "IN_PROGRESS" || i.status === "RETURNED");
  const defIds = [...new Set(ouvertes.map((i) => i.definitionId))];
  const assignes = [...new Set(ouvertes.map((i) => i.assigneeId).filter((x): x is string => Boolean(x)))];
  const [defs, derniers, gens] = await Promise.all([
    defIds.length
      ? prisma.workflowDefinition.findMany({ where: { id: { in: defIds } }, include: { steps: true } }).catch(sansBloquer("ad-pro.liste.definitions", []))
      : [],
    ouvertes.length
      ? prisma.workflowStepEvent.groupBy({ by: ["instanceId"], where: { instanceId: { in: ouvertes.map((i) => i.id) } }, _max: { createdAt: true } })
          .catch(sansBloquer("ad-pro.liste.derniers-gestes", [] as { instanceId: string; _max: { createdAt: Date | null } }[]))
      : [],
    assignes.length ? prisma.user.findMany({ where: { id: { in: assignes } }, select: { id: true, name: true } }) : [],
  ]);
  const etapes = new Map<string, WorkflowStep>();
  for (const d of defs) for (const s of d.steps) etapes.set(`${d.id}:${s.slug}`, s);
  const dernierGeste = new Map(derniers.map((d) => [d.instanceId, d._max.createdAt]));
  const nom = new Map(gens.map((g) => [g.id, g.name]));
  const parCle = new Map<string, WorkflowInstance>(instances.map((i) => [`${i.entityType}:${i.entityId}`, i]));
  return {
    instance: (r: AdProRequest) => parCle.get(`${AD_PRO_ENTITY_TYPE[r.kind]}:${r.id}`) ?? null,
    etape: (i: WorkflowInstance) => (i.currentSlug ? etapes.get(`${i.definitionId}:${i.currentSlug}`) ?? null : null),
    depuis: (i: WorkflowInstance) => dernierGeste.get(i.id) ?? i.createdAt,
    nom: (id: string | null) => (id ? nom.get(id) ?? null : null),
  };
}

/** « À vous » : la règle du circuit — sauf le passe-partout du Super Admin (voir l'en-tête). */
async function estAVous(user: SessionUser, step: WorkflowStep, instance: WorkflowInstance, requesterId: string | null): Promise<boolean> {
  if (user.role !== "SUPER_ADMIN") return canActOnStep(user, step, instance, { requesterId }).catch(sansBloquer("ad-pro.liste.a-vous", false));
  switch (step.actorScope) {
    case "GLOBAL_VIEW": return true;
    case "ASSIGNEE": return instance.assigneeId === user.id;
    case "REQUESTER": return requesterId === user.id;
    case "ROLE": return Boolean(user.secondaryRole && step.actorRoles.includes(user.secondaryRole));
    default: return false;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const RIEN: AttenteDemande = { chezQui: null, etape: null, aVous: false, depuis: null, echeance: null };

/** Les lignes de la liste, avec ce que l'écran affiche en plus. Même ordre, mêmes lignes. */
export async function lignesAvecAttente(user: SessionUser, rows: readonly AdProRequest[]): Promise<LigneAdPro[]> {
  if (rows.length === 0) return [];
  const [faits, circuits] = await Promise.all([lireFaits(rows), lireCircuits(rows)]);

  return Promise.all(rows.map(async (r): Promise<LigneAdPro> => {
    if (estClose(r.state)) return { ...r, ...RIEN };
    const f = faits.get(cleDemande(r));
    const requesterId = f?.requesterId ?? null;
    const sienne = requesterId !== null && requesterId === user.id;
    const echeance = iso(f?.echeance);
    const instance = circuits.instance(r);

    // EN COURS DE CIRCUIT : l'étape, qui la tient (la personne désignée si le circuit en a nommé une), depuis son dernier geste.
    if (instance?.status === "IN_PROGRESS" && r.state === "AWAITING") {
      const step = circuits.etape(instance);
      if (step) {
        const aVous = await estAVous(user, step, instance, requesterId);
        const tenant = circuits.nom(instance.assigneeId)
          ?? (step.actorScope === "ROLE" ? acteurDe({ actorScope: "ROLE", actorRoles: step.actorRoles }) : QUI_COURT[step.actorScope] ?? null);
        return { ...r, chezQui: aVous ? "vous" : tenant, etape: step.title, aVous, depuis: iso(circuits.depuis(instance)), echeance };
      }
    }

    // À CORRIGER OU BROUILLON : c'est le demandeur qui a la main (§118.186).
    if (r.state === "RETURNED" || r.state === "DRAFT") {
      const depuis = instance?.status === "RETURNED" ? circuits.depuis(instance) : f?.renvoyeeLe ?? f?.majLe ?? null;
      return {
        ...r, chezQui: sienne ? "vous" : "le demandeur", etape: r.state === "RETURNED" ? "Correction" : "À soumettre",
        aVous: sienne, depuis: iso(depuis) ?? r.createdAt, echeance,
      };
    }

    // Le reste (validée, en exécution ; en attente hors circuit lisible) : la date qui vient, l'attente si elle attend.
    return { ...r, ...RIEN, depuis: r.state === "AWAITING" ? iso(f?.majLe) ?? r.createdAt : null, echeance };
  }));
}

/** Repli : si la lecture d'à côté tombe, le tableau s'affiche quand même — sans « chez qui ». */
export async function lignesPourLaListe(user: SessionUser, rows: readonly AdProRequest[]): Promise<LigneAdPro[]> {
  return lignesAvecAttente(user, rows).catch(sansBloquer("ad-pro.liste.attente", rows.map((r) => ({ ...r, ...RIEN }))));
}
