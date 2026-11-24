import type { DocumentCategory, EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { statutApresJustificatif, type CentralStatus } from "../domaine/authorization";
import {
  KINDS_JUSTIFIANTS, LIBELLE_LIEU_JUSTIFICATIF, LIBELLE_NATURE_JUSTIFICATIF, NATURE_DE_CATEGORIE, NATURE_DE_PIECE_LEGAL,
  natureAcceptee, regleDeJustificatif, type LieuJustificatif, type NatureJustificatif,
} from "../domaine/justificatif";
import { annoncerAuCentre } from "./relance-destinataires";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ EST LE JUSTIFICATIF D'UN ORDRE ? — une lecture, en lot, selon `JUSTIFICATIF_DE_SOURCE`.
 *
 * Lue à la NAISSANCE de l'ordre (`createExpenseOrder` : l'ordre entre au centre, ou attend sa pièce), à chaque pièce
 * déposée (`libererLesOrdresJustifies` : l'ordre qui attendait entre seul au centre), par le centre (`justificatifsDesOrdres`
 * : l'alerte « sans justificatif » des ordres d'avant la règle) et au règlement. Une seule lecture pour les quatre :
 * deux lectures du même fait divergent toujours (§118.5).
 *
 * Les lectures sont EN LOT — une poignée de requêtes, quel que soit le nombre d'ordres.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface OrdreAJustifier { id: string; sourceType: string | null; sourceId: string | null }

/** Ce que l'appelant SAIT à la naissance, avant que ses liens vers l'ordre soient posés. */
export interface IndiceDeJustificatif {
  /** La déclaration d'information médicale validée dont la validation émet l'ordre. */
  declarationId?: string | null;
  /** Un fichier déjà rangé ailleurs qui justifie la dépense (le PDF du devis retenu d'une prise en charge). */
  documentId?: string | null;
}

export interface JustificatifLu {
  present: boolean;
  nature: NatureJustificatif | null;
  lieu: LieuJustificatif | null;
  /** « facture — pièce du dossier de paiement » ; « sans justificatif ». */
  libelle: string;
}

const ABSENT: JustificatifLu = { present: false, nature: null, lieu: null, libelle: "sans justificatif" };
const CATEGORIES_JUSTIFIANTES = Object.keys(NATURE_DE_CATEGORIE) as DocumentCategory[];

export async function lireJustificatifs(
  ordres: readonly OrdreAJustifier[], indices: ReadonlyMap<string, IndiceDeJustificatif> = new Map(),
): Promise<Map<string, JustificatifLu>> {
  const out = new Map<string, JustificatifLu>(ordres.map((o) => [o.id, ABSENT]));
  if (ordres.length === 0) return out;
  const parId = new Map(ordres.map((o) => [o.id, o]));
  const regle = (id: string) => regleDeJustificatif(parId.get(id)?.sourceType);
  /** Pose le justificatif d'un ordre s'il est accepté par la règle de SON origine, à CE lieu. */
  const poser = (id: string | null | undefined, nature: NatureJustificatif | null | undefined, lieu: LieuJustificatif, sansFiltreNature = false) => {
    if (!id || !nature || out.get(id)?.present) return;
    const r = regle(id);
    if (!r.lieux.includes(lieu) || (!sansFiltreNature && !natureAcceptee(r, nature))) return;
    out.set(id, { present: true, nature, lieu, libelle: `${LIBELLE_NATURE_JUSTIFICATIF[nature]} — ${LIBELLE_LIEU_JUSTIFICATIF[lieu]}` });
  };

  const ids = ordres.map((o) => o.id);
  const fiches = ordres.filter((o) => o.sourceType && o.sourceId) as (OrdreAJustifier & { sourceType: string; sourceId: string })[];
  const sourcesDe = (t: string) => fiches.filter((o) => o.sourceType === t).map((o) => o.sourceId);
  const ordresDeLaFiche = (t: string, i: string) => fiches.filter((o) => o.sourceType === t && o.sourceId === i).map((o) => o.id);
  const declarationsIndiquees = [...indices.entries()].filter(([, v]) => v.declarationId).map(([k, v]) => [k, v.declarationId as string] as const);
  const documentsIndiques = [...indices.entries()].filter(([, v]) => v.documentId).map(([k, v]) => [k, v.documentId as string] as const);

  const [docsOrdre, dossiers, docsFiche, postes, registre, sourcesLegal, validees, avances, declarations, devisPec, docsIndiques] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ids }, category: { in: CATEGORIES_JUSTIFIANTES } }, select: { entityId: true, category: true } }),
    prisma.paymentRequest.findMany({
      where: { OR: [{ expenseOrderId: { in: ids } }, { id: { in: sourcesDe("PAYMENT_REQUEST") } }] },
      select: { id: true, expenseOrderId: true, entityType: true },
    }),
    fiches.length
      ? prisma.document.findMany({
          where: { OR: fiches.map((f) => ({ entityType: f.sourceType as EntityType, entityId: f.sourceId })) },
          select: { entityType: true, entityId: true, category: true },
        })
      : Promise.resolve([]),
    prisma.adProItem.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true, expenseOrderId: true } }),
    prisma.legalDocument.findMany({
      where: {
        kind: { in: Object.keys(NATURE_DE_PIECE_LEGAL) as never[] }, status: { not: "CANCELLED" },
        OR: [{ expenseOrderId: { in: ids } }, ...fiches.map((f) => ({ sourceType: f.sourceType as EntityType, sourceId: f.sourceId }))],
      },
      select: { id: true, kind: true, expenseOrderId: true, sourceType: true, sourceId: true },
    }),
    prisma.legalDocument.findMany({ where: { id: { in: sourcesDe("LEGAL_DOCUMENT") }, status: { not: "CANCELLED" } }, select: { id: true, kind: true } }),
    prisma.validationRequest.findMany({
      where: { entityType: "ADMIN_REQUEST", entityId: { in: sourcesDe("ADMIN_REQUEST") }, status: "APPROVED", documentId: { not: null } },
      select: { entityId: true },
    }),
    prisma.salaryAdvance.findMany({ where: { id: { in: sourcesDe("SALARY_ADVANCE") } }, select: { id: true, createdById: true, employee: { select: { userId: true } } } }),
    prisma.medicalInfoDeclaration.findMany({
      where: { status: "VALIDATED", OR: [{ expenseOrderId: { in: ids } }, { id: { in: declarationsIndiquees.map(([, d]) => d) } }] },
      select: { id: true, expenseOrderId: true },
    }),
    prisma.careQuote.findMany({ where: { expenseOrderId: { in: ids }, documentId: { not: null } }, select: { expenseOrderId: true } }),
    documentsIndiques.length
      ? prisma.document.findMany({ where: { id: { in: documentsIndiques.map(([, d]) => d) } }, select: { id: true, category: true } })
      : Promise.resolve([]),
  ]);

  // 1. Un fichier joint à l'ORDRE : il y a été joint comme son justificatif — quelle que soit l'origine.
  for (const d of docsOrdre) poser(d.entityId, NATURE_DE_CATEGORIE[d.category], "DOCUMENT_ORDRE", true);

  // 2. Les pièces du DOSSIER de paiement (compagnon, ou demande de paiement source) — et le bon de versement.
  const ordresDuDossier = new Map<string, string[]>();
  for (const d of dossiers) {
    const lies = [...(d.expenseOrderId && parId.has(d.expenseOrderId) ? [d.expenseOrderId] : []), ...ordresDeLaFiche("PAYMENT_REQUEST", d.id)];
    ordresDuDossier.set(d.id, [...new Set(lies)]);
    // Le BON DE VERSEMENT (`isBonDeVersement`) : validé en amont, exempté de pièce — il est son propre justificatif.
    if (d.entityType === "MEDICAL_INFO_DECLARATION") for (const o of ordresDeLaFiche("PAYMENT_REQUEST", d.id)) poser(o, "BON_DE_VERSEMENT", "SOURCE");
  }
  const pieces = ordresDuDossier.size
    ? await prisma.paymentPiece.findMany({
        where: { requestId: { in: [...ordresDuDossier.keys()] }, status: { not: "REJECTED" }, kind: { in: KINDS_JUSTIFIANTS as never[] } },
        select: { requestId: true, kind: true },
      })
    : [];
  for (const p of pieces) for (const o of ordresDuDossier.get(p.requestId) ?? []) poser(o, p.kind as NatureJustificatif, "PIECE_DOSSIER");

  // 3. Les fichiers de la FICHE d'origine — et du poste Ad & Pro qui a émis l'ordre.
  for (const d of docsFiche) {
    for (const o of ordresDeLaFiche(d.entityType, d.entityId)) {
      const toutCompte = regle(o).toutFichierDeLaSource === true;
      poser(o, NATURE_DE_CATEGORIE[d.category] ?? (toutCompte ? "PROOF" : null), "PIECE_SOURCE", toutCompte);
    }
  }
  const ordreDuPoste = new Map(postes.map((p) => [p.id, p.expenseOrderId as string]));
  if (ordreDuPoste.size) {
    const docsPostes = await prisma.document.findMany({
      where: { entityType: "AD_PRO_ITEM", entityId: { in: [...ordreDuPoste.keys()] }, category: { in: CATEGORIES_JUSTIFIANTES } },
      select: { entityId: true, category: true },
    });
    for (const d of docsPostes) poser(ordreDuPoste.get(d.entityId), NATURE_DE_CATEGORIE[d.category], "PIECE_SOURCE");
  }
  for (const q of devisPec) poser(q.expenseOrderId, "QUOTE", "PIECE_SOURCE");
  for (const [o, doc] of documentsIndiques) {
    const d = docsIndiques.find((x) => x.id === doc);
    if (d) poser(o, NATURE_DE_CATEGORIE[d.category] ?? "QUOTE", "PIECE_SOURCE", true);
  }

  // 4. Le REGISTRE Legal : une pièce rattachée à l'ordre ou à sa fiche, qui porte au moins un fichier (une ligne de
  //    registre sans pièce ne prouve rien — la règle de `facture-ordre.ts`).
  const avecFichier = registre.length
    ? new Set((await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: registre.map((r) => r.id) } }, select: { entityId: true } })).map((d) => d.entityId))
    : new Set<string>();
  for (const r of registre) {
    if (!avecFichier.has(r.id)) continue;
    const nature = NATURE_DE_PIECE_LEGAL[r.kind];
    if (r.expenseOrderId && parId.has(r.expenseOrderId)) poser(r.expenseOrderId, nature, "REGISTRE");
    if (r.sourceType && r.sourceId) for (const o of ordresDeLaFiche(r.sourceType, r.sourceId)) poser(o, nature, "REGISTRE");
  }

  // 5. La SOURCE est le justificatif.
  for (const l of sourcesLegal) for (const o of ordresDeLaFiche("LEGAL_DOCUMENT", l.id)) poser(o, NATURE_DE_PIECE_LEGAL[l.kind], "SOURCE");
  for (const v of validees) for (const o of ordresDeLaFiche("ADMIN_REQUEST", v.entityId ?? "")) poser(o, "PIECE_VALIDEE", "SOURCE");
  // L'avance demandée par le salarié LUI-MÊME, depuis sa session : sa demande est signée de fait. Saisie par les RH pour
  // lui, il faut la demande signée scannée (un fichier de l'avance).
  for (const a of avances) {
    if (a.createdById && a.createdById === a.employee.userId) for (const o of ordresDeLaFiche("SALARY_ADVANCE", a.id)) poser(o, "DEMANDE_SIGNEE", "SOURCE");
  }
  for (const d of declarations) {
    if (d.expenseOrderId && parId.has(d.expenseOrderId)) poser(d.expenseOrderId, "DECLARATION", "SOURCE");
    for (const [o, decl] of declarationsIndiquees) if (decl === d.id) poser(o, "DECLARATION", "SOURCE");
  }
  return out;
}

/** L'ÉTAT DU JUSTIFICATIF DES ORDRES — pour le centre (alerte « sans justificatif »), le règlement, les écrans. */
export interface JustificatifDeLOrdre extends JustificatifLu {
  /** L'ordre est né sous la règle : sans justificatif, il ne se règle pas. Faux pour les ordres d'avant la bascule. */
  exige: boolean;
  /** L'ordre attend sa pièce AVANT le centre. */
  enAttente: boolean;
}

export async function justificatifsDesOrdres(ids: readonly string[]): Promise<Map<string, JustificatifDeLOrdre>> {
  const res = new Map<string, JustificatifDeLOrdre>();
  if (ids.length === 0) return res;
  const ordres = await prisma.expenseOrder.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, sourceType: true, sourceId: true, justificatifExige: true, centralStatus: true },
  });
  const lus = await lireJustificatifs(ordres);
  for (const o of ordres) {
    res.set(o.id, { ...(lus.get(o.id) ?? ABSENT), exige: o.justificatifExige, enAttente: o.centralStatus === "AWAITING_PROOF" });
  }
  return res;
}

/**
 * LA PIÈCE EST JOINTE : L'ORDRE ENTRE AU CENTRE — seul, sans un second geste. Appelé après chaque pièce déposée (dossier de
 * paiement, fichier d'une fiche, du registre, de l'ordre) : relit les ordres qui attendent leur justificatif (peu nombreux,
 * index sur `centralStatus`) et fait entrer ceux qui l'ont désormais. L'écriture est CONDITIONNELLE (§118.151) — deux
 * dépôts simultanés n'annoncent l'ordre qu'une fois. Ne lève jamais : une pièce déposée ne doit pas échouer pour ça.
 */
export async function libererLesOrdresJustifies(acteurId?: string | null): Promise<number> {
  try {
    const attente = await prisma.expenseOrder.findMany({
      where: { centralStatus: "AWAITING_PROOF", status: "PENDING" },
      select: { id: true, reference: true, label: true, amount: true, companyId: true, sourceType: true, sourceId: true, centralStatus: true },
      take: 500,
    });
    if (attente.length === 0) return 0;
    const lus = await lireJustificatifs(attente);
    let entres = 0;
    for (const o of attente) {
      const j = lus.get(o.id);
      const suivant = statutApresJustificatif(o.centralStatus as CentralStatus, Boolean(j?.present));
      if (!suivant || !j) continue;
      const pris = await prisma.expenseOrder.updateMany({ where: { id: o.id, centralStatus: "AWAITING_PROOF", status: "PENDING" }, data: { centralStatus: suivant } });
      if (pris.count === 0) continue;
      entres += 1;
      await recordAudit({
        actorId: acteurId ?? null, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: o.id,
        field: "centralStatus", oldValue: "AWAITING_PROOF", newValue: suivant,
        summary: `${o.reference} — justificatif joint (${j.libelle}) : l'ordre entre au centre de paiement`,
      });
      await annoncerAuCentre({ reference: o.reference, label: o.label, amount: Number(o.amount), companyId: o.companyId });
    }
    return entres;
  } catch (e) {
    console.error("[justificatif] entrée au centre non évaluée", e);
    return 0;
  }
}
