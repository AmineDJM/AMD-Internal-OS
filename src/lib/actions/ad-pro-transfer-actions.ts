"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildRef, enSerie } from "@/lib/refs";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { fermerInstance, ouvrirLeCircuit } from "@/lib/workflow/engine";
import { adProInit } from "@/lib/workflow/origin";
import type { CongressRequestStatus, SponsoringStatus } from "@prisma/client";

/**
 * TRANSFÉRER UNE DEMANDE D'UN MODULE AD & PRO VERS UN AUTRE.
 *
 * Le cas réel : un délégué saisit une demande en « Sponsoring » alors qu'il s'agit en réalité
 * d'une prise en charge nationale. Aujourd'hui il faut tout ressaisir, et les pièces déjà
 * jointes se perdent — ou pire, la demande reste au mauvais endroit et personne ne la retrouve.
 *
 * Ce que le transfert fait, et ce qu'il refuse de faire :
 *
 *   • **Il ne supprime pas la source.** Elle est marquée transférée et pointe vers la nouvelle
 *     demande. L'historique d'une demande réglementaire ne s'efface pas parce qu'on s'est trompé
 *     de guichet.
 *
 *   • **Il déplace les pièces jointes**, qui sont l'essentiel du travail déjà fait.
 *
 *   • **Il ne recopie PAS le circuit de validation.** Les modules n'ont pas les mêmes étapes ni
 *     les mêmes acteurs : rejouer un état d'avancement d'un circuit dans un autre produirait une
 *     demande qui se croit validée par des gens qui ne l'ont jamais vue. La nouvelle demande
 *     repart de son propre début.
 *
 *   • **Il refuse une demande dont l'argent est engagé.** Un ordre de dépense pointe la source :
 *     la déplacer laisserait une pièce comptable orpheline.
 *
 * Réservé à la vue groupe (Super Admin / Direction) : c'est une correction d'aiguillage, pas un
 * geste courant.
 */

type AdProKind = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL";

const LABELS: Record<AdProKind, string> = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prise en charge Nationale",
  CONGRESS_INTERNATIONAL: "Prise en charge Internationale",
};

const PATHS: Record<AdProKind, string> = {
  SPONSORING: "/sponsoring",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
};

const isKind = (v: string): v is AdProKind => v in LABELS;

/** La catégorie de circuit de chaque module — celle dont la route se lit pour la demande transférée. */
const CATEGORIE_DU_MODULE = { SPONSORING: "SPONSORING", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL" } as const;

/** Ce qu'on sait d'une demande, quel que soit son module — le socle commun du transfert. */
interface Common {
  title: string;
  institution: string | null;
  specialty: string | null;
  estimatedBudget: number | null;
  requesterId: string | null;
  productManagerId: string | null;
  comments: string | null;
  /** Entité de la demande d'origine — un transfert de module ne change pas de société. */
  companyId: string | null;
  /**
   * Pourquoi la demande ne se transfère plus — `null` quand elle se transfère. L'argent engagé
   * (un ordre de dépense) ferme le transfert depuis toujours ; sous la règle de la tenue
   * (§118.151), les POSTES d'un sponsoring engagent aussi — un BC demandé, un ordre émis — et le
   * transfert ne les emporte pas : ils resteraient accrochés à une demande close, en silence.
   */
  engagement: string | null;
}

const ENGAGE_PAR_ORDRE = "Un ordre de dépense a été émis sur cette demande : elle ne peut plus être transférée.";

/** La colonne qui rattache un poste à chaque nature de demande transférable. */
const COLONNE_POSTE: Record<AdProKind, "sponsoringId" | "congressNationalId" | "congressInternationalId"> = {
  SPONSORING: "sponsoringId",
  CONGRESS_NATIONAL: "congressNationalId",
  CONGRESS_INTERNATIONAL: "congressInternationalId",
};

async function readSource(kind: AdProKind, id: string): Promise<Common | null> {
  if (kind === "SPONSORING") {
    const r = await prisma.sponsoringRequest.findUnique({ where: { id } });
    if (!r) return null;
    const postesEngages = await prisma.adProItem.count({
      where: { sponsoringId: id, OR: [{ expenseOrderId: { not: null } }, { orderStage: { in: ["REQUESTED", "DIRECTION_OK", "ISSUED"] } }] },
    });
    const engagement = r.expenseOrderId ? ENGAGE_PAR_ORDRE
      : r.status === "CLOSED" ? "Cette demande est close (ou déjà transférée) : elle ne se transfère plus."
      : r.status === "PRE_VALIDATED" || r.closedAt != null
        ? "La tenue de cet événement a été pré-validée et ses postes se préparent : la demande ne se transfère plus. "
          + "Pour l'arrêter, refusez ses postes puis clôturez-la."
        : postesEngages > 0
          ? `${postesEngages} poste(s) de cette demande engagent déjà la dépense (bon de commande ou ordre) : elle ne peut plus être transférée.`
          : null;
    return {
      title: r.institution, institution: r.institution, specialty: r.specialty,
      estimatedBudget: r.amountRequested != null ? toNumber(r.amountRequested) : null,
      requesterId: r.requesterId, productManagerId: r.productManagerId, comments: r.comments,
      companyId: r.companyId, engagement,
    };
  }
  if (kind === "CONGRESS_NATIONAL") {
    const r = await prisma.congressNational.findUnique({ where: { id } });
    if (!r) return null;
    return {
      title: r.name, institution: r.hostInstitution, specialty: r.specialty,
      estimatedBudget: r.estimatedBudget != null ? toNumber(r.estimatedBudget) : null,
      requesterId: r.requesterId, productManagerId: r.productManagerId, comments: r.finalNote,
      companyId: r.companyId, engagement: await engagementPriseEnCharge(kind, id, r),
    };
  }
  const r = await prisma.congressInternational.findUnique({ where: { id } });
  if (!r) return null;
  return {
    title: r.name, institution: null, specialty: r.specialty,
    estimatedBudget: r.estimatedBudget != null ? toNumber(r.estimatedBudget) : null,
    requesterId: r.requesterId, productManagerId: r.productManagerId, comments: r.finalNote,
    companyId: r.companyId, engagement: await engagementPriseEnCharge(kind, id, r),
  };
}

/**
 * CE QUI RETIENT UNE PRISE EN CHARGE (audit du 27/10/2026, ADPRO-05). Depuis le circuit du 27/10, l'argent d'une prise
 * en charge ne passe plus par un ordre GLOBAL (`expenseOrderId` de la demande) mais par ses POSTES et ses DEVIS de
 * personnes : seul l'ordre global était lu, et une prise en charge dont un BC était demandé ou un devis payé se
 * transférait — ses postes et ses ordres restaient accrochés à une demande annulée, en silence. La règle est celle du
 * sponsoring (plus haut) ; s'y ajoute la demande DÉJÀ partie : la transférer une seconde fois en ferait deux.
 */
async function engagementPriseEnCharge(
  kind: "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL", id: string, r: { expenseOrderId: string | null; requestStatus: string },
): Promise<string | null> {
  if (r.expenseOrderId) return ENGAGE_PAR_ORDRE;
  if (r.requestStatus === "CANCELLED") return "Cette demande est annulée (ou déjà transférée) : elle ne se transfère plus.";
  const colonne = COLONNE_POSTE[kind];
  const [postesEngages, devisPayes] = await Promise.all([
    prisma.adProItem.count({
      where: { [colonne]: id, OR: [{ expenseOrderId: { not: null } }, { orderStage: { in: ["REQUESTED", "DIRECTION_OK", "ISSUED"] } }] },
    }),
    prisma.careQuote.count({ where: { [colonne]: id, expenseOrderId: { not: null } } }),
  ]);
  if (postesEngages > 0) return `${postesEngages} poste(s) de cette demande engagent déjà la dépense (bon de commande ou ordre) : elle ne peut plus être transférée.`;
  if (devisPayes > 0) return `${devisPayes} devis de cette prise en charge ont déjà un ordre de dépense : elle ne peut plus être transférée.`;
  return null;
}

async function createTarget(kind: AdProKind, src: Common, actorId: string, fromLabel: string): Promise<string> {
  // La note d'origine est portée par la NOUVELLE demande : en la lisant, on doit comprendre
  // d'où elle vient sans avoir à fouiller le journal d'audit.
  const origin = `Transférée depuis ${fromLabel}.${src.comments ? ` — ${src.comments}` : ""}`;
  // LA ROUTE DU NOUVEAU MODULE SE LIT SUR LE CRÉATEUR (décision #28, 27/10/2026) : une demande transférée
  // repart au début de SA prévalidation — celle de son demandeur —, pas à l'étape préliminaire par défaut.
  const createur = src.requesterId
    ? await prisma.user.findUnique({ where: { id: src.requesterId }, select: { role: true, secondaryRole: true } })
    : null;
  const init = createur ? adProInit(createur, CATEGORIE_DU_MODULE[kind]) : null;

  if (kind === "SPONSORING") {
    const year = new Date().getFullYear();
    const refs = await prisma.sponsoringRequest.findMany({
      where: { reference: { startsWith: `SPO-${year}-` } }, select: { reference: true },
    });
    const created = await prisma.sponsoringRequest.create({
      data: {
        reference: buildRef("SPO", year, refs.map((r) => r.reference)),
        institution: src.institution ?? src.title,
        // Le type de sponsoring n'a pas d'équivalent dans les autres modules : on ne l'invente
        // pas, on dit d'où il vient pour qu'un humain le corrige.
        type: "À qualifier (transfert)",
        specialty: src.specialty,
        amountRequested: src.estimatedBudget ?? undefined,
        ...(init ? { status: init.status as SponsoringStatus } : {}),
        requesterId: src.requesterId,
        productManagerId: src.productManagerId,
        comments: origin,
        createdById: actorId,
        // Changer de module ne change pas de société : l'entité suit la demande.
        companyId: src.companyId,
      },
      select: { id: true },
    });
    return created.id;
  }

  if (kind === "CONGRESS_NATIONAL") {
    const created = await prisma.congressNational.create({
      data: {
        name: src.title, hostInstitution: src.institution, specialty: src.specialty,
        estimatedBudget: src.estimatedBudget ?? undefined,
        ...(init ? { requestStatus: init.status as CongressRequestStatus } : {}),
        requesterId: src.requesterId, productManagerId: src.productManagerId,
        finalNote: origin, createdById: actorId, companyId: src.companyId,
      },
      select: { id: true },
    });
    return created.id;
  }

  const created = await prisma.congressInternational.create({
    data: {
      name: src.title, specialty: src.specialty,
      estimatedBudget: src.estimatedBudget ?? undefined,
      ...(init ? { requestStatus: init.status as CongressRequestStatus } : {}),
      requesterId: src.requesterId, productManagerId: src.productManagerId,
      finalNote: origin, createdById: actorId, companyId: src.companyId,
    },
    select: { id: true },
  });
  return created.id;
}

/** Referme la demande d'origine — sans l'effacer, en disant où elle est partie. */
async function closeSource(kind: AdProKind, id: string, targetKind: AdProKind, targetId: string): Promise<void> {
  const note = `Transférée vers ${LABELS[targetKind]} — ${PATHS[targetKind]}/${targetId}`;
  if (kind === "SPONSORING") {
    await prisma.sponsoringRequest.update({ where: { id }, data: { status: "CLOSED", comments: note } });
    return;
  }
  if (kind === "CONGRESS_NATIONAL") {
    await prisma.congressNational.update({ where: { id }, data: { requestStatus: "CANCELLED", rejectionReason: note } });
    return;
  }
  await prisma.congressInternational.update({ where: { id }, data: { requestStatus: "CANCELLED", rejectionReason: note } });
}

export async function transferAdProRequest(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!hasGlobalView(user)) return { ok: false, error: "Réservé à la Direction et au Super Admin." };

  const fromRaw = fdStr(formData, "from") ?? "";
  const toRaw = fdStr(formData, "to") ?? "";
  const sourceId = fdStr(formData, "sourceId");
  if (!isKind(fromRaw) || !isKind(toRaw) || !sourceId) return { ok: false, error: "Transfert mal formé." };
  if (fromRaw === toRaw) return { ok: false, error: "La demande est déjà dans ce module." };
  // UN TRANSFERT À LA FOIS PAR DEMANDE (ADPRO-05) : deux clics lisaient tous deux la source ouverte et créaient deux
  // demandes cibles. La file sérialise dans le processus ; la source relue sous elle refuse la seconde (déjà annulée).
  return enSerie(`ad-pro-transfert:${fromRaw}:${sourceId}`, async (): Promise<ActionResult> => {
    const src = await readSource(fromRaw, sourceId);
    if (!src) return { ok: false, error: "Demande introuvable." };
    if (src.engagement) return { ok: false, error: src.engagement };
    // DU MATÉRIEL DU STOCK RÉSERVÉ (§118.167) : la demande d'origine se ferme, ses postes y restent —
    // et avec eux du matériel sorti du magasin que plus personne ne confirmerait. Pour toute nature
    // de demande : un congrès accordé porte des postes de stock aussi bien qu'un sponsoring.
    const reservees = await prisma.adProStockLine.count({
      where: { statut: "RESERVEE", item: { [COLONNE_POSTE[fromRaw]]: sourceId } },
    });
    if (reservees > 0) {
      return {
        ok: false,
        error: `${reservees} article(s) du stock sont réservés pour cette demande : confirmez d'abord ce qui a été remis (0 si rien) — le reste revient au magasin —, puis transférez-la.`,
      };
    }

    try {
      const targetId = await createTarget(toRaw, src, user.id, `${LABELS[fromRaw]} (${src.title})`);

      // Les pièces suivent : elles sont l'essentiel du travail déjà fait.
      const moved = await prisma.document.updateMany({
        where: { entityType: fromRaw, entityId: sourceId },
        data: { entityType: toRaw, entityId: targetId },
      });

      // Le circuit de validation de la source est clos : ses étapes n'ont plus d'objet, et le
      // laisser ouvert ferait apparaître la demande dans les files d'attente de ses acteurs. Par la
      // porte du moteur (`fermerInstance`) : elle ferme aussi une demande À CORRIGER, que l'écriture
      // d'ici — « en cours » seulement — laissait ouverte chez son demandeur (§118.186), et elle
      // laisse la raison au journal du circuit.
      await fermerInstance({
        viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
        entityType: fromRaw, entityId: sourceId, motif: `Transférée vers ${LABELS[toRaw]}`,
      }).catch(() => false);

      await closeSource(fromRaw, sourceId, toRaw, targetId);
      // Le circuit de la demande reçue naît maintenant, sur la route de son créateur, et prévient ses acteurs.
      await ouvrirLeCircuit(toRaw, targetId);

      for (const entry of [
        { entityId: sourceId, entityType: fromRaw, summary: `Demande transférée vers ${LABELS[toRaw]} (${PATHS[toRaw]}/${targetId}) — ${moved.count} pièce(s) déplacée(s).` },
        { entityId: targetId, entityType: toRaw, summary: `Demande reçue par transfert depuis ${LABELS[fromRaw]} — le circuit de validation repart de son début.` },
      ]) {
        await recordAudit({
          actorId: user.id, action: "UPDATE", module: LABELS[entry.entityType as AdProKind],
          entityType: entry.entityType as never, entityId: entry.entityId, summary: entry.summary,
        }).catch(() => undefined);
      }

      if (src.requesterId) {
        await notifyUser({
          userId: src.requesterId, type: "GENERIC",
          title: "Votre demande a été transférée",
          body: `« ${src.title} » a été déplacée vers ${LABELS[toRaw]}. Le circuit de validation y repart du début.`,
          link: `${PATHS[toRaw]}/${targetId}`,
        }).catch(() => undefined);
      }

      revalidatePath(PATHS[fromRaw]);
      revalidatePath(`${PATHS[fromRaw]}/${sourceId}`);
      revalidatePath(PATHS[toRaw]);
      return {
        ok: true, id: targetId,
        message: `Transférée vers ${LABELS[toRaw]}${moved.count > 0 ? ` avec ${moved.count} pièce(s)` : ""}. Le circuit y repart du début.`,
      };
    } catch (err) {
      console.error("[ad-pro] transfert impossible", err);
      return { ok: false, error: "Le transfert n'a pas pu être effectué." };
    }
  });
}
