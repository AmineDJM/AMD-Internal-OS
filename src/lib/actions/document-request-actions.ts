"use server";

import type { DocumentRequestStatus, EntityType, LegalDocKind } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { buildRef, createWithRetry } from "@/lib/refs";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import {
  nextDocRequestStatus, canSubmit, canDecide, refusAnnulationPiece, refusReaffectation, STATUTS_PIECE_ANNULABLES, STATUTS_PIECE_REAFFECTABLES,
} from "@/lib/doc-request";
import { tientPourLaSollicitee } from "@/lib/doc-request-interim";
import { companyIdForNew } from "@/lib/company";
import { pieceKindOf, legalKindOfPiece, legalTitleFromPiece, PIECE_KIND_LABEL } from "@/lib/legal/from-piece";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { reserveDeLAiguillage } from "@/lib/bons-de-commande/regle";
import { assistantesDeDirection, natureDePiece, rattacherPieceAuPoste, societeDuPoste } from "@/modules/ad-pro/api";

const PATH = "/pieces";

/**
 * DEMANDER UNE PIÈCE À QUELQU'UN — n'importe qui, pas seulement le secrétariat.
 *
 * Les autorisations ne reposent PAS sur le module de l'objet visé : celui à qui l'on demande une
 * facture n'a pas forcément accès au poste de dépense, et c'est normal. Elles reposent sur le
 * fil lui-même — on est le demandeur, ou celui à qui l'on demande. C'est ce qui permet de
 * réclamer une pièce à un collègue sans lui ouvrir tout un module au passage.
 */

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.documentRequest.findMany({
    where: { reference: { startsWith: `PIE-${year}-` } }, select: { reference: true },
  });
  return buildRef("PIE", year, refs.map((r) => r.reference));
}

function revalidate(id?: string, link?: string | null) {
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
  if (link) revalidatePath(link);
}

const dateOf = (raw: string | null): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Demander une pièce. L'objet visé sert de contexte ; le lien ramène à son écran. */
export async function requestDocument(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const entityType = fdStr(formData, "entityType");
    const entityId = fdStr(formData, "entityId");
    const askedToId = fdStr(formData, "askedToId");
    const label = fdStr(formData, "label");

    if (!entityType || !entityId) return { ok: false, error: "Objet non précisé." };
    if (!askedToId) return { ok: false, error: "Indiquez à qui vous demandez la pièce." };
    // Se demander une pièce à soi-même n'attend rien de personne : c'est un dépôt, pas une demande.
    if (askedToId === user.id) return { ok: false, error: "Pour déposer une pièce vous-même, utilisez « Ajouter une pièce »." };
    if (!label) return { ok: false, error: "Dites CE QUE vous demandez — « la facture définitive de l'agence », pas « pièce n° 3 »." };

    const req = await createWithRetry(async () =>
      prisma.documentRequest.create({
        data: {
          reference: await nextRef(),
          entityType: entityType as EntityType,
          entityId,
          link: fdStr(formData, "link"),
          label,
          // LA NATURE DE LA PIÈCE — c'est elle qui décide si l'acceptation la classe dans Legal.
          kind: pieceKindOf(fdStr(formData, "kind")),
          note: fdStr(formData, "note"),
          dueDate: dateOf(fdStr(formData, "dueDate")),
          askedById: user.id,
          askedToId,
          status: "PENDING",
        },
      }),
    );

    await notifyUser({
      userId: askedToId, type: "ASSIGNMENT",
      title: "Une pièce vous est demandée",
      body: `${req.reference} — ${label}`,
      link: `${PATH}/${req.id}`,
    });
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Demandes de pièce",
      entityType: "DOCUMENT_REQUEST", entityId: req.id, summary: `Pièce demandée — ${req.reference} : ${label}`,
    });
    revalidate(req.id, req.link);
    return { ok: true, id: req.id };
  } catch (err) {
    console.error("[doc-request] requestDocument failed", err);
    return { ok: false, error: "La demande n'a pas pu être créée." };
  }
}

/** Celui à qui l'on demande signale avoir déposé ses pièces. */
export async function submitDocumentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.documentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    // L'INTÉRIMAIRE de l'assistante sollicitée pour le BC d'un poste Ad & Pro dépose à sa place (audit
    // Assistante de direction, 10/2026) : absente, la demande restait figée chez elle.
    if (!canSubmit(req, user.id, await tientPourLaSollicitee(user.id, req))) return { ok: false, error: "Seule la personne sollicitée (ou son intérimaire, pour le BC d'un poste) peut déposer." };

    // Signaler « déposé » sans rien avoir joint enverrait le demandeur chercher un fichier
    // inexistant — et le fil repartirait pour un tour inutile.
    const count = await prisma.document.count({ where: { entityType: "DOCUMENT_REQUEST", entityId: id } });
    if (count === 0) return { ok: false, error: "Joignez au moins une pièce avant de signaler le dépôt." };

    const next = nextDocRequestStatus(req.status, "SUBMIT");
    await prisma.documentRequest.update({
      where: { id },
      data: { status: next as DocumentRequestStatus, submittedAt: new Date(), responseNote: fdStr(formData, "note") },
    });
    await notifyUser({
      userId: req.askedById, type: "GENERIC",
      title: "Pièce déposée", body: `${req.reference} — ${req.label}`, link: `${PATH}/${id}`,
    });
    revalidate(id, req.link);
    return { ok: true, id };
  } catch (err) {
    console.error("[doc-request] submitDocumentRequest failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

/**
 * CLASSER LA PIÈCE ACCEPTÉE DANS LEGAL — quand sa nature engage la société.
 *
 * ── CE QUI SE PASSE, ET DANS QUEL ORDRE ─────────────────────────────────────────────────────
 *
 * Une pièce Legal est créée sous la nature déclarée (facture, bon de commande, devis, contrat),
 * et les fichiers déposés DÉMÉNAGENT vers elle. Ils ne sont pas recopiés : un fichier, un seul
 * domicile — deux copies divergent le jour où l'une est remplacée. Le fil de la demande continue
 * de les montrer, en les lisant à leur nouvelle adresse (`/pieces/[id]`).
 *
 * ── LES DROITS, QUI SONT LE VRAI PIÈGE ──────────────────────────────────────────────────────
 *
 * Un document Legal SANS lecteur désigné est visible de TOUT le module. Classer sans y penser
 * exposerait donc, en silence, une facture à des gens qui n'avaient rien à en connaître. La pièce
 * naît RESTREINTE — celui qui a demandé, celui qui a déposé — et Legal offre déjà le geste
 * inverse, explicite : « Ouvrir à tout le module ».
 *
 * BEST-EFFORT : un classement qui échoue ne doit pas annuler l'acceptation. La pièce est bien
 * déposée et acceptée ; ce qui manque est son entrée au registre, et elle se rattrape.
 */
async function classerDansLegal(
  req: { id: string; reference: string; label: string; kind: string; legalDocumentId: string | null; askedById: string; askedToId: string; entityType: string; entityId: string },
  actorId: string,
): Promise<{ id: string; kindLabel: string; reserve: string | null } | null> {
  const legalKind = legalKindOfPiece(req.kind);
  if (!legalKind) return null;
  // Déjà classée : accepter une seconde fois ne crée pas un second engagement.
  if (req.legalDocumentId) return null;
  try {
    const doc = await prisma.legalDocument.create({
      data: {
        title: legalTitleFromPiece(req.label, req.reference),
        kind: legalKind as LegalDocKind,
        // Une pièce d'achat d'un POSTE prend la société de SA demande (§118.204), comme son devis et sa
        // facture ; sinon celle de qui l'accepte.
        companyId: (req.entityType === "AD_PRO_ITEM" ? await societeDuPoste(req.entityId) : null) ?? await companyIdForNew(actorId),
        sourceType: "DOCUMENT_REQUEST",
        sourceId: req.id,
        createdById: actorId,
        updatedById: actorId,
        // Ni référence, ni montant, ni dates, ni contrepartie : on n'INVENTE rien à partir d'un
        // fichier qu'on n'a pas lu. Ce sont des champs qu'un humain remplit en ouvrant la pièce.
        notes: `Enregistrée depuis la demande de pièce ${req.reference}.`,
      },
      select: { id: true },
    });
    // UNE PIÈCE D'ACHAT DEMANDÉE POUR UN POSTE AD & PRO (§118.204) rejoint SON poste, et elle n'est PAS
    // restreinte : c'est la chaîne d'achat d'une demande du pôle, que les Finances signent puis règlent.
    // La restreindre au demandeur et à l'assistante la cachait à la file de signature (qui lit les
    // lecteurs), et le BC restait « à signer » chez personne. Ceux qui voient la demande la voient sur
    // le poste (`accesAuxPiecesLegal`, exception des postes).
    const natureDuPoste = req.entityType === "AD_PRO_ITEM" ? natureDePiece(legalKind) : null;
    if (natureDuPoste) {
      await rattacherPieceAuPoste({ itemId: req.entityId, legalDocumentId: doc.id, nature: natureDuPoste, acteurId: actorId });
    } else {
      // LES LECTEURS SUIVENT — sans quoi classer une facture l'exposerait à tout le module.
      await prisma.legalDocumentReader.createMany({
        data: [...new Set([req.askedById, req.askedToId, actorId])].map((userId) => ({
          documentId: doc.id, userId, grantedById: actorId,
        })),
        skipDuplicates: true,
      });
    }
    // LE FICHIER DÉMÉNAGE, il n'est pas recopié.
    await prisma.document.updateMany({
      where: { entityType: "DOCUMENT_REQUEST", entityId: req.id },
      data: { entityType: "LEGAL_DOCUMENT", entityId: doc.id },
    });
    await prisma.documentRequest.update({ where: { id: req.id }, data: { legalDocumentId: doc.id } });
    await recordAudit({
      actorId, action: "CREATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id,
      summary: `Pièce ${req.reference} enregistrée dans Legal (${legalKind}) — ${req.label}`,
    });
    // UN BON DE COMMANDE CLASSÉ PASSE PAR SON CENTRE (§118.148). Réclamé sur le poste d'une
    // opération Ad & Pro dont le BC a déjà été VISÉ, il matérialise ce visa et n'en demande pas un
    // second ; sinon il attend le centre de son origine — que l'aiguillage lit en remontant la
    // demande de pièce jusqu'à l'objet qu'elle visait.
    // La réserve voyage avec le classement : « enregistrée dans Legal » sur un BC que personne n'a
    // validé le ferait envoyer au fournisseur (§118.32) — et un aiguillage raté doit se DIRE.
    const aiguillage = legalKind === "PURCHASE_ORDER" ? await aiguillerBC(doc.id, { acteurId: actorId }) : null;
    const reserve = aiguillage ? reserveDeLAiguillage(aiguillage) : null;
    return { id: doc.id, kindLabel: PIECE_KIND_LABEL[pieceKindOf(req.kind)].toLowerCase(), reserve };
  } catch (e) {
    console.error("[doc-request] classement Legal impossible", e);
    return null;
  }
}

/** Celui qui a demandé accepte la pièce, ou la refuse — et la demande repart alors. */
export async function decideDocumentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const accept = fdStr(formData, "accept") === "1";
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.documentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!canDecide(req, user.id)) return { ok: false, error: "Seule la personne qui a demandé peut trancher." };

    const next = nextDocRequestStatus(req.status, accept ? "ACCEPT" : "DECLINE");
    if (!next) return { ok: false, error: "Cette demande n'attend pas de décision." };

    await prisma.documentRequest.update({
      where: { id },
      data: {
        status: next as DocumentRequestStatus,
        responseNote: fdStr(formData, "note") ?? req.responseNote,
        closedAt: accept ? new Date() : null,
        closedById: accept ? user.id : null,
      },
    });
    // ── LA PIÈCE ACCEPTÉE REJOINT LE REGISTRE DES ENGAGEMENTS ─────────────────────────────
    //
    // À l'ACCEPTATION, et non au dépôt : le registre ne doit contenir que des pièces que
    // quelqu'un a regardées. Une facture déposée puis refusée — mauvais montant, mauvaise
    // société — y resterait comme un engagement de la société.
    const classement = accept ? await classerDansLegal(req, user.id) : null;

    await notifyUser({
      userId: req.askedToId, type: "GENERIC",
      title: accept ? "Pièce acceptée" : "Pièce refusée — à redéposer",
      body: `${req.reference} — ${req.label}`, link: `${PATH}/${id}`,
    });
    await recordAudit({
      actorId: user.id, action: accept ? "VALIDATE" : "UPDATE", module: "Demandes de pièce",
      entityType: "DOCUMENT_REQUEST", entityId: id,
      summary: `${accept ? "Pièce acceptée" : "Pièce refusée"} — ${req.reference}`,
    });
    revalidate(id, req.link);
    if (classement) revalidatePath("/legal");
    return {
      ok: true, id,
      message: classement
        ? `Pièce acceptée et enregistrée dans Legal (${classement.kindLabel}).${classement.reserve ? ` ${classement.reserve}` : ""}`
        : undefined,
    };
  } catch (err) {
    console.error("[doc-request] decideDocumentRequest failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

export async function cancelDocumentRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.documentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    const refus = refusAnnulationPiece(req, user.id, hasGlobalView(user.role));
    if (refus) return { ok: false, error: refus };

    // UN GESTE À LA FOIS : un dépôt passé entre la lecture et le clic l'emporte (la pièce déposée vaut
    // exécution), et deux clics n'annulent qu'une fois.
    const pris = await prisma.documentRequest.updateMany({
      where: { id, status: { in: [...STATUTS_PIECE_ANNULABLES] } },
      data: { status: "CANCELLED", closedAt: new Date(), closedById: user.id },
    });
    if (pris.count === 0) {
      const apres = await prisma.documentRequest.findUnique({ where: { id }, select: { status: true, askedById: true, askedToId: true } });
      return { ok: false, error: (apres && refusAnnulationPiece(apres, user.id, hasGlobalView(user.role))) ?? "Cette demande vient de changer — rechargez la page." };
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Pièces demandées", entityType: "DOCUMENT_REQUEST", entityId: id,
      field: "status", oldValue: req.status, newValue: "CANCELLED", summary: `Demande de pièce ${req.reference} annulée — ${req.label}`,
    });
    await notifyUser({
      userId: req.askedToId, type: "GENERIC",
      title: "Demande de pièce annulée", body: `${req.reference} — ${req.label}`, link: `${PATH}/${id}`,
    });
    revalidate(id, req.link);
    return { ok: true, id };
  } catch (err) {
    console.error("[doc-request] cancelDocumentRequest failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

/**
 * RÉAFFECTER LE BC D'UN POSTE À UNE AUTRE ASSISTANTE (audit Assistante de direction, 10/2026).
 *
 * La demande de bon de commande d'un poste Ad & Pro part chez UNE assistante nommée (`requestAdProItemOrder`) : absente,
 * débordée ou partie, la demande restait figée chez elle. Qui l'a demandée, l'assistante sollicitée (ou son intérimaire)
 * et la Direction la passent à une autre assistante de direction ACTIVE (`refusReaffectation`). Tant que la pièce n'est
 * pas déposée : l'écriture est conditionnelle (un dépôt croisé l'emporte), le poste suit (`bcAssistantId`), la nouvelle
 * assistante est prévenue, l'ancienne aussi.
 */
export async function reaffecterDemandeBC(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const cibleId = fdStr(formData, "assistantId");
    if (!id) return { ok: false, error: "Demande introuvable." };
    if (!cibleId) return { ok: false, error: "Choisissez l'assistante de direction qui reprend la demande." };
    const req = await prisma.documentRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    const remplace = await tientPourLaSollicitee(user.id, req);
    const refus = refusReaffectation(req, { id: user.id, vueGlobale: hasGlobalView(user.role), remplace }, cibleId);
    if (refus) return { ok: false, error: refus };
    const cible = (await assistantesDeDirection()).find((a) => a.id === cibleId);
    if (!cible) return { ok: false, error: "Cette personne n'est pas une assistante de direction active." };

    const pris = await prisma.documentRequest.updateMany({
      where: { id, askedToId: req.askedToId, status: { in: [...STATUTS_PIECE_REAFFECTABLES] } },
      data: { askedToId: cible.id },
    });
    if (pris.count === 0) return { ok: false, error: "Cette demande vient de changer — rechargez la page." };
    await prisma.adProItem.updateMany({ where: { id: req.entityId }, data: { bcAssistantId: cible.id } });
    const avant = await prisma.user.findUnique({ where: { id: req.askedToId }, select: { name: true } });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Pièces demandées", entityType: "DOCUMENT_REQUEST", entityId: id,
      field: "askedToId", oldValue: req.askedToId, newValue: cible.id,
      summary: `Demande de pièce ${req.reference} réaffectée de ${avant?.name ?? "—"} à ${cible.name} — ${req.label}`,
    });
    await notifyUser({
      userId: cible.id, type: "ASSIGNMENT",
      title: "Bon de commande à établir", body: `${req.reference} — ${req.label} (repris de ${avant?.name ?? "une collègue"})`, link: `${PATH}/${id}`,
    });
    if (req.askedToId !== user.id) {
      await notifyUser({
        userId: req.askedToId, type: "GENERIC",
        title: "Demande de bon de commande réaffectée", body: `${req.reference} — reprise par ${cible.name}.`, link: `${PATH}/${id}`,
      });
    }
    revalidate(id, req.link);
    return { ok: true, id, message: `Demande réaffectée à ${cible.name}.` };
  } catch (err) {
    console.error("[doc-request] reaffecterDemandeBC failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

/**
 * Les personnes à qui l'on peut demander une pièce — chargées À L'OUVERTURE du panneau.
 *
 * La liste ne descend pas avec la page : un écran de poste de dépense n'a aucune raison de
 * transporter l'annuaire complet à chaque affichage, pour un panneau que la plupart des visites
 * n'ouvriront pas.
 */
export async function askablePeople(): Promise<{ id: string; name: string }[]> {
  const user = await enLecture(requireUser);
  return prisma.user.findMany({
    where: { isActive: true, id: { not: user.id } },
    select: { id: true, name: true }, orderBy: { name: "asc" },
  });
}
