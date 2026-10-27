import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyRoles } from "@/lib/notify";
import { statutApresRevision, memeBeneficiaire, ROLES_CENTRE_DE_PAIEMENT, type CentralStatus } from "@/lib/payments/authorization";
import { ENTITE_SANS, slugSectionDeLOrdre } from "@/lib/payments/sections-centre";
import { lienCentreDePaiement } from "@/lib/chemins/finances";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉVISER UN ORDRE DE DÉPENSE NON RÉGLÉ — le seul endroit où son montant ou son bénéficiaire change
 * après sa naissance (§118.191, audit 360° R04).
 *
 * ── POURQUOI UN SEUL ENDROIT ───────────────────────────────────────────────────────────────
 *
 * Deux gestes font bouger un ordre déjà né : la Direction qui relève le budget accordé d'un congrès,
 * et — désormais — le demandeur qui corrige sa demande de paiement. Le premier écrivait en ligne, et
 * sans condition : il lisait l'ordre « non réglé », puis l'écrivait par son seul identifiant. Un
 * règlement passé entre les deux voyait son ordre PAYÉ changer de montant, et son autorisation
 * rouverte au centre — un paiement déjà parti redevenu « à autoriser ». Deux écritures de la même
 * règle auraient fini par diverger ; la seconde aurait hérité du défaut de la première (§118.5).
 *
 * ── CE QUE L'ÉCRITURE GARANTIT ─────────────────────────────────────────────────────────────
 *
 *   • elle ne touche qu'un ordre NON RÉGLÉ, et le dit quand il l'est (`REGLE`) ;
 *   • elle ne touche pas un ordre REFUSÉ par le centre (`REFUSE`) : un refus ne se contourne pas en
 *     retouchant le chiffre, et l'appelant dit au demandeur le geste qui reste ;
 *   • l'autorisation suit la règle (`statutApresRevision`) — une hausse ou un autre bénéficiaire
 *     rouvre une autorisation donnée, une baisse ne rouvre rien ;
 *   • elle est CONDITIONNELLE sur ce qu'elle a lu (statut, autorisation, montant, bénéficiaire). Si
 *     l'ordre a bougé entre la lecture et l'écriture — le centre vient d'autoriser, un règlement vient
 *     de passer —, elle RELIT et la règle rejuge sur l'état réel : une autorisation donnée pendant la
 *     révision est rouverte si la révision la dépasse, un règlement arrête tout. Ce n'est pas un
 *     « réessayer en espérant » : la décision est recalculée sur le fait nouveau, et bornée.
 *
 * L'échéance de l'ordre ne suit la demande que lorsque l'ordre ATTEND le centre (après la révision) :
 * une fois autorisé, sa date peut être celle que le centre a IMPOSÉE aux Finances (`decidePayment`),
 * et le souhait du demandeur ne la réécrit pas.
 *
 * Module serveur ordinaire (pas « use server ») : il reçoit l'auteur en argument, et une fonction qui
 * reçoit une identité n'a rien à faire parmi les points d'entrée publics (§118.153).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Client = Prisma.TransactionClient | typeof prisma;

export interface RevisionOrdre {
  montant?: number;
  beneficiaire?: string | null;
  libelle?: string;
  echeance?: Date | null;
  natureEcheance?: string | null;
}

export type ResultatRevision =
  | { ok: true; revise: false; reference: string | null }
  | {
      ok: true; revise: true; orderId: string; reference: string; rouvert: boolean;
      montantAvant: number; montantApres: number;
      beneficiaireAvant: string | null; beneficiaireApres: string | null;
    }
  | { ok: false; motif: "REGLE" | "REFUSE" | "INSTABLE"; error: string; reference: string | null };

/** Les statuts d'un ordre qui ne l'ont pas encore payé (les mêmes que l'annulation). */
const NON_REGLES = ["PENDING", "REVISION_REQUESTED"] as const;
/** Une relecture par fait nouveau ; au-delà, l'ordre change sans cesse et on le dit. */
const ESSAIS = 3;

const memeDate = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export async function reviserOrdreNonRegle(
  tx: Client,
  orderId: string,
  revision: RevisionOrdre,
  opts: { acteurId: string; raison: string },
): Promise<ResultatRevision> {
  let reference: string | null = null;
  for (let essai = 0; essai < ESSAIS; essai += 1) {
    const o = await tx.expenseOrder.findUnique({
      where: { id: orderId },
      select: {
        reference: true, status: true, amount: true, beneficiary: true, label: true,
        centralStatus: true, dueDate: true, deadlineNature: true,
      },
    });
    if (!o || o.status === "CANCELLED") return { ok: true, revise: false, reference: o?.reference ?? null };
    reference = o.reference;
    if (o.status === "PAID") {
      return { ok: false, motif: "REGLE", reference, error: `Le paiement ${o.reference} est déjà réglé : l'argent est parti, il ne se révise plus. Si le montant était faux, voyez les Finances.` };
    }
    if (o.centralStatus === "REFUSED") {
      return { ok: false, motif: "REFUSE", reference, error: `Le centre de paiement a refusé ${o.reference} : réviser le paiement ne lève pas un refus.` };
    }

    const montantAvant = Number(o.amount);
    const montantApres = revision.montant ?? montantAvant;
    const beneficiaireApres = revision.beneficiaire !== undefined ? revision.beneficiaire : o.beneficiary;
    const libelleApres = revision.libelle ?? o.label;
    const suivant = statutApresRevision({
      courant: o.centralStatus as CentralStatus, avant: montantAvant, apres: montantApres,
      beneficiaireAvant: o.beneficiary, beneficiaireApres,
    });
    const rouvert = suivant !== o.centralStatus;
    const echeanceSuit = suivant === "AWAITING";
    const echeanceApres = echeanceSuit && revision.echeance !== undefined ? revision.echeance : o.dueDate;
    const natureApres = echeanceSuit && revision.natureEcheance !== undefined ? revision.natureEcheance : o.deadlineNature;

    const inchange = montantApres === montantAvant && (beneficiaireApres ?? null) === (o.beneficiary ?? null)
      && libelleApres === o.label && memeDate(echeanceApres, o.dueDate) && (natureApres ?? null) === (o.deadlineNature ?? null);
    if (inchange) return { ok: true, revise: false, reference };

    const ecrit = await tx.expenseOrder.updateMany({
      where: {
        id: orderId, status: { in: [...NON_REGLES] },
        centralStatus: o.centralStatus, amount: o.amount, beneficiary: o.beneficiary,
      },
      data: {
        amount: montantApres, beneficiary: beneficiaireApres, label: libelleApres,
        dueDate: echeanceApres, deadlineNature: natureApres,
        ...(rouvert ? { centralStatus: suivant, centralDecidedById: null, centralDecidedAt: null } : {}),
      },
    });
    // L'ORDRE A BOUGÉ entre la lecture et l'écriture : on relit, et la règle rejuge sur le fait réel.
    if (ecrit.count === 0) continue;

    if (rouvert) {
      // La raison de la réouverture vit dans le FIL du centre — c'est là que le prochain arbitre la
      // lira, à côté de l'autorisation précédente, qui reste dans l'historique.
      const parties: string[] = [];
      if (montantApres > montantAvant || !Number.isFinite(montantAvant) || !Number.isFinite(montantApres)) {
        parties.push(`montant relevé de ${montantAvant.toLocaleString("fr-FR")} à ${montantApres.toLocaleString("fr-FR")} DZD`);
      }
      if (!memeBeneficiaire(o.beneficiary, beneficiaireApres)) {
        parties.push(`bénéficiaire changé : « ${o.beneficiary ?? "—"} » → « ${beneficiaireApres ?? "—"} »`);
      }
      const quoi = parties.join(", et ");
      await tx.paymentCentreMessage.create({
        data: {
          orderId,
          body: `${quoi.charAt(0).toUpperCase()}${quoi.slice(1)} après autorisation (${opts.raison}) — l'autorisation est à redonner.`,
          authorId: opts.acteurId,
        },
      });
    }
    return {
      ok: true, revise: true, orderId, reference, rouvert,
      montantAvant, montantApres, beneficiaireAvant: o.beneficiary, beneficiaireApres,
    };
  }
  return {
    ok: false, motif: "INSTABLE", reference,
    error: "L'ordre de dépense change sans cesse en ce moment (décision du centre, règlement) : rouvrez la fiche et reprenez.",
  };
}

/**
 * PRÉVENIR QUI DOIT AGIR APRÈS UNE RÉVISION — le centre quand l'autorisation est à redonner.
 *
 * Appelée APRÈS l'écriture (et après la validation de la transaction de l'appelant) : une
 * notification partie pour une révision annulée serait une alerte pour rien. L'audit de l'ordre
 * s'écrit ici aussi, pour qu'un ordre révisé le dise à son propre historique, quel que soit le geste
 * qui l'a révisé.
 */
export async function apresRevisionOrdre(
  r: Extract<ResultatRevision, { revise: true }>,
  opts: { acteurId: string; objet: string; raison: string },
): Promise<void> {
  await recordAudit({
    actorId: opts.acteurId, action: "UPDATE", module: "Finances",
    entityType: "EXPENSE_ORDER", entityId: r.orderId,
    summary: `Ordre de dépense ${r.reference} révisé (${opts.raison}) — ${r.montantAvant.toLocaleString("fr-FR")} → ${r.montantApres.toLocaleString("fr-FR")} DZD${r.rouvert ? " ; autorisation rouverte au centre" : ""}`,
  }).catch((e) => console.error("[revision-ordre] audit non écrit", e));
  if (!r.rouvert) return;
  const releve = r.montantApres > r.montantAvant;
  const autreBeneficiaire = !memeBeneficiaire(r.beneficiaireAvant, r.beneficiaireApres);
  const cause = releve && autreBeneficiaire ? "montant relevé et bénéficiaire changé"
    : releve ? "montant relevé" : "bénéficiaire changé";
  // Le centre ouvert sur l'entité et la section où l'ordre attend de nouveau.
  const o = await prisma.expenseOrder.findUnique({ where: { id: r.orderId }, select: { companyId: true, sourceType: true } }).catch(() => null);
  await notifyRoles([...ROLES_CENTRE_DE_PAIEMENT], {
    type: "VALIDATION_REQUIRED",
    title: `Paiement à ré-autoriser — ${cause}`,
    body: `${r.reference} — ${opts.objet} : ${r.montantAvant.toLocaleString("fr-FR")} → ${r.montantApres.toLocaleString("fr-FR")} DZD${autreBeneficiaire ? `, à « ${r.beneficiaireApres ?? "—"} »` : ""}`,
    link: o ? lienCentreDePaiement(o.companyId ?? ENTITE_SANS, slugSectionDeLOrdre(o.sourceType)) : lienCentreDePaiement(),
  });
}
