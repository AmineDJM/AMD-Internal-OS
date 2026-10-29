/**
 * RECRUTEMENT — le CIRCUIT lu par les actions : la chaîne de validation figée à la soumission et ses marches, les
 * personnes à prévenir (le suivi, la marche suivante ou les RH, les approbateurs d'une demande retirée, qui reprend
 * une demande rouverte), et le refus « un autre geste est passé avant le vôtre » (`EtatChange`).
 *
 * Sorti de `actions/recruitment-actions.ts` (lot V4). Aucune écriture en base : la chaîne se LIT, le suivi se
 * NOTIFIE (l'écrivain commun des notifications).
 */
import { prisma } from "@/lib/prisma";
import { isTopManagement, rolesWithModule } from "@/lib/rbac";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { getManagementChain } from "@/lib/departments";
import {
  completerJusquAuSommet, currentStep, ORDRE_DU_SOMMET, suiveursAPrevenir, type ChainStep, type RecruitmentStage,
} from "@/lib/recruitment/request-flow";
import { sansBloquer } from "@/lib/journal";

/**
 * PRÉVENIR LE SUIVI — le futur N+1 et les personnes en charge du suivi (désignés par le DG, Direction 07/10)
 * reçoivent les notifications d'étape là où le demandeur les reçoit. Jamais l'auteur du geste ni ceux de `sauf`
 * (le demandeur, déjà prévenu). Un échec de notification ne défait pas le geste.
 */
export async function prevenirLeSuivi(
  id: string,
  n: { title: string; body: string },
  sauf: (string | null | undefined)[],
): Promise<void> {
  const r = await prisma.recruitmentRequest.findUnique({
    where: { id }, select: { futureManagerId: true, followers: { select: { userId: true } } },
  });
  if (!r) return;
  for (const userId of suiveursAPrevenir(r.futureManagerId, r.followers.map((f) => f.userId), sauf)) {
    await notifyUser({ userId, type: "GENERIC", title: n.title, body: n.body, link: `/recrutement/${id}` }).catch(sansBloquer("recruitment-actions.prevenirLeSuivi.notifyUser"));
  }
}

/**
 * UN GESTE À LA FOIS (audit 360°, R14 — §118.192). Chaque écriture d'étape est conditionnelle sur l'étape
 * LUE : deux gestes croisés sur la même demande — le N+1 et la direction sur la même marche, un retrait
 * pendant une validation, deux RH qui tranchent ensemble — ne s'écrasent plus l'un l'autre. Le perdant
 * le dit et n'écrit rien ; dans une transaction, il défait ce qu'il avait commencé.
 */
export class EtatChange extends Error {}
export const DEJA_CHANGE = "Cette demande vient de changer — un autre geste est passé avant le vôtre : rouvrez-la pour voir où elle en est.";
export const MOTIF_REFUS = "Un refus se motive — c'est ce que le demandeur lira.";

/**
 * Construit la chaîne de validation : le N+1, puis les N+1 successifs jusqu'au sommet.
 *
 * Elle est FIGÉE ici, à la soumission. Une réorganisation en cours de route changerait sinon les
 * validateurs d'une demande déjà partie, et l'on ne saurait plus qui devait trancher quand elle a
 * été déposée.
 *
 * Le demandeur est écarté de sa propre chaîne : un directeur qui est aussi son propre N+1 dans
 * l'organigramme ne se valide pas lui-même.
 *
 * ELLE MONTE JUSQU'AU DG (Direction, 07/10) : si l'organigramme s'arrête avant le sommet (`isTopManagement`), le
 * premier sommet actif — DG, puis Direction, puis Super Admin — est ajouté en dernière marche
 * (`completerJusquAuSommet`). Un demandeur sans fiche employé part donc directement au sommet.
 */
export async function buildChain(requesterUserId: string): Promise<{ approverId: string; name: string }[]> {
  const emp = await prisma.employee.findUnique({ where: { userId: requesterUserId }, select: { id: true } });
  const chain = emp ? await getManagementChain(emp.id) : [];
  const ids: string[] = [];
  const noms = new Map<string, string>();
  const seen = new Set<string>([requesterUserId]);
  for (const m of chain) {
    if (!m.userId || seen.has(m.userId)) continue;
    seen.add(m.userId);
    ids.push(m.userId);
    noms.set(m.userId, m.fullName);
  }
  const [comptes, sommets] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, secondaryRole: true } }),
    prisma.user.findMany({
      where: { isActive: true, OR: [{ role: { in: [...ORDRE_DU_SOMMET] } }, { secondaryRole: { in: [...ORDRE_DU_SOMMET] } }] },
      select: { id: true, name: true, role: true, secondaryRole: true },
    }),
  ]);
  const top = new Map(comptes.map((c) => [c.id, isTopManagement(c)]));
  const rang = (u: { role: string; secondaryRole: string | null }) => Math.min(
    ...[u.role, u.secondaryRole].map((r) => { const i = (ORDRE_DU_SOMMET as readonly string[]).indexOf(r ?? ""); return i < 0 ? 99 : i; }),
  );
  const sommetsTries = [...sommets].sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name));
  return completerJusquAuSommet(
    ids.map((id) => ({ approverId: id, name: noms.get(id) ?? "", isTop: top.get(id) ?? false })),
    sommetsTries.map((s) => ({ id: s.id, name: s.name })),
    requesterUserId,
  );
}

/** Aucun validateur trouvé : la demande ne pourrait être validée par personne, et le refus dit à qui s'adresser. */
export const AUCUN_VALIDATEUR = "Aucun validateur n'a pu être trouvé — ni responsable hiérarchique au-dessus de vous, ni direction "
  + "générale active : la demande ne pourrait être validée par personne. Faites compléter l'organigramme par les RH.";

/** Les marches de la chaîne telles que les règles les lisent (`request-flow.ts`). */
export function etapesDeLaChaine(
  approvals: { order: number; approverId: string; status: ChainStep["status"]; approver: { name: string } | null }[],
): ChainStep[] {
  return approvals.map((a) => ({ order: a.order, approverId: a.approverId, approverName: a.approver?.name ?? "", status: a.status }));
}

/**
 * On prévient CELUI QUI ATTEND après un accord : les RH quand la chaîne est franchie, sinon la marche suivante. Une
 * notification à tout le monde n'aiderait personne.
 */
export async function prevenirLaSuite(
  id: string, req: { reference: string; position: string }, complete: boolean, nextSteps: ChainStep[],
): Promise<void> {
  if (complete) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), {
      type: "GENERIC",
      title: "Nouvelle demande de recrutement à instruire",
      body: `${req.reference} — ${req.position}`,
      link: `/recrutement/${id}`,
    });
  } else {
    const next = currentStep(nextSteps);
    if (next) {
      await notifyUser({
        userId: next.approverId, type: "GENERIC",
        title: "Demande de recrutement à valider",
        body: `${req.reference} — ${req.position}`,
        link: `/recrutement/${id}`,
      });
    }
  }
}

/** Une demande retirée : chaque approbateur qui l'avait en main est prévenu. */
export async function prevenirLesApprobateurs(id: string, approbateurs: string[], corps: string): Promise<void> {
  for (const approverId of approbateurs) {
    await notifyUser({ userId: approverId, type: "GENERIC", title: "Demande de recrutement retirée", body: corps, link: `/recrutement/${id}` }).catch(sansBloquer("recruitment-actions.cancelRecruitmentRequest.notifyUser"));
  }
}

/** Une demande rouverte : la marche qui l'avait refusée la tranche de nouveau, ou les RH l'instruisent. */
export async function prevenirQuiLaReprend(
  ou: { vers: RecruitmentStage; marche: number | null }, steps: ChainStep[], corps: string, lien: string,
): Promise<void> {
  if (ou.vers === "CHAIN" && ou.marche !== null) {
    const marche = steps.find((s) => s.order === ou.marche);
    if (marche) await notifyUser({ userId: marche.approverId, type: "GENERIC", title: "Demande de recrutement rouverte — à trancher de nouveau", body: corps, link: lien });
  } else if (ou.vers === "HR_REVIEW") {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Demande de recrutement rouverte — à instruire", body: corps, link: lien });
  }
}
