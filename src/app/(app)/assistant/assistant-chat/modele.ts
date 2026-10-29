/**
 * LA CONVERSATION — le modèle de l'écran : un message, une pièce jointe en attente, l'état d'une
 * action proposée, la reprise d'un tour rangé, les amorces et le nettoyage du Markdown résiduel.
 */
import type { ProposedAction, AssistantStreamEvent } from "@/lib/assistant";
import type { WorkspaceComposition } from "@/lib/assistant/workspace/protocol";
import { lireWorkspaceRange, type TourRelu } from "@/lib/assistant/workspace/turn";

/** Pièce jointe en attente d'envoi : fichier local (upload) ou fichier du Drive (référence). */
export type PendingAttach =
  | { id: string; kind: "upload"; name: string; file: File }
  | { id: string; kind: "drive"; name: string; nodeId: string };

/** Lit un fichier local en base64 (sans le préfixe data:) pour l'envoyer à l'action serveur. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export type ActionState = "pending" | "running" | "done" | "cancelled" | "error";

/**
 * UN TOUR RANGÉ REDEVIENT UN TOUR À L'ÉCRAN — la même traduction aux DEUX endroits qui
 * rouvrent une conversation : le premier rendu (fourni par le serveur) et l'ouverture d'un
 * autre fil depuis l'historique. Deux traductions finiraient par diverger, et l'on retrouverait
 * son écran ou son texte seul selon le chemin emprunté pour y revenir.
 */
export function repriseDuTour(m: TourRelu): Msg {
  const ws = lireWorkspaceRange(m.workspace);
  return { id: nextId(), role: m.role, content: m.content, ...(ws ? { workspace: ws } : {}) };
}

export interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** L'heure du tour, quand elle est connue. Un fil restauré n'en a pas — on n'en invente pas. */
  at?: number;
  attachmentNames?: string[];
  trace?: string[];
  /** Les actions proposées dans CE tour (souvent une, parfois plusieurs — « crée les trois tâches »). */
  proposals?: ProposedAction[];
  /** État / résultat / lien PAR action, alignés sur `proposals`. */
  actionStates?: ActionState[];
  actionResults?: (string | undefined)[];
  actionLinks?: (string | undefined)[];
  /**
   * L'ESPACE DE TRAVAIL de ce tour — des blocs TYPÉS bâtis par le serveur à partir d'une
   * source canonique. Ils restent attachés au message : remonter dans la conversation
   * redonne le tableau, il ne se volatilise pas au tour suivant.
   */
  workspace?: WorkspaceComposition[];
}

export const SUGGESTIONS = [
  "Où en suis-je ? Résume mon espace de travail.",
  "Crée une tâche : préparer le dossier AMM pour vendredi.",
  "Demande à l'assistante de direction un billet Alger → Paris du 12 au 14 mars.",
  "Quels sont mes médecins à fort potentiel ?",
];

export type StreamEvent = AssistantStreamEvent;

let counter = 1;
export const nextId = () => counter++;

/** Nettoie un éventuel Markdown résiduel (l'assistant doit répondre en texte simple). */
export function cleanReply(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")        // **gras**
    .replace(/__(.+?)__/g, "$1")              // __gras__
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")    // `code`
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")        // # titres
    .replace(/^(\s*)[*]\s+/gm, "$1- ")          // puces * → -
    .trim();
}
