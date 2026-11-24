import { prisma } from "@/lib/prisma";
import { PAYMENT_PIECE_KIND } from "@/lib/labels/finance";
import {
  etatQuestion, phraseRelances, EVT_QUESTION, EVT_RAPPEL, EVT_REPONSE, type EtatQuestion,
} from "../../domaine/banque-paiements";
import { KINDS_QUESTION } from "../questions-finances";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE MONTRE LE PANNEAU D'UNE LIGNE DE « BANQUE & PAIEMENTS » — le justificatif, le RIB, les échanges.
 *
 * Tout vient du DOSSIER COMPAGNON de l'ordre (ses pièces, son fil) et des pièces jointes à l'ordre lui-même : un seul
 * fil, celui que le demandeur lit sur sa demande. Le RIB est celui de l'annuaire (`CompanyContact.rib`) quand UN seul
 * contact porte le nom exact du bénéficiaire — deux homonymes, et l'on ne choisit pas à la place des Finances.
 *
 * Chargé pour les lignes de l'onglet ouvert seulement, en cinq lectures quel que soit leur nombre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PieceVue {
  documentId: string;
  nom: string;
  mime: string | null;
  /** « Facture », « Devis »… — la nature déclarée de la pièce. */
  nature: string;
}

export interface MessageFil {
  id: string;
  auteur: string;
  /** ISO. */
  at: string;
  /** « Question des Finances », « Réponse », « Relance »… */
  genre: string;
  message: string | null;
  /** Écrit par les Finances (à droite) ou par le demandeur (à gauche). */
  deFinances: boolean;
}

export interface DossierDeLigne {
  dossierId: string | null;
  dossierRef: string | null;
  demandeur: string | null;
  justificatif: PieceVue | null;
  autresPieces: PieceVue[];
  fil: MessageFil[];
  question: EtatQuestion | null;
  /** « Relancé 2 fois par le demandeur — dernière relance le … », ou rien. */
  relances: string | null;
  rib: string | null;
}

/** Ce qui fait foi d'abord : la facture, puis ce qui en tient lieu. */
const PRIORITE = ["INVOICE", "PROOF", "QUOTE", "PURCHASE_ORDER", "CONTRACT", "DELIVERY_NOTE", "OTHER"];

const GENRE: Record<string, string> = {
  COMMENT: "Message", [EVT_QUESTION]: "Question des Finances", [EVT_REPONSE]: "Réponse", [EVT_RAPPEL]: "Rappel",
  NUDGE: "Relance", URGENT: "Urgence signalée",
};
const KINDS_FIL = [...new Set([...KINDS_QUESTION, "NUDGE", "URGENT"])];

export async function chargerDossiersDesLignes(
  ordres: readonly { id: string; beneficiary: string | null }[],
): Promise<Map<string, DossierDeLigne>> {
  const out = new Map<string, DossierDeLigne>();
  if (ordres.length === 0) return out;
  const ids = ordres.map((o) => o.id);
  const beneficiaires = [...new Set(ordres.map((o) => o.beneficiary?.trim()).filter((b): b is string => Boolean(b)))];

  const [dossiers, docsOrdres, contacts] = await Promise.all([
    prisma.paymentRequest.findMany({
      where: { expenseOrderId: { in: ids } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, reference: true, requesterId: true, expenseOrderId: true,
        pieces: { where: { replacedBy: { is: null } }, orderBy: { position: "asc" }, select: { documentId: true, kind: true } },
      },
    }),
    prisma.document.findMany({
      where: { entityType: "EXPENSE_ORDER", entityId: { in: ids } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, mimeType: true, entityId: true },
    }),
    beneficiaires.length === 0 ? Promise.resolve([]) : prisma.companyContact.findMany({
      where: { isActive: true, rib: { not: null }, OR: beneficiaires.map((b) => ({ name: { equals: b, mode: "insensitive" as const } })) },
      select: { name: true, rib: true },
    }),
  ]);
  // Le premier dossier de chaque ordre : celui qu'il a ouvert en naissant.
  const dossierDe = new Map<string, (typeof dossiers)[number]>();
  for (const d of dossiers) if (d.expenseOrderId && !dossierDe.has(d.expenseOrderId)) dossierDe.set(d.expenseOrderId, d);
  const dossierIds = [...dossierDe.values()].map((d) => d.id);

  const [docsPieces, events] = await Promise.all([
    prisma.document.findMany({
      where: { id: { in: [...dossierDe.values()].flatMap((d) => d.pieces.map((p) => p.documentId)) } },
      select: { id: true, name: true, mimeType: true },
    }),
    dossierIds.length === 0 ? Promise.resolve([]) : prisma.paymentRequestEvent.findMany({
      where: { requestId: { in: dossierIds }, kind: { in: KINDS_FIL } },
      orderBy: { at: "asc" },
      select: { id: true, requestId: true, kind: true, actorId: true, message: true, at: true },
    }),
  ]);
  const acteurs = [...new Set([...events.map((e) => e.actorId), ...dossierIds.map((id) => dossiers.find((d) => d.id === id)?.requesterId ?? null)].filter((a): a is string => Boolean(a)))];
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: acteurs } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const docParId = new Map(docsPieces.map((d) => [d.id, d]));
  const ribParNom = new Map<string, string[]>();
  for (const c of contacts) ribParNom.set(c.name.trim().toLowerCase(), [...(ribParNom.get(c.name.trim().toLowerCase()) ?? []), c.rib!]);

  for (const o of ordres) {
    const d = dossierDe.get(o.id) ?? null;
    const pieces: (PieceVue & { rang: number })[] = (d?.pieces ?? []).flatMap((p) => {
      const doc = docParId.get(p.documentId);
      if (!doc) return [];
      return [{ documentId: doc.id, nom: doc.name, mime: doc.mimeType, nature: PAYMENT_PIECE_KIND[p.kind] ?? "Pièce", rang: PRIORITE.indexOf(p.kind) }];
    });
    for (const doc of docsOrdres.filter((x) => x.entityId === o.id)) {
      pieces.push({ documentId: doc.id, nom: doc.name, mime: doc.mimeType, nature: "Pièce de l'ordre", rang: PRIORITE.length });
    }
    const triees = [...pieces].sort((a, b) => a.rang - b.rang);
    const principal = triees[0] ?? null;
    const sesEvents = d ? events.filter((e) => e.requestId === d.id) : [];
    const lecture = d ? etatQuestion(sesEvents, d.requesterId) : null;
    const ribs = o.beneficiary ? [...new Set(ribParNom.get(o.beneficiary.trim().toLowerCase()) ?? [])] : [];
    out.set(o.id, {
      dossierId: d?.id ?? null,
      dossierRef: d?.reference ?? null,
      demandeur: d ? noms.get(d.requesterId) ?? null : null,
      justificatif: principal ? { documentId: principal.documentId, nom: principal.nom, mime: principal.mime, nature: principal.nature } : null,
      autresPieces: triees.slice(1).map((p) => ({ documentId: p.documentId, nom: p.nom, mime: p.mime, nature: p.nature })),
      fil: sesEvents.filter((e) => e.kind !== "REPONSE_LUE").slice(-30).map((e) => ({
        id: e.id, auteur: e.actorId ? noms.get(e.actorId) ?? "Utilisateur" : "Rappel automatique", at: e.at.toISOString(),
        genre: GENRE[e.kind] ?? e.kind, message: e.message, deFinances: Boolean(d && e.actorId && e.actorId !== d.requesterId) || e.kind === EVT_RAPPEL,
      })),
      question: lecture?.etat ?? null,
      relances: d ? phraseRelances(sesEvents.filter((e) => (e.kind === "NUDGE" || e.kind === "URGENT") && e.actorId === d.requesterId).map((e) => e.at)) : null,
      rib: ribs.length === 1 ? ribs[0] : null,
    });
  }
  return out;
}
