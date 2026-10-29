/**
 * RECRUTEMENT — ce que disent les étapes et ce qu'une correction change à la chaîne : les phrases d'une réponse,
 * d'une correction, d'une réouverture, et l'issue d'une correction (changements matériels, chaîne qui repart).
 *
 * Sorti de `actions/recruitment-actions.ts` (lot V4) : pur. Les ÉCRITURES d'étape restent dans les actions — deux
 * cliquets les y lisent, conditionnelles et suivies de la resynchronisation de l'offre du site.
 */
import { changementsMateriels, type ChainStep, type RecruitmentStage } from "@/lib/recruitment/request-flow";

/** Ce que dit la réponse enregistrée : transmise aux RH, ou la demande a changé, ou d'autres questions attendent. */
export function phraseDeLaReponse(retours: number, pending: number): string {
  return retours > 0 ? "Réponse transmise aux RH."
    : pending === 0 ? "Réponse enregistrée — la demande a changé entre-temps : rouvrez-la pour voir où elle en est."
      : "Réponse enregistrée.";
}

/** Ce que dit une correction renvoyée : la chaîne qui repart, la marche qui l'attend, ou les RH. */
export function phraseDeLaCorrection(repart: boolean, materiels: string[], vers: RecruitmentStage): string {
  return repart
    ? `Demande corrigée — le besoin a changé (${materiels.join(", ")}) : la chaîne repart de sa première marche.`
    : vers === "CHAIN" ? "Demande corrigée — elle revient à la marche qui vous l'avait renvoyée." : "Demande corrigée — elle revient aux RH.";
}

/** Ce que dit une réouverture : la marche qui avait refusé, les RH, ou le poste de nouveau ouvert. */
export function phraseDeLaReouverture(vers: RecruitmentStage): string {
  return vers === "CHAIN" ? "Demande rouverte — elle repart à la marche qui l'avait refusée."
    : vers === "HR_REVIEW" ? "Demande rouverte — elle revient aux RH." : "Demande rouverte — le poste est de nouveau ouvert.";
}

/**
 * CE QU'UNE CORRECTION CHANGE À LA CHAÎNE — les changements matériels, si la chaîne repart, et où va la demande.
 */
export function issueDeLaCorrection(
  req: {
    position: string; headcount: number; contractType: string; salaryMin: unknown; salaryMax: unknown; endDate: Date | null;
    returnedFrom: string | null;
  },
  draft: Parameters<typeof changementsMateriels>[1],
  steps: ChainStep[],
): { materiels: string[]; repart: boolean; vers: RecruitmentStage } {
  const nombre = (v: unknown) => (v == null ? null : Number(v));
  const materiels = changementsMateriels(
    { position: req.position, headcount: req.headcount, contractType: req.contractType, salaryMin: nombre(req.salaryMin), salaryMax: nombre(req.salaryMax), endDate: req.endDate },
    draft,
  );
  // La chaîne ne REPART que si quelqu'un y avait déjà dit oui : renvoyée de la première marche, une
  // correction matérielle y revient de toute façon.
  const repart = materiels.length > 0 && steps.some((s) => s.status !== "PENDING");
  const vers: RecruitmentStage = repart ? "CHAIN" : (req.returnedFrom as RecruitmentStage | null) ?? "CHAIN";
  return { materiels, repart, vers };
}
