import { Prisma, type CareCurrency } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import {
  achatsApresCorrection, jugerNouveauPrix, refusAchatHorsBc, type JugementPrix, type LigneAchat,
} from "../../domaine/prise-en-charge/achats";
import { montantLisible } from "../../domaine/prise-en-charge/fiches";
import { type Scope, SPEC, ecrireAAssistante, loadRequest, parentWhere } from "./actions-commun";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE CIRCUIT D'ACHAT PAR BC NUMÉROTÉS : les écritures communes et les gardes (Super Admin, 24/11/2026).
 *
 * Les règles sont pures (`domaine/prise-en-charge/achats.ts`) ; ici, ce qui lit et écrit la base pour elles : les lignes de
 * BC d'un poste, l'écriture HISTORISÉE d'un prix (marge de 10 % comprise), la demande de chiffrage, la garde d'achat que
 * relisent les dépôts (billet, confirmation), le BC de prise en charge derrière une pièce Legal, et l'avis à l'assistante
 * quand les Finances ont signé. Aucune porte n'exporte les écrivains : les actions du module les importent en relatif ;
 * l'api n'expose que les gardes et les lectures que d'autres domaines doivent tenir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number | null => (v == null ? null : toNumber(v as never));

export type LigneLue = LigneAchat & { id: string; bcId: string; cellId: string; libelle: string; legalDocumentId: string | null };

/** La demande suit-elle le circuit d'achat par BC (née après lui) ? */
export async function circuitAchat(scope: Scope, requestId: string): Promise<boolean> {
  const r = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id: requestId }, select: { circuitAchatAt: true } })
    : await prisma.congressInternational.findUnique({ where: { id: requestId }, select: { circuitAchatAt: true } });
  return Boolean(r?.circuitAchatAt);
}

/** Les signatures des Finances (et annulations) de plusieurs pièces — une requête. */
async function piecesDesBc(ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { signeFinances: boolean; annule: boolean }>();
  const docs = await prisma.legalDocument.findMany({ where: { id: { in: [...ids] } }, select: { id: true, signedAt: true, status: true } });
  return new Map(docs.map((d) => [d.id, { signeFinances: d.signedAt != null && d.status !== "CANCELLED", annule: d.status === "CANCELLED" }]));
}

/** Les lignes de BC de plusieurs postes, avec l'état de leur BC — par poste. */
export async function lignesDesPostes(cellIds: readonly string[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Map<string, LigneLue[]>> {
  const out = new Map<string, LigneLue[]>();
  if (cellIds.length === 0) return out;
  const rows = await db.carePecBcLigne.findMany({
    where: { cellId: { in: [...cellIds] } },
    select: {
      id: true, bcId: true, cellId: true, libelle: true, statut: true, montantDzd: true, montantAchatDzd: true, rembourse: true, rembourseDzd: true,
      bc: { select: { numero: true, legalDocumentId: true, expenseOrderId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const pieces = await piecesDesBc(rows.map((r) => r.bc.legalDocumentId).filter((x): x is string => Boolean(x)));
  for (const r of rows) {
    const p = r.bc.legalDocumentId ? pieces.get(r.bc.legalDocumentId) : undefined;
    const l: LigneLue = {
      id: r.id, bcId: r.bcId, cellId: r.cellId, libelle: r.libelle, legalDocumentId: r.bc.legalDocumentId,
      // UN BC ANNULÉ ne porte plus rien : sa ligne non achetée se lit barrée — le poste revient au prochain BC.
      bcNumero: r.bc.numero, statut: p?.annule && r.statut === "ACTIVE" ? "RETIREE_AVANT_ACHAT" : r.statut, montantDzd: num(r.montantDzd) ?? 0, montantAchatDzd: num(r.montantAchatDzd),
      rembourse: r.rembourse, rembourseDzd: num(r.rembourseDzd), bcSigneFinances: Boolean(p?.signeFinances), bcPaiementDemande: r.bc.expenseOrderId != null,
    };
    out.set(r.cellId, [...(out.get(r.cellId) ?? []), l]);
  }
  return out;
}

// ───────────────────────────── Le prix d'un poste, historisé ─────────────────────────────

export type EcriturePrix =
  | { ok: true; voie: JugementPrix["voie"]; message: string }
  | { ok: false; error: string };

/**
 * ÉCRIRE LE PRIX D'UN POSTE — toujours HISTORISÉ (qui, quand, ancien → nouveau, pourquoi), sous le verrou de la case.
 *
 *   • aucun BC ne le porte : le prix change, il redevient « à valider » s'il diffère du validé ;
 *   • dans la marge de 10 % (ou une baisse) : le prix d'achat des lignes est corrigé et le validé suit — aucun nouveau BC ;
 *   • au-delà : le BC signé ne bouge pas ; le nouveau prix attend la validation de la Direction Marketing, puis le
 *     complément part dans un BC complémentaire ;
 *   • paiement du BC demandé : refusé — l'ordre de dépense est né, son montant ne se change plus d'ici.
 */
export async function ecrirePrixDuPoste(i: {
  cellId: string; montant: number; devise: CareCurrency; amountDzd: number; auteurId: string; motif: string; chiffrage: boolean; pieceId?: string | null;
}): Promise<EcriturePrix> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "CareCell" WHERE id = ${i.cellId} FOR UPDATE`;
    const cell = await tx.careCell.findUnique({ where: { id: i.cellId }, select: { id: true, label: true, amountDzd: true, amount: true, currency: true, montantValideDzd: true, chiffreLe: true } });
    if (!cell) return { ok: false as const, error: "Poste introuvable." };
    const lignes = (await lignesDesPostes([i.cellId], tx)).get(i.cellId) ?? [];
    const j = jugerNouveauPrix(i.amountDzd, lignes);
    if (j.voie === "PAIEMENT_DEMANDE") {
      return { ok: false as const, error: `Le paiement du BC n°${j.bcNumero} est déjà demandé : le montant de « ${cell.label} » ne change plus d'ici.` };
    }
    const maintenant = new Date();
    await tx.careCell.update({
      where: { id: i.cellId },
      data: {
        amount: i.montant, currency: i.devise, amountDzd: i.amountDzd,
        ...(i.chiffrage || !cell.chiffreLe ? { chiffreLe: maintenant, chiffreParId: i.auteurId } : {}),
        ...(i.pieceId ? { chiffragePieceId: i.pieceId } : {}),
        // DANS LA MARGE : la correction vaut validation — la Direction Marketing a validé l'achat, la marge l'autorise.
        ...(j.voie === "DANS_LA_MARGE" ? { montantValideDzd: i.amountDzd } : {}),
      },
    });
    if (j.voie === "DANS_LA_MARGE") {
      const achats = achatsApresCorrection(i.amountDzd, lignes);
      for (const [k, a] of achats.entries()) {
        if (a == null) continue;
        await tx.carePecBcLigne.update({ where: { id: lignes[k]!.id }, data: { montantAchatDzd: a } });
      }
    }
    const motif = j.voie === "HORS_MARGE" ? `${i.motif} — au-delà de la marge de 10 % : complément pour un BC complémentaire` : j.voie === "DANS_LA_MARGE" ? `${i.motif} — dans la marge de 10 %` : i.motif;
    await tx.carePrixHistorique.create({
      data: {
        cellId: i.cellId, ancienDzd: cell.amountDzd, nouveauDzd: i.amountDzd, ancienMontant: cell.amount, nouveauMontant: i.montant,
        devise: i.devise, motif, auteurId: i.auteurId,
      },
    });
    const message = j.voie === "HORS_MARGE"
      ? `Au-delà de la marge de 10 % (plafond ${montantLisible(j.plafond)} sur le BC signé) : le BC ne change pas. Le complément de ${montantLisible(j.complement)} est mis de côté — la Direction Marketing le valide, puis il part dans un BC complémentaire.`
      : j.voie === "DANS_LA_MARGE"
        ? `Prix d'achat corrigé dans la marge (${montantLisible(i.amountDzd)}, plafond ${montantLisible(j.plafond)}) : aucun nouveau BC.`
        : `Montant enregistré : ${montantLisible(i.amountDzd)}.`;
    return { ok: true as const, voie: j.voie, message };
  });
}

// ───────────────────────────── La demande de chiffrage ─────────────────────────────

/**
 * SOLLICITER LE CHIFFRAGE — une seule demande ouverte par prise en charge : une nouvelle sollicitation s'y ajoute (les
 * professionnels s'accumulent, « Actualiser » l'étend à tout). Elle s'écrit dans le sujet de l'assistante (ce qui lui ouvre
 * la porte étroite de la prise en charge, `devis-acces.ts`) et la prévient.
 */
export async function solliciterChiffrage(
  user: { id: string; name?: string | null; role: string; secondaryRole?: string | null },
  scope: Scope, requestId: string, quoi: { beneficiaryIds: string[] } | { tous: true },
): Promise<{ ok: true; id: string; nouveau: boolean; reference: string } | { ok: false; error: string }> {
  const req = await loadRequest(scope, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  const r = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('care-chiffrage'), hashtext(${requestId}))`;
    const ouverte = await tx.careChiffrage.findFirst({ where: { ...parentWhere(scope, requestId), etat: { in: ["A_PRENDRE", "EN_COURS"] } }, orderBy: { demandeLe: "asc" } });
    if (ouverte) {
      const ids = "tous" in quoi ? ouverte.beneficiaryIds : [...new Set([...ouverte.beneficiaryIds, ...quoi.beneficiaryIds])];
      await tx.careChiffrage.update({ where: { id: ouverte.id }, data: { beneficiaryIds: ids, tous: ouverte.tous || "tous" in quoi } });
      return { id: ouverte.id, nouveau: false };
    }
    const c = await tx.careChiffrage.create({
      data: { ...parentWhere(scope, requestId), tous: "tous" in quoi, beneficiaryIds: "tous" in quoi ? [] : quoi.beneficiaryIds, demandeParId: user.id },
      select: { id: true },
    });
    return { id: c.id, nouveau: true };
  });
  const lien = `${SPEC[scope].path}/${requestId}/chiffrer`;
  const sujet = await ecrireAAssistante(scope, req, user as never, "Demande de chiffrage.",
    `${"tous" in quoi ? "Actualiser les prix de tout ce qui n'est pas encore acheté" : `${quoi.beneficiaryIds.length} professionnel(s) à chiffrer`} — saisissez les montants poste par poste, puis « Envoyer les montants » : ${lien}`);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  if (r.nouveau) {
    await notifyRoles(["DIRECTION_ASSISTANT"], {
      type: "VALIDATION_REQUIRED", title: "Chiffrage demandé — prise en charge", body: `${req.name} : montants à saisir.`, link: lien,
    }).catch(sansBloquer("pec-achats.solliciterChiffrage.notifyRoles"));
  }
  return { ok: true, id: r.id, nouveau: r.nouveau, reference: sujet.reference };
}

// ───────────────────────────── Les gardes que d'autres domaines relisent ─────────────────────────────

/**
 * LE DÉPÔT D'UN BILLET / D'UNE CONFIRMATION SUR UN POSTE DU CIRCUIT D'ACHAT — `null` quand il est permis. Une demande d'avant
 * le circuit garde ses règles (rien de plus) ; une demande du circuit n'achète QUE ce qui est dans un BC signé par les Finances.
 */
export async function refusAchatHorsBcPec(cellId: string): Promise<string | null> {
  const cell = await prisma.careCell.findUnique({
    where: { id: cellId },
    select: { beneficiary: { select: { congressNational: { select: { circuitAchatAt: true } }, congressInternational: { select: { circuitAchatAt: true } } } } },
  });
  const circuit = cell?.beneficiary.congressNational?.circuitAchatAt ?? cell?.beneficiary.congressInternational?.circuitAchatAt ?? null;
  if (!circuit) return null;
  return refusAchatHorsBc((await lignesDesPostes([cellId])).get(cellId) ?? []);
}

/** UN DÉPÔT QUI VAUT ACHAT : la ligne active du poste, dans un BC signé par les Finances, passe « achetée » (écriture conditionnelle). */
export async function marquerAcheteeParDepot(cellId: string, acteurId: string): Promise<number> {
  const lignes = (await lignesDesPostes([cellId])).get(cellId) ?? [];
  const ids = lignes.filter((l) => l.statut === "ACTIVE" && l.bcSigneFinances).map((l) => l.id);
  if (ids.length === 0) return 0;
  const r = await prisma.carePecBcLigne.updateMany({ where: { id: { in: ids }, statut: "ACTIVE" }, data: { statut: "ACHETEE", acheteLe: new Date(), acheteParId: acteurId } });
  return r.count;
}

/** Le BC de prise en charge derrière une pièce Legal — `null` si la pièce n'en est pas un. */
export async function bcPecDuDocument(legalDocumentId: string) {
  const bc = await prisma.carePecBc.findUnique({
    where: { legalDocumentId },
    select: { id: true, numero: true, congressNationalId: true, congressInternationalId: true, expenseOrderId: true },
  });
  if (!bc) return null;
  const scope: Scope = bc.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = bc.congressNationalId ?? bc.congressInternationalId;
  return requestId ? { ...bc, scope, requestId } : null;
}

/**
 * APRÈS LA SIGNATURE DES FINANCES D'UN BC DE PRISE EN CHARGE : l'assistante (celle du sujet, sinon le secrétariat) peut
 * acheter — et seulement ce qui est dans ce BC. La Direction Marketing et le demandeur le voient sur la fiche. Jamais bloquant.
 */
export async function apresSignatureFinancesPec(legalDocumentId: string, acteurId: string, signataire: string): Promise<boolean> {
  const bc = await bcPecDuDocument(legalDocumentId);
  if (!bc) return false;
  const req = await loadRequest(bc.scope, bc.requestId);
  if (!req) return false;
  const sujet = req.careReservationDossierId
    ? await prisma.dossier.findUnique({ where: { id: req.careReservationDossierId }, select: { assignedToId: true } })
    : null;
  const lien = `${SPEC[bc.scope].path}/${bc.requestId}/achat/${bc.numero}`;
  const avis = {
    type: "GENERIC" as const,
    title: `Achats à faire — BC n°${bc.numero} signé`,
    body: `${req.name} : le BC n°${bc.numero} est signé par ${signataire}. Achetez ce qui y figure — et seulement cela.`,
    link: lien,
  };
  await prevenirLeSecretariat(sujet?.assignedToId ?? null, avis, acteurId).catch(sansBloquer("pec-achats.apresSignatureFinancesPec.prevenirLeSecretariat", 0));
  if (req.requesterId && req.requesterId !== acteurId) {
    await notifyUser({ userId: req.requesterId, ...avis, title: `BC n°${bc.numero} signé — prise en charge`, link: `${SPEC[bc.scope].path}/${bc.requestId}` })
      .catch(sansBloquer("pec-achats.apresSignatureFinancesPec.notifyUser"));
  }
  await recordAudit({
    actorId: acteurId, action: "VALIDATE", module: SPEC[bc.scope].module, entityType: SPEC[bc.scope].module, entityId: bc.requestId,
    summary: `BC n°${bc.numero} de la prise en charge signé par les Finances (${signataire}) — l'assistante est prévenue d'acheter.`,
  }).catch(sansBloquer("pec-achats.apresSignatureFinancesPec.recordAudit"));
  return true;
}
