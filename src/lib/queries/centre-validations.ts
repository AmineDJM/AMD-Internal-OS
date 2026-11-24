import { prisma } from "@/lib/prisma";
import { toNumber, formatDate } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { libelleNatureValidation } from "@/lib/labels";
import { getPendingValidations, type PendingValidationItem } from "@/lib/queries/validations";
import { getBudgetOverview } from "@/lib/queries/budget";
import { categoriesBvCandidates } from "@/lib/queries/budget-bv-acceptes";
import { categorieDuBvAccepte } from "@/lib/budget-regulatory/bv-acceptes";
import { sortForCentre } from "@/lib/validations/centre";
import {
  etiquetteDeLaDemande, genreDeLaDemande, partDuBv,
  type BlocBv, type LigneCentre, type LigneDecidee, type MessageFil,
} from "@/lib/validations/centre-affichage";

/**
 * LE CHARGEUR DU CENTRE DE VALIDATIONS (un seul écran, maquette du 24/11/2026) — la file « À décider » et ce que chaque
 * fiche affiche, puis « Déjà décidés ».
 *
 * LA FILE EST CELLE D'HIER, À L'IDENTIQUE : `getPendingValidations` (mon étape, celle de l'absent que je remplace, les BV
 * des dossiers réglementaires pour qui a accès au centre) — aucune règle d'accès n'est réécrite ici. On n'en garde que
 * les étapes DÉCIDABLES maintenant : celles qui attendent le validateur précédent reviendront d'elles-mêmes à leur tour.
 * Ce chargeur ne fait qu'APPORTER le contexte en lot : la nature, la chaîne déjà validée, le validateur suivant, le fil
 * des échanges, la société de l'objet et, pour un BV, le budget avant → après (le chiffre même de l'écran Budgets,
 * `getBudgetOverview`, sous la visibilité de la personne).
 */

type Societe = { name: string; shortName: string | null } | null;
const nomSociete = (c: Societe) => (c ? c.shortName || c.name : null);

/** La société de l'objet d'origine, quand l'objet en porte une (registre Legal, dossier réglementaire, information médicale). */
async function societesDesObjets(paires: readonly { entityType: string | null; entityId: string | null }[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(paires.filter((p) => p.entityType === type && p.entityId).map((p) => p.entityId!))];
  const [legal, reg, im] = await Promise.all([
    ids("LEGAL_DOCUMENT").length ? prisma.legalDocument.findMany({ where: { id: { in: ids("LEGAL_DOCUMENT") } }, select: { id: true, company: { select: { name: true, shortName: true } } } }) : [],
    ids("REGULATORY_PRODUCT").length ? prisma.regulatoryProduct.findMany({ where: { id: { in: ids("REGULATORY_PRODUCT") } }, select: { id: true, company: { select: { name: true, shortName: true } } } }) : [],
    ids("MEDICAL_INFO_DECLARATION").length ? prisma.medicalInfoDeclaration.findMany({ where: { id: { in: ids("MEDICAL_INFO_DECLARATION") } }, select: { id: true, company: { select: { name: true, shortName: true } } } }) : [],
  ]);
  const out = new Map<string, string>();
  for (const [type, rows] of [["LEGAL_DOCUMENT", legal], ["REGULATORY_PRODUCT", reg], ["MEDICAL_INFO_DECLARATION", im]] as const) {
    for (const r of rows) {
      const nom = nomSociete(r.company);
      if (nom) out.set(`${type}:${r.id}`, nom);
    }
  }
  return out;
}

/**
 * LE BUDGET D'UN BV, AVANT → APRÈS — la catégorie BV 25 % / 75 % de l'enveloppe Regulatory qui le comptera s'il est
 * accepté aujourd'hui (`categorieDuBvAccepte`, la règle même qui le range à l'acceptation), et ses chiffres lus par
 * `getBudgetOverview` : une enveloppe qui n'est pas ouverte à la personne ne livre aucun chiffre.
 */
async function blocsBv(user: SessionUser, bvs: readonly { requestId: string; part: "25" | "75"; montant: number; productId: string | null }[], now: Date): Promise<Map<string, BlocBv>> {
  const out = new Map<string, BlocBv>();
  if (bvs.length === 0) return out;
  const productIds = [...new Set(bvs.map((b) => b.productId).filter((x): x is string => Boolean(x)))];
  const [candidates, dossiers] = await Promise.all([
    categoriesBvCandidates(),
    productIds.length ? prisma.regulatoryProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, companyId: true } }) : [],
  ]);
  const societeDe = new Map(dossiers.map((d) => [d.id, d.companyId]));
  const vues = new Map<string, Awaited<ReturnType<typeof getBudgetOverview>>>();
  const vue = async (envelopeId: string) => {
    if (!vues.has(envelopeId)) vues.set(envelopeId, await getBudgetOverview(user, envelopeId));
    return vues.get(envelopeId) ?? null;
  };
  const chiffres = async (part: "25" | "75", societe: string | null) => {
    const cat = categorieDuBvAccepte(part, now, candidates, societe);
    if (!cat) return null;
    const v = await vue(cat.enveloppe.id);
    const c = v?.categories.find((x) => x.id === cat.id) ?? null;
    return { cat, v, c };
  };
  for (const b of bvs) {
    const societe = b.productId ? societeDe.get(b.productId) ?? null : null;
    const lu = await chiffres(b.part, societe);
    if (!lu) { out.set(b.requestId, { etat: "SANS_ENVELOPPE", part: b.part }); continue; }
    const categorie = `${lu.cat.enveloppe.nom} › ${lu.cat.nom}`;
    if (!lu.v || !lu.c) { out.set(b.requestId, { etat: "NON_VISIBLE", part: b.part, categorie }); continue; }
    const disponibleAvant = lu.c.allocated - lu.c.consumed - lu.c.committed;
    // LE 75 % QUI SUIVRA (3 × le 25 %, la règle de la page Budget Regulatory) et ce qu'il reste sur sa ligne.
    let prevision75: { montant: number; disponible: number | null } | null = null;
    if (b.part === "25") {
      const l75 = await chiffres("75", societe);
      prevision75 = { montant: b.montant * 3, disponible: l75?.c ? l75.c.allocated - l75.c.consumed - l75.c.committed : null };
    }
    out.set(b.requestId, {
      etat: "LU", part: b.part, categorie,
      periode: `${formatDate(lu.cat.enveloppe.periodStart, { month: "short", year: "numeric" })} – ${formatDate(lu.cat.enveloppe.periodEnd, { month: "short", year: "numeric" })}`,
      alloue: lu.c.allocated, consomme: lu.c.consumed, engage: lu.c.committed, demande: b.montant,
      disponibleAvant, disponibleApres: disponibleAvant - b.montant, prevision75,
    });
  }
  return out;
}

/** Ce que la fiche apporte en plus de la file d'hier, lu en lot pour toutes les lignes. */
async function contexteDesLignes(user: SessionUser, decidables: readonly PendingValidationItem[], seuilBC: number, now: Date): Promise<LigneCentre[]> {
  if (decidables.length === 0) return [];
  const requestIds = [...new Set(decidables.map((p) => p.requestId))];
  const [demandes, commentaires] = await Promise.all([
    prisma.validationRequest.findMany({
      where: { id: { in: requestIds } },
      select: {
        id: true, entityType: true, entityId: true, documentId: true, version: true, mode: true, currentOrder: true,
        steps: { select: { id: true, order: true, status: true, decidedAt: true, validator: { select: { name: true } } }, orderBy: { order: "asc" } },
      },
    }),
    prisma.comment.findMany({
      where: { entityType: "VALIDATION_REQUEST", entityId: { in: requestIds } },
      select: { id: true, entityId: true, body: true, createdAt: true, authorId: true, author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const demandeDe = new Map(demandes.map((d) => [d.id, d]));
  const filDe = new Map<string, MessageFil[]>();
  for (const c of commentaires) {
    if (!c.entityId) continue;
    (filDe.get(c.entityId) ?? filDe.set(c.entityId, []).get(c.entityId)!).push({
      id: c.id, auteur: c.author?.name ?? "—", deMoi: c.authorId === user.id, le: c.createdAt.toISOString(), texte: c.body,
    });
  }
  const societes = await societesDesObjets(demandes);
  const bvs = await blocsBv(user, decidables.flatMap((p) => {
    const part = partDuBv(p.objectType);
    const d = demandeDe.get(p.requestId);
    return part && p.amount !== null
      ? [{ requestId: p.requestId, part, montant: p.amount, productId: d?.entityType === "REGULATORY_PRODUCT" ? d.entityId : null }]
      : [];
  }), now);

  return decidables.map((p) => {
    const d = demandeDe.get(p.requestId);
    const genre = genreDeLaDemande({ objectType: p.objectType, entityType: d?.entityType ?? null, documentId: d?.documentId ?? null });
    const steps = d?.steps ?? [];
    const mienne = steps.find((s) => s.id === p.stepId);
    // LE SUIVANT, EN SÉQUENTIEL : le premier rang après le mien qui attend encore.
    const suivant = d?.mode === "SEQUENTIAL" && mienne
      ? steps.find((s) => s.order > mienne.order && s.status === "PENDING")?.validator?.name ?? null
      : null;
    return {
      stepId: p.stepId,
      requestId: p.requestId,
      reference: p.reference,
      genre,
      etiquette: etiquetteDeLaDemande(genre, p.objectType, p.module),
      nature: libelleNatureValidation(p.objectType) ?? p.module,
      objectType: p.objectType || null,
      objet: p.title,
      description: p.description,
      montant: p.amount,
      demandeur: p.requester,
      demandeLe: p.createdAt,
      depuis: p.depuis,
      echeance: p.deadline,
      lienObjet: p.link || null,
      societe: d?.entityType && d.entityId ? societes.get(`${d.entityType}:${d.entityId}`) ?? null : null,
      pourLeCompteDe: p.pourLeCompteDe,
      version: d?.version ?? 1,
      chaine: steps
        .filter((s) => s.id !== p.stepId && s.status === "APPROVED")
        .map((s) => ({ etape: `Accepté par ${s.validator?.name ?? "—"}`, detail: s.decidedAt ? `étape ${s.order} · ${formatDate(s.decidedAt, { day: "numeric", month: "short" })}` : `étape ${s.order}` })),
      suivant,
      pieces: p.documents.map((doc) => ({ id: doc.id, nom: doc.name, hasFile: doc.hasFile })),
      fil: filDe.get(p.requestId) ?? [],
      bv: bvs.get(p.requestId) ?? null,
      seuilBC: genre === "BC" ? seuilBC : null,
    } satisfies LigneCentre;
  });
}

/**
 * LA FILE « À DÉCIDER » — les étapes décidables maintenant, la plus urgente en tête (`sortForCentre` : l'échéance,
 * puis la plus ancienne), avec leur fiche.
 */
export async function fileDuCentre(user: SessionUser, opts: { seuilBC: number; now?: Date } = { seuilBC: 0 }): Promise<LigneCentre[]> {
  const now = opts.now ?? new Date();
  const pending = await getPendingValidations(user.id);
  const decidables = sortForCentre(pending.filter((p) => p.actionable));
  return contexteDesLignes(user, decidables, opts.seuilBC, now);
}

/** « DÉJÀ DÉCIDÉS » — mes décisions, les plus récentes d'abord. */
export async function decisionsRecentes(userId: string, limite = 60): Promise<LigneDecidee[]> {
  const steps = await prisma.validationStep.findMany({
    where: { validatorId: userId, status: { in: ["APPROVED", "REJECTED", "CHANGES_REQUESTED"] }, decidedAt: { not: null } },
    select: {
      id: true, status: true, reason: true, decidedAt: true,
      request: { select: { id: true, title: true, amount: true, module: true, objectType: true, entityType: true, documentId: true } },
    },
    orderBy: { decidedAt: "desc" },
    take: limite,
  });
  return steps.map((s) => {
    const genre = genreDeLaDemande(s.request);
    return {
      stepId: s.id, requestId: s.request.id, genre,
      etiquette: etiquetteDeLaDemande(genre, s.request.objectType, s.request.module),
      objet: s.request.title, montant: s.request.amount === null ? null : toNumber(s.request.amount),
      status: s.status, motif: s.reason, decideeLe: (s.decidedAt as Date).toISOString(),
    };
  });
}
