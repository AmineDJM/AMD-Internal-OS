/**
 * RECRUTEMENT — ce que les décisions disent et annoncent : les désignés du sommet (le N+1 de la recrue, le suivi),
 * l'annonce de la désignation, la fiche employé pré-remplie (et la fiche de son futur N+1), la
 * question à laquelle on répond, et les refus qui disent pourquoi
 * (retrait, renvoi, annulation d'embauche).
 *
 * Sorti de `actions/recruitment-actions.ts` (lot V4). Aucune écriture en base directe : les annonces passent par le
 * fil et les notifications ; les gardes et les écritures d'étape restent dans les actions.
 */
import type { ContractType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { ecrireAuFil } from "@/modules/ad-pro/api";
import {
  canDecideStep, ETAPES_RETIRABLES, nettoyerIds, refusDesignationDuSommet, type ChainStep, type RecruitmentStage,
} from "@/lib/recruitment/request-flow";
import { sansBloquer } from "@/lib/journal";

/**
 * LES DÉSIGNÉS DU SOMMET, lus actifs : le refus qui dit ce qui manque, ou leurs noms (pour la phrase du suivi).
 */
export async function designesDuSommet(
  futureManagerId: string | null, followerIds: string[],
): Promise<{ ok: true; noms: Map<string, string> } | { ok: false; error: string }> {
  const actifs = await prisma.user.findMany({
    where: { id: { in: nettoyerIds([futureManagerId, ...followerIds]) }, isActive: true },
    select: { id: true, name: true },
  });
  const refus = refusDesignationDuSommet({ futureManagerId, followerIds }, new Set(actifs.map((a) => a.id)));
  if (refus) return { ok: false, error: refus };
  return { ok: true, noms: new Map(actifs.map((a) => [a.id, a.name])) };
}

/** LA DÉSIGNATION ANNONCÉE : au fil de la demande, au futur N+1, et à chaque personne du suivi (jamais à soi). */
export async function annoncerLaDesignation(
  id: string, req: { reference: string; position: string }, user: { id: string; name: string },
  futureManagerId: string, followerIds: string[], phraseSuivi: string | null,
): Promise<void> {
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Validée par ${user.name} — ${phraseSuivi}` }).catch(sansBloquer("recruitment-actions.decideRecruitmentStep.ecrireAuFil"));
  if (futureManagerId !== user.id) {
    await notifyUser({
      userId: futureManagerId, type: "GENERIC",
      title: "Vous serez le N+1 d'une future recrue",
      body: `${req.reference} — ${req.position} : la direction générale vous a désigné N+1 du poste.`,
      link: `/recrutement/${id}`,
    }).catch(sansBloquer("recruitment-actions.decideRecruitmentStep.notifyUser"));
  }
  for (const f of followerIds) {
    if (f === user.id || f === futureManagerId) continue;
    await notifyUser({
      userId: f, type: "GENERIC",
      title: "Recrutement à suivre",
      body: `${req.reference} — ${req.position} : la direction générale vous a confié le suivi de ce recrutement.`,
      link: `/recrutement/${id}`,
    }).catch(sansBloquer("recruitment-actions.decideRecruitmentStep.notifyUser"));
  }
}

/** Une demande qu'on ne peut pas retirer : par qui elle se retire, ou pourquoi elle ne se retire plus. */
export function refusRetrait(stage: RecruitmentStage): string {
  return ETAPES_RETIRABLES.has(stage)
    ? "Seul le demandeur (ou la direction) retire cette demande."
    : "Cette demande n'est plus en cours : un recrutement a été prononcé, ou elle est déjà close — elle ne se retire plus.";
}

/**
 * LA FICHE EMPLOYÉ PRÉ-REMPLIE depuis la demande (département, entité, contrat, dates, rémunération) et depuis le
 * candidat (nom, courriel, téléphone) — ressaisir ce qui est déjà écrit introduirait des écarts.
 */
export function ficheDeLaRecrue(
  req: {
    position: string; companyId: string | null; departmentId: string | null; department: { name: string } | null;
    contractType: ContractType; startDate: Date | null; endDate: Date | null; salaryMin: Prisma.Decimal | null; reference: string;
  },
  hired: { fullName: string; email: string | null; phone: string | null },
  managerFiche: { id: string } | null,
) {
  return {
    fullName: hired.fullName,
    position: req.position,
    companyId: req.companyId,
    departmentId: req.departmentId,
    department: req.department?.name ?? null,
    email: hired.email, phone: hired.phone,
    contractType: req.contractType,
    contractStart: req.startDate, contractEnd: req.endDate,
    hireDate: req.startDate,
    // La borne BASSE de la fourchette, pas la haute : c'est l'hypothèse prudente, et le
    // salaire réel se fixe au contrat — que les RH saisiront sur la fiche.
    baseSalary: req.salaryMin ?? 0,
    managerId: managerFiche?.id ?? null,
    isActive: true,
    notes: `Recruté via la demande ${req.reference}.`,
  };
}

/** Un renvoi refusé : la raison de la marche (chaîne), les RH (instruction), ou l'étape où l'on ne renvoie pas. */
export function refusRenvoi(stage: RecruitmentStage, steps: ChainStep[], decideur: { userId: string; isTop: boolean }): string {
  return stage === "CHAIN" ? canDecideStep(stage, steps, decideur).reason ?? "Ce n'est pas à vous de trancher cette marche."
    : stage === "HR_REVIEW" ? "Seuls les RH renvoient une demande qu'ils instruisent."
      : "Une demande ne se renvoie que pendant sa validation : dans la chaîne, ou chez les RH.";
}

/** Une embauche qu'on ne peut pas annuler d'ici : la fiche existe, rien n'attend, ou ce n'est pas à vous. */
export function refusAnnulationEmbauche(recrute: { employeeId: string | null } | undefined, stage: string): string {
  return recrute && recrute.employeeId !== null
    ? "La fiche employé existe déjà : l'embauche ne s'annule plus d'ici — c'est un départ, à traiter aux RH."
    : stage !== "ONBOARDING" ? "Aucune embauche en attente d'intégration sur cette demande."
      : "Seuls les RH ou la direction annulent une embauche.";
}

/** Ce que la décision du sommet dit du suivi : le N+1 de la future recrue et les personnes du suivi, nommés. */
export function phraseDuSuivi(noms: Map<string, string>, futureManagerId: string | null, followerIds: string[]): string {
  return `N+1 de la future recrue : ${noms.get(futureManagerId ?? "") ?? "—"} · Suivi : ${followerIds.map((f) => noms.get(f) ?? "—").join(", ")}`;
}

/** La question de CETTE demande à laquelle on répond — `null` si elle n'est pas la sienne. */
export async function questionDeLaDemande(requestId: string, infoId: string) {
  return prisma.recruitmentInfoRequest.findFirst({
    where: { id: infoId, requestId }, select: { id: true, askedById: true, question: true, answeredAt: true },
  });
}

/** La fiche employé du N+1 désigné par le sommet — `null` sans N+1, ou s'il n'a pas de fiche. */
export async function ficheDuFuturManager(futureManagerId: string | null): Promise<{ id: string } | null> {
  return futureManagerId
    ? await prisma.employee.findUnique({ where: { userId: futureManagerId }, select: { id: true } })
    : null;
}
