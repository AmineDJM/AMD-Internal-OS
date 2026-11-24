import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { LIBELLE_BC_DEMANDE } from "@/lib/secretariat/devis-natif";
import { sansBloquer } from "@/lib/journal";
import { apresSignatureFinancesPec } from "@/modules/ad-pro/api";

/**
 * APRÈS LA SIGNATURE D'UN BC (module Bons de commande) : si le BC vient d'une demande au
 * secrétariat, la demande le DIT — « Signé et validé » se lit sur sa fiche (l'état est relu par
 * `etatsDesBC`, jamais copié) — et l'assistante qui la suit est prévenue, avec le demandeur : la
 * commande peut partir, la facture suivra, et la demande pourra se terminer. Jamais bloquant.
 *
 * Module à part, sans la fabrique : l'action de signature l'appelle, et n'a pas à charger le
 * générateur de pièces (ni son cycle d'initialisation avec Adam) pour prévenir deux personnes.
 */
/**
 * LE BC SIGNÉ D'UN POSTE À FICHES DE VOYAGE (recette du 23/11/2026) : billets et hôtels se font émettre APRÈS la
 * signature du bon de commande — or seule la Direction Marketing (qui l'a établi) l'apprenait. L'assistante qui a PRIS les
 * fiches du poste est prévenue qu'elle peut faire émettre et déposer ; des fiches que personne n'a prises préviennent le
 * secrétariat. Les fiches déjà réservées ou retirées ne comptent pas. Jamais bloquant.
 */
export async function apresSignatureDuBCDesFiches(bcId: string, acteurId: string, signataire: string): Promise<void> {
  const bc = await prisma.legalDocument.findUnique({ where: { id: bcId }, select: { reference: true, title: true, kind: true } });
  if (!bc || bc.kind !== "PURCHASE_ORDER") return;
  // LE BC n°k D'UNE PRISE EN CHARGE (circuit d'achat, 24/11/2026) : l'assistante achète ce qu'il porte — et seulement cela.
  if (await apresSignatureFinancesPec(bcId, acteurId, signataire)) return;
  const liens = await prisma.adProItemPiece.findMany({ where: { legalDocumentId: bcId, nature: "BON_DE_COMMANDE" }, select: { itemId: true } });
  if (liens.length === 0) return;
  const fiches = await prisma.demandeReservation.findMany({
    where: { itemId: { in: liens.map((l) => l.itemId) }, etat: { in: ["ENVOYEE", "PRISE", "DEVIS_RECU", "MODIFIEE_APRES_ENVOI", "MANQUE_SIGNALE"] } },
    select: { id: true, nature: true, priseParId: true, voyageur: { select: { nom: true, prenom: true } }, hebergement: { select: { nom: true, prenom: true } } },
    orderBy: { envoyeeLe: "asc" },
  });
  if (fiches.length === 0) return;
  const nom = bc.reference?.trim() || `« ${bc.title} »`;
  const parAssistante = new Map<string | null, typeof fiches>();
  for (const f of fiches) parAssistante.set(f.priseParId, [...(parAssistante.get(f.priseParId) ?? []), f]);
  for (const [assistanteId, siennes] of parAssistante) {
    const qui = siennes.map((f) => {
      const p = f.voyageur ?? f.hebergement;
      const personne = p ? [p.prenom, p.nom].filter(Boolean).join(" ") : "fiche";
      return `${f.nature === "HOTEL" ? "hôtel" : "billet"} · ${personne}`;
    });
    const avis = {
      type: "GENERIC" as const,
      title: siennes.some((f) => f.nature === "BILLET") ? "Billets à faire émettre — BC signé" : "Réservations à confirmer — BC signé",
      body: `${nom} signé par ${signataire} : faites émettre puis déposez sur ${siennes.length > 1 ? "les fiches" : "la fiche"} — ${qui.join(", ")}.`,
      link: `/demandes/fiches/${siennes[0]!.id}`,
    };
    await prevenirLeSecretariat(assistanteId, avis, acteurId).catch(sansBloquer("bc-signe.apresSignatureDuBCDesFiches.prevenirLeSecretariat", 0));
  }
}

export async function apresSignatureDuBCDeDemande(bcId: string, acteurId: string, signataire: string): Promise<void> {
  const bc = await prisma.legalDocument.findUnique({ where: { id: bcId }, select: { sourceType: true, sourceId: true, reference: true, title: true, kind: true } });
  if (!bc || bc.kind !== "PURCHASE_ORDER" || bc.sourceType !== "ADMIN_REQUEST" || !bc.sourceId) return;
  const demande = await prisma.administrativeRequest.findUnique({ where: { id: bc.sourceId }, select: { id: true, reference: true, requesterId: true, assignedToId: true, deletedAt: true } });
  if (!demande || demande.deletedAt) return;
  const nom = bc.reference?.trim() || `« ${bc.title} »`;
  await recordAudit({
    actorId: acteurId, action: "VALIDATE", module: "Bureau du secrétariat", entityType: "ADMIN_REQUEST", entityId: demande.id,
    summary: `Bon de commande ${nom} ${LIBELLE_BC_DEMANDE.SIGNE.toLowerCase()} — signé par ${signataire}`,
  }).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.recordAudit"));
  const avis = { type: "GENERIC" as const, title: "Bon de commande signé et validé", body: `${demande.reference} — ${nom} signé par ${signataire} : la commande peut partir.`, link: `/demandes/${demande.id}` };
  await prevenirLeSecretariat(demande.assignedToId, avis, acteurId).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.prevenirLeSecretariat", 0));
  if (demande.requesterId && demande.requesterId !== acteurId && demande.requesterId !== demande.assignedToId) {
    await notifyUser({ userId: demande.requesterId, ...avis }).catch(sansBloquer("bc-signe.apresSignatureDuBCDeDemande.notifyUser"));
  }
}
