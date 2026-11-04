import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { aiFeatureEnabled } from "./consommation";
import { jouerTour, type IntentionDuTour } from "./fil/tour";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ENTRÉES D'UN TOUR — UN SEUL MOTEUR (lot I6, décision 0070 ; audit AU3 §1.1 et §4, étape 4).
 *
 * Avant ce lot, cinq entrées du Super Admin faisaient tourner l'ANCIEN moteur (`runAssistant`) : le Bureau d'Adam, l'appel
 * vocal global, la dictée, « Demander » d'Adventum Brain et la relance (nudge). Le Super Admin avait donc deux Adam, sans
 * la même mémoire, ni les mêmes outils, ni les mêmes gardes (S1, K10, garde de vérité P1).
 *
 * Désormais, chacune de ces entrées joue SON tour ici, c'est-à-dire par `jouerTour` : le même catalogue (`outilsV1`, filtré
 * par le `ProfilDAcces` — le Super Admin y trouve ses outils d'Adam, son Gmail, sa mémoire, PAR L'ACCÈS), la même sélection,
 * les mêmes invariants, la même fin de tour (où le contrôle final du lot I5 se pose), la même clé de cache par personne.
 * Une entrée ne change que ce que la personne a dit : elle n'ajoute AUCUNE consigne (ce qui casserait le préfixe stable
 * partagé par toutes les entrées) — le contexte propre à l'entrée (extraits de Brain, messages non lus) voyage dans le
 * message, c'est-à-dire dans la partie variable.
 *
 * Une écriture reste une CARTE persistée (intention, C1) : l'entrée la rend, l'écran la confirme par
 * `confirmerIntentionAssistantIA` — jamais par l'ancienne confirmation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les entrées rebranchées (le journal les nomme ; le moteur, lui, ne les distingue pas). */
export const ENTREES_REBRANCHEES = ["bureau", "brain", "relance", "appel", "dictee"] as const;
export type EntreeDuTour = (typeof ENTREES_REBRANCHEES)[number];

/** Une carte à valider, telle qu'un écran hors conversation l'affiche (et la confirme par l'intention). */
export interface CarteDEntree {
  id: string;
  titre: string;
  champs: { label: string; value: string }[];
  avertissements: string[];
  confirmText?: string;
  libelleBouton?: string;
}

export type ResultatDEntree =
  | { ok: true; reponse: string; cartes: CarteDEntree[]; outils: string[] }
  | { ok: false; erreur: string };

export interface DemandeDEntree {
  texte: string;
  historique?: { role: "user" | "assistant"; content: string }[];
  /** Le message a été dit (dictée, appel) : le moteur le sait. */
  vocal?: boolean;
}

/** Une intention du tour → la carte d'un écran hors conversation. */
export function carteDEntree(i: IntentionDuTour): CarteDEntree {
  return {
    id: i.id, titre: i.title, champs: i.fields ?? [], avertissements: i.warnings ?? [],
    ...(i.confirmText ? { confirmText: i.confirmText } : {}),
    ...(i.libelleBouton ? { libelleBouton: i.libelleBouton } : {}),
  };
}

/**
 * JOUER LE TOUR D'UNE ENTRÉE — `jouerTour`, rien d'autre. La Vue exacte, l'interrupteur, le plafond, les familles et le
 * profil d'accès sont jugés par le moteur, comme pour la conversation écrite.
 */
export async function jouerTourDEntree(user: CurrentUser, entree: EntreeDuTour, d: DemandeDEntree): Promise<ResultatDEntree> {
  const historique = (d.historique ?? [])
    .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .slice(-12);
  const r = await jouerTour(user, { texte: d.texte, pieces: [], historique, vocal: d.vocal === true });
  if (!r.ok) {
    console.info("[assistant-ia] entrée", { entree, ok: false });
    return { ok: false, erreur: r.error };
  }
  console.info("[assistant-ia] entrée", { entree, ok: true, cartes: r.intents.length, outils: r.outilsAppeles.length });
  return { ok: true, reponse: r.content, cartes: r.intents.map(carteDEntree), outils: r.outilsAppeles };
}

/**
 * LA RELANCE DU MOTEUR UNIQUE (ex-`assistantNudge` de l'ancien Adam) — les messages internes NON LUS de la personne, et au
 * plus UNE action utile proposée en carte. Même règle de coût qu'avant : le modèle n'est appelé que si les non-lus ont
 * changé (`signature`) et si la relance est ouverte dans le Centre de contrôle IA (« nudge »). Le tour est `jouerTour` :
 * catalogue filtré par le profil d'accès, gardes, clé de cache de la personne.
 */
export interface ResultatRelance { signature: string; suggestion: { resume: string; carte?: CarteDEntree } | null }

/**
 * LES MESSAGES INTERNES NON LUS DE LA PERSONNE (les 15 plus récents, d'autrui, texte seul) — ce que lisait l'ancienne
 * relance (`lib/assistant-nudge.ts`, côté Adam, intact). Lu ici, dans le module : la frontière 0013 interdit d'importer
 * Adam, et le socle IA ne lit pas la base. `signature` change dès qu'un message arrive : le modèle n'est rappelé qu'alors.
 */
export async function nonLusDe(userId: string): Promise<{ signature: string; nombre: number; texte: string }> {
  const appartenances = await prisma.conversationMember.findMany({ where: { userId }, select: { conversationId: true, lastReadAt: true } });
  if (!appartenances.length) return { signature: "0", nombre: 0, texte: "" };
  const recus = await prisma.message.findMany({
    where: {
      kind: "TEXT", senderId: { not: userId },
      OR: appartenances.map((a) => (a.lastReadAt ? { conversationId: a.conversationId, createdAt: { gt: a.lastReadAt } } : { conversationId: a.conversationId })),
    },
    orderBy: { createdAt: "desc" }, take: 15,
    select: { id: true, body: true, sender: { select: { name: true } }, conversation: { select: { title: true } } },
  });
  if (!recus.length) return { signature: "0", nombre: 0, texte: "" };
  const lignes: string[] = [];
  for (let i = recus.length - 1; i >= 0; i -= 1) {
    const m = recus[i]!;
    lignes.push(`De ${m.sender?.name ?? "?"}${m.conversation?.title ? ` (${m.conversation.title})` : ""} : ${m.body.slice(0, 400)}`);
  }
  return { signature: `${recus.length}:${recus[0]!.id}`, nombre: recus.length, texte: lignes.join("\n") };
}

export async function relanceDuMoteur(user: CurrentUser, signaturePrecedente: string): Promise<ResultatRelance> {
  const digest = await nonLusDe(user.id);
  if (digest.nombre === 0) return { signature: "0", suggestion: null };
  if (digest.signature === signaturePrecedente) return { signature: digest.signature, suggestion: null };
  if (!(await aiFeatureEnabled("nudge"))) return { signature: digest.signature, suggestion: null };
  const texte =
    `Messages internes récents NON LUS reçus par l'utilisateur (analyse le contexte global : plusieurs messages peuvent être liés) :\n\n${digest.texte}\n\n` +
    "S'il y a UNE action concrète et utile à proposer (créer une tâche, répondre à un collègue, créer une demande administrative, envoyer un e-mail…), prépare-la (un seul outil d'écriture). " +
    "Sinon réponds EXACTEMENT « RAS ». Sois bref.";
  const e = await jouerTourDEntree(user, "relance", { texte });
  if (!e.ok) return { signature: digest.signature, suggestion: null };
  const resume = e.reponse.trim();
  const carte = e.cartes[0];
  if (!carte && (!resume || /^ras\b/i.test(resume))) return { signature: digest.signature, suggestion: null };
  return { signature: digest.signature, suggestion: { resume: resume || "J'ai repéré une action possible à partir de vos messages.", ...(carte ? { carte } : {}) } };
}
