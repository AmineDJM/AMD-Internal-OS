import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveFile } from "@/lib/storage";
import { recordAudit } from "@/lib/audit";
import { ETAPES_BV } from "@/lib/budget-regulatory/bv";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";
import type { RegWorkflowState } from "@/lib/regulatory-workflow";
import { syncStatusFromWorkflow } from "@/lib/regulatory/sync-status";
import { inscrireDocumentEcrit } from "@/modules/bibliotheque/api-inscription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÈGLEMENT D'UN BV DE DOSSIER — la quittance, puis l'étape « Paiement du BV » (Direction, 10/2026).
 *
 * « Une fois payé, les Finances uploadent le document et mettent “payé”. » Le règlement d'un ordre de BV
 * (source `REGULATORY_PRODUCT`, libellé « BV 25 % — … ») exige donc la QUITTANCE (bon de versement payé) :
 * déposée au geste « Payé », elle se range sur l'étape « Paiement du BV » du DOSSIER — là où l'équipe
 * Regulatory la cherche, avec les droits du dossier —, et l'étape se coche. Une quittance déjà jointe à
 * l'ordre (catégorie quittance / reçu de paiement) vaut aussi : on ne la redemande pas.
 *
 * Module SERVEUR (lit la base, écrit le stockage) — jamais importé par un composant client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qui compte comme la quittance d'un BV quand elle est jointe à l'ORDRE lui-même. */
const QUITTANCE_SUR_L_ORDRE = ["BV_RECEIPT", "PAYMENT_RECEIPT"] as const;

export interface OrdreBvRegle {
  id: string;
  reference?: string;
  sourceType: string | null;
  sourceId: string | null;
  label: string;
  createdAt: Date;
}

/** Les ordres de BV dont la quittance est déjà là — EN LOT (deux requêtes quelle que soit la taille). */
export async function ordresBvAvecQuittance(ordres: readonly OrdreBvRegle[]): Promise<Set<string>> {
  const out = new Set<string>();
  const bv = ordres.filter((o) => o.sourceId && natureDeLOrdreBv(o));
  if (bv.length === 0) return out;
  const [surOrdre, surDossier] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "EXPENSE_ORDER", entityId: { in: bv.map((o) => o.id) }, category: { in: [...QUITTANCE_SUR_L_ORDRE] } },
      select: { entityId: true },
    }),
    prisma.document.findMany({
      where: {
        entityType: "REGULATORY_PRODUCT", entityId: { in: bv.map((o) => o.sourceId!) }, category: "BV_RECEIPT",
        stepKey: { in: [ETAPES_BV["25"].paiement, ETAPES_BV["75"].paiement] },
      },
      select: { entityId: true, stepKey: true, createdAt: true },
    }),
  ]);
  const ordresAvecPiece = new Set(surOrdre.map((d) => d.entityId));
  for (const o of bv) {
    if (ordresAvecPiece.has(o.id)) { out.add(o.id); continue; }
    const etape = ETAPES_BV[natureDeLOrdreBv(o)!].paiement;
    // Une quittance d'AVANT l'ordre est celle d'un autre versement : elle ne prouve pas celui-ci.
    if (surDossier.some((d) => d.entityId === o.sourceId && d.stepKey === etape && d.createdAt >= o.createdAt)) out.add(o.id);
  }
  return out;
}

/**
 * Dépose la quittance sur l'étape « Paiement du BV » du dossier. LÈVE si le stockage échoue : un
 * règlement qui exige la pièce ne passe pas sans elle.
 */
export async function deposerQuittanceBv(o: OrdreBvRegle, file: File, userId: string): Promise<string> {
  const nature = natureDeLOrdreBv(o);
  if (!nature || !o.sourceId) throw new Error("Cet ordre n'est pas le BV d'un dossier.");
  const key = `REGULATORY_PRODUCT/${o.sourceId}/${randomUUID()}__${file.name}`;
  const ecrit = await saveFile(key, Buffer.from(await file.arrayBuffer()));
  const doc = await prisma.document.create({
    data: {
      name: file.name, category: "BV_RECEIPT", entityType: "REGULATORY_PRODUCT", entityId: o.sourceId,
      stepKey: ETAPES_BV[nature].paiement, fileKey: key, mimeType: file.type || null, sizeBytes: file.size,
      confidentiality: "INTERNAL", uploadedById: userId,
    },
    select: { id: true, entityType: true, category: true, confidentiality: true, name: true, mimeType: true, sizeBytes: true, uploadedById: true },
  });
  // La pièce entre à la bibliothèque (J1) : registre, clé du document, file de lecture. Ne lève jamais.
  await inscrireDocumentEcrit(doc, ecrit);
  return doc.id;
}

/**
 * LE BV EST PAYÉ : « Paiement du BV » se coche — et la demande, si elle ne l'était pas (un ordre réglé
 * a forcément été demandé). IDEMPOTENT : une étape déjà faite garde sa date. L'écriture est
 * CONDITIONNELLE sur la version lue du dossier (une coche faite entre-temps à l'écran n'est pas
 * écrasée : on relit et on recommence). Le niveau de process suit, par son seul écrivain.
 */
export async function cocherPaiementBv(o: OrdreBvRegle, actorId: string): Promise<boolean> {
  const nature = natureDeLOrdreBv(o);
  if (!nature || !o.sourceId) return false;
  const { demande, paiement } = ETAPES_BV[nature];
  for (let essai = 0; essai < 4; essai++) {
    const p = await prisma.regulatoryProduct.findUnique({
      where: { id: o.sourceId },
      select: { workflow: true, status: true, reference: true, updatedAt: true },
    });
    if (!p) return false;
    const wf: RegWorkflowState = { ...((p.workflow as RegWorkflowState | null) ?? {}) };
    const jour = new Date().toISOString().slice(0, 10);
    let change = false;
    for (const k of [demande, paiement]) {
      if (wf[k]?.status === "DONE") continue;
      wf[k] = { ...wf[k], status: "DONE", date: wf[k]?.date ?? jour };
      change = true;
    }
    if (!change) return false;
    const ecrit = await prisma.regulatoryProduct.updateMany({
      where: { id: o.sourceId, updatedAt: p.updatedAt },
      data: { workflow: wf as unknown as Prisma.InputJsonValue },
    });
    if (ecrit.count === 0) continue;
    await recordAudit({
      actorId, action: "UPDATE", module: "Regulatory", entityType: "REGULATORY_PRODUCT", entityId: o.sourceId,
      summary: `Paiement du ${LIBELLE_NATURE_BV[nature]} — étape cochée au règlement de l'ordre ${o.reference ?? o.id}`,
    });
    await syncStatusFromWorkflow(o.sourceId, wf, p.status, p.reference, actorId);
    return true;
  }
  return false;
}
