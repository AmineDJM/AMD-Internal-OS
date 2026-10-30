import type { AssistantIaFil, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { genererTexte } from "../generer";
import { auNomDe } from "../consommation";
import { censurerTexte, sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import {
  CONSIGNE_TITRE, extraitAutour, limitePurgePrivees, nettoyerTitre, refusChangerPrive, termeDeRecherche, TITRE_DEFAUT,
  type ConversationResumee,
} from "../../domaine/conversations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSATIONS DE L'ASSISTANT IA — CÔTÉ BASE (décision 0027, Adventum IA, 30/10/2026).
 *
 * Une conversation est un fil (`AssistantIaFil`) : ses tours, son résumé roulant (J4), sa prise. Chaque geste porte
 * la personne dans son `where` — un identifiant reçu qui n'est pas le sien ne donne rien. L'ERP (`/assistant`) et
 * l'app Adventum IA lisent les MÊMES conversations par ce service : il n'y a qu'une implémentation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Resultat<T = object> = ({ ok: true } & T) | { ok: false; erreur: string };
const INTROUVABLE = { ok: false as const, erreur: "Conversation introuvable." };
const EN_COURS = ["EN_ATTENTE", "EN_COURS"];

export function resumerConversation(f: Pick<AssistantIaFil, "id" | "titre" | "prive" | "epingleLe" | "archiveLe" | "dossierId" | "dernierLe">): ConversationResumee {
  return {
    id: f.id, titre: f.titre ?? TITRE_DEFAUT, prive: f.prive, epingle: !!f.epingleLe, archive: !!f.archiveLe,
    dossierId: f.dossierId, dernierLe: f.dernierLe.toISOString(),
  };
}

/** La conversation de CETTE personne, ou `null` (jamais celle d'un collègue). */
export function conversationDe(userId: string, id: string | null | undefined) {
  if (typeof id !== "string" || !id || id.length > 64) return Promise.resolve(null);
  return prisma.assistantIaFil.findFirst({ where: { id, userId } });
}

/**
 * La conversation COURANTE quand l'écran n'en nomme aucune (anciens liens, ancien écran) : la plus récente, ni
 * archivée ni privée ; créée si la personne n'en a aucune. C'était « le » fil d'avant la décision 0027.
 */
export async function conversationCourante(userId: string): Promise<AssistantIaFil> {
  const derniere = await prisma.assistantIaFil.findFirst({
    where: { userId, archiveLe: null, prive: false },
    orderBy: { dernierLe: "desc" },
  });
  return derniere ?? prisma.assistantIaFil.create({ data: { userId } });
}

export async function listerConversations(userId: string, opts: { archivees?: boolean } = {}): Promise<ConversationResumee[]> {
  const fils = await prisma.assistantIaFil.findMany({
    where: { userId, archiveLe: opts.archivees ? { not: null } : null },
    orderBy: { dernierLe: "desc" },
    take: 300,
  });
  // Une conversation créée mais jamais commencée ne pèse pas dans la liste (l'écran la tient tant qu'elle est ouverte).
  const commencees = new Set((await prisma.assistantIaTour.groupBy({
    by: ["filId"], where: { filId: { in: fils.map((f) => f.id) } }, _count: { _all: true },
  })).map((g) => g.filId));
  return fils.filter((f) => commencees.has(f.id) || f.titre).map(resumerConversation);
}

export async function creerConversation(userId: string, opts: { prive?: boolean; dossierId?: string | null } = {}): Promise<Resultat<{ conversation: ConversationResumee }>> {
  let dossierId: string | null = null;
  if (opts.dossierId) {
    const d = await prisma.assistantIaDossier.findFirst({ where: { id: opts.dossierId, userId }, select: { id: true } });
    if (!d) return { ok: false, erreur: "Dossier introuvable." };
    dossierId = d.id;
  }
  // L'option « réponse vocale » est un réglage de la personne : la nouvelle conversation la reprend.
  const courante = await prisma.assistantIaFil.findFirst({ where: { userId }, orderBy: { dernierLe: "desc" }, select: { reponseVocale: true } });
  const f = await prisma.assistantIaFil.create({ data: { userId, prive: opts.prive === true, dossierId, reponseVocale: courante?.reponseVocale ?? false } });
  return { ok: true, conversation: resumerConversation(f) };
}

export async function renommerConversation(userId: string, id: string, titre: string): Promise<Resultat> {
  const t = nettoyerTitre(titre);
  if (!t) return { ok: false, erreur: "Donnez un titre à la conversation." };
  const r = await prisma.assistantIaFil.updateMany({ where: { id, userId }, data: { titre: t, titreSource: "manuel" } });
  return r.count ? { ok: true } : INTROUVABLE;
}

export async function epinglerConversation(userId: string, id: string, epingle: boolean): Promise<Resultat> {
  const r = await prisma.assistantIaFil.updateMany({ where: { id, userId }, data: { epingleLe: epingle ? new Date() : null } });
  return r.count ? { ok: true } : INTROUVABLE;
}

export async function archiverConversation(userId: string, id: string, archive: boolean): Promise<Resultat> {
  const r = await prisma.assistantIaFil.updateMany({ where: { id, userId }, data: { archiveLe: archive ? new Date() : null, ...(archive ? { epingleLe: null } : {}) } });
  return r.count ? { ok: true } : INTROUVABLE;
}

/** SUPPRIMER : la conversation et ses tours. Refusé tant que l'assistant y travaille (la réponse s'écrirait dans le vide). */
export async function supprimerConversation(userId: string, id: string): Promise<Resultat> {
  const f = await conversationDe(userId, id);
  if (!f) return INTROUVABLE;
  if (await prisma.assistantIaTour.count({ where: { filId: f.id, etat: { in: EN_COURS } } })) {
    return { ok: false, erreur: "L'assistant travaille encore dans cette conversation : attendez sa réponse avant de la supprimer." };
  }
  await prisma.assistantIaFil.deleteMany({ where: { id: f.id, userId } });
  return { ok: true };
}

/** PRIVÉE : réglable tant que la conversation n'a aucun message — ensuite, verrouillée (décision 0027, point 4). */
export async function reglerPrive(userId: string, id: string, prive: boolean): Promise<Resultat> {
  const f = await conversationDe(userId, id);
  if (!f) return INTROUVABLE;
  if (f.prive === prive) return { ok: true };
  const refus = refusChangerPrive(await prisma.assistantIaTour.count({ where: { filId: f.id } }));
  if (refus) return { ok: false, erreur: refus };
  // Garde contre la course : un message déposé entre le compte et l'écriture verrouille quand même.
  const r = await prisma.assistantIaFil.updateMany({ where: { id: f.id, userId, tours: { none: {} } }, data: { prive } });
  return r.count ? { ok: true } : { ok: false, erreur: refusChangerPrive(1)! };
}

export async function rangerConversation(userId: string, id: string, dossierId: string | null): Promise<Resultat> {
  if (dossierId) {
    const d = await prisma.assistantIaDossier.findFirst({ where: { id: dossierId, userId }, select: { id: true } });
    if (!d) return { ok: false, erreur: "Dossier introuvable." };
  }
  const r = await prisma.assistantIaFil.updateMany({ where: { id, userId }, data: { dossierId } });
  return r.count ? { ok: true } : INTROUVABLE;
}

/**
 * RECHERCHER dans SES conversations — titres et contenu des messages (insensible à la casse). Les conversations
 * privées en sont, pour la personne elle-même (elle les voit dans sa liste) ; jamais pour le modèle (`chercherPourModele`).
 */
export async function rechercherConversations(userId: string, brut: string): Promise<ConversationResumee[]> {
  const terme = termeDeRecherche(brut);
  if (!terme) return [];
  const [parTitre, parContenu] = await Promise.all([
    prisma.assistantIaFil.findMany({ where: { userId, titre: { contains: terme, mode: "insensitive" } }, orderBy: { dernierLe: "desc" }, take: 30 }),
    prisma.assistantIaTour.findMany({
      where: { userId, contenu: { contains: terme, mode: "insensitive" } },
      orderBy: { createdAt: "desc" }, take: 60, select: { filId: true, contenu: true, role: true },
    }),
  ]);
  const extraits = new Map<string, string>();
  for (const t of parContenu) {
    if (extraits.has(t.filId)) continue;
    extraits.set(t.filId, extraitAutour(t.role === "assistant" ? sansValeursRevelees(t.contenu) : t.contenu, terme));
  }
  const ids = new Set(parTitre.map((f) => f.id));
  const autres = await prisma.assistantIaFil.findMany({ where: { userId, id: { in: [...extraits.keys()].filter((x) => !ids.has(x)) } }, orderBy: { dernierLe: "desc" } });
  return [...parTitre, ...autres].map((f) => ({ ...resumerConversation(f), ...(extraits.has(f.id) ? { extrait: extraits.get(f.id) } : {}) }));
}

/**
 * LA MÉMOIRE DES CONVERSATIONS PASSÉES, POUR LE MODÈLE (outil `chercher_conversations`) : seulement celles de la
 * personne, JAMAIS une conversation privée, jamais celle en cours ; texte filtré (une valeur révélée redevient
 * « [confidentiel] », une donnée sensible saisie est masquée).
 */
export async function chercherPourModele(userId: string, brut: string, sauf: string | null): Promise<{ titre: string; date: string; extrait: string }[]> {
  const terme = termeDeRecherche(brut);
  if (!terme) return [];
  const tours = await prisma.assistantIaTour.findMany({
    where: {
      userId, contenu: { contains: terme, mode: "insensitive" }, etat: { in: ["TRAITE", "TERMINE"] },
      fil: { prive: false, ...(sauf ? { id: { not: sauf } } : {}) },
    },
    orderBy: { createdAt: "desc" }, take: 12,
    select: { contenu: true, role: true, createdAt: true, fil: { select: { titre: true } } },
  });
  return tours.slice(0, 8).map((t) => ({
    titre: t.fil.titre ?? TITRE_DEFAUT,
    date: t.createdAt.toISOString().slice(0, 10),
    extrait: censurerTexte(extraitAutour(t.role === "assistant" ? sansValeursRevelees(t.contenu) : t.contenu, terme, 160)).texte,
  }));
}

/** Un message déposé : la conversation remonte en tête, et reçoit son titre provisoire si elle n'en a pas. */
export async function marquerActivite(filId: string, titreSiAucun: string): Promise<void> {
  await prisma.assistantIaFil.update({ where: { id: filId }, data: { dernierLe: new Date(), consulteLe: new Date() } });
  await prisma.assistantIaFil.updateMany({ where: { id: filId, titre: null }, data: { titre: titreSiAucun, titreSource: "provisoire" } });
}

/**
 * LE TITRE PROPOSÉ (modèle RAPIDE, après la première réponse) : remplace le titre provisoire, jamais un titre que la
 * personne a choisi. Une panne laisse le provisoire. Ne lève jamais.
 */
export async function proposerTitre(filId: string): Promise<{ fait: boolean }> {
  try {
    const f = await prisma.assistantIaFil.findUnique({ where: { id: filId } });
    if (!f || f.titreSource === "manuel" || f.titreSource === "auto") return { fait: false };
    const tours = await prisma.assistantIaTour.findMany({
      where: { filId, etat: { in: ["TRAITE", "TERMINE"] } }, orderBy: { createdAt: "asc" }, take: 2, select: { role: true, contenu: true },
    });
    const texte = tours.map((t) => `${t.role === "user" ? "Personne" : "Assistant"} : ${censurerTexte(t.role === "assistant" ? sansValeursRevelees(t.contenu) : t.contenu).texte.slice(0, 600)}`).join("\n");
    if (!texte.trim()) return { fait: false };
    const r = await auNomDe(f.userId, () => genererTexte(CONSIGNE_TITRE, texte, 15_000, { role: "rapide" }), filId);
    const titre = r.ok ? nettoyerTitre(censurerTexte(r.texte).texte) : null;
    if (!titre) return { fait: false };
    const ecrit = await prisma.assistantIaFil.updateMany({ where: { id: filId, titreSource: { in: ["provisoire"] } }, data: { titre, titreSource: "auto" } });
    return { fait: ecrit.count > 0 };
  } catch (e) {
    console.error("[assistant-conversations] titre", filId, e);
    return { fait: false };
  }
}

/** LES CONVERSATIONS PRIVÉES EXPIRÉES (30 jours après leur création) : supprimées, tours compris. */
export async function purgerConversationsPrivees(maintenant = new Date()): Promise<{ supprimees: number }> {
  const limite = limitePurgePrivees(maintenant);
  const where: Prisma.AssistantIaFilWhereInput = { prive: true, createdAt: { lt: limite }, tours: { none: { etat: { in: EN_COURS } } } };
  const r = await prisma.assistantIaFil.deleteMany({ where });
  return { supprimees: r.count };
}
