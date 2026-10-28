import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { notifyUser } from "@/lib/notify";
import { createDossierRecord } from "@/lib/dossiers-core";
import { chargerFiche, colonneFiche, type FicheReservation } from "@/lib/reservation-fiche/fiches";
import {
  diffEmpreintes, estChezElle, etatRepris, lireEmpreinte, phraseChangements, NATURE_LIBELLE,
  type EtatDemande, type SourceFiche,
} from "@/lib/reservation-fiche/etat";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE CHEZ L'ASSISTANTE — ce que les gestes partagent, côté serveur.
 *
 * Le SUJET (DOS) du poste — ou de la prise en charge — reste le fil de discussion : il naît au premier
 * envoi d'une fiche, et chaque geste y écrit sa ligne. Les NOTIFICATIONS, elles, sont ciblées : la fiche
 * relancée prévient celle qui l'a prise (sinon toutes les assistantes actives), la fiche prise ou réservée
 * prévient le demandeur — jamais tout le sujet à chaque clic.
 *
 * Aucune fonction ici ne lit la session : l'acteur est passé par l'action, qui l'a vérifié. Rien de ce
 * module n'est exporté par un fichier « use server » (un acteur en paramètre serait une porte ouverte).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le lien qui ouvre la fiche chez l'assistante — l'onglet « Ad & Pro » du Bureau du secrétariat. */
export const lienBureau = (demandeId?: string) => `/demandes?onglet=adpro${demandeId ? `&fiche=${demandeId}` : ""}`;

/** Les assistantes de direction ACTIVES — rôle principal OU secondaire. */
export async function assistantesActives(): Promise<{ id: string; name: string }[]> {
  return prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) },
    select: { id: true, name: true }, orderBy: { createdAt: "asc" },
  });
}

/** À qui s'adresse un geste du demandeur : celle qui a pris la fiche, sinon toutes les assistantes actives. */
export async function destinatairesAssistante(d: { priseParId: string | null }): Promise<string[]> {
  if (d.priseParId) {
    const u = await prisma.user.findUnique({ where: { id: d.priseParId }, select: { isActive: true } });
    if (u?.isActive) return [d.priseParId];
  }
  return (await assistantesActives()).map((a) => a.id);
}

export async function prevenir(userIds: readonly string[], n: { title: string; body: string; link: string }, sauf?: string): Promise<void> {
  for (const userId of new Set(userIds)) {
    if (userId === sauf) continue;
    await notifyUser({ userId, type: "GENERIC", title: n.title, body: n.body, link: n.link }).catch(sansBloquer("reservation-fiche-serveur.prevenir.notifyUser"));
  }
}

/** « Billet · Salem Smail · Alger → Constantine · aller-retour · avion · 22/10/2026 → 25/10/2026 ». */
export const ligneFiche = (f: Pick<FicheReservation, "nature" | "nom" | "resume" | "dates">) =>
  `${NATURE_LIBELLE[f.nature]} · ${f.nom} · ${f.resume} · ${f.dates}`;

/**
 * ÉCRIRE UNE LIGNE AU FIL (le sujet) sans prévenir tout le sujet — l'appelant prévient qui doit l'être. Rend
 * `false` si le sujet n'existe plus.
 */
export async function noterAuFil(dossierId: string | null, auteurId: string, body: string): Promise<boolean> {
  if (!dossierId) return false;
  const d = await prisma.dossier.findUnique({ where: { id: dossierId }, select: { id: true } });
  if (!d) return false;
  await prisma.dossierMessage.create({ data: { dossierId, authorId: auteurId, body } });
  await prisma.dossier.update({ where: { id: dossierId }, data: { updatedAt: new Date() } });
  return true;
}

/** L'assistante qui prend une fiche devient membre du fil (elle doit y lire et y écrire, et lire le passeport). */
export async function assurerMembre(dossierId: string | null, userId: string): Promise<void> {
  if (!dossierId) return;
  const d = await prisma.dossier.findUnique({ where: { id: dossierId }, select: { assignedToId: true, createdById: true, participantIds: true } });
  if (!d || d.assignedToId === userId || d.createdById === userId || d.participantIds.includes(userId)) return;
  await prisma.dossier.update({ where: { id: dossierId }, data: { participantIds: { push: userId } } });
}

/**
 * LE SUJET DE LA FICHE — celui du poste (Ad & Pro) ou de la prise en charge, déjà ouvert ; sinon un nouveau, comme
 * l'ouvrait la demande en bloc : une seule assistante active en est responsable, plusieurs en sont participantes,
 * le demandeur aussi. Un sujet clos (abouti ou archivé) se ROUVRE : une fiche nouvelle à réserver relance l'échange.
 *
 * Écriture CONDITIONNELLE du lien : deux premiers envois simultanés sur le même poste n'ouvrent pas deux sujets —
 * le second voit le lien posé, supprime le sujet vide qu'il venait d'ouvrir, et écrit dans celui du premier.
 */
export async function assurerSujet(f: FicheReservation, acteurId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const existant = f.sujetId ? await prisma.dossier.findUnique({ where: { id: f.sujetId }, select: { id: true, status: true } }) : null;
  if (existant) {
    if (existant.status === "DONE" || existant.status === "ARCHIVED") {
      await prisma.dossier.updateMany({ where: { id: existant.id, status: { in: ["DONE", "ARCHIVED"] } }, data: { status: "IN_PROGRESS" } });
    }
    return { ok: true, id: existant.id };
  }
  const assistantes = await assistantesActives();
  if (assistantes.length === 0) {
    return { ok: false, error: "Aucune assistante de direction active : la fiche n'a personne à qui partir (Administration › Comptes)." };
  }
  const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
  const titre = f.itemId ? `Réservation — ${f.operation.ref} · ${f.poste}` : `Prise en charge — ${f.operation.ref}`;
  const sujet = await createDossierRecord({
    title: titre,
    description: "Fil des fiches de voyage envoyées à l'assistante de direction — chaque fiche se suit dans le Bureau du secrétariat, onglet « Ad & Pro ».",
    category: "Billets",
    priority: "HIGH",
    assignedToId: seule,
    participantIds: [...(seule ? [] : assistantes.map((a) => a.id)), ...(f.operation.requesterId ? [f.operation.requesterId] : [])],
    sourceType: f.operation.type,
    sourceId: f.operation.id,
    companyId: f.operation.companyId,
  }, acteurId);
  const pose = f.itemId
    ? await prisma.adProItem.updateMany({ where: { id: f.itemId, reservationDossierId: null }, data: { reservationDossierId: sujet.id } })
    : f.operation.type === "CONGRESS_NATIONAL"
      ? await prisma.congressNational.updateMany({ where: { id: f.operation.id, careReservationDossierId: null }, data: { careReservationDossierId: sujet.id } })
      : await prisma.congressInternational.updateMany({ where: { id: f.operation.id, careReservationDossierId: null }, data: { careReservationDossierId: sujet.id } });
  if (pose.count > 0) return { ok: true, id: sujet.id };
  // UN AUTRE ENVOI L'A OUVERT ENTRE-TEMPS : on retire le nôtre (vide) et on rejoint le sien.
  await prisma.dossier.delete({ where: { id: sujet.id } }).catch(sansBloquer("reservation-fiche-serveur.assurerSujet.dossier"));
  const autre = f.itemId
    ? (await prisma.adProItem.findUnique({ where: { id: f.itemId }, select: { reservationDossierId: true } }))?.reservationDossierId
    : f.operation.type === "CONGRESS_NATIONAL"
      ? (await prisma.congressNational.findUnique({ where: { id: f.operation.id }, select: { careReservationDossierId: true } }))?.careReservationDossierId
      : (await prisma.congressInternational.findUnique({ where: { id: f.operation.id }, select: { careReservationDossierId: true } }))?.careReservationDossierId;
  return autre ? { ok: true, id: autre } : { ok: false, error: "Le sujet de réservation n'a pas pu être ouvert : réessayez." };
}

/**
 * LA FICHE A ÉTÉ MODIFIÉE — appelé par les gestes qui modifient une fiche (voyageur, fiche hôtellerie, poste d'une
 * prise en charge), APRÈS leur écriture. Une fiche chez l'assistante dont les champs ne sont plus ceux de l'envoi
 * passe « modifiée après l'envoi » (à renvoyer) ; l'assistante qui l'a prise (sinon toutes) est prévenue, avec ce
 * qui a changé. Une modification ANNULÉE (la fiche redit ce qu'elle disait) la rend à son état. Écritures
 * conditionnelles ; jamais d'erreur remontée : la modification de la fiche a eu lieu, c'est elle qui compte.
 */
export async function noterModificationFiche(source: SourceFiche, ficheId: string, acteurId: string): Promise<void> {
  try {
    const d = await prisma.demandeReservation.findUnique({ where: colonneFiche(source, ficheId) as never });
    if (!d || !d.empreinte) return;
    const etat = d.etat as EtatDemande;
    if (!estChezElle(etat) && etat !== "MODIFIEE_APRES_ENVOI") return;
    const f = await chargerFiche(source, ficheId);
    const avant = lireEmpreinte(d.empreinte);
    if (!f || !avant) return;
    const changements = diffEmpreintes(avant, f.empreinte);
    if (changements.length > 0 && estChezElle(etat)) {
      const w = await prisma.demandeReservation.updateMany({ where: { id: d.id, etat: d.etat }, data: { etat: "MODIFIEE_APRES_ENVOI", modifieeLe: new Date() } });
      if (w.count === 0) return;
      await noterAuFil(d.dossierId, acteurId, `Fiche modifiée après l'envoi — ${NATURE_LIBELLE[f.nature]} · ${f.nom} : ${phraseChangements(changements)}. Elle sera renvoyée par le demandeur.`);
      await prevenir(await destinatairesAssistante(d), {
        title: "Fiche modifiée après l'envoi",
        body: `${NATURE_LIBELLE[f.nature]} · ${f.nom} — ${phraseChangements(changements)}`.slice(0, 240),
        link: lienBureau(d.id),
      }, acteurId);
    } else if (changements.length === 0 && etat === "MODIFIEE_APRES_ENVOI") {
      await prisma.demandeReservation.updateMany({ where: { id: d.id, etat: "MODIFIEE_APRES_ENVOI" }, data: { etat: etatRepris(d), modifieeLe: null } });
      await noterAuFil(d.dossierId, acteurId, `Fiche revenue à ce qui avait été envoyé — ${NATURE_LIBELLE[f.nature]} · ${f.nom}.`);
    }
  } catch (err) {
    console.error("[reservation-fiche] modification non notée", err);
  }
}
