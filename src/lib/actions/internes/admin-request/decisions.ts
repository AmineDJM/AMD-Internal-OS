/**
 * DEMANDES ADMINISTRATIVES — les APPROBATIONS et les CORRECTIONS : l'approbation à trancher, les refus qui disent à
 * qui elle revient (ou pourquoi la décision n'a pas pu se prendre), l'ordre qu'un accord chiffré émet, les approbations
 * précédentes retirées, ce qui retient une correction et ce qu'elle change, les phrases d'une annulation, et l'état
 * d'une course de chauffeur.
 *
 * Sorti de `actions/admin-request-actions.ts` (lot V4). Les gardes (`peutTrancherApprobation`, `isTopManagement`),
 * l'émission de l'ordre et le journal restent dans les actions.
 */
import type { AdminRequestStatus, DriverMissionStatus, Priority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { changementsDeLaDemande, refusDeModification, type ContenuDemande } from "@/lib/secretariat/porte-demandeur";
import { fieldLabels } from "@/lib/admin-requests";
import { ADMIN_REQUEST_STATUS } from "@/lib/labels";
import type { ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";
import { DEMANDE_CHANGEE, VALIDATION_SANS_OBJET, enTexte, jour } from "./demande";

/** L'approbation à trancher, son validateur et sa demande. */
export async function approbationATrancher(approvalId: string) {
  return prisma.adminApproval.findUnique({
    where: { id: approvalId },
    include: {
      validator: { select: { name: true } },
      request: { select: { id: true, title: true, requesterId: true, assignedToId: true, reference: true, fields: true, status: true, deletedAt: true } },
    },
  });
}

/** Une approbation adressée à quelqu'un d'autre : seul le validateur, son intérimaire ou la Direction la tranche. */
export function refusAutreValidateur(nomDuValidateur: string | undefined): string {
  return `Cette validation est adressée à ${nomDuValidateur ?? "une autre personne"} : seul le validateur, son intérimaire ou la Direction la tranche.`;
}

/** On ne valide pas sa propre demande — dit au validateur nommé, ou à qui voulait trancher à sa place. */
export function refusSaPropreDemande(estLeValidateur: boolean, nomDuValidateur: string | undefined): string {
  return estLeValidateur
    ? "On ne valide pas sa propre demande : le secrétariat doit l'adresser à quelqu'un d'autre."
    : `On ne valide pas sa propre demande : c'est à ${nomDuValidateur ?? "la personne désignée"} de trancher.`;
}

/** Une décision qui n'a pas pu se prendre : retirée, tranchée par quelqu'un d'autre, ou sa demande annulée. */
export async function refusApresLaPrise(approvalId: string): Promise<string> {
  const apres = await prisma.adminApproval.findUnique({ where: { id: approvalId }, select: { status: true } });
  return !apres
    ? "Cette validation vient d'être retirée : la demande a été annulée, retirée par son auteur ou redemandée à quelqu'un d'autre — rechargez la page."
    : apres.status !== "PENDING"
      ? "Cette validation vient d'être tranchée par quelqu'un d'autre — rechargez la page."
      : VALIDATION_SANS_OBJET;
}

/** La demande annulée pendant la décision : l'accord reste, et ce qu'il est advenu du paiement émis se dit. */
export function refusOrdreAnnulePendantLaDecision(retrait: { ok: boolean; error?: string }): string {
  return retrait.ok
    ? "La demande vient d'être annulée pendant votre décision : votre accord est enregistré, mais le paiement qu'il émettait a été annulé — rechargez la page."
    : `La demande vient d'être annulée pendant votre décision, et le paiement qu'il émettait n'a pas pu être annulé : ${retrait.error}`;
}

/**
 * UNE DEMANDE VALIDÉE SANS RESPONSABLE REVIENT AU SECRÉTARIAT (audit 360°, I10) : le N+1 disait oui, et personne au
 * bureau ne l'apprenait — l'achat attendait qu'on tombe dessus.
 */
export async function renvoyerAuSecretariat(req: { id: string; reference: string; title: string }): Promise<void> {
  await notifyRoles(["DIRECTION_ASSISTANT"], { type: "ASSIGNMENT", title: "Demande validée — à traiter", body: `${req.reference} — ${req.title}`, link: `/demandes/${req.id}` }).catch(sansBloquer("admin-request-actions.decideApproval.notifyRoles"));
}

/**
 * UNE DEMANDE, UNE APPROBATION EN ATTENTE (lot E5) : les approbations précédentes encore en attente sont retirées (sous
 * condition), et leur validateur le sait.
 */
export async function retirerLesApprobationsPrecedentes(
  requestId: string, nouvelleId: string, validatorId: string, acteurId: string, reference: string,
): Promise<void> {
  const precedentes = await prisma.adminApproval.findMany({
    where: { requestId, status: "PENDING", id: { not: nouvelleId } },
    select: { id: true, validatorId: true },
  });
  if (precedentes.length > 0) {
    const nouveau = await prisma.user.findUnique({ where: { id: validatorId }, select: { name: true } });
    for (const p of precedentes) {
      const retiree = await prisma.adminApproval.deleteMany({ where: { id: p.id, status: "PENDING" } });
      if (retiree.count === 0 || !p.validatorId || p.validatorId === acteurId || p.validatorId === validatorId) continue;
      await notifyUser({
        userId: p.validatorId, type: "GENERIC", title: "Validation retirée",
        body: `${reference} — redemandée à ${nouveau?.name ?? "une autre personne"}`, link: "/demandes/approvals",
      }).catch(sansBloquer("admin-request-actions.requestApproval.notifyUser"));
    }
  }
}

/** Ce qui retient la correction d'une demande : une validation en cours, ou un paiement déjà émis. */
export async function refusModificationEnCours(id: string): Promise<string | null> {
  const [validations, approbations, ordres] = await Promise.all([
    prisma.validationRequest.count({ where: { entityType: "ADMIN_REQUEST", entityId: id, documentId: null, status: "PENDING" } }),
    prisma.adminApproval.count({ where: { requestId: id, status: "PENDING" } }),
    prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, status: { not: "CANCELLED" } } }),
  ]);
  return refusDeModification({ validationEnCours: validations + approbations > 0, paiementEmis: ordres > 0 });
}

/** Ce qu'une annulation emporte avec elle (rendu par `annulerDemandeSecretariat`). */
interface Annulation { reference: string; ordresAnnules: string[]; retraits: number; reserve?: string | null }

/** Annulée par le secrétariat : le demandeur est prévenu, les paiements annulés sont nommés. */
export function phraseAnnulationParLeSecretariat(a: Annulation): string {
  return `Demande ${a.reference} annulée — le demandeur est prévenu${a.ordresAnnules.length ? ` ; paiement(s) ${a.ordresAnnules.join(", ")} annulé(s)` : ""}.${a.reserve ? ` Attention : ${a.reserve}` : ""}`;
}

/** Annulée par son demandeur : l'assistante est prévenue, les validations retirées et paiements annulés sont comptés. */
export function phraseAnnulationParLeDemandeur(a: Annulation): string {
  const suites = [
    a.retraits > 0 ? `${a.retraits} validation${a.retraits > 1 ? "s" : ""} retirée${a.retraits > 1 ? "s" : ""}` : null,
    a.ordresAnnules.length > 0 ? `paiement${a.ordresAnnules.length > 1 ? "s" : ""} ${a.ordresAnnules.join(", ")} annulé${a.ordresAnnules.length > 1 ? "s" : ""}` : null,
  ].filter(Boolean);
  return `Demande ${a.reference} annulée — l'assistante est prévenue${suites.length ? ` ; ${suites.join(", ")}` : ""}.${a.reserve ? ` Attention : ${a.reserve}` : ""}`;
}

/** L'ordre de dépense qu'un accord CHIFFRÉ émet pour la demande (le bénéficiaire saisi, sinon son titre). */
export function ordreDeLApprobation(
  req: { id: string; reference: string; title: string; fields: unknown }, amt: number, requestedById: string,
) {
  const fields = (req.fields as Record<string, unknown> | null) ?? {};
  return {
    label: `Demande ${req.reference} — ${req.title}`,
    amount: amt, category: "AUTRE" as const,
    beneficiary: (fields.beneficiaire as string) ?? req.title,
    sourceType: "ADMIN_REQUEST" as const, sourceId: req.id, requestedById,
  };
}

/** Ce qu'une correction du demandeur change à sa demande, nommé par les libellés de son type. */
export function ceQuiAChange(
  req: { title: string; description: string | null; priority: Priority; deadline: Date | null; type: string },
  existants: Record<string, unknown>,
  apres: { title: string; description: string | null; priority: Priority; deadline: Date | null; fields: Record<string, unknown> },
): string[] {
  const avant: ContenuDemande = { title: req.title, description: req.description, priority: req.priority, deadline: jour(req.deadline), fields: enTexte(existants) };
  const ensuite: ContenuDemande = { title: apres.title, description: apres.description, priority: apres.priority, deadline: jour(apres.deadline), fields: enTexte(apres.fields) };
  return changementsDeLaDemande(avant, ensuite, fieldLabels(req.type));
}

/** L'état d'une course posé par le chauffeur : son départ et sa fin se datent au moment du geste. */
export function etatDeLaCourse(status: DriverMissionStatus, proofComment: string | null) {
  const data: { status: DriverMissionStatus; proofComment?: string | null; startedAt?: Date; completedAt?: Date } = { status, proofComment };
  if (status === "EN_ROUTE" || status === "ACCEPTED") data.startedAt = new Date();
  if (status === "DONE") data.completedAt = new Date();
  return data;
}

/**
 * L'APPROBATION NÉE APRÈS UNE ANNULATION, COMPENSÉE (§118.187) : la demande a été close entre la lecture et l'écriture,
 * l'approbation qu'on vient de créer est retirée (si elle attend encore), et le refus le dit.
 */
export async function retirerLApprobationNee(approbationId: string): Promise<ActionResult> {
  await prisma.adminApproval.deleteMany({ where: { id: approbationId, status: "PENDING" } });
  return { ok: false, error: DEMANDE_CHANGEE };
}

/** Ce que le demandeur lit d'un statut : son NOM — jamais l'énumération brute —, et le motif d'un blocage. */
export function phraseDuStatut(status: AdminRequestStatus, motif: string | null): { libelle: string; phrase: string } {
  const libelle = ADMIN_REQUEST_STATUS[status]?.label ?? status;
  const phrase = status === "BLOCKED" ? `Demande bloquée — ${motif}` : `Statut : ${libelle}`;
  return { libelle, phrase };
}
