import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDER UN ÉTAT DE STOCK — l'ÉCRIVAIN UNIQUE, appelé par le bouton et par le battement.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * L'effet vivait dans `requestStockState`, une server action : une tâche assignée, une
 * notification nominative, une ligne d'audit. La récurrence (#119) doit produire EXACTEMENT
 * cela — mais un déclenchement planifié n'a pas de session, donc il ne peut pas appeler une
 * action qui commence par `requireUser()`.
 *
 * Les deux issues étaient : recopier les trois écritures dans le battement, ou les sortir ici.
 * La recopie aurait fait DEUX vérités sur ce qu'est une demande d'état de stock, et c'est celle
 * de la récurrence qui aurait pris du retard au premier correctif (§118.5) — le symptôme serait
 * une demande automatique sans notification, donc un KAM qui ne sait pas qu'on lui a demandé
 * quelque chose, c'est-à-dire le faux succès exact que ce lot existe pour fermer.
 *
 * ── CE FICHIER NE PORTE AUCUNE PERMISSION, ET C'EST VOULU ────────────────────────────────
 *
 * `canRequestStockState` reste chez ses appelants : dans l'action pour la session, et dans le
 * battement pour l'autorité de l'AUTEUR de la récurrence, RELUE à chaque déclenchement. Y
 * glisser une garde en ferait une seconde vérité qui prendrait du retard sur `scopes.ts`, et
 * c'est la version en retard qui serait la faille (§118.74). Ce module écrit ; il ne décide pas
 * qui a le droit d'écrire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** D'où vient la demande — ce que le journal doit pouvoir distinguer. */
export type OrigineDemande =
  | { genre: "MANUELLE" }
  | { genre: "RECURRENCE"; recurrenceId: string; nom: string };

export interface DemandeEtatStock {
  /** Au nom de qui la demande part. Son autorité a été vérifiée PAR L'APPELANT. */
  actorId: string;
  assigneeId: string;
  hospitalIds: readonly string[];
  note?: string | null;
  origine: OrigineDemande;
}

export type ResultatDemande =
  | { ok: true; taskId: string; hopitaux: string[] }
  | { ok: false; error: string };

/**
 * CRÉE LA DEMANDE : une tâche assignée, une notification, une ligne d'audit.
 *
 * Les hôpitaux sont VALIDÉS EN BASE et jamais pris pour des libellés libres : une demande qui
 * citerait un nom d'hôpital inventé enverrait quelqu'un compter dans un établissement qui
 * n'existe pas. Un identifiant inconnu fait échouer la demande ENTIÈRE plutôt que de partir
 * avec la sélection amputée — un relevé partiel qu'on croit complet est pire qu'un refus.
 */
export async function creerDemandeEtatStock(input: DemandeEtatStock): Promise<ResultatDemande> {
  const ids = [...new Set(input.hospitalIds.map((v) => String(v).trim()).filter(Boolean))];
  const note = (input.note ?? "").trim();

  const assignee = await prisma.user.findFirst({
    where: { id: input.assigneeId, isActive: true },
    select: { id: true },
  });
  if (!assignee) return { ok: false, error: "Destinataire invalide." };

  let hospitals: { id: string; name: string }[] = [];
  if (ids.length > 0) {
    hospitals = await prisma.stockAnnex.findMany({
      where: { id: { in: ids }, kind: { not: "ANNEX" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (hospitals.length !== ids.length) return { ok: false, error: "Hôpital inconnu dans la sélection." };
  }
  const noms = hospitals.map((h) => h.name);
  const hospitalNames = noms.join(", ");

  const titre = hospitals.length > 0
    ? `État de stock demandé — ${hospitalNames}`.slice(0, 180)
    : "État de stock demandé" + (note ? ` — ${note.slice(0, 120)}` : "");

  const task = await prisma.task.create({
    data: {
      title: titre,
      description: [
        note ? note + "\n" : "",
        hospitals.length > 0
          ? `Hôpitaux concernés : ${hospitalNames}.\nMerci de relever l'état de stock de chacun et de le renseigner dans le module Stocks (onglet « Stock hôpitaux »).`
          : "Merci de relever l'état de stock actuel et de le renseigner dans le module Stocks.",
        // LA DEMANDE DIT D'OÙ ELLE VIENT. Sans cette ligne, un KAM qui reçoit la même tâche
        // chaque mois ne peut pas savoir si quelqu'un la lui adresse à chaque fois ou si c'est
        // une récurrence — et il ne sait donc pas à qui demander de l'arrêter.
        input.origine.genre === "RECURRENCE"
          ? `\n(Demande automatique — récurrence « ${input.origine.nom} ».)`
          : "",
      ].join("\n"),
      assignedToId: assignee.id,
      createdById: input.actorId,
      priority: "HIGH",
      module: "STOCKS",
    },
    select: { id: true },
  });

  await notifyUser({
    userId: assignee.id,
    type: "ASSIGNMENT",
    title: "État de stock demandé",
    body: (hospitals.length > 0
      ? `Hôpitaux : ${hospitalNames}${note ? ` — ${note}` : ""}`
      : note || "Relevez et renseignez l'état de stock actuel.").slice(0, 240),
    link: "/stocks",
  }).catch(sansBloquer("demande.creerDemandeEtatStock.notifyUser"));

  await recordAudit({
    actorId: input.actorId,
    action: "CREATE",
    module: "Stocks",
    entityType: "TASK",
    entityId: task.id,
    summary: `Demande d'état de stock${hospitals.length > 0 ? ` (${hospitals.length} hôpital·aux : ${hospitalNames.slice(0, 120)})` : ""}`
      + (note ? " — " + note.slice(0, 80) : "")
      + (input.origine.genre === "RECURRENCE" ? ` [récurrence « ${input.origine.nom} »]` : ""),
  });

  return { ok: true, taskId: task.id, hopitaux: noms };
}
