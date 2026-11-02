import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { piecesCitees } from "../operations/pieces";
import {
  DOCUMENTS_DOSSIER_MAX, lireDocuments, nettoyerConsignes, nettoyerNomDossier, sectionDossier, type DocumentDuDossier, type DossierVue,
} from "../../domaine/dossiers";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOSSIERS DE CONVERSATIONS — CÔTÉ BASE (décision 0027, point 5 — comme les « Projets » de ChatGPT).
 *
 * Les documents de référence sont des fichiers du Drive (ou de la Bibliothèque, qui y vit) : à l'AJOUT, la personne
 * doit pouvoir les ouvrir ; à CHAQUE TOUR, ils sont revérifiés (`piecesCitees`) — un document retiré, ou dont l'accès
 * a été retiré, n'est plus nommé au modèle. Les outils de lecture rejugent encore au moment de l'ouvrir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Resultat<T = object> = ({ ok: true } & T) | { ok: false; erreur: string };
const INTROUVABLE = { ok: false as const, erreur: "Dossier introuvable." };

export async function listerDossiers(userId: string): Promise<DossierVue[]> {
  const ds = await prisma.assistantIaDossier.findMany({
    where: { userId }, orderBy: { nom: "asc" },
    include: { _count: { select: { conversations: { where: { archiveLe: null } } } } },
  });
  return ds.map((d) => ({ id: d.id, nom: d.nom, consignes: d.consignes, documents: lireDocuments(d.documents), conversations: d._count.conversations }));
}

export async function creerDossier(userId: string, nom: string): Promise<Resultat<{ dossier: DossierVue }>> {
  const n = nettoyerNomDossier(nom);
  if (!n) return { ok: false, erreur: "Donnez un nom au dossier." };
  const d = await prisma.assistantIaDossier.create({ data: { userId, nom: n } });
  return { ok: true, dossier: { id: d.id, nom: d.nom, consignes: "", documents: [], conversations: 0 } };
}

export async function modifierDossier(userId: string, id: string, champs: { nom?: string; consignes?: string }): Promise<Resultat> {
  const data: Prisma.AssistantIaDossierUpdateManyMutationInput = {};
  if (champs.nom !== undefined) {
    const n = nettoyerNomDossier(champs.nom);
    if (!n) return { ok: false, erreur: "Donnez un nom au dossier." };
    data.nom = n;
  }
  if (champs.consignes !== undefined) data.consignes = nettoyerConsignes(champs.consignes);
  const r = await prisma.assistantIaDossier.updateMany({ where: { id, userId }, data });
  return r.count ? { ok: true } : INTROUVABLE;
}

/** SUPPRIMER un dossier : ses conversations restent (elles sortent du dossier), ses consignes et sa liste partent. */
export async function supprimerDossier(userId: string, id: string): Promise<Resultat> {
  const r = await prisma.assistantIaDossier.deleteMany({ where: { id, userId } });
  return r.count ? { ok: true } : INTROUVABLE;
}

/** AJOUTER des documents : seulement ceux que la personne peut ouvrir, maintenant. Les autres sont dits refusés. */
export async function ajouterDocuments(user: CurrentUser, id: string, ids: string[]): Promise<Resultat<{ documents: DocumentDuDossier[]; refuses: number }>> {
  const d = await prisma.assistantIaDossier.findFirst({ where: { id, userId: user.id } });
  if (!d) return INTROUVABLE;
  const demandes = [...new Set(ids.filter((x) => typeof x === "string" && x))].slice(0, DOCUMENTS_DOSSIER_MAX);
  const visibles = await piecesCitees(user, demandes);
  const documents = lireDocuments([...lireDocuments(d.documents), ...visibles.map((p) => ({ id: p.id, nom: p.nom }))]);
  await prisma.assistantIaDossier.update({ where: { id: d.id }, data: { documents: documents as unknown as Prisma.InputJsonValue } });
  return { ok: true, documents, refuses: demandes.length - visibles.length };
}

export async function retirerDocument(userId: string, id: string, documentId: string): Promise<Resultat> {
  const d = await prisma.assistantIaDossier.findFirst({ where: { id, userId } });
  if (!d) return INTROUVABLE;
  const documents = lireDocuments(d.documents).filter((x) => x.id !== documentId);
  await prisma.assistantIaDossier.update({ where: { id: d.id }, data: { documents: documents as unknown as Prisma.InputJsonValue } });
  return { ok: true };
}

/**
 * LA SECTION DU DOSSIER POUR CE TOUR — consignes et documents ENCORE ouvrables par la personne (droits relus). `null`
 * si la conversation n'est dans aucun dossier (ou un dossier qui n'est pas le sien).
 */
export async function sectionDossierDuTour(user: CurrentUser, dossierId: string | null | undefined): Promise<string | null> {
  if (!dossierId) return null;
  const d = await prisma.assistantIaDossier.findFirst({ where: { id: dossierId, userId: user.id } });
  if (!d) return null;
  const documents = lireDocuments(d.documents);
  const ouvrables = documents.length ? await piecesCitees(user, documents.map((x) => x.id)) : [];
  return sectionDossier({ nom: d.nom, consignes: d.consignes, documents: ouvrables.map((p) => ({ id: p.id, nom: p.nom })) });
}
