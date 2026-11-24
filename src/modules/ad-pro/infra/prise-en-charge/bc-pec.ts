import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { moneyEntityOf } from "@/lib/company";
import { enSerie } from "@/lib/refs";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { reserveDeLAiguillage } from "@/lib/bons-de-commande/regle";
import { emettreDocumentDrive } from "@/platform/ia/artifact/factory";
import type { LigneCommerciale } from "@/lib/artifact/factory/commercial";
import { detailDuPoste, nomCourtDuPoste, resteAMettreEnBc } from "../../domaine/prise-en-charge/achats";
import { beneficiaryName } from "../../domaine/prise-en-charge/regles";
import { montantLisible } from "../../domaine/prise-en-charge/fiches";
import { type Scope, SPEC, CELL_FICHE_SELECT, loadRequest, parentWhere, versCellRow } from "./actions-commun";
import { lignesDesPostes } from "./achats";
import { refusEngagementPriseEnCharge } from "./engagement";
import { refusSiPorteDgFermee } from "../porte-dg";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « LANCER LES ACHATS » — LE BC NUMÉROTÉ D'UNE PRISE EN CHARGE (Super Admin, 24/11/2026).
 *
 * Tout ce qui est VALIDÉ par la Direction Marketing et pas encore couvert par un BC (le complément d'un prix relevé
 * au-delà de la marge compris) part dans le BC n°k suivant : un vrai `LegalDocument` PURCHASE_ORDER composé par la
 * FABRIQUE des pièces commerciales (numérotation, Word, PDF — jamais un second générateur), une ligne par poste.
 *
 * Le BC naît RETENU (`prevalidation`) : aucun centre ne le voit avant la signature de la Direction Marketing — c'est elle
 * qui le libère vers le centre Ad & Pro (`libererVersLeCentre`), puis les Finances le signent. Les lignes du BC sont écrites
 * sous le verrou de la demande, APRÈS avoir relu ce qui reste à mettre en BC : deux lancements simultanés ne mettent pas
 * deux fois le même poste dans deux BC (le second annule sa pièce et le dit).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PosteAMettreEnBc { cellId: string; nom: string; libelle: string; montant: number }

/** Ce qui partirait au prochain BC : postes des professionnels ACCORDÉS, validés, et pas encore (entièrement) en BC. */
export async function postesAMettreEnBc(scope: Scope, requestId: string): Promise<PosteAMettreEnBc[]> {
  const personnes = await prisma.careBeneficiary.findMany({
    where: { ...parentWhere(scope, requestId), status: "APPROVED" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      doctorId: true, firstName: true, lastName: true,
      cells: {
        // Un poste déjà engagé par le circuit d'avant (devis accepté, ordre émis) n'entre jamais dans un BC : il serait payé deux fois.
        where: { kind: "SERVICE", status: { not: "WAIVED" }, expenseOrderId: null, quoteId: null, montantValideDzd: { not: null } },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { ...CELL_FICHE_SELECT, montantValideDzd: true },
      },
    },
  });
  const docIds = personnes.map((p) => p.doctorId).filter((x): x is string => Boolean(x));
  const docs = docIds.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(docs.map((d) => [d.id, d.name]));
  const lignes = await lignesDesPostes(personnes.flatMap((p) => p.cells.map((c) => c.id)));
  const out: PosteAMettreEnBc[] = [];
  for (const p of personnes) {
    const nom = beneficiaryName({ ...p, doctorName: p.doctorId ? nomDe.get(p.doctorId) ?? null : null });
    for (const c of p.cells) {
      const deja = lignes.get(c.id) ?? [];
      const reste = resteAMettreEnBc(c.montantValideDzd != null ? toNumber(c.montantValideDzd) : null, deja);
      if (reste <= 0) continue;
      const row = versCellRow(c);
      const complement = deja.some((l) => l.statut === "ACTIVE" || l.statut === "ACHETEE");
      out.push({ cellId: c.id, nom, libelle: `${nom} — ${nomCourtDuPoste(c.serviceKind)}${complement ? " (complément)" : ""} : ${detailDuPoste(row)}`, montant: reste });
    }
  }
  return out;
}

export type ResultatLancement =
  | { ok: true; bcId: string; numero: number; reference: string; total: number; lignes: number; reserve: string | null }
  | { ok: false; error: string };

/** LANCER LES ACHATS — l'appelant (l'action) a vérifié que c'est la Direction Marketing, sur une demande qu'elle voit. */
export async function lancerLesAchats(
  user: CurrentUser, scope: Scope, requestId: string, opts: { fournisseur?: string | null; budgetCategoryId?: string | null },
): Promise<ResultatLancement> {
  return enSerie(`pec-achats:${requestId}`, async () => {
    const req = await loadRequest(scope, requestId);
    if (!req) return { ok: false, error: "Demande introuvable." };
    const postes = await postesAMettreEnBc(scope, requestId);
    if (postes.length === 0) return { ok: false, error: "Rien de validé n'attend un BC : validez d'abord les montants chiffrés des professionnels accordés." };
    // RIEN NE S'ENGAGE AVANT LA PRÉVALIDATION ET L'ACCORD, ni au-dessus du seuil sans le DG (27/10/2026).
    const refus = await refusEngagementPriseEnCharge(scope, requestId, postes.map((p) => p.cellId));
    if (refus) return { ok: false, error: refus };
    const refusDg = await refusSiPorteDgFermee(SPEC[scope].module, requestId);
    if (refusDg) return { ok: false, error: refusDg };
    const societe = req.companyId ?? (req.requesterId ? await moneyEntityOf(req.requesterId) : null);
    if (!societe) return { ok: false, error: "La demande n'est rattachée à aucune société : corrigez-la (l'entité qui paie) avant de lancer les achats." };
    if (opts.budgetCategoryId && (await prisma.budgetCategoryLine.count({ where: { id: opts.budgetCategoryId } })) === 0) {
      return { ok: false, error: "La catégorie budgétaire choisie est introuvable." };
    }

    const dernier = await prisma.carePecBc.findFirst({ where: parentWhere(scope, requestId), orderBy: { numero: "desc" }, select: { numero: true } });
    const numero = (dernier?.numero ?? 0) + 1;
    const fournisseur = opts.fournisseur?.trim() || `Prestataires de la prise en charge « ${req.name} »`;
    const lignes: LigneCommerciale[] = postes.map((p) => ({ designation: p.libelle, quantite: 1, unite: "forfait", prixUnitaire: p.montant, tva: 0 }));
    const emis = await emettreDocumentDrive(user, {
      type: "BON_DE_COMMANDE",
      societe,
      tiers: { nom: fournisseur },
      lignes,
      // MONTANTS TTC SAISIS PAR L'ASSISTANTE : la TVA n'est jamais devinée — elle est dans le prix chiffré.
      tvaDefaut: 0,
      objet: `Prise en charge « ${req.name} » — BC n°${numero}`,
      dossier: `Ad & Pro/${req.name}`,
      // RETENU jusqu'à la signature de la Direction Marketing : c'est elle qui l'adresse au centre Ad & Pro.
      prevalidation: true,
    }, { source: { type: SPEC[scope].module, id: requestId }, delegation: `Prise en charge « ${req.name} » — BC n°${numero} lancé par la Direction Marketing d'après les montants validés` });
    if (!emis.ok) return { ok: false, error: `Le BC n°${numero} n'a pas pu être composé : ${emis.motif}` };

    // LES LIGNES, SOUS LE VERROU DE LA DEMANDE, APRÈS RELECTURE : ce qui a été composé est ce qui reste à mettre en BC.
    const ecrit = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pec-achats'), hashtext(${requestId}))`;
      const relus = await postesAMettreEnBc(scope, requestId);
      const pareil = relus.length === postes.length && relus.every((r, k) => r.cellId === postes[k]!.cellId && r.montant === postes[k]!.montant);
      if (!pareil) return null;
      const bc = await tx.carePecBc.create({
        data: { ...parentWhere(scope, requestId), numero, legalDocumentId: emis.legalDocumentId, fournisseur, budgetCategoryId: opts.budgetCategoryId ?? null, creeParId: user.id },
        select: { id: true },
      });
      await tx.carePecBcLigne.createMany({ data: postes.map((p) => ({ bcId: bc.id, cellId: p.cellId, libelle: p.libelle, montantDzd: p.montant })) });
      return bc;
    }).catch((e) => { console.error("[pec-achats] écriture des lignes du BC impossible", e); return null; });
    if (!ecrit) {
      // La pièce numérotée ne s'efface pas : elle passe ANNULÉE, son numéro reste consommé.
      await prisma.legalDocument.update({ where: { id: emis.legalDocumentId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Lancement des achats concurrent : les postes avaient changé." } })
        .catch(sansBloquer("pec-achats.lancerLesAchats.annulation"));
      return { ok: false, error: "Les montants ou les postes à mettre en BC viennent de changer : rien n'a été lancé — rechargez la page et relancez." };
    }
    const total = Math.round(postes.reduce((s, p) => s + p.montant * 100, 0)) / 100;
    await recordAudit({
      actorId: user.id, action: "CREATE", module: SPEC[scope].module, entityType: SPEC[scope].module, entityId: requestId,
      summary: `BC n°${numero} (${emis.reference}) lancé — ${postes.length} poste(s), ${montantLisible(total)} : ${postes.map((p) => `${p.libelle} = ${montantLisible(p.montant)}`).join(" ; ")}.`,
    }).catch(sansBloquer("pec-achats.lancerLesAchats.recordAudit"));
    return { ok: true, bcId: ecrit.id, numero, reference: emis.reference, total, lignes: postes.length, reserve: null };
  });
}

/**
 * LIBÉRER LE BC VERS LE CENTRE — après la signature de la Direction Marketing : la retenue est levée (écriture
 * conditionnelle) et l'aiguillage ordinaire l'adresse au centre Ad & Pro (au-dessus du seuil des BC) ou aux Finances.
 */
export async function libererVersLeCentre(legalDocumentId: string, acteurId: string): Promise<string | null> {
  await prisma.legalDocument.updateMany({ where: { id: legalDocumentId, bcPrevalidationAt: { not: null } }, data: { bcPrevalidationAt: null, bcPrevalidationRequestId: null } });
  const a = await aiguillerBC(legalDocumentId, { acteurId });
  return reserveDeLAiguillage(a);
}
