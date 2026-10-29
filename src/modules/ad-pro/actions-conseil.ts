"use server";

import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { canAccessEntity } from "@/lib/entity-access";
import { readFileByKey } from "@/lib/storage";
import { fdStr } from "@/lib/actions/types";
import { conseillerParModele, type ResultatConseil } from "@/lib/conseil-pieces-ia";
import {
  lireEmplacement, NATURES_DEMANDE_CONSEIL, type NatureDemandeConseil, type PosteDuContexte,
} from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA CONSEILLE OÙ RANGER UNE PIÈCE — l'action de l'écran. CONSULTATIVE : elle n'écrit RIEN
 * (hors du journal d'usage de l'IA et du cache de lecture du dépôt), ne déplace aucune pièce.
 *
 * Les gardes, dans l'ordre, et chacune a son cas au banc :
 *   1. la demande se VOIT (`canAccessEntity` … "VIEW") — sinon « introuvable », la même phrase
 *      que l'absence (une demande qu'on ne voit pas n'existe pas pour soi) ;
 *   2. le fichier (`Document`) appartient à CETTE demande ou à l'un de SES postes — par le lien
 *      causal en base, jamais par un identifiant cru sur parole : on ne lit pas par cette porte le
 *      fichier d'une autre demande ;
 *   3. l'emplacement visé se lit strictement, et un poste visé doit être un poste de la demande ;
 *   4. le contexte (postes, titre) est RECHARGÉ EN BASE : celui du formulaire ne fait jamais foi.
 *
 * Une pièce non INTERNE (RESTRICTED, CONFIDENTIAL) ne part pas chez le fournisseur : le serveur le
 * dit (`CONFIDENTIELLE`), et l'écran affiche le refus, jamais « bien placé ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const INTROUVABLE = "Demande introuvable.";
const FICHIER_INTROUVABLE = "Cette pièce n'appartient pas à cette demande ni à l'un de ses postes.";

type ColonneParent = "sponsoringId" | "congressInternationalId" | "congressNationalId" | "eventId" | "otherRequestId";
const COLONNE: Record<NatureDemandeConseil, ColonneParent> = {
  SPONSORING: "sponsoringId",
  CONGRESS_INTERNATIONAL: "congressInternationalId",
  CONGRESS_NATIONAL: "congressNationalId",
  EVENT: "eventId",
  AD_PRO_OTHER: "otherRequestId",
};

async function titreDeLaDemande(nature: NatureDemandeConseil, id: string): Promise<string | null> {
  switch (nature) {
    case "SPONSORING": {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id }, select: { reference: true, institution: true } });
      return r ? `${r.reference} — ${r.institution}` : null;
    }
    case "CONGRESS_INTERNATIONAL":
      return (await prisma.congressInternational.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    case "CONGRESS_NATIONAL":
      return (await prisma.congressNational.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    case "EVENT":
      return (await prisma.event.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
    case "AD_PRO_OTHER": {
      const r = await prisma.adProOtherRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    }
  }
}

/**
 * CONSEILLER UNE PIÈCE DÉJÀ DÉPOSÉE.
 * Champs : `entityType` (SPONSORING | CONGRESS_INTERNATIONAL | CONGRESS_NATIONAL | EVENT),
 * `entityId`, `fichierId` (l'identifiant du `Document`), `emplacement` (JSON d'`EmplacementPiece`).
 */
export async function conseillerPiece(formData: FormData): Promise<ResultatConseil> {
  const user = await requireUser();
  const entityType = fdStr(formData, "entityType") ?? "";
  const entityId = fdStr(formData, "entityId") ?? "";
  const fichierId = fdStr(formData, "fichierId") ?? "";
  const emplacementBrut = fdStr(formData, "emplacement") ?? "";

  if (!(NATURES_DEMANDE_CONSEIL as readonly string[]).includes(entityType) || !entityId) {
    return { ok: false, raison: "LECTURE", error: INTROUVABLE };
  }
  const nature = entityType as NatureDemandeConseil;
  if (!(await canAccessEntity(user, nature as EntityType, entityId, "VIEW"))) {
    return { ok: false, raison: "LECTURE", error: INTROUVABLE };
  }
  const titre = await titreDeLaDemande(nature, entityId);
  if (titre === null) return { ok: false, raison: "LECTURE", error: INTROUVABLE };

  // LE CONTEXTE VIENT DE LA BASE — jamais du formulaire.
  const postesEnBase = await prisma.adProItem.findMany({
    where: { [COLONNE[nature]]: entityId },
    select: { id: true, kind: true, label: true, amountEstimated: true, amountGranted: true, supplier: true },
    orderBy: { createdAt: "asc" },
  });
  const postes: PosteDuContexte[] = postesEnBase.map((p) => {
    const m = p.amountGranted ?? p.amountEstimated;
    return { id: p.id, nature: p.kind, libelle: p.label, montant: m === null ? null : Number(m), fournisseur: p.supplier };
  });

  const emplacement = lireEmplacement(emplacementBrut);
  if (!emplacement) return { ok: false, raison: "LECTURE", error: "Emplacement de la pièce illisible." };
  if (emplacement.type === "POSTE" && !postes.some((p) => p.id === emplacement.posteId)) {
    return { ok: false, raison: "LECTURE", error: "Le poste visé n'appartient pas à cette demande." };
  }

  // LES PIÈCES D'ACHAT DES POSTES (§118.204) : devis, BC, factures vivent au registre Legal et se
  // rattachent au poste — leur fichier est sur la PIÈCE, que le lien du poste désigne (lien causal).
  const piecesDesPostes = postes.length > 0
    ? (await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes.map((p) => p.id) } }, select: { legalDocumentId: true } }))
        .map((l) => l.legalDocumentId)
    : [];

  // LE FICHIER : sur la demande elle-même, sur l'un de SES postes, ou sur une pièce d'un de ses postes.
  const doc = fichierId
    ? await prisma.document.findFirst({
        where: {
          id: fichierId,
          OR: [
            { entityType: nature as EntityType, entityId },
            ...(postes.length > 0 ? [{ entityType: "AD_PRO_ITEM" as EntityType, entityId: { in: postes.map((p) => p.id) } }] : []),
            ...(piecesDesPostes.length > 0 ? [{ entityType: "LEGAL_DOCUMENT" as EntityType, entityId: { in: piecesDesPostes } }] : []),
          ],
        },
        select: { name: true, fileKey: true, confidentiality: true },
      })
    : null;
  if (!doc) return { ok: false, raison: "LECTURE", error: FICHIER_INTROUVABLE };
  if (!doc.fileKey) return { ok: false, raison: "LECTURE", error: "Cette pièce n'a pas de fichier à lire (métadonnées seulement)." };

  // Une pièce non interne ne sort pas : on ne lit même pas ses octets.
  const confidentielle = doc.confidentiality !== "INTERNAL";
  let octets: Buffer = Buffer.alloc(0);
  if (!confidentielle) {
    try {
      octets = await readFileByKey(doc.fileKey);
    } catch {
      return { ok: false, raison: "LECTURE", error: "Le fichier de cette pièce est introuvable dans le stockage." };
    }
  }

  return conseillerParModele({
    octets,
    confidentielle,
    userId: user.id,
    contexte: { natureDemande: nature, titre, postes, emplacement, nomFichier: doc.name },
  });
}
