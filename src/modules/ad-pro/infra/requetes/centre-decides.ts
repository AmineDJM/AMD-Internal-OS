import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";
import { lienDemandeAdPro, lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { AD_PRO_KINDS } from "../../domaine/unified";
import { PARENT_COLONNE, type AdProParent } from "../../domaine/postes";
import { visasTranchesCentreAdPro } from "./centre";
import type { DecisionCentre, EtatDecide } from "../../domaine/centre-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « DÉJÀ DÉCIDÉS » — le menu ⋯ du centre Ad & Pro (maquette validée le 24/11/2026).
 *
 * Les décisions récentes du centre, toutes formes confondues, lues là où chacune s'écrit — aucune table
 * de synthèse (§118.5) :
 *   • le VISA d'une demande ou d'un BC du registre Legal (`AdProGateVisa`, décidé) ;
 *   • le TOTAL d'une demande validé ou renvoyé en révision par le DG (`AdProPorteDg`) ;
 *   • le BC d'un POSTE visé (`orderDirectionAt`) ou refusé (`orderStage = REFUSED`).
 * Seul un REFUS de visa se réexamine — et seulement sur une demande qui attend encore (la règle de
 * `visasTranchesCentreAdPro`, reprise telle quelle).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LIMITE = 30;

const lienNature = (kind: string, id: string) => `${AD_PRO_KINDS.find((k) => k.kind === kind)?.href ?? "/ad-pro"}/${id}`;

/** Le nom de chaque demande-parent (sponsoring, congrès, événement, autre), en lot. */
async function nomsDesParents(refs: readonly { type: AdProParent; id: string }[]): Promise<Map<string, string>> {
  const ids = (t: AdProParent) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const [spons, natio, intl, evts, autres] = await Promise.all([
    ids("SPONSORING").length ? prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { id: true, reference: true, institution: true } }).catch(sansBloquer("ad-pro-centre-decides.sponsoring", [])) : [],
    ids("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, name: true } }).catch(sansBloquer("ad-pro-centre-decides.congressNational", [])) : [],
    ids("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true } }).catch(sansBloquer("ad-pro-centre-decides.congressInternational", [])) : [],
    ids("EVENT").length ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, name: true } }).catch(sansBloquer("ad-pro-centre-decides.event", [])) : [],
    ids("AD_PRO_OTHER").length ? prisma.adProOtherRequest.findMany({ where: { id: { in: ids("AD_PRO_OTHER") } }, select: { id: true, reference: true, title: true } }).catch(sansBloquer("ad-pro-centre-decides.adProOther", [])) : [],
  ]);
  const out = new Map<string, string>();
  for (const r of spons) out.set(`SPONSORING:${r.id}`, `${r.reference} — ${r.institution}`);
  for (const r of natio) out.set(`CONGRESS_NATIONAL:${r.id}`, r.name);
  for (const r of intl) out.set(`CONGRESS_INTERNATIONAL:${r.id}`, r.name);
  for (const r of evts) out.set(`EVENT:${r.id}`, r.name);
  for (const r of autres) out.set(`AD_PRO_OTHER:${r.id}`, r.reference ? `${r.reference} — ${r.title}` : r.title);
  return out;
}

export async function decisionsRecentesCentreAdPro(): Promise<DecisionCentre[]> {
  const [visas, totaux, vises, refuses, tranches] = await Promise.all([
    prisma.adProGateVisa.findMany({
      where: { status: { in: ["APPROVED", "REFUSED", "CHANGES_REQUESTED"] }, decidedAt: { not: null } },
      orderBy: { decidedAt: "desc" }, take: LIMITE,
      select: { entityType: true, entityId: true, status: true, amount: true, note: true, decidedAt: true, decidedBy: { select: { name: true } } },
    }).catch(sansBloquer("ad-pro-centre-decides.adProGateVisa", [])),
    prisma.adProPorteDg.findMany({
      where: { decideLe: { not: null }, statut: { in: ["VALIDEE", "A_REVOIR"] } },
      orderBy: { decideLe: "desc" }, take: LIMITE,
      select: { entityType: true, entityId: true, statut: true, montant: true, note: true, decideLe: true, decideParId: true },
    }).catch(sansBloquer("ad-pro-centre-decides.adProPorteDg", [])),
    prisma.adProItem.findMany({
      where: { orderDirectionAt: { not: null } },
      orderBy: { orderDirectionAt: "desc" }, take: LIMITE,
      select: {
        id: true, label: true, supplier: true, amountGranted: true, orderVisaAmount: true, orderDecisionNote: true, orderDirectionAt: true, orderDirectionById: true,
        sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
      },
    }).catch(sansBloquer("ad-pro-centre-decides.adProItem.vises", [])),
    prisma.adProItem.findMany({
      where: { orderStage: "REFUSED" },
      orderBy: { updatedAt: "desc" }, take: LIMITE,
      select: {
        id: true, label: true, supplier: true, amountGranted: true, orderVisaAmount: true, orderDecisionNote: true, updatedAt: true, updatedById: true,
        sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
      },
    }).catch(sansBloquer("ad-pro-centre-decides.adProItem.refuses", [])),
    visasTranchesCentreAdPro(),
  ]);

  // Les NOMS : documents Legal, contrats et autres demandes à visa ; parents des totaux et des postes ; décideurs.
  const idsDe = (t: string) => visas.filter((v) => v.entityType === t).map((v) => v.entityId);
  const [legaux, contrats, autresVisa] = await Promise.all([
    idsDe("LEGAL_DOCUMENT").length ? prisma.legalDocument.findMany({ where: { id: { in: idsDe("LEGAL_DOCUMENT") } }, select: { id: true, reference: true, title: true, counterparty: true } }).catch(sansBloquer("ad-pro-centre-decides.legalDocument", [])) : [],
    idsDe("CONSULTING_CONTRACT").length ? prisma.consultingContract.findMany({ where: { id: { in: idsDe("CONSULTING_CONTRACT") } }, select: { id: true, reference: true, title: true } }).catch(sansBloquer("ad-pro-centre-decides.consultingContract", [])) : [],
    idsDe("AD_PRO_OTHER").length ? prisma.adProOtherRequest.findMany({ where: { id: { in: idsDe("AD_PRO_OTHER") } }, select: { id: true, reference: true, title: true } }).catch(sansBloquer("ad-pro-centre-decides.adProOtherRequest", [])) : [],
  ]);
  const parentDe = (p: Record<(typeof PARENT_COLONNE)[AdProParent], string | null>): { type: AdProParent; id: string } | null => {
    for (const [type, col] of Object.entries(PARENT_COLONNE) as [AdProParent, (typeof PARENT_COLONNE)[AdProParent]][]) {
      if (p[col]) return { type, id: p[col]! };
    }
    return null;
  };
  const refsParents = [
    ...totaux.filter((t) => t.entityType in PARENT_COLONNE).map((t) => ({ type: t.entityType as AdProParent, id: t.entityId })),
    ...[...vises, ...refuses].map(parentDe).filter((x): x is { type: AdProParent; id: string } => x !== null),
  ];
  const idsPersonnes = [...new Set([
    ...totaux.map((t) => t.decideParId), ...vises.map((v) => v.orderDirectionById), ...refuses.map((r) => r.updatedById),
  ].filter((x): x is string => Boolean(x)))];
  const [parents, personnes] = await Promise.all([
    nomsDesParents(refsParents),
    idsPersonnes.length ? prisma.user.findMany({ where: { id: { in: idsPersonnes } }, select: { id: true, name: true } }).catch(sansBloquer("ad-pro-centre-decides.user", [])) : [],
  ]);
  const nom = new Map(personnes.map((u) => [u.id, u.name]));
  const reexaminables = new Set(tranches.lignes.filter((t) => t.etat === "REFUSED").map((t) => `${t.entityType}:${t.entityId}`));

  const out: DecisionCentre[] = [];
  const fiches = new Map<string, { objet: string; href: string }>();
  for (const d of legaux) fiches.set(`LEGAL_DOCUMENT:${d.id}`, { objet: `BC ${d.reference ?? ""} — ${d.counterparty ?? d.title}`.replace("BC  — ", "BC — "), href: `/legal/${d.id}` });
  for (const c of contrats) fiches.set(`CONSULTING_CONTRACT:${c.id}`, { objet: c.reference ? `${c.reference} — ${c.title}` : c.title, href: lienNature("CONSULTING", c.id) });
  for (const o of autresVisa) fiches.set(`AD_PRO_OTHER:${o.id}`, { objet: o.reference ? `${o.reference} — ${o.title}` : o.title, href: lienNature("OTHER", o.id) });

  for (const v of visas) {
    const cle = `${v.entityType}:${v.entityId}`;
    const f = fiches.get(cle);
    if (!f) continue; // la pièce ou la demande n'existe plus : rien à montrer
    const bc = v.entityType === "LEGAL_DOCUMENT";
    out.push({
      cle, entityType: v.entityType, entityId: v.entityId, objet: f.objet, href: f.href,
      montant: v.amount == null ? null : toNumber(v.amount),
      etat: v.status === "APPROVED" ? (bc ? "VISE" : "AUTORISE") : v.status === "REFUSED" ? "REFUSE" : "RENVOYE",
      decideur: v.decidedBy?.name ?? null, le: v.decidedAt?.toISOString() ?? null, note: v.note,
      reexaminable: v.status === "REFUSED" && reexaminables.has(cle),
    });
  }
  for (const t of totaux) {
    if (!(t.entityType in PARENT_COLONNE)) continue;
    const parent = t.entityType as AdProParent;
    const n = parents.get(`${parent}:${t.entityId}`);
    if (!n) continue;
    out.push({
      cle: `TOTAL:${parent}:${t.entityId}`, entityType: t.entityType, entityId: t.entityId,
      objet: `Total — ${n}`, href: lienDemandeAdPro(parent, t.entityId),
      montant: t.montant == null ? null : toNumber(t.montant),
      etat: t.statut === "VALIDEE" ? "VALIDE" : "RENVOYE",
      decideur: t.decideParId ? nom.get(t.decideParId) ?? null : null, le: t.decideLe?.toISOString() ?? null, note: t.note, reexaminable: false,
    });
  }
  const poste = (p: (typeof vises)[number] | (typeof refuses)[number], etat: EtatDecide, le: Date | null, par: string | null) => {
    const parent = parentDe(p);
    if (!parent) return;
    const op = parents.get(`${parent.type}:${parent.id}`);
    out.push({
      cle: `AD_PRO_ITEM:${p.id}:${etat}`, entityType: "AD_PRO_ITEM", entityId: p.id,
      objet: `BC — ${p.label}${p.supplier ? ` · ${p.supplier}` : ""}${op ? ` — ${op}` : ""}`,
      href: lienPosteAdPro(parent.type, parent.id, p.id),
      montant: p.orderVisaAmount != null ? toNumber(p.orderVisaAmount) : p.amountGranted != null ? toNumber(p.amountGranted) : null,
      etat, decideur: par ? nom.get(par) ?? null : null, le: le?.toISOString() ?? null, note: p.orderDecisionNote, reexaminable: false,
    });
  };
  for (const v of vises) poste(v, "VISE", v.orderDirectionAt, v.orderDirectionById);
  for (const r of refuses) poste(r, "REFUSE", r.updatedAt, r.updatedById);

  return out.sort((a, b) => (b.le ?? "").localeCompare(a.le ?? "")).slice(0, LIMITE);
}
