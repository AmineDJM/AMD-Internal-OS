import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView } from "@/lib/rbac";
import { canRequestStockState } from "@/lib/stocks/scopes";
import { creerDemandeEtatStock } from "@/lib/stocks/demande";
import { echeanceApresDeclenchement, estRecurrenceStock, type StatutRecurrence } from "@/lib/stocks/recurrence";
import type { Recurrence } from "@/lib/scheduler/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉCLENCHEMENT DES RÉCURRENCES DE DEMANDE D'ÉTAT DE STOCK — appelé par le BATTEMENT.
 *
 * ── POURQUOI PAS DANS LE REGISTRE DES PLANIFICATIONS ─────────────────────────────────────
 *
 * `scheduler/registry.ts` porte les traitements qu'une PERSONNE choisit dans une liste, et son
 * en-tête l'écrit sans détour : « un traitement qui enverrait un e-mail ou modifierait l'ERP n'a
 * pas sa place ici », avec `mutates: false` figé par un test. La règle est juste : la clé y est
 * choisie par un humain — ou proposée par un modèle — donc y admettre une écriture ouvrirait une
 * porte d'effet arbitraire.
 *
 * Une demande d'état de stock n'est pas dans ce cas. Ce que le directeur des opérations choisit,
 * c'est QUI, QUELS hôpitaux et À QUELLE CADENCE ; ce que le déclenchement FAIT est écrit ici, en
 * revue de code, et ne varie pas. C'est donc l'autre étage du même ordonnanceur — celui de
 * `runScheduledJobs`, dont le README dit « ajouter un job = une fonction appelée dans
 * runScheduledJobs », et où vivent déjà les rappels de réunion et les avis de paie, qui
 * notifient et écrivent. Aucun second ordonnanceur (§118.5, §39).
 *
 * ── L'AUTORITÉ EST RELUE À CHAQUE DÉCLENCHEMENT ──────────────────────────────────────────
 *
 * La récurrence part au nom de son AUTEUR. Si cette personne n'a plus le droit de réquisitionner
 * — mutation, départ, droits retirés — la récurrence s'ARRÊTE au lieu de continuer à envoyer.
 * Sans cette relecture, une planification serait une permission qui survit à son titulaire :
 * exactement la porte dérobée que le contrôle d'accès existe pour fermer (§118.7).
 *
 * Elle est mise en PAUSE, jamais supprimée : le directeur doit pouvoir voir POURQUOI elle s'est
 * arrêtée et la reprendre après avoir désigné quelqu'un d'autre. Une suppression silencieuse
 * ferait disparaître la demande et la raison en même temps.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Combien de récurrences un passage traite au plus — le battement ne doit jamais s'éterniser. */
const PAR_PASSAGE = 20;

export interface BilanRecurrences {
  declenchees: number;
  /** Mises en pause parce que leur auteur n'a plus l'autorité de réquisitionner. */
  suspendues: number;
  /** Échouées pour une autre raison (destinataire inactif, hôpital supprimé). */
  echouees: number;
}

/**
 * DÉCLENCHE LES RÉCURRENCES DUES. Ne lève jamais : le battement enchaîne d'autres travaux, et
 * une récurrence en défaut ne doit pas empêcher les rappels de réunion de partir.
 */
export async function declencherRecurrencesStock(maintenant: Date = new Date()): Promise<BilanRecurrences> {
  const bilan: BilanRecurrences = { declenchees: 0, suspendues: 0, echouees: 0 };

  const dues = await prisma.stockRequestRecurrence.findMany({
    where: { status: "ACTIVE" satisfies StatutRecurrence, nextRunAt: { lte: maintenant } },
    select: {
      id: true, name: true, assigneeId: true, note: true, createdById: true,
      recurrence: true, hourLocal: true, dayOfWeek: true, dayOfMonth: true,
      hospitals: { select: { annexId: true } },
    },
    orderBy: { nextRunAt: "asc" },
    take: PAR_PASSAGE,
  });
  if (dues.length === 0) return bilan;

  for (const r of dues) {
    // LE VERROU : seul le premier passage qui repousse l'échéance gagne le droit d'envoyer. Sans
    // lui, deux processus concurrents adresseraient DEUX fois la même demande au même KAM.
    const suivante = estRecurrenceStock(r.recurrence)
      ? echeanceApresDeclenchement(
        { recurrence: r.recurrence as Recurrence, hourLocal: r.hourLocal, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth },
        maintenant,
      )
      : null;
    if (!suivante) {
      // Une maille illisible en base ne doit pas faire tourner la récurrence à chaque battement :
      // on la met en pause en le DISANT plutôt que de réessayer indéfiniment (§118.70).
      await prisma.stockRequestRecurrence.updateMany({
        where: { id: r.id, status: "ACTIVE" },
        data: { status: "PAUSED", claimedAt: maintenant },
      });
      bilan.echouees += 1;
      continue;
    }
    const prise = await prisma.stockRequestRecurrence.updateMany({
      where: { id: r.id, status: "ACTIVE", nextRunAt: { lte: maintenant } },
      data: { nextRunAt: suivante, claimedAt: maintenant },
    });
    if (prise.count === 0) continue;

    // L'AUTORITÉ DE L'AUTEUR, RELUE MAINTENANT. Sans auteur (compte supprimé), il n'y a plus
    // d'autorité du tout : la récurrence s'arrête, elle ne part pas « au nom de personne ».
    const auteur = r.createdById
      ? await prisma.user.findFirst({ where: { id: r.createdById, isActive: true }, select: { id: true, role: true } })
      : null;
    const autorise = auteur
      ? canRequestStockState({
        canSeeSupplyChain: userCan({ role: auteur.role, access: await getAccess(auteur.id, auteur.role) } as never, "PCH", "VIEW"),
        hasGlobalView: hasGlobalView(auteur.role as never),
        isSuperAdmin: auteur.role === "SUPER_ADMIN",
        roles: [auteur.role],
      })
      : false;
    if (!autorise) {
      await prisma.stockRequestRecurrence.update({
        where: { id: r.id },
        data: { status: "PAUSED" satisfies StatutRecurrence },
      });
      bilan.suspendues += 1;
      continue;
    }

    const res = await creerDemandeEtatStock({
      actorId: auteur!.id,
      assigneeId: r.assigneeId,
      hospitalIds: r.hospitals.map((h) => h.annexId),
      note: r.note,
      origine: { genre: "RECURRENCE", recurrenceId: r.id, nom: r.name },
    });
    if (!res.ok) {
      // LE COMPTEUR N'AVANCE PAS SUR UN ÉCHEC, et `lastRunAt` non plus : « 12 demandes
      // envoyées » doit compter des demandes RÉELLEMENT parties, sinon l'écran affiche un
      // pilotage qui n'a pas eu lieu (§118.51).
      bilan.echouees += 1;
      continue;
    }
    await prisma.stockRequestRecurrence.update({
      where: { id: r.id },
      data: { lastRunAt: maintenant, runCount: { increment: 1 }, claimedAt: null },
    });
    bilan.declenchees += 1;
  }
  return bilan;
}
