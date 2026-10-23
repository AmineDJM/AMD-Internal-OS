import type { Priority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import type { PowerTool } from "@/lib/assistant/power-tools";
import {
  persistActionIntents,
  executeIntentGuarded,
  type IntentSeed,
  type IntentExecuteResult,
} from "@/lib/assistant/action-intents";
import { createTaskRecord } from "@/lib/tasks/create-core";
import { findDirectConversation } from "@/lib/messaging";

/**
 * ACTIONS D'ÉCRITURE SÉCURISÉES DE L'ASSISTANT — Jalon 5 (Décisions Q7 & Q8).
 *
 * Principes stricts :
 * 1. Zéro écriture directe en base depuis le modèle : l'outil ne fait que PRÉPARER une intention
 *    d'action (`AssistantActionIntent`, état PROPOSED) matérialisée par une carte de confirmation.
 * 2. L'exécution effective n'a lieu qu'après un clic de confirmation de l'utilisateur (ou décision UI),
 *    protégée par la machine d'état serveur idempotente (`executeIntentGuarded`).
 * 3. Tranche V1 : Deux écritures confirmées :
 *    - `create_task` (créer une tâche / assigner une demande)
 *    - `send_message` (envoyer un message interne)
 */

export interface PayloadCreerTache {
  title: string;
  assignedToId?: string | null;
  priority?: Priority | null;
  dueDate?: string | null;
  description?: string | null;
}

export interface PayloadEnvoyerMessage {
  destinataireId: string;
  body: string;
}

/**
 * Outil 1 : Proposer la création d'une tâche.
 */
export const outilCreerTache: PowerTool = {
  def: {
    name: "create_task",
    description:
      "Prépare la création d'une tâche ou d'une demande. Soumis obligatoirement à validation par l'utilisateur.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Intitulé clair et précis de la tâche." },
        assignedToId: {
          type: "string",
          description: "ID de la personne à qui confier la tâche. Si omis, s'assigne à l'utilisateur courant.",
        },
        priority: {
          type: "string",
          enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
          description: "Niveau de priorité (défaut MEDIUM).",
        },
        dueDate: {
          type: "string",
          description: "Date d'échéance souhaitée (format AAAA-MM-JJ).",
        },
        description: {
          type: "string",
          description: "Détails ou consignes complémentaires.",
        },
      },
      required: ["title"],
    },
  } as PowerTool["def"],

  allowed: (user: CurrentUser) => userCan(user, "WORKSPACE", "CREATE"),
  refus: "Vous n'avez pas les droits nécessaires pour créer des tâches.",
  label: "Préparation d'une tâche",

  run: async (entree: Record<string, unknown>, user: CurrentUser) => {
    const title = String(entree.title ?? "").trim();
    if (!title) return JSON.stringify({ error: "Le titre de la tâche est obligatoire." });

    const assignedToId = (entree.assignedToId ? String(entree.assignedToId) : user.id).trim();
    const priority = (entree.priority ? String(entree.priority) : "MEDIUM") as Priority;
    const dueDateStr = entree.dueDate ? String(entree.dueDate) : null;
    const description = entree.description ? String(entree.description).trim() : null;

    // Résolution du destinataire pour l'affichage
    let destinataireNom = "Vous-même";
    if (assignedToId && assignedToId !== user.id) {
      const destinataire = await prisma.user.findUnique({
        where: { id: assignedToId },
        select: { name: true },
      });
      if (destinataire) destinataireNom = destinataire.name;
    }

    const payload: PayloadCreerTache = {
      title,
      assignedToId,
      priority,
      dueDate: dueDateStr,
      description,
    };

    const seed: IntentSeed = {
      kind: "create_task",
      module: "WORKSPACE",
      title: `Créer la tâche : "${title}"`,
      fields: [
        { label: "Titre", value: title },
        { label: "Assignée à", value: destinataireNom },
        { label: "Priorité", value: priority },
        ...(dueDateStr ? [{ label: "Échéance", value: dueDateStr }] : []),
      ],
      level: "SENSITIVE",
      payload,
    };

    const ids = await persistActionIntents(user.id, [seed], "text");
    const intentId = ids[0];

    return JSON.stringify({
      statut: "PROPOSITION_CREEE",
      intentId,
      titre: title,
      assigneA: destinataireNom,
      message: `La tâche « ${title} » (pour ${destinataireNom}) a été préparée. Une carte de confirmation est soumise à votre validation avant création effective.`,
    });
  },
};

/**
 * Outil 2 : Proposer l'envoi d'un message interne.
 */
export const outilEnvoyerMessage: PowerTool = {
  def: {
    name: "send_message",
    description:
      "Prépare l'envoi d'un message interne à un collègue. Soumis obligatoirement à validation par l'utilisateur.",
    input_schema: {
      type: "object",
      properties: {
        destinataireId: {
          type: "string",
          description: "Identifiant unique (ID) du destinataire.",
        },
        body: {
          type: "string",
          description: "Contenu du message à envoyer.",
        },
      },
      required: ["destinataireId", "body"],
    },
  } as PowerTool["def"],

  allowed: (user: CurrentUser) => userCan(user, "MESSAGING", "CREATE"),
  refus: "La messagerie interne ne vous est pas ouverte en écriture.",
  label: "Préparation d'un message",

  run: async (entree: Record<string, unknown>, user: CurrentUser) => {
    const destinataireId = String(entree.destinataireId ?? "").trim();
    const body = String(entree.body ?? "").trim();

    if (!destinataireId) return JSON.stringify({ error: "L'identifiant du destinataire est requis." });
    if (!body) return JSON.stringify({ error: "Le corps du message ne peut pas être vide." });

    const destinataire = await prisma.user.findUnique({
      where: { id: destinataireId },
      select: { id: true, name: true, isActive: true },
    });

    if (!destinataire || !destinataire.isActive) {
      return JSON.stringify({ error: "Destinataire introuvable ou inactif." });
    }

    const payload: PayloadEnvoyerMessage = {
      destinataireId: destinataire.id,
      body,
    };

    const seed: IntentSeed = {
      kind: "send_message",
      module: "MESSAGING",
      title: `Message pour ${destinataire.name}`,
      fields: [
        { label: "Destinataire", value: destinataire.name },
        { label: "Contenu", value: body.slice(0, 100) + (body.length > 100 ? "…" : "") },
      ],
      level: "SENSITIVE",
      payload,
    };

    const ids = await persistActionIntents(user.id, [seed], "text");
    const intentId = ids[0];

    return JSON.stringify({
      statut: "PROPOSITION_CREEE",
      intentId,
      destinataire: destinataire.name,
      message: `Le message à destination de ${destinataire.name} a été préparé. Une carte de confirmation est affichée pour validation avant l'envoi.`,
    });
  },
};

/**
 * Exécute une action après confirmation humaine via son intention d'action (Intent).
 * Seul ce point d'entrée réalise l'écriture effective en base, avec dédoublonnage strict.
 */
export async function executerActionConfirmee(
  intentId: string,
  user: CurrentUser
): Promise<IntentExecuteResult> {
  const resultat = await executeIntentGuarded(user, intentId, async (payloadBrut) => {
    const payload = payloadBrut as Record<string, unknown>;

    // Vérification de la nature de l'action
    if ("title" in payload && "assignedToId" in payload) {
      // Cas 1 : Création de tâche via le cœur canonique
      const p = payload as unknown as PayloadCreerTache;
      const created = await createTaskRecord(
        user.id,
        {
          title: p.title,
          description: p.description,
          assignedToId: p.assignedToId || user.id,
          priority: p.priority ?? "MEDIUM",
          dueDate: p.dueDate ? new Date(p.dueDate) : null,
          module: "Assistant IA",
        },
        { module: "Assistant IA", suffix: " — via Assistant IA" }
      );

      return {
        ok: true,
        message: `Tâche « ${p.title} » créée avec succès.`,
        link: `/mon-espace/taches?id=${created.id}`,
        revalidate: ["/mon-espace/taches"],
      };
    }

    if ("destinataireId" in payload && "body" in payload) {
      // Cas 2 : Envoi de message interne
      const p = payload as unknown as PayloadEnvoyerMessage;

      // Retrouver ou créer la conversation directe
      let convId = await findDirectConversation(user.id, p.destinataireId);
      if (!convId) {
        const conv = await prisma.conversation.create({
          data: {
            type: "DIRECT",
            createdById: user.id,
            members: { create: [{ userId: user.id }, { userId: p.destinataireId }] },
          },
          select: { id: true },
        });
        convId = conv.id;
      }

      const msg = await prisma.message.create({
        data: {
          conversationId: convId,
          senderId: user.id,
          body: p.body,
          kind: "TEXT",
        },
        select: { id: true },
      });

      return {
        ok: true,
        message: "Message envoyé avec succès.",
        link: `/messages?c=${convId}&m=${msg.id}`,
        revalidate: ["/messages"],
      };
    }

    return {
      ok: false,
      error: "Type d'action non reconnu.",
    };
  });

  return resultat ?? { ok: false, error: "Action introuvable ou non autorisée." };
}
