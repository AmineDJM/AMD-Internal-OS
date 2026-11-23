import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { cheminDeClassement } from "@/lib/legal/classement";
import { parentOf, PARENTS } from "./postes/commun";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RANGER UNE PIÈCE DE POSTE DANS L'ARMOIRE LEGAL (recette du 23/11/2026).
 *
 * Appelé par `rattacherPieceAuPoste` — le SEUL chemin par lequel un devis, un bon de commande ou une
 * facture rejoint un poste (écran du poste, BC généré, demande de pièce, Budget Marketing) : un seul
 * branchement les range tous. La règle du chemin est pure (`lib/legal/classement.ts`).
 *
 *   · Le dossier se crée s'il n'existe pas (trouver-ou-créer, niveau par niveau), commun au groupe.
 *   · Une pièce DÉJÀ rangée à la main n'est jamais déplacée : on ne range que ce qui est « non classé ».
 *   · Rien ne bloque : un échec de rangement laisse la pièce où elle était (l'appelant l'avale).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function dossierTrouveOuCree(noms: readonly string[]): Promise<string | null> {
  let parentId: string | null = null;
  for (const name of noms) {
    const existant: { id: string } | null = await prisma.legalFolder.findFirst({ where: { name, parentId }, select: { id: true }, orderBy: { createdAt: "asc" } });
    if (existant) { parentId = existant.id; continue; }
    const cree: { id: string } = await prisma.legalFolder.create({
      data: { name, parentId, description: parentId ? null : "Pièces des demandes Ad & Pro, rangées automatiquement par demande." },
      select: { id: true },
    });
    parentId = cree.id;
  }
  return parentId;
}

/** Le nom et l'année de la demande qui porte le poste — l'événement d'abord par sa date. */
async function demandeDuPoste(itemId: string): Promise<{ parent: string; nom: string; annee: number } | null> {
  const item = await prisma.adProItem.findUnique({
    where: { id: itemId },
    select: { eventId: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, otherRequestId: true, createdAt: true },
  });
  if (!item) return null;
  const p = parentOf(item);
  if (!p) return null;
  if (p.parent === "EVENT") {
    const ev = await prisma.event.findUnique({ where: { id: p.id }, select: { name: true, startDate: true, createdAt: true } });
    if (!ev) return null;
    return { parent: p.parent, nom: ev.name, annee: (ev.startDate ?? ev.createdAt).getFullYear() };
  }
  const info = await PARENTS[p.parent].load(p.id);
  if (!info) return null;
  return { parent: p.parent, nom: info.ref, annee: item.createdAt.getFullYear() };
}

export async function rangerPieceDuPoste(i: { itemId: string; legalDocumentId: string }): Promise<string | null> {
  const doc = await prisma.legalDocument.findUnique({ where: { id: i.legalDocumentId }, select: { folderId: true } });
  if (!doc || doc.folderId) return doc?.folderId ?? null;
  const demande = await demandeDuPoste(i.itemId);
  if (!demande) return null;
  const chemin = cheminDeClassement(demande.parent, demande.annee, demande.nom);
  if (!chemin) return null;
  const folderId = await dossierTrouveOuCree(chemin);
  if (!folderId) return null;
  // `folderId: null` dans la garde : un rangement manuel fait entre-temps n'est pas écrasé.
  await prisma.legalDocument.updateMany({ where: { id: i.legalDocumentId, folderId: null }, data: { folderId } });
  return folderId;
}

/**
 * LE RATTRAPAGE — range les pièces de postes déjà au registre et encore « non classées ». Idempotent :
 * relancé, il ne trouve plus rien. Par lots, pour ne pas tenir une transaction sur tout le registre.
 */
export async function rangerPiecesNonClasseesDesPostes(lot = 200): Promise<{ rangees: number; examinees: number }> {
  const pieces = await prisma.adProItemPiece.findMany({
    where: { legalDocument: { folderId: null } },
    select: { itemId: true, legalDocumentId: true },
    orderBy: { createdAt: "asc" },
    take: lot,
  });
  let rangees = 0;
  for (const p of pieces) {
    if (await rangerPieceDuPoste(p).catch(sansBloquer("classement-juridique.rangerPiecesNonClasseesDesPostes", null))) rangees += 1;
  }
  return { rangees, examinees: pieces.length };
}

const NATURE_DEMANDE: Record<string, string> = {
  EVENT: "Événement",
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prise en charge nationale",
  CONGRESS_INTERNATIONAL: "Prise en charge internationale",
  AD_PRO_OTHER: "Demande Ad & Pro",
};

/**
 * LA DEMANDE D'UNE PIÈCE DU REGISTRE — par son poste (`AdProItemPiece`), quelle que soit la source écrite
 * sur la pièce (un BC généré porte le POSTE, un devis l'ÉVÉNEMENT). « Événement — Journée de cardiologie »
 * et le lien vers sa fiche ; `null` : la pièce n'est rattachée à aucun poste.
 */
export async function demandeDeLaPiece(legalDocumentId: string): Promise<{ libelle: string; href: string } | null> {
  const lien = await prisma.adProItemPiece.findFirst({
    where: { legalDocumentId },
    select: { item: { select: { eventId: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, otherRequestId: true, label: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!lien) return null;
  const p = parentOf(lien.item);
  if (!p) return null;
  const info = await PARENTS[p.parent].load(p.id);
  if (!info) return null;
  return { libelle: `${NATURE_DEMANDE[p.parent] ?? "Demande"} — ${info.ref} · poste « ${lien.item.label} »`, href: `${PARENTS[p.parent].path}/${p.id}` };
}
