import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { toNumber } from "@/lib/utils";
import { hasGlobalView, hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { estDecideurInfoMed } from "@/lib/medical-info/decideur";
import type { DocItem } from "@/components/documents/document-list";
import { sortByUrgency, type SupervisedRow } from "@/lib/validation-supervision";
import { entityHref } from "@/lib/entity-href";
import { depuisEtapeValidation, instantDeReprise } from "@/lib/validations/decision";

export interface PendingValidationItem {
  stepId: string;
  requestId: string;
  reference: string;
  title: string;
  description: string;
  module: string;
  objectType: string;
  amount: number | null;
  priority: string;
  requester: string;
  deadline: string | null;
  link: string;
  createdAt: string;
  /** Pièces à valider RENDUES SUR PLACE (jointes à la demande + celles de l'objet lié) :
   *  le validateur voit/prévisualise l'original SANS naviguer dans un autre module. */
  documents: DocItem[];
  /** Décidable MAINTENANT (parallèle, ou séquentiel : c'est mon tour). Sinon l'étape
   *  m'est assignée mais j'attends le validateur précédent → visible mais non décidable. */
  actionable: boolean;
  /** Mes verdicts GRANULAIRES déjà posés (message + pièces), pour réafficher l'état.
   *  itemKey = "MESSAGE" ou l'id d'un document. */
  itemDecisions: { itemKey: string; decision: string; comment: string }[];
  /** En intérim : le nom de l'absent à qui l'étape est adressée ; `null` quand elle est à moi (I18). */
  pourLeCompteDe: string | null;
  /**
   * DEPUIS QUAND L'ÉTAPE EST À SON TOUR (ISO, lot E2 — 07-05) : le dépôt, la décision du rang précédent en
   * séquentiel, ou la resoumission. `null` quand la reprise d'une demande resoumise ne se lit pas (§118.16).
   */
  depuis: string | null;
}

export interface MyValidationStep {
  order: number;
  validator: string;
  status: string;
  reason: string;
  /** Retour GRANULAIRE de ce validateur, élément par élément (message + pièces),
   *  avec le libellé lisible de l'élément. Vide si le validateur n'a rien détaillé. */
  items?: { label: string; decision: string; comment: string }[];
}

export interface MyValidationItem {
  id: string;
  reference: string;
  title: string;
  module: string;
  amount: number | null;
  status: string;
  mode: string;
  createdAt: string;
  /**
   * La validation porte-t-elle sur la demande ENTIÈRE, ou sur UNE de ses pièces ? Sans cette
   * distinction, quatre pièces soumises séparément s'affichaient comme quatre demandes — et une
   * pièce acceptée se lisait « demande acceptée ».
   */
  scope: "OBJECT" | "DOCUMENT";
  /** Objet d'origine (`ADMIN_REQUEST:xxx`) : ce qui permet de regrouper sous LA demande. */
  parentKey: string | null;
  /** Nom de la pièce visée, quand c'est une validation de pièce. */
  documentName: string | null;
  steps: MyValidationStep[];
}

/**
 * Étapes en attente où je suis validateur — qu'elles soient à traiter MAINTENANT
 * (mon tour) ou à venir (séquentiel : j'attends le validateur précédent). Toutes
 * VISIBLES pour que le validateur concerné n'en manque aucune ; le champ `actionable`
 * indique si la décision est déjà possible. Les « actionnables » sont renvoyées en tête.
 */
export async function getPendingValidations(userId: string): Promise<PendingValidationItem[]> {
  // LES ÉTAPES DES ABSENTS QUE JE REMPLACE (I18) : la porte de décision acceptait l'intérimaire,
  // la liste ne lui montrait rien — il fallait connaître l'identifiant de l'étape. Jamais celles
  // de mes propres demandes : l'intérim ne fait pas s'approuver soi-même.
  const auNom = await auNomDeQui(userId);
  const absents = auNom.absents.map((a) => a.userId);
  const steps = await prisma.validationStep.findMany({
    where: {
      status: "PENDING", request: { status: "PENDING" },
      OR: [
        { validatorId: userId },
        ...(absents.length ? [{ validatorId: { in: absents }, request: { status: "PENDING" as const, requesterId: { not: userId } } }] : []),
      ],
    },
    include: {
      // Les rangs voisins (leur décision date le tour de chacun) — dans la même lecture (lot E2).
      request: { include: { requester: { select: { name: true } }, steps: { select: { order: true, decidedAt: true } } } },
      itemDecisions: { select: { itemKey: true, decision: true, comment: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const isActionable = (s: (typeof steps)[number]) => s.request.mode === "PARALLEL" || s.order === s.request.currentOrder;

  // LA REPRISE D'UNE DEMANDE RESOUMISE se lit au journal — `resoumettreValidation` est le seul écrivain du
  // champ « version » et y trace la version atteinte. Une requête pour le lot (lot E2 — 07-05).
  const resoumises = [...new Set(steps.filter((s) => s.request.version > 1).map((s) => s.request.id))];
  const tracesDeVersion = resoumises.length
    ? await prisma.auditLog.findMany({
        where: { entityType: "VALIDATION_REQUEST", entityId: { in: resoumises }, field: "version" },
        select: { entityId: true, newValue: true, createdAt: true },
      })
    : [];
  const tracesDe = new Map<string, { newValue: string | null; createdAt: Date }[]>();
  for (const t of tracesDeVersion) {
    if (!t.entityId) continue;
    (tracesDe.get(t.entityId) ?? tracesDe.set(t.entityId, []).get(t.entityId)!).push(t);
  }

  // Pièces à valider rendues SUR PLACE : celles jointes à la demande (entité
  // VALIDATION_REQUEST) + celles de l'objet lié quand il est renseigné (ex. le bon
  // de commande). Récupérées en LOT pour éviter les requêtes N+1.
  const reqIds = steps.map((s) => s.request.id);
  const linkedPairs = steps
    .filter((s) => s.request.entityType && s.request.entityId)
    .map((s) => ({ entityType: s.request.entityType as EntityType, entityId: s.request.entityId as string }));
  const orClauses: Prisma.DocumentWhereInput[] = [];
  if (reqIds.length) orClauses.push({ entityType: "VALIDATION_REQUEST", entityId: { in: reqIds } });
  for (const p of linkedPairs) orClauses.push({ entityType: p.entityType, entityId: p.entityId });
  const documents = orClauses.length
    ? await prisma.document.findMany({
        where: { OR: orClauses },
        include: { uploadedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const toItem = (d: (typeof documents)[number]): DocItem => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  });
  const byAttachKey = new Map<string, DocItem[]>(); // clé `${entityType}:${entityId}` → pièces
  for (const d of documents) {
    const key = `${d.entityType}:${d.entityId}`;
    (byAttachKey.get(key) ?? byAttachKey.set(key, []).get(key)!).push(toItem(d));
  }

  return steps
    .map((s) => {
      const own = byAttachKey.get(`VALIDATION_REQUEST:${s.request.id}`) ?? [];
      const linked = s.request.entityType && s.request.entityId
        ? byAttachKey.get(`${s.request.entityType}:${s.request.entityId}`) ?? []
        : [];
      return {
        stepId: s.id,
        requestId: s.request.id,
        reference: s.request.reference,
        title: s.request.title,
        description: s.request.description ?? "",
        module: s.request.module,
        objectType: s.request.objectType ?? "",
        amount: s.request.amount === null ? null : toNumber(s.request.amount),
        priority: s.request.priority,
        requester: s.request.requester?.name ?? "",
        deadline: s.request.deadline?.toISOString() ?? null,
        // LE LIEN VERS L'OBJET, AVEC UN REPLI. `request.link` est un texte libre posé par qui a
        // créé la demande ; les validations nées d'une RÈGLE d'un autre module ne le renseignent
        // pas, et le validateur se retrouvait alors devant un titre sans rien à ouvrir. Quand
        // l'objet est identifié (`entityType` / `entityId`), la table des routes le retrouve.
        link: s.request.link || entityHref(s.request.entityType, s.request.entityId) || "",
        createdAt: s.request.createdAt.toISOString(),
        documents: [...own, ...linked],
        actionable: isActionable(s),
        itemDecisions: s.itemDecisions.map((d) => ({ itemKey: d.itemKey, decision: d.decision, comment: d.comment ?? "" })),
        pourLeCompteDe: auNom.nomDe(s.validatorId),
        depuis: depuisEtapeValidation({
          mode: s.request.mode, ordre: s.order, creeLe: s.createdAt, version: s.request.version,
          etapes: s.request.steps.map((e) => ({ ordre: e.order, decideeLe: e.decidedAt })),
          reprise: instantDeReprise(tracesDe.get(s.request.id) ?? [], s.request.version),
        })?.toISOString() ?? null,
      };
    })
    // Les demandes à traiter maintenant d'abord, puis celles à venir.
    .sort((a, b) => Number(b.actionable) - Number(a.actionable));
}

export async function getMyValidationRequests(userId: string): Promise<MyValidationItem[]> {
  const reqs = await prisma.validationRequest.findMany({
    where: { requesterId: userId },
    include: {
      steps: {
        include: { validator: { select: { name: true } }, itemDecisions: { select: { itemKey: true, decision: true, comment: true } } },
        orderBy: { order: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // Libellés lisibles des pièces : celles référencées par les verdicts granulaires (itemKey =
  // id de Document) ET celles que vise la demande elle-même (`documentId`).
  const docIds = [...new Set([
    ...reqs.flatMap((r) => r.steps.flatMap((s) => s.itemDecisions.map((d) => d.itemKey))),
    ...reqs.map((r) => r.documentId ?? ""),
  ].filter((k) => k && k !== "MESSAGE"))];
  const docNames = new Map(
    docIds.length
      ? (await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } })).map((d) => [d.id, d.name])
      : [],
  );
  return reqs.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    module: r.module,
    amount: r.amount === null ? null : toNumber(r.amount),
    status: r.status,
    mode: r.mode,
    createdAt: r.createdAt.toISOString(),
    scope: r.documentId ? ("DOCUMENT" as const) : ("OBJECT" as const),
    parentKey: r.entityType && r.entityId ? `${r.entityType}:${r.entityId}` : null,
    documentName: r.documentId ? docNames.get(r.documentId) ?? "Pièce jointe" : null,
    steps: r.steps.map((s) => ({
      order: s.order,
      validator: s.validator?.name ?? "",
      status: s.status,
      reason: s.reason ?? "",
      items: s.itemDecisions.map((d) => ({
        label: d.itemKey === "MESSAGE" ? "Message" : docNames.get(d.itemKey) ?? "Pièce jointe",
        decision: d.decision,
        comment: d.comment ?? "",
      })),
    })),
  }));
}

// ─────────── Validations transverses : tout ce qui attend MA validation, agrégé ───────────

export interface CrossValidationItem {
  id: string;
  reference: string;
  title: string;
  module: string;
  stage: string;
  amount: number | null;
  requester: string;
  createdAt: string;
  link: string;
}

// LES ÉTAPES D'UN SPONSORING TELLES QU'ELLES SONT AUJOURD'HUI (§118.151) : `AWAITING_FINAL` est
// l'étape de la Direction Marketing, qui pré-valide la TENUE ; `PRE_VALIDATED` est la suite —
// les postes se décident et se rangent dans leurs budgets, puis la validation finale clôture.
// Absente de ce tableau, une demande pré-validée n'était « à faire » nulle part.
const SPO_STAGE: Record<string, string> = {
  AWAITING_PRELIMINARY: "Préliminaire",
  AWAITING_FINAL: "Pré-validation de la tenue",
  AWAITING_FINAL_APPEAL: "Définitive (appel)",
  PRE_VALIDATED: "Postes, puis validation finale et clôture",
};
const CONG_STAGE: Record<string, string> = { AWAITING_PRELIMINARY: "Préliminaire", AWAITING_FINAL: "Définitive" };

/**
 * LE TABLEAU TRANSVERSE NE S'AFFICHE PAS AUX DEUX DIRECTIONS OPÉRATIONNELLES.
 *
 * Pour elles, il ne montrait rien de nouveau : chaque ligne renvoie à la fiche du module où la
 * décision se prend, et ces deux rôles ont déjà le module ENTIER sous les yeux — le Directeur
 * des opérations voit toutes les demandes administratives (portée ALL), le Directeur général
 * voit tout le sponsoring et toutes les prises en charge. Le bloc rejouait donc une seconde
 * fois, sous un autre titre, ce que leur écran métier affiche déjà, et gonflait le compteur
 * « à valider par vous » de doublons.
 *
 * Rien n'est perdu : aucune de ces décisions ne se prenait ICI. Elles se prennent, comme avant,
 * sur la fiche du sponsoring, du congrès ou de la demande — et le lien de chaque ligne le disait
 * déjà (« Ouvrir pour valider »).
 */
export function skipsCrossModuleBoard(user: SessionUser): boolean {
  return user.role === "GENERAL_MANAGER" || user.role === "OPERATIONS_DIRECTOR";
}

/**
 * Centre de validation : agrège dans un seul endroit TOUTES les validations en
 * attente de l'utilisateur, issues des autres modules — demandes administratives
 * escaladées (AdminApproval), sponsoring et congrès en attente de Direction.
 * Chaque ligne renvoie vers la fiche où la décision se prend réellement.
 */
export async function getCrossModuleValidations(user: SessionUser): Promise<CrossValidationItem[]> {
  if (skipsCrossModuleBoard(user)) return [];
  const out: CrossValidationItem[] = [];
  const global = hasGlobalView(user.role);

  // 1) Demandes administratives escaladées (l'assistante « demande validation » → Direction).
  const approvals = await prisma.adminApproval.findMany({
    where: { status: "PENDING", validatorId: user.id },
    include: { request: { include: { requester: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" }, take: 100,
  });
  for (const a of approvals) {
    out.push({
      id: `aa-${a.id}`, reference: a.request.reference, title: a.request.title,
      module: "Demande administrative", stage: "Validation demandée",
      amount: a.amount === null ? null : toNumber(a.amount),
      requester: a.request.requester?.name ?? "", createdAt: a.createdAt.toISOString(),
      link: `/demandes/${a.request.id}`,
    });
  }

  // 2) Sponsoring en attente de Direction.
  if (global || userCan(user, "SPONSORING", "VALIDATE")) {
    const spo = await prisma.sponsoringRequest.findMany({
      where: { status: { in: ["AWAITING_PRELIMINARY", "AWAITING_FINAL", "AWAITING_FINAL_APPEAL", "PRE_VALIDATED"] } },
      include: { requester: { select: { name: true } } }, orderBy: { createdAt: "asc" }, take: 100,
    });
    for (const s of spo) out.push({
      id: `spo-${s.id}`, reference: s.reference, title: s.institution, module: "Sponsoring",
      stage: SPO_STAGE[s.status] ?? s.status,
      amount: s.amountProposed ? toNumber(s.amountProposed) : s.amountRequested ? toNumber(s.amountRequested) : null,
      requester: s.requester?.name ?? "", createdAt: s.createdAt.toISOString(), link: `/sponsoring/${s.id}`,
    });
  }

  // 3) Congrès (international + national) en attente de Direction.
  const congress: { id: string; name: string; requestStatus: string; estimatedBudget: unknown; requesterId: string | null; createdAt: Date; kind: "ci" | "cn" }[] = [];
  if (global || userCan(user, "CONGRESS_INTERNATIONAL", "VALIDATE")) {
    const ci = await prisma.congressInternational.findMany({ where: { requestStatus: { in: ["AWAITING_PRELIMINARY", "AWAITING_FINAL"] } }, select: { id: true, name: true, requestStatus: true, estimatedBudget: true, requesterId: true, createdAt: true }, take: 100 });
    congress.push(...ci.map((c) => ({ ...c, kind: "ci" as const })));
  }
  if (global || userCan(user, "CONGRESS_NATIONAL", "VALIDATE")) {
    const cn = await prisma.congressNational.findMany({ where: { requestStatus: { in: ["AWAITING_PRELIMINARY", "AWAITING_FINAL"] } }, select: { id: true, name: true, requestStatus: true, estimatedBudget: true, requesterId: true, createdAt: true }, take: 100 });
    congress.push(...cn.map((c) => ({ ...c, kind: "cn" as const })));
  }
  if (congress.length) {
    const ids = [...new Set(congress.map((c) => c.requesterId).filter(Boolean) as string[])];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    for (const c of congress) out.push({
      id: `${c.kind}-${c.id}`, reference: c.name, title: c.name,
      module: c.kind === "ci" ? "Prise en charge Internationale" : "Prise en charge Nationale",
      stage: CONG_STAGE[c.requestStatus] ?? c.requestStatus,
      amount: c.estimatedBudget ? toNumber(c.estimatedBudget as never) : null,
      requester: c.requesterId ? names.get(c.requesterId) ?? "" : "",
      createdAt: c.createdAt.toISOString(), link: `/${c.kind === "ci" ? "congress-international" : "congress-national"}/${c.id}`,
    });
  }

  // 4) Information médicale : l'INSTRUCTION (à déclarer, pièces demandées, prêt à valider)
  //    est la file du PHARMACIEN RESPONSABLE (PRIM) — pas de tous ceux qui ont le droit
  //    d'agir sur le module. La validation finale (AWAITING_DIRECTION) appartient au Directeur
  //    des Opérations (`medical-info/decideur.ts`, Direction 10/2026) — plus à la Direction des
  //    opérations : même garde que l'action `validateDeclarationByDirection`. Le Super Admin voit tout.
  {
    const prim = hasRole(user, "MEDICAL_INFO_PHARMACIST") || user.role === "SUPER_ADMIN";
    const statuses: ("AWAITING_REVIEW" | "DOCS_REQUESTED" | "READY" | "AWAITING_DIRECTION")[] = [
      ...(prim ? (["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"] as const) : []),
      ...(estDecideurInfoMed(user) ? (["AWAITING_DIRECTION"] as const) : []),
    ];
    const decls = statuses.length
      ? await prisma.medicalInfoDeclaration.findMany({
          where: { status: { in: statuses } },
          orderBy: { createdAt: "asc" }, take: 100,
        })
      : [];
    const MI_STAGE: Record<string, string> = { AWAITING_REVIEW: "À déclarer", DOCS_REQUESTED: "Pièces demandées", READY: "Prêt à valider", AWAITING_DIRECTION: "Validation finale (Directeur des Opérations)" };
    for (const d of decls) out.push({
      id: `mi-${d.id}`, reference: d.reference, title: d.label, module: "Information médicale",
      stage: MI_STAGE[d.status] ?? d.status,
      amount: d.amount ? toNumber(d.amount) : null,
      requester: "", createdAt: d.createdAt.toISOString(), link: `/information-medicale/${d.id}`,
    });
  }

  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface SupervisedValidationItem extends SupervisedRow {
  description: string;
  status: string;
  mode: string;
  /** Lien vers l'objet original (ex. /courrier/…, /demandes/…) quand le demandeur l'a renseigné. */
  link: string;
  /** Pièces de la demande ORIGINALE (celles jointes à la demande + celles de l'objet lié),
   *  pour un aperçu sur place — la Direction / le Super Admin accède à tout sans naviguer. */
  documents: DocItem[];
  steps: MyValidationStep[];
}

/**
 * SUPERVISION (Super Admin / Direction) : toutes les demandes de validation EN COURS
 * dont l'utilisateur n'est ni le demandeur ni un validateur assigné — de sorte qu'un
 * responsable à vue globale VOIE l'intégralité des demandes de validation de la société,
 * même celles qui ne le concernent pas directement. Chaque demande expose son LIEN et ses
 * PIÈCES ORIGINALES (aperçu sur place). Renvoie une liste vide sinon.
 */
export async function getSupervisedValidations(user: SessionUser): Promise<SupervisedValidationItem[]> {
  if (!hasGlobalView(user.role)) return [];
  const reqs = await prisma.validationRequest.findMany({
    where: {
      status: "PENDING",
      requesterId: { not: user.id },
      steps: { none: { validatorId: user.id } },
    },
    include: { requester: { select: { name: true } }, steps: { include: { validator: { select: { name: true } } }, orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Pièces des demandes ORIGINALES chargées EN LOT : celles jointes à la demande
  // (entité VALIDATION_REQUEST) + celles de l'objet lié quand il est renseigné.
  const reqIds = reqs.map((r) => r.id);
  const linkedPairs = reqs
    .filter((r) => r.entityType && r.entityId)
    .map((r) => ({ entityType: r.entityType as EntityType, entityId: r.entityId as string }));
  const orClauses: Prisma.DocumentWhereInput[] = [];
  if (reqIds.length) orClauses.push({ entityType: "VALIDATION_REQUEST", entityId: { in: reqIds } });
  for (const p of linkedPairs) orClauses.push({ entityType: p.entityType, entityId: p.entityId });
  const documents = orClauses.length
    ? await prisma.document.findMany({ where: { OR: orClauses }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } })
    : [];
  const byKey = new Map<string, DocItem[]>();
  for (const d of documents) {
    const key = `${d.entityType}:${d.entityId}`;
    const item: DocItem = { id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes, confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey) };
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(item);
  }

  const now = new Date();
  const rows = reqs.map((r) => {
    const own = byKey.get(`VALIDATION_REQUEST:${r.id}`) ?? [];
    const linked = r.entityType && r.entityId ? byKey.get(`${r.entityType}:${r.entityId}`) ?? [] : [];
    // QUI BLOQUE : la première étape encore en attente. C'est la seule information que la
    // Direction cherche vraiment dans cette liste — sans elle, il faut ouvrir chaque demande
    // pour savoir chez qui elle dort.
    const blocking = r.steps.find((s) => s.status === "PENDING") ?? null;
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      description: r.description ?? "",
      module: r.module,
      amount: r.amount === null ? null : toNumber(r.amount),
      priority: r.priority,
      status: r.status,
      mode: r.mode,
      requester: r.requester?.name ?? "",
      createdAt: r.createdAt.toISOString(),
      deadline: r.deadline ? r.deadline.toISOString() : null,
      blockingValidator: blocking?.validator?.name ?? null,
      blockingStepId: blocking?.id ?? null,
      blockingOrder: blocking?.order ?? null,
      link: r.link || entityHref(r.entityType, r.entityId) || "",
      documents: [...own, ...linked],
      steps: r.steps.map((s) => ({ order: s.order, validator: s.validator?.name ?? "", status: s.status, reason: s.reason ?? "" })),
    };
  });
  // Ce qui est en retard, puis ce qui va l'être, puis ce qui dort — et non « le plus récent
  // d'abord », qui range exactement à l'envers de ce qu'on cherche.
  return sortByUrgency(rows, now);
}

export async function getMyValidations(user: SessionUser) {
  const [toValidate, myRequests, crossModule, supervised] = await Promise.all([
    getPendingValidations(user.id),
    getMyValidationRequests(user.id),
    getCrossModuleValidations(user),
    getSupervisedValidations(user),
  ]);
  return { toValidate, myRequests, crossModule, supervised };
}

/** Vue Super Admin : règles + dernières demandes (supervision). */
export async function getValidationAdminData() {
  const [rules, requests] = await Promise.all([
    prisma.validationRule.findMany({ orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.validationRequest.findMany({
      include: { requester: { select: { name: true } }, steps: { include: { validator: { select: { name: true } } }, orderBy: { order: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return { rules, requests };
}
