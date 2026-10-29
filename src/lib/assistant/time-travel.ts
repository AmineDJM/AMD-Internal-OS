import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";

/**
 * TIME TRAVEL — « Où en était ce dossier au 1er juin ? »
 *
 * L'outil reconstruit l'ÉTAT PASSÉ d'un dossier à une date donnée, à partir du journal d'audit
 * (`AuditLog`) : ce qui s'était déjà passé, la valeur des champs modifiés depuis, et ce qui a
 * changé entre cette date et aujourd'hui (LE « avant / maintenant » se lit dans la même réponse).
 *
 * Deux règles absolues :
 *   • STRICTEMENT LECTURE SEULE — aucune écriture, aucune correction, aucun « rejeu » : on lit
 *     le journal, on le présente, rien d'autre ;
 *   • HONNÊTETÉ DE COUVERTURE — le journal ne capture que ce qui a été TRACÉ : un champ jamais
 *     audité n'apparaît pas, et l'outil le dit au lieu de compléter par déduction.
 */

/** Le siège exécutif : PDG (DIRECTION) et Super Admin — la même porte que les autres outils. */
const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

/** Un instant, en heure d'Alger, lisible — même rendu que les autres outils exécutifs. */
function fr(d: Date | null | undefined): string {
  if (!d) return "—";
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
}

/**
 * La date cible → l'instant de coupure : « au 1er juin » = la FIN de cette journée (heure
 * d'Alger) — l'état après tout ce qui s'est passé ce jour-là. Un horodatage ISO complet est
 * pris tel quel. Renvoie null si la date est illisible.
 */
export function parseTimeTravelDate(raw: string): Date | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999+01:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Le dossier résolu : de quoi lire son journal et montrer son état ACTUEL en face du passé. */
export interface ResolvedRecord {
  entityType: string;
  id: string;
  type: string;
  reference: string | null;
  titre: string;
  creeLe: Date;
  lien: string;
  etatActuel: Record<string, unknown>;
}

/**
 * Résout la référence sur les mêmes pistes qu'`inspect_record` (paiement → règlement → Legal →
 * Regulatory → tâche) — bornées, insensibles à la casse, le titre en repli de la référence.
 * Exportée : `what_changed` (« qu'est-ce qui a changé depuis lundi ? ») résout par le MÊME chemin.
 */
export async function resolveRecord(ref: string): Promise<ResolvedRecord | null> {
  const refOrTitle = (titleField: string) => ({
    OR: [{ reference: { equals: ref, mode: "insensitive" as const } }, { [titleField]: { contains: ref, mode: "insensitive" as const } }],
  });

  const pay = await prisma.paymentRequest.findFirst({
    where: refOrTitle("title") as never,
    select: { id: true, reference: true, title: true, payee: true, amount: true, status: true, dueDate: true, createdAt: true },
  });
  if (pay) {
    return {
      entityType: "PAYMENT_REQUEST", id: pay.id, type: "Demande de paiement",
      reference: pay.reference, titre: pay.title, creeLe: pay.createdAt, lien: `/validations/paiements/${pay.id}`,
      etatActuel: { statut: pay.status, beneficiaire: pay.payee, montantDzd: Math.round(toNumber(pay.amount)), echeance: pay.dueDate ? fr(pay.dueDate) : null },
    };
  }

  const order = await prisma.expenseOrder.findFirst({
    where: refOrTitle("label") as never,
    select: { id: true, reference: true, label: true, amount: true, status: true, centralStatus: true, paidDate: true, createdAt: true },
  });
  if (order) {
    return {
      entityType: "EXPENSE_ORDER", id: order.id, type: "Règlement (ordre de dépense)",
      reference: order.reference, titre: order.label, creeLe: order.createdAt, lien: "/centre-de-paiement",
      etatActuel: { statut: order.status, centreDePaiement: order.centralStatus, montantDzd: Math.round(toNumber(order.amount)), payeLe: order.paidDate ? fr(order.paidDate) : "pas encore payé" },
    };
  }

  const legal = await prisma.legalDocument.findFirst({
    where: refOrTitle("title") as never,
    select: { id: true, reference: true, title: true, kind: true, counterparty: true, amount: true, status: true, endDate: true, createdAt: true },
  });
  if (legal) {
    return {
      entityType: "LEGAL_DOCUMENT", id: legal.id, type: `Document Legal (${legal.kind})`,
      reference: legal.reference, titre: legal.title, creeLe: legal.createdAt, lien: `/legal/${legal.id}`,
      etatActuel: { statut: legal.status, partie: legal.counterparty, montantDzd: legal.amount != null ? Math.round(toNumber(legal.amount)) : null, fin: legal.endDate ? fr(legal.endDate) : null },
    };
  }

  const reg = await prisma.regulatoryProduct.findFirst({
    where: { OR: [{ reference: { equals: ref, mode: "insensitive" } }, { dci: { contains: ref, mode: "insensitive" } }, { brandName: { contains: ref, mode: "insensitive" } }] },
    select: { id: true, reference: true, dci: true, brandName: true, status: true, priority: true, manufacturingStatus: true, targetSubmissionDate: true, targetDate: true, createdAt: true },
  });
  if (reg) {
    return {
      entityType: "REGULATORY_PRODUCT", id: reg.id, type: "Dossier Regulatory",
      reference: reg.reference, titre: [reg.brandName, reg.dci].filter(Boolean).join(" — ") || reg.dci, creeLe: reg.createdAt, lien: `/regulatory/${reg.id}`,
      etatActuel: { statut: reg.status, priorite: reg.priority, fabrication: reg.manufacturingStatus, depotCible: reg.targetSubmissionDate ? fr(reg.targetSubmissionDate) : null, enregistrementCible: reg.targetDate ? fr(reg.targetDate) : null },
    };
  }

  const task = await prisma.task.findFirst({
    where: { title: { contains: ref, mode: "insensitive" } },
    select: { id: true, title: true, status: true, priority: true, dueDate: true, createdAt: true, assignedTo: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (task) {
    return {
      entityType: "TASK", id: task.id, type: "Tâche",
      reference: null, titre: task.title, creeLe: task.createdAt, lien: "/mon-espace",
      etatActuel: { statut: task.status, priorite: task.priority, assigneeA: task.assignedTo?.name ?? null, echeance: task.dueDate ? fr(task.dueDate) : null },
    };
  }

  return null;
}

/** Une entrée d'audit, projetée pour la réponse. */
const line = (h: { createdAt: Date; summary: string | null; action: string; field: string | null; oldValue: string | null; newValue: string | null; actor: { name: string } | null }) => ({
  date: fr(h.createdAt),
  evenement: h.summary ?? h.action,
  ...(h.field ? { champ: h.field, de: h.oldValue, a: h.newValue } : {}),
  ...(h.actor?.name ? { par: h.actor.name } : {}),
});

const AUDIT_SELECT = {
  createdAt: true, action: true, summary: true, field: true, oldValue: true, newValue: true,
  actor: { select: { name: true } },
} as const;

export const TIME_TRAVEL_TOOLS: PowerTool[] = [
  {
    def: {
      name: "time_travel",
      description:
        "Reconstruit l'ÉTAT PASSÉ d'un dossier à une date donnée, depuis le journal d'audit — LECTURE SEULE, rien n'est modifié. " +
        "Pour « où en était ce dossier au 1er juin ? », « qui l'avait validé à ce moment-là ? », « qu'est-ce qui a changé depuis ? ». " +
        "Renvoie : la valeur des champs à cette date (dernières écritures tracées), les événements déjà survenus, ce qui a changé APRÈS " +
        "la date, et l'état ACTUEL en face (le « avant / maintenant » se lit d'un coup d'œil). Couvre demandes de paiement, règlements, " +
        "documents Legal, dossiers Regulatory (avec l'état des étapes ANPP à la date) et tâches. Le journal ne capture que ce qui a été " +
        "tracé : l'outil dit ce qu'il ne sait pas au lieu de l'inventer.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Référence (PAY-…, ORD-…, REG-…) ou fragment de titre du dossier." },
          date: { type: "string", description: "La date cible, format AAAA-MM-JJ (ex. 2026-06-01 pour « au 1er juin »)." },
        },
        required: ["reference", "date"],
      },
    },
    allowed: EXEC,
    label: "État passé reconstruit",
    run: async (input, user) => {
      void user;
      const ref = str(input, "reference");
      const rawDate = str(input, "date");
      if (ref.length < 2) return "Donnez une référence ou un fragment de titre.";
      const cutoff = parseTimeTravelDate(rawDate);
      if (!cutoff) return `Date illisible : « ${rawDate} ». Donnez-la au format AAAA-MM-JJ (ex. 2026-06-01).`;
      if (cutoff.getTime() > Date.now()) {
        return `La date ${rawDate} est dans le futur — le voyage dans le temps ne va que vers le passé. Pour l'état d'aujourd'hui, utiliser inspect_record.`;
      }

      const record = await resolveRecord(ref);
      if (!record) {
        return `Aucun dossier ne porte « ${ref} » — ni demande de paiement, ni règlement, ni document Legal, ni dossier Regulatory, ni tâche. Vérifier la référence (search_everything).`;
      }

      // LE DOSSIER N'EXISTAIT PAS ENCORE — la réponse honnête s'arrête là.
      if (record.creeLe.getTime() > cutoff.getTime()) {
        return JSON.stringify({
          type: record.type, reference: record.reference, titre: record.titre,
          dateCible: rawDate,
          reponse: `Ce dossier n'existait pas encore au ${rawDate} : il a été créé le ${fr(record.creeLe)}.`,
          etatActuel: record.etatActuel,
          lien: record.lien,
          garantie: "Reconstruction en LECTURE SEULE depuis le journal d'audit — rien n'a été modifié.",
        });
      }

      // Le journal, de part et d'autre de la coupure — BORNÉ : on reconstruit, on ne rejoue pas
      // toute la vie du dossier.
      const [before, after] = await Promise.all([
        prisma.auditLog.findMany({
          where: { entityType: record.entityType as never, entityId: record.id, createdAt: { lte: cutoff } },
          select: AUDIT_SELECT, orderBy: { createdAt: "desc" }, take: 200,
        }),
        prisma.auditLog.findMany({
          where: { entityType: record.entityType as never, entityId: record.id, createdAt: { gt: cutoff } },
          select: AUDIT_SELECT, orderBy: { createdAt: "asc" }, take: 200,
        }),
      ]);

      // LA VALEUR DES CHAMPS À LA DATE — deux sources, dans cet ordre de préférence :
      //   1. la DERNIÈRE écriture tracée AVANT la coupure (newValue) ;
      //   2. sinon, la PREMIÈRE écriture APRÈS la coupure : son oldValue est PRÉCISÉMENT la
      //      valeur que le champ portait encore à la date cible.
      const champs: Record<string, { valeur: string | null; source: string }> = {};
      for (const h of before) {
        if (h.field && !(h.field in champs)) {
          champs[h.field] = { valeur: h.newValue, source: `écrit le ${fr(h.createdAt)}${h.actor?.name ? ` par ${h.actor.name}` : ""}` };
        }
      }
      for (const h of after) {
        if (h.field && !(h.field in champs) && h.oldValue != null) {
          champs[h.field] = { valeur: h.oldValue, source: `valeur remplacée après la date (le ${fr(h.createdAt)})` };
        }
      }

      // Dossier Regulatory : l'état des ÉTAPES ANPP à la date — faites / pas encore, avec ce qui
      // s'est fait depuis. Les dates réelles des étapes sont la meilleure archive du circuit.
      let etapes: unknown = undefined;
      if (record.entityType === "REGULATORY_PRODUCT") {
        const steps = await prisma.regulatoryStep.findMany({
          where: { productId: record.id },
          select: { type: true, order: true, status: true, plannedDate: true, actualDate: true },
          orderBy: { order: "asc" },
        });
        etapes = steps.map((s) => ({
          etape: s.type,
          aLaDate: s.actualDate && s.actualDate.getTime() <= cutoff.getTime()
            ? `faite le ${fr(s.actualDate)}`
            : s.actualDate
              ? `pas encore faite à cette date (faite depuis, le ${fr(s.actualDate)})`
              : `non faite${s.plannedDate ? ` (prévue le ${fr(s.plannedDate)})` : ""}`,
          statutActuel: s.status,
        }));
      }

      const chronologiques = [...before].reverse();
      return JSON.stringify({
        type: record.type, reference: record.reference, titre: record.titre,
        dateCible: rawDate,
        existaitDepuis: fr(record.creeLe),
        etatReconstruitALaDate: Object.keys(champs).length > 0
          ? champs
          : "Aucune modification de champ tracée pour reconstruire des valeurs — voir les événements ci-dessous.",
        ...(etapes !== undefined ? { etapesRegulatoryALaDate: etapes } : {}),
        evenementsDejaSurvenus: {
          total: before.length >= 200 ? "200+ (bornés)" : before.length,
          derniers: chronologiques.slice(-15).map(line),
        },
        changementsDepuisCetteDate: {
          total: after.length >= 200 ? "200+ (bornés)" : after.length,
          premiers: after.slice(0, 5).map(line),
        },
        etatActuel: record.etatActuel,
        lien: record.lien,
        garantie:
          "Reconstruction en LECTURE SEULE depuis le journal d'audit — rien n'a été modifié. " +
          "Le journal ne capture que ce qui a été tracé : un champ jamais audité n'apparaît pas ici.",
      });
    },
  },
];
