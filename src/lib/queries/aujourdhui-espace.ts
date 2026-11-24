import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { getActionCenter } from "@/lib/queries/action-center";
import { isOutstanding } from "@/lib/doc-request";
import { getMyTeam } from "@/lib/queries/my-team";
import { getMyTeamOverview } from "@/lib/queries/my-team-overview";
import { peutRelancer } from "@/lib/tasks/request-flow";
import { composerEquipe, regrouperFile, totaux, type ElementFile, type Lot, type MembreEncart, type MembreLu } from "@/lib/espace/aujourdhui";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « AUJOURD'HUI » — CE QUE LA PAGE LIT (Direction, 14/10/2026 ; règles PURES : `espace/aujourdhui.ts`).
 *
 * Aucune file neuve : la source est le centre d'actions (`getActionCenter`, déjà filtré par les droits
 * de la personne, une ligne par objet) et les pièces qu'on lui demande — exactement ce que l'ancien
 * « Mon espace » listait à plat. Ce module y ajoute l'encart « Mon équipe » pour un N+1 (`getMyTeam` →
 * `getMyTeamOverview`), avec, par personne, la tâche que JE lui ai demandée et que la règle de relance
 * (`peutRelancer`) laisse relancer.
 *
 * ÉCRAN SIMPLIFIÉ (maquette validée, 24/11/2026) : la ligne « semaine », la phrase d'accroche, les tuiles
 * de chiffres du métier et les raccourcis ont quitté l'écran — les lectures qui ne nourrissaient qu'eux
 * (gestes datés de la semaine, compteurs du métier, paiements réglés de la semaine, réglages des
 * modules) sont retirées avec eux. La file, les congés et l'équipe se lisent comme avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Aujourdhui {
  lots: Lot[];
  ouverts: number;
  enRetard: number;
  equipe: { membres: MembreEncart[]; personnesEnRetard: number; retards: number; directs: number } | null;
  /** Les pièces que J'attends des autres — une ligne de suivi, pas une action. */
  piecesEnAttente: number;
  /** Les congés à signer, tels que le centre les a lus (la page les ouvre dans leur panneau). */
  conges: Awaited<ReturnType<typeof getActionCenter>>["conges"];
}

export async function chargerAujourdhui(user: SessionUser, opts: { maintenant?: Date } = {}): Promise<Aujourdhui> {
  const now = opts.maintenant ?? new Date();

  const [centre, pieces, team] = await Promise.all([
    getActionCenter(user),
    prisma.documentRequest.findMany({
      where: { OR: [{ askedToId: user.id }, { askedById: user.id }] },
      orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, label: true, reference: true, status: true, dueDate: true, createdAt: true, askedToId: true, askedById: true, askedBy: { select: { name: true } } },
    }),
    getMyTeam(user, { maintenant: now }).catch(sansBloquer("aujourdhui-espace.chargerAujourdhui.getMyTeam", null)),
  ]);

  // LA FILE : le centre d'actions, plus les pièces qu'on ME demande (l'ancienne section « Pièces demandées »).
  const piecesADeposer: ElementFile[] = pieces
    .filter((r) => r.askedToId === user.id && isOutstanding(r.status))
    .map((r) => ({
      key: `piece-${r.id}`, objet: `DOCUMENT_REQUEST:${r.id}`, title: r.label,
      subtitle: `${r.reference} · demandée par ${r.askedBy.name}`, module: "Pièces", href: `/pieces/${r.id}`,
      kind: "request", deadline: r.dueDate?.toISOString() ?? null, depuis: r.createdAt.toISOString(), owner: "",
      statusLabel: "À déposer",
    }));
  const piecesEnAttente = pieces.filter((r) => r.askedById === user.id && isOutstanding(r.status)).length;
  const lots = regrouperFile([...centre.items, ...piecesADeposer], now);
  const { ouverts, enRetard } = totaux(lots);

  // L'ÉQUIPE — pour un N+1 seulement (des directs dans l'organigramme).
  let equipe: Aujourdhui["equipe"] = null;
  if (team && team.directCount > 0) {
    const apercu = await getMyTeamOverview(user, team, { maintenant: now }).catch(sansBloquer("aujourdhui-espace.chargerAujourdhui.getMyTeamOverview", null));
    if (apercu) {
      const directs = apercu.lignes.filter((l) => l.direct);
      const userIds = directs.map((l) => l.userId).filter((x): x is string => Boolean(x));
      const demandees = userIds.length
        ? await prisma.task.findMany({
            where: { createdById: user.id, assignedToId: { in: userIds }, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] }, dueDate: { lt: now } },
            select: { id: true, status: true, requestedAt: true, assignedToId: true, createdById: true, lastNudgeAt: true, nudgeCount: true },
            orderBy: { dueDate: "asc" }, take: 200,
          })
        : [];
      const employeDuCompte = new Map(directs.filter((l) => l.userId).map((l) => [l.userId as string, l.employeeId]));
      const relances = new Map<string, string>();
      for (const t of demandees) {
        const emp = t.assignedToId ? employeDuCompte.get(t.assignedToId) : undefined;
        if (!emp || relances.has(emp)) continue;
        if (peutRelancer(t, user.id, now.getTime()).ok) relances.set(emp, t.id);
      }
      const membres: MembreLu[] = directs.map((l) => ({
        employeeId: l.employeeId, nom: l.nom, poste: l.poste, direct: l.direct,
        aujourdhui: l.aujourdhui.genre, ouvertes: l.taches.ouvertes, enRetard: l.taches.enRetard, aDecider: l.aDecider,
        alerte: [...l.alertes].sort((a, b) => a.rang - b.rang)[0]?.court ?? null,
        sansRapport: l.terrainMois?.sansRapport ?? null,
      }));
      equipe = composerEquipe(membres, relances);
    }
  }

  return { lots, ouverts, enRetard, equipe, piecesEnAttente, conges: centre.conges };
}
