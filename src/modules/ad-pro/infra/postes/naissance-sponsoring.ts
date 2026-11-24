import { prisma } from "@/lib/prisma";
import { montantDzd, toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { sansBloquer } from "@/lib/journal";
import { POSTE_DE_LA_NATURE, posteDuSponsoring } from "../../domaine/poste-du-sponsoring";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { libelleTemps, opsFranchiALaSoumission } from "../../domaine/validation-poste";
import { demandeurDe, prevenirLeTemps, recordDecision } from "./commun";

/** Ce que la naissance a fait — lu par les bancs ; le moteur ne s'en sert pas. */
export type NaissancePoste = "NE" | "SOUMIS" | "DEJA_LA" | "SANS_NATURE";

/** La phrase du premier temps franchi d'office — la MÊME que la soumission d'un poste (`submitAdProItem`). */
const NOTE_OPS = "Demande prévalidée (N+1, Directeur des opérations, Direction Marketing) : la Direction Marketing accepte le poste.";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POSTE DU SPONSORING NAÎT QUAND LA PRÉVALIDATION EST COMPLÈTE (recette 24/11/2026).
 *
 * Appelé par le moteur du circuit à l'approbation qui conclut un sponsoring (`advanceWorkflowInstance` — la Direction
 * Marketing, ou la prévalidation d'office d'une demande de la Direction Marketing). Le poste naît EN ATTENTE de la
 * Direction Marketing, exactement comme un poste soumis (`submitAdProItem`, notifications comprises) : elle le lit,
 * l'ajuste et l'accorde, sans « Soumettre pour validation ».
 *
 * IDEMPOTENT — un second appel (un appel du délégué rouvre le circuit, qui reconclut) ne crée rien :
 *   • le poste de la nature existe en BROUILLON (demande d'avant cette règle) → il passe en attente, rien n'est recréé ;
 *   • la demande porte déjà un poste, quel qu'il soit → rien : le poste est né, a été réparti, décidé ou retiré, et
 *     aucun poste ne s'ajoute à la main avant la prévalidation (`refusAvantPrevalidation`) ;
 *   • sinon il naît. Deux approbations simultanées n'existent pas : le circuit est PRIS pendant le geste.
 * Une demande sans nature (d'avant la règle) n'a pas de poste à ouvrir : rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function naitrePosteDuSponsoring(sponsoringId: string, acteurId: string): Promise<NaissancePoste> {
  const spo = await prisma.sponsoringRequest.findUnique({
    where: { id: sponsoringId },
    select: {
      reference: true, institution: true, nature: true, amountRequested: true, amountProposed: true, requesterId: true,
      // Un poste HISTORIQUE (dépense 2026 reprise du fichier) n'est pas un poste du circuit : il ne retient rien.
      items: { where: { historiqueLotId: null }, select: { id: true, kind: true, status: true, label: true, amountEstimated: true } },
    },
  });
  if (!spo?.nature) return "SANS_NATURE";
  const kind = POSTE_DE_LA_NATURE[spo.nature];

  // LES MÊMES CHAMPS QU'UNE SOUMISSION : en attente, le premier temps franchi d'office (tracé), rien de décidé.
  const demandeur = await demandeurDe(spo.requesterId);
  const opsDOffice = opsFranchiALaSoumission(demandeur);
  const maintenant = new Date();
  const enAttente = {
    status: "PENDING" as const, submittedAt: maintenant, decisionNote: null, updatedById: acteurId,
    opsDecidedAt: opsDOffice ? maintenant : null, opsDecidedById: null, opsDecisionNote: opsDOffice ? NOTE_OPS : null,
  };

  let poste: { id: string; label: string; amountEstimated: unknown };
  let issue: NaissancePoste;
  const brouillon = spo.items.find((i) => i.kind === kind && i.status === "DRAFT");
  if (brouillon) {
    // Écriture CONDITIONNELLE : un brouillon soumis ou retiré entre la lecture et l'écriture n'est pas réécrit.
    const fait = await prisma.adProItem.updateMany({ where: { id: brouillon.id, status: "DRAFT" }, data: enAttente });
    if (fait.count === 0) return "DEJA_LA";
    poste = brouillon;
    issue = "SOUMIS";
  } else if (spo.items.length > 0) {
    return "DEJA_LA";
  } else {
    const p = posteDuSponsoring({
      nature: spo.nature, institution: spo.institution,
      amountRequested: spo.amountRequested != null ? toNumber(spo.amountRequested) : null,
      amountProposed: spo.amountProposed != null ? toNumber(spo.amountProposed) : null,
    }, montantDzd);
    poste = await prisma.adProItem.create({
      data: {
        sponsoringId, ...p, budgetKind: "INCLUDED", position: 1,
        // LE BLOC PRINCIPAL (Direction, 15/11/2026) : « le principal, c'est le prix proposé par le médecin et le délégué ».
        principal: true,
        ...enAttente,
        createdById: spo.requesterId ?? acteurId,
      },
      select: { id: true, label: true, amountEstimated: true },
    });
    issue = "NE";
  }

  // LA SUITE D'UNE SOUMISSION : la trace de la décision, la Direction Marketing prévenue (« Poste à valider »), l'audit.
  const montant = poste.amountEstimated != null ? toNumber(poste.amountEstimated) : null;
  await recordDecision(poste.id, "PENDING", "Prévalidation de la demande : le poste part à la Direction Marketing.", montant, acteurId);
  const temps = opsDOffice ? "MARKETING" as const : "OPERATIONS" as const;
  const corps = `${spo.reference} — ${ITEM_KIND_LABELS[kind]} « ${poste.label} »${montant != null ? ` (${montant.toLocaleString("fr-FR")} DZD)` : ""}`;
  await prevenirLeTemps(temps, demandeur, "Poste à valider", corps, lienPosteAdPro("SPONSORING", sponsoringId, poste.id));
  await recordAudit({
    actorId: acteurId, module: "SPONSORING", entityType: "SPONSORING", entityId: sponsoringId, action: issue === "NE" ? "CREATE" : "UPDATE",
    summary: `Poste « ${poste.label} » ${issue === "NE" ? "né" : "passé en attente"} à la prévalidation — en attente de ${libelleTemps(temps, demandeur)}.`,
  }).catch(sansBloquer("ad-pro.naitrePosteDuSponsoring.recordAudit"));
  return issue;
}
