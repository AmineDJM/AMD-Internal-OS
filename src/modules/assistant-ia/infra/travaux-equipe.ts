import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { isManagerOfUser } from "@/lib/departments";
import { lireTravail, listerTravauxDe, type EtapeVue, type TravailVue } from "@/lib/missions/travaux/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TRAVAUX DE MON ÉQUIPE (J8, décision 0023) — un responsable voit les travaux de son équipe SI la console
 * l'autorise (`AssistantIaReglage.managerVoitEquipe`, défaut : NON).
 *
 *   • L'ÉQUIPE est la ligne hiérarchique réelle (`isManagerOfUser` : N+1, direct ou plus haut) — la même que les
 *     circuits de validation. Pas de liste à part, qui divergerait.
 *   • CE QU'IL VOIT : le résumé (état, attente, avancement, coût, priorité) et la liste des étapes — ni le carnet,
 *     ni le journal, ni les livrables : ce que la personne a lu reste à elle.
 *   • L'AUDIT ENREGISTRE QUI VOIT QUOI : chaque consultation (liste ou détail) est une ligne d'audit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TravailDEquipe = TravailVue & { personne: string };
export type ResultatEquipe<T> = { ok: true; valeur: T } | { ok: false; erreur: string };

const REFUS_CONSOLE = "La console de l'Assistant IA ne permet pas aux responsables de voir les travaux de leur équipe.";

export async function equipeVisible(): Promise<boolean> {
  const r = await prisma.assistantIaReglage.findUnique({ where: { id: "global" }, select: { managerVoitEquipe: true } });
  return r?.managerVoitEquipe === true;
}

/** Les personnes de l'équipe de `viewerId` qui ont des travaux — la ligne hiérarchique, relue maintenant. */
async function equipeAvecTravaux(viewerId: string): Promise<Map<string, string>> {
  const principaux = await prisma.mission.findMany({
    where: { kind: "TRAVAIL", principalId: { not: viewerId }, status: { not: "AWAITING_APPROVAL" } },
    select: { principalId: true }, distinct: ["principalId"], take: 500,
  });
  const ids = principaux.map((p) => p.principalId).filter((x): x is string => !!x);
  const membres: string[] = [];
  for (const id of ids) if (await isManagerOfUser(viewerId, id)) membres.push(id);
  const noms = await prisma.user.findMany({ where: { id: { in: membres } }, select: { id: true, name: true } });
  return new Map(noms.map((u) => [u.id, u.name]));
}

export async function listerTravauxEquipe(viewerId: string): Promise<ResultatEquipe<TravailDEquipe[]>> {
  if (!(await equipeVisible())) return { ok: false, erreur: REFUS_CONSOLE };
  const equipe = await equipeAvecTravaux(viewerId);
  const travaux = await listerTravauxDe([...equipe.keys()]);
  await recordAudit({
    actorId: viewerId, action: "EXPORT", module: "Assistant IA — travaux", field: "Travaux de l'équipe",
    summary: `Consultation des travaux de l'équipe : ${travaux.length} travail(aux) de ${equipe.size} personne(s)${equipe.size ? ` (${[...equipe.values()].join(", ")})` : ""}`.slice(0, 500),
  });
  return { ok: true, valeur: travaux.map(({ principalId, ...t }) => ({ ...t, personne: equipe.get(principalId) ?? "?" })) };
}

export async function lireTravailEquipe(viewerId: string, travailId: string): Promise<ResultatEquipe<TravailDEquipe & { liste: EtapeVue[] }>> {
  if (!(await equipeVisible())) return { ok: false, erreur: REFUS_CONSOLE };
  const m = await prisma.mission.findFirst({ where: { id: travailId, kind: "TRAVAIL" }, select: { principalId: true, title: true } });
  if (!m?.principalId || m.principalId === viewerId || !(await isManagerOfUser(viewerId, m.principalId))) {
    return { ok: false, erreur: "Travail introuvable — ou il n'est pas celui d'une personne de votre équipe." };
  }
  const t = await lireTravail(travailId, m.principalId);
  if (!t || t.etat === "A_APPROUVER") return { ok: false, erreur: "Travail introuvable." };
  const personne = (await prisma.user.findUnique({ where: { id: m.principalId }, select: { name: true } }))?.name ?? "?";
  await recordAudit({
    actorId: viewerId, action: "EXPORT", module: "Assistant IA — travaux", field: "Travail d'un membre de l'équipe",
    summary: `Consultation du travail « ${m.title} » de ${personne} (résumé et étapes, sans le carnet)`.slice(0, 500),
  });
  // LE RÉSUMÉ ET LES ÉTAPES — jamais le carnet, le journal, les livrables ni les demandes.
  const { carnet: _carnet, journal: _journal, demandes: _demandes, ...vue } = t;
  return { ok: true, valeur: { ...vue, personne } };
}
