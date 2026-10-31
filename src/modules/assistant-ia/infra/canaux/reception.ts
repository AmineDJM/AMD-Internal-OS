import { Prisma, type AssistantIaAttentePieces } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { getAppSettings } from "@/lib/settings";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { proprietaire } from "@/platform/ia/proprietaire";
import {
  ACCUSE_WHATSAPP, attentePourCanal, canauxAttendus, categorieProposee, cleTelephone, DESCRIPTION_MAX, dureeAttenteHeures, expirationAttente,
  LIBELLE_CANAL, masquerExpediteur, messageDeReception, pieceConfidentielle, REFUS_INCONNU_WHATSAPP, refusPieceRecue,
  type CanalEntrant,
} from "../../domaine/canaux/attentes";
import { deposerAudio } from "../lecture/voix";
import { conversationDe, conversationCourante } from "../conversations/service";
import { preparerCarte } from "../operations";
import { estNatureDemande, ficheVisible, trouverDemande } from "../operations/demandes-visibles";
import { detecterInjection } from "../../domaine/provenance-tierce";
import { notifierConversation } from "../fil/service";
import { attentesVivantes } from "./section";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES REÇUES PAR WHATSAPP ET PAR MAIL (lot K6, décision 0036) — le serveur.
 *
 *   • OUVRIR UNE ATTENTE (`ouvrirAttente`) — l'outil `attendre_pieces`, à l'écrit comme à la voix (la voix délègue au
 *     fil) : la fiche visée est RÉSOLUE sous les droits de la personne (une demande invisible n'est jamais nommée).
 *   • RECEVOIR (`recevoirPieces`) — appelé par les webhooks (WhatsApp, mail de l'assistant) et par l'ingestion Gmail :
 *     idempotence (journal unique par canal + message), personne reconnue, gardes (accès, expéditeur automatique,
 *     taille, format, injection), dépôt au Drive PRIVÉ de la personne, puis la conversation : sa pièce, et la réponse
 *     de l'assistant — avec la CARTE de rangement quand une attente nomme la fiche. Rien ne s'écrit dans l'ERP sans
 *     la confirmation. La personne est notifiée.
 *   • LE CONTEXTE (`sectionAttentesDuTour`) : une section de la consigne SEULEMENT quand une attente est ouverte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DOSSIER_PIECES_RECUES = "Assistant IA — pièces reçues";
const ATTENTES_OUVERTES_MAX = 5;

type Resultat<T> = T | { manque: string } | { erreur: string };

export interface DemandeAttente {
  description: string;
  canaux?: unknown;
  demande?: string;
  natureDemande?: string;
  typeFiche?: string;
  idFiche?: string;
  categorie?: string;
  origine?: "ECRIT" | "VOIX" | "ASSISTANT";
  conversation?: string | null;
}

/** OUVRIR une attente de pièces — la fiche visée résolue sous les droits de la personne. */
export async function ouvrirAttente(user: CurrentUser, d: DemandeAttente, maintenant = new Date()): Promise<Resultat<AssistantIaAttentePieces>> {
  const description = (d.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX);
  if (!description) return { manque: "ce qui est attendu (« lettre de demande du Dr X »)" };
  let cible: { type: string; id: string; libelle: string; lien: string | null } | null = null;
  if (d.demande?.trim()) {
    const r = await trouverDemande(user, d.demande, d.natureDemande ?? "");
    if ("manque" in r) return r;
    cible = { type: r.nature, id: r.id, libelle: r.libelle, lien: r.lien };
  } else if (d.typeFiche?.trim() && d.idFiche?.trim()) {
    const t = d.typeFiche.trim().toUpperCase();
    const libelle = ENTITY_TYPE_LABELS[t as keyof typeof ENTITY_TYPE_LABELS];
    if (!libelle) return { manque: `le type de la fiche (« ${d.typeFiche} » inconnu)` };
    if (!estNatureDemande(t) && !(await ficheVisible(user, t, d.idFiche.trim()))) return { erreur: "Cette fiche ne vous est pas accessible." };
    cible = { type: t, id: d.idFiche.trim(), libelle: `${libelle} ${d.idFiche.trim()}`, lien: null };
  }
  let filId: string | null = null;
  if (d.conversation) filId = (await conversationDe(user.id, d.conversation))?.id ?? null;
  // Pas plus de cinq attentes ouvertes : la plus ancienne est close (une attente oubliée ne s'accumule pas).
  const ouvertes = await prisma.assistantIaAttentePieces.findMany({ where: { userId: user.id, etat: "OUVERTE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (ouvertes.length >= ATTENTES_OUVERTES_MAX) {
    await prisma.assistantIaAttentePieces.updateMany({ where: { id: { in: ouvertes.slice(0, ouvertes.length - ATTENTES_OUVERTES_MAX + 1).map((o) => o.id) } }, data: { etat: "CLOSE" } });
  }
  return prisma.assistantIaAttentePieces.create({
    data: {
      userId: user.id, filId, description, canaux: canauxAttendus(d.canaux),
      cibleType: cible?.type ?? null, cibleId: cible?.id ?? null, cibleLibelle: cible?.libelle ?? null, cibleLien: cible?.lien ?? null,
      categorie: categorieProposee(description, d.categorie), origine: d.origine ?? "ECRIT",
      expireLe: expirationAttente(maintenant, dureeAttenteHeures(process.env.ASSISTANT_IA_ATTENTE_HEURES)),
    },
  });
}

/** Annuler les attentes ouvertes de la personne (« laisse tomber, je ne l'enverrai pas »). */
export async function annulerAttentes(userId: string): Promise<number> {
  const r = await prisma.assistantIaAttentePieces.updateMany({ where: { userId, etat: { in: ["OUVERTE", "RECUE"] } }, data: { etat: "ANNULEE" } });
  return r.count;
}


/** Une attente rattachable pour ce canal ? (la boîte Gmail ne remet une pièce à l'assistant QUE dans ce cas). */
export async function attenteOuvertePour(userId: string, canal: CanalEntrant, maintenant = new Date()): Promise<boolean> {
  return !!attentePourCanal(await attentesVivantes(userId, maintenant), canal, maintenant);
}

// ─────────────────────────────── La réception ───────────────────────────────

export interface FichierRecu {
  nom: string; mime: string | null; octets: Buffer | null; taille: number | null;
  /** Pourquoi le contenu manque (`octets` nul) : téléchargement refusé, trop volumineux… */
  raison?: string | null;
}

export interface EntreeReception {
  canal: CanalEntrant;
  /** L'identifiant du message chez le fournisseur : la clé d'idempotence. */
  idExterne: string;
  /** Le numéro (WhatsApp) ou l'adresse (mail) de l'expéditeur. */
  expediteur: string;
  /** Déjà connu (boîte Gmail connectée du dirigeant). */
  userId?: string | null;
  /** La légende (WhatsApp) ou l'objet (mail) — contenu NON FIABLE. */
  texte?: string | null;
  /** Les pièces — ou leur CHARGEMENT, appelé seulement une fois la personne reconnue (un inconnu ne fait rien télécharger). */
  fichiers: FichierRecu[] | (() => Promise<FichierRecu[]>);
  /** Un auto-répondeur, une liste, un rejet de remise : jamais traité. */
  automatique?: boolean;
}

export type IssueReception =
  | "RECUE" | "DOUBLON" | "REFUS_INCONNU" | "REFUS_ACCES" | "REFUS_AUTOMATIQUE" | "SANS_PIECE" | "REFUS_TAILLE" | "ERREUR";

export interface ResultatReception {
  issue: IssueReception;
  /** Ce qu'on peut répondre à l'expéditeur (WhatsApp) — jamais un détail interne. */
  reponse: string | null;
  userId?: string;
  conversation?: string;
  tourId?: string;
  intentId?: string;
}

/** La personne derrière un numéro : fiche utilisateur, sinon fiche employé liée à un compte. Deux candidats : personne. */
export async function personneParTelephone(numero: string): Promise<string | null> {
  const cle = cleTelephone(numero);
  if (!cle) return null;
  // Les numéros sont saisis librement (« 0555 12 34 56 ») : comparés par leur clé, pas par une sous-chaîne.
  const [users, employes] = await Promise.all([
    prisma.user.findMany({ where: { phone: { not: null }, isActive: true }, select: { id: true, phone: true } }),
    prisma.employee.findMany({ where: { phone: { not: null }, userId: { not: null } }, select: { userId: true, phone: true } }),
  ]);
  const ids = new Set<string>();
  for (const u of users) if (cleTelephone(u.phone) === cle) ids.add(u.id);
  for (const e of employes) if (e.userId && cleTelephone(e.phone) === cle) ids.add(e.userId);
  return ids.size === 1 ? [...ids][0]! : null;
}

export async function personneParAdresse(adresse: string): Promise<string | null> {
  const a = adresse.trim().toLowerCase();
  if (!a.includes("@")) return null;
  const u = await prisma.user.findFirst({ where: { email: { equals: a, mode: "insensitive" }, isActive: true }, select: { id: true } });
  return u?.id ?? null;
}

const cleDe = (id: string, i: number) => (i === 0 ? id : `${id}#${i}`).slice(0, 300);

/**
 * RECEVOIR LES PIÈCES D'UN MESSAGE. Ne lève jamais : chaque issue est journalisée et rendue.
 */
export async function recevoirPieces(e: EntreeReception, maintenant = new Date()): Promise<ResultatReception> {
  const idExterne = e.idExterne.trim();
  if (!idExterne) return { issue: "ERREUR", reponse: null };
  const masque = masquerExpediteur(e.expediteur);
  // 1. LA PRISE (idempotence) : la ligne du message est créée d'abord ; une relivraison bute sur l'unicité.
  let journal;
  try {
    // Le cas courant d'une relivraison, lu d'abord (sans bruit au journal) ; la contrainte tient la course.
    if (await prisma.assistantIaReception.findUnique({ where: { canal_idExterne: { canal: e.canal, idExterne: cleDe(idExterne, 0) } }, select: { id: true } })) {
      return { issue: "DOUBLON", reponse: null };
    }
    journal = await prisma.assistantIaReception.create({ data: { canal: e.canal, idExterne: cleDe(idExterne, 0), expediteur: masque, issue: "EN_COURS" } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { issue: "DOUBLON", reponse: null };
    console.error("[assistant-ia canaux] journal", err);
    return { issue: "ERREUR", reponse: null };
  }
  const clore = (issue: IssueReception, data: Prisma.AssistantIaReceptionUpdateInput = {}) =>
    prisma.assistantIaReception.update({ where: { id: journal.id }, data: { issue, ...data } }).catch(sansBloquer("canaux.recevoir.journal"));

  try {
    // 2. LA PERSONNE : par son numéro ou son adresse. Inconnue : refus poli, rien n'est stocké.
    const userId = e.userId ?? (e.canal === "WHATSAPP" ? await personneParTelephone(e.expediteur) : await personneParAdresse(e.expediteur));
    if (!userId) {
      await clore("REFUS_INCONNU", { raison: "expéditeur non reconnu" });
      return { issue: "REFUS_INCONNU", reponse: e.canal === "WHATSAPP" ? REFUS_INCONNU_WHATSAPP : null };
    }
    const user = await proprietaire(userId);
    if (!user || !peutUtiliserAssistantIA(user)) {
      await clore("REFUS_ACCES", { userId, raison: "Assistant IA non ouvert à ce compte" });
      return { issue: "REFUS_ACCES", reponse: "Votre compte n'a pas accès à l'Assistant IA : rien n'a été enregistré.", userId };
    }
    if (e.automatique) {
      await clore("REFUS_AUTOMATIQUE", { userId, raison: "expéditeur automatique" });
      return { issue: "REFUS_AUTOMATIQUE", reponse: null, userId };
    }
    const fichiers = typeof e.fichiers === "function" ? await e.fichiers() : e.fichiers;
    if (!fichiers.length) {
      await clore("SANS_PIECE", { userId });
      return { issue: "SANS_PIECE", reponse: "Je reçois ici les pièces jointes (document, photo). Pour me parler, utilisez l'Assistant IA.", userId };
    }
    return await deposerEtAnnoncer(user, { ...e, fichiers }, journal.id, maintenant);
  } catch (err) {
    console.error("[assistant-ia canaux] réception", e.canal, err);
    await clore("ERREUR", { raison: (err instanceof Error ? err.message : "erreur").slice(0, 300) });
    return { issue: "ERREUR", reponse: null };
  }
}

async function deposerEtAnnoncer(user: CurrentUser, e: EntreeReception & { fichiers: FichierRecu[] }, journalId: string, maintenant: Date): Promise<ResultatReception> {
  const reglages = await getAppSettings();
  const maxMo = reglages.maxDriveUploadMb;
  const attentes = await attentesVivantes(user.id, maintenant);
  const attente = attentePourCanal(attentes, e.canal, maintenant);
  // Le texte joint (légende, objet) est un contenu NON FIABLE : des consignes adressées à l'assistant le font écarter.
  const injection = detecterInjection(e.texte ?? "").length > 0;

  // 3. LE DÉPÔT : chaque pièce au Drive PRIVÉ de la personne (quotas, format, taille) ; un refus se dit, sans bloquer les autres.
  const gardees: { id: string; nom: string; mime: string | null; taille: number; confidentiel: boolean }[] = [];
  const refusees: string[] = [];
  for (const [i, f] of e.fichiers.slice(0, 10).entries()) {
    const confidentiel = pieceConfidentielle(f.nom, attente?.cibleType);
    const ligne = { userId: user.id, nom: f.nom, mime: f.mime, taille: f.taille ?? f.octets?.length ?? null, attenteId: attente?.id ?? null, confidentiel, injection };
    const journaliser = (issue: IssueReception, data: Record<string, unknown>) => (i === 0
      ? prisma.assistantIaReception.update({ where: { id: journalId }, data: { ...ligne, issue, ...data } })
      : prisma.assistantIaReception.create({ data: { canal: e.canal, idExterne: cleDe(e.idExterne, i), expediteur: masquerExpediteur(e.expediteur), ...ligne, issue, ...data } })
    ).catch(sansBloquer("canaux.deposer.journal"));
    if (!f.octets) {
      const raison = f.raison?.trim() || "contenu non transmis par le fournisseur";
      refusees.push(`« ${f.nom} » (${raison})`);
      await journaliser(/volumineux/.test(raison) ? "REFUS_TAILLE" : "ERREUR", { raison: raison.slice(0, 300) });
      continue;
    }
    const refus = refusPieceRecue(f.nom, f.octets.length, maxMo);
    if (refus) {
      refusees.push(`« ${f.nom} » (${refus})`);
      await journaliser("REFUS_TAILLE", { raison: refus.slice(0, 300) });
      continue;
    }
    const d = await deposerAudio(user, f.octets, f.nom, f.mime || "application/octet-stream", DOSSIER_PIECES_RECUES);
    if ("erreur" in d) {
      refusees.push(`« ${f.nom} » (${d.erreur})`);
      await journaliser("REFUS_TAILLE", { raison: d.erreur.slice(0, 300) });
      continue;
    }
    gardees.push({ id: d.id, nom: f.nom, mime: f.mime, taille: f.octets.length, confidentiel });
    await journaliser("RECUE", { driveNodeId: d.id });
  }

  // 4. LA CONVERSATION : celle de l'attente, sinon la courante. La pièce y entre comme un message de la personne.
  const fil = (attente?.filId ? await conversationDe(user.id, attente.filId) : null) ?? (await conversationCourante(user.id));
  const canal = LIBELLE_CANAL[e.canal];
  const legende = (e.texte ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const dit = injection ? "[texte joint écarté : consignes suspectes]" : legende ? `« ${legende} »` : "";
  const question = await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: user.id, role: "user", etat: "TRAITE",
      contenu: `[Reçu par ${canal}${e.canal === "WHATSAPP" ? "" : ` de ${e.expediteur}`}]${dit ? ` ${dit}` : ""}`.slice(0, 1_000),
      ...(gardees.length ? { pieces: gardees.map((g) => ({ id: g.id, nom: g.nom })) as Prisma.InputJsonValue } : {}),
    },
  });

  // 5. LA CARTE DE RANGEMENT — quand l'attente nomme la fiche. Préparée par le même `proposer` que l'outil du modèle.
  let intent: Record<string, unknown> | null = null;
  let refusCarte: string | null = null;
  if (attente?.cibleType && attente.cibleId && gardees.length) {
    const confidentiel = gardees.some((g) => g.confidentiel);
    const c = await preparerCarte(user, "preparer_depot_piece", {
      typeFiche: attente.cibleType, idFiche: attente.cibleId, pieces: gardees.map((g) => g.id).join(","),
      categorie: attente.categorie ?? "", ...(confidentiel ? { confidentiel: "oui" } : {}),
    });
    if ("carte" in c) {
      intent = {
        id: c.carte.intentId, kind: c.carte.kind, title: c.carte.title, fields: c.carte.fields,
        ...(c.carte.warnings.length ? { warnings: c.carte.warnings } : {}), status: "PROPOSED",
      };
    } else refusCarte = "manque" in c ? c.manque.join(", ") : c.erreur;
  }
  const contenu = [
    messageDeReception({
      canal: e.canal, noms: gardees.map((g) => g.nom), description: attente?.description ?? null,
      cibleLibelle: attente?.cibleLibelle ?? null, carte: !!intent, confidentiel: gardees.some((g) => g.confidentiel), refusees,
    }),
    refusCarte ? `Je n'ai pas pu préparer le rangement : ${refusCarte}.` : null,
  ].filter(Boolean).join("\n");
  const reponse = await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: user.id, role: "assistant", etat: "TERMINE", repondA: question.id, contenu,
      ...(intent ? { intent: intent as Prisma.InputJsonValue } : {}),
    },
  });
  await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { dernierLe: new Date() } });
  if (attente && gardees.length) {
    await prisma.assistantIaAttentePieces.update({ where: { id: attente.id }, data: { etat: "RECUE", recueLe: attente.recueLe ?? maintenant } });
  }
  await prisma.assistantIaReception.updateMany({
    where: { canal: e.canal, idExterne: { in: e.fichiers.map((_, i) => cleDe(e.idExterne, i)) } },
    data: { filId: fil.id, tourId: question.id, intentId: (intent?.id as string | undefined) ?? null },
  }).catch(sansBloquer("canaux.deposer.journal-fil"));

  // 6. NOTIFIER — jamais le contenu de la pièce, seulement son nom et la question.
  await notifierConversation(user.id, fil.id, gardees.length ? `Assistant IA : pièce reçue par ${canal}` : `Assistant IA : pièce non reçue (${canal})`, contenu);

  if (!gardees.length) return { issue: "REFUS_TAILLE", reponse: `Pièce non enregistrée : ${refusees.join(" ; ")}`.slice(0, 900), userId: user.id, conversation: fil.id, tourId: reponse.id };
  return {
    issue: "RECUE", reponse: ACCUSE_WHATSAPP, userId: user.id, conversation: fil.id, tourId: reponse.id,
    ...(intent?.id ? { intentId: intent.id as string } : {}),
  };
}
