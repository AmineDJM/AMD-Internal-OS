"use server";

import { porte } from "./infra/porte-actions";
import { prisma } from "@/lib/prisma";
import type { ConversationResumee } from "./domaine/conversations";
import type { DocumentDuDossier, DossierVue } from "./domaine/dossiers";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSATIONS, LES DOSSIERS ET LES APPAREILS — gestes de la personne (décision 0027, Adventum IA).
 *
 * Clé `assistant-ia-conversations-actions`. Les mêmes gestes servent l'écran `/assistant` de l'ERP et l'app
 * Adventum IA : une seule implémentation. L'identité vient TOUJOURS de la session (`porte`), jamais d'un paramètre ;
 * chaque service met la personne dans son `where` (un identifiant qui n'est pas le sien ne donne rien) ; aucune
 * écriture en « Vue exacte ». Pas de partage de conversation (décision 0027, point 6).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Echec = { ok: false; erreur: string };
const id = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 64 ? v : null);
const conversations = () => import("./infra/conversations/service");
const dossiers = () => import("./infra/conversations/dossiers");
const INTROUVABLE: Echec = { ok: false, erreur: "Conversation introuvable." };

// ─────────────────────────────── Les conversations ───────────────────────────────

export async function listerMesConversations(archivees?: boolean): Promise<{ ok: true; conversations: ConversationResumee[] } | Echec> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, conversations: await (await conversations()).listerConversations(p.user.id, { archivees: archivees === true }) };
}

export async function rechercherMesConversations(terme: string): Promise<{ ok: true; conversations: ConversationResumee[] } | Echec> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, conversations: await (await conversations()).rechercherConversations(p.user.id, typeof terme === "string" ? terme : "") };
}

/** Une conversation neuve, privée ou non, éventuellement dans un dossier — le caractère privé est choisi ICI. */
export async function creerMaConversation(prive?: boolean, dossierId?: string | null) {
  const p = await porte(true);
  if (!p.ok) return p;
  const { nouvelleConversation } = await import("./api");
  return nouvelleConversation(p.user.id, { prive: prive === true, dossierId: id(dossierId) });
}

export async function renommerMaConversation(conversationId: string, titre: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).renommerConversation(p.user.id, conversationId, typeof titre === "string" ? titre : "");
}

export async function epinglerMaConversation(conversationId: string, epingle: boolean) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).epinglerConversation(p.user.id, conversationId, epingle === true);
}

export async function archiverMaConversation(conversationId: string, archive: boolean) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).archiverConversation(p.user.id, conversationId, archive === true);
}

export async function supprimerMaConversation(conversationId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).supprimerConversation(p.user.id, conversationId);
}

/** Privée ou non — seulement AVANT le premier message ; ensuite, le service refuse et dit pourquoi. */
export async function reglerMaConversationPrivee(conversationId: string, prive: boolean) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).reglerPrive(p.user.id, conversationId, prive === true);
}

export async function rangerMaConversation(conversationId: string, dossierId: string | null) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(conversationId)) return INTROUVABLE;
  return (await conversations()).rangerConversation(p.user.id, conversationId, id(dossierId));
}

// ─────────────────────────────── Les dossiers ───────────────────────────────

export async function listerMesDossiers(): Promise<{ ok: true; dossiers: DossierVue[] } | Echec> {
  const p = await porte(false);
  if (!p.ok) return p;
  return { ok: true, dossiers: await (await dossiers()).listerDossiers(p.user.id) };
}

export async function creerMonDossier(nom: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  return (await dossiers()).creerDossier(p.user.id, typeof nom === "string" ? nom : "");
}

export async function modifierMonDossier(dossierId: string, nom?: string, consignes?: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(dossierId)) return { ok: false as const, erreur: "Dossier introuvable." };
  return (await dossiers()).modifierDossier(p.user.id, dossierId, {
    ...(typeof nom === "string" ? { nom } : {}), ...(typeof consignes === "string" ? { consignes } : {}),
  });
}

export async function supprimerMonDossier(dossierId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(dossierId)) return { ok: false as const, erreur: "Dossier introuvable." };
  return (await dossiers()).supprimerDossier(p.user.id, dossierId);
}

/** `documents` : la liste JSON des identifiants Drive à ajouter — seuls ceux que la personne peut ouvrir sont gardés. */
export async function ajouterDocumentsAuDossier(dossierId: string, documents: string): Promise<{ ok: true; documents: DocumentDuDossier[]; refuses: number } | Echec> {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(dossierId)) return { ok: false, erreur: "Dossier introuvable." };
  let ids: unknown = [];
  try { ids = JSON.parse(typeof documents === "string" ? documents : "[]"); } catch { ids = []; }
  return (await dossiers()).ajouterDocuments(p.user, dossierId, Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
}

export async function retirerDocumentDuDossier(dossierId: string, documentId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(dossierId) || !id(documentId)) return { ok: false as const, erreur: "Dossier introuvable." };
  return (await dossiers()).retirerDocument(p.user.id, dossierId, documentId);
}

// ─────────────────────────────── Les appareils (déconnexion à distance) ───────────────────────────────
//
// La session d'Adventum IA est longue (30 jours, celle de l'ERP) — un téléphone perdu se déconnecte d'ici : la session
// révoquée (`UserSession.revokedAt`) n'est plus honorée par `build` à la requête suivante. Seulement SES sessions.

export interface AppareilConnecte { id: string; appareil: string; derniereFois: string; courant: boolean }

export async function listerMesAppareils(): Promise<{ ok: true; appareils: AppareilConnecte[] } | Echec> {
  const p = await porte(false);
  if (!p.ok) return p;
  const sessions = await prisma.userSession.findMany({
    where: { userId: p.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" }, take: 20,
    select: { id: true, device: true, browser: true, os: true, city: true, lastSeenAt: true },
  });
  return {
    ok: true,
    appareils: sessions.map((s) => ({
      id: s.id,
      appareil: [s.device, s.browser, s.os].filter(Boolean).join(" · ") + (s.city ? ` — ${s.city}` : "") || "Appareil",
      derniereFois: s.lastSeenAt.toISOString(),
      courant: s.id === p.user.sid,
    })),
  };
}

export async function deconnecterMonAppareil(sessionId: string) {
  const p = await porte(true);
  if (!p.ok) return p;
  if (!id(sessionId)) return { ok: false as const, erreur: "Appareil introuvable." };
  const r = await prisma.userSession.updateMany({ where: { id: sessionId, userId: p.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count ? { ok: true as const } : { ok: false as const, erreur: "Appareil introuvable." };
}
