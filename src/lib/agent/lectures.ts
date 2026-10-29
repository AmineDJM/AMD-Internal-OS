import { prisma } from "@/lib/prisma";
import { derniersMessagesParConversation } from "@/lib/queries/messaging";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { REFUS_SECONDE_CARTE, type PropositionCarte } from "@/lib/agent/operations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES DU QUOTIDIEN — CE QUI EST À LA PERSONNE, et rien d'autre.
 *
 *   • mes_conversations : SES conversations (elle en est membre), le dernier message de chacune,
 *     ce qu'elle n'a pas lu — pour savoir à quoi répondre ;
 *   • mes_demandes_en_attente : SES demandes de validation en attente, et qui doit trancher —
 *     pour relancer ;
 *   • mes_brouillons : ce qu'ELLE a commencé et pas fini — événements en brouillon, postes en
 *     brouillon, cartes de l'assistant jamais confirmées. Reprendre une carte la RÉAFFICHE
 *     (même intention : rien n'est rejoué, rien n'est dupliqué).
 *
 * Chaque requête filtre sur l'identifiant de la personne ; aucune ne lit au-delà.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const def = (name: string, description: string, properties: Record<string, unknown> = {}) =>
  ({ name, description, input_schema: { type: "object", properties } }) as PowerTool["def"];

export function lecturesQuotidien(user: CurrentUser, propositions: PropositionCarte[]): PowerTool[] {
  const a_moi = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: def("mes_conversations", "Tes conversations internes récentes : interlocuteurs, dernier message, non lus. À lire avant de répondre à un message.", {
        avec: { type: "string", description: "Filtrer par interlocuteur ou nom de groupe (facultatif)." },
      }),
      allowed: a_moi,
      label: "Conversations consultées",
      run: async (entree) => {
        const filtre = typeof entree.avec === "string" ? entree.avec.trim().toLowerCase() : "";
        const membres = await prisma.conversationMember.findMany({
          where: { userId: user.id, leftAt: null },
          select: {
            lastReadAt: true,
            conversation: {
              select: {
                id: true, title: true,
                members: { where: { leftAt: null, userId: { not: user.id } }, select: { user: { select: { name: true } } }, take: 6 },
              },
            },
          },
          take: 200,
        });
        // Les 3 derniers messages de chaque conversation, BORNÉS EN SQL : un `messages: { take: 3 }` imbriqué
        // ici rapatriait tout l'historique des 200 conversations, corps compris (audit performance PERF-08).
        const derniers = await derniersMessagesParConversation(membres.map((m) => m.conversation.id), 3);
        const lignes = membres
          .map((m) => {
            const c = m.conversation;
            const libelle = c.title || c.members.map((x) => x.user.name).join(", ") || "Conversation";
            const messages = derniers.get(c.id) ?? [];
            const dernier = messages[0];
            return {
              conversation: libelle,
              dernierMessage: dernier ? { de: dernier.senderId === user.id ? "vous" : dernier.senderName ?? "—", le: dernier.createdAt.toISOString().slice(0, 16).replace("T", " "), texte: dernier.body.slice(0, 300) } : null,
              nonLu: Boolean(dernier && dernier.senderId !== user.id && (!m.lastReadAt || dernier.createdAt > m.lastReadAt)),
              precedents: messages.slice(1).map((x) => `${x.senderId === user.id ? "vous" : x.senderName ?? "—"} : ${x.body.slice(0, 160)}`),
              _date: dernier?.createdAt.getTime() ?? 0,
            };
          })
          .filter((l) => l.dernierMessage && (!filtre || l.conversation.toLowerCase().includes(filtre)))
          .sort((a, b) => b._date - a._date)
          .slice(0, 12)
          .map(({ _date, ...l }) => l);
        return JSON.stringify({ conversations: lignes, count: lignes.length });
      },
    },
    {
      def: def("mes_demandes_en_attente", "Tes demandes de validation en attente : référence, objet, depuis quand, qui doit trancher. À lire avant une relance."),
      allowed: a_moi,
      label: "Demandes en attente consultées",
      run: async () => {
        const d = await prisma.validationRequest.findMany({
          where: { requesterId: user.id, status: "PENDING" },
          select: { reference: true, title: true, createdAt: true, steps: { where: { status: "PENDING" }, orderBy: { order: "asc" }, take: 1, select: { validator: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
        return JSON.stringify({
          demandes: d.map((x) => ({ reference: x.reference, objet: x.title, depuis: x.createdAt.toISOString().slice(0, 10), enAttenteDe: x.steps[0]?.validator.name ?? null })),
          count: d.length,
        });
      },
    },
    {
      def: def("mes_brouillons", "Ce que TU as commencé sans le finir : événements en brouillon, postes en brouillon, cartes de l'assistant jamais confirmées. Avec `reprendre` (l'identifiant d'une carte), la carte est réaffichée pour être confirmée.", {
        reprendre: { type: "string", description: "Identifiant d'une carte non confirmée à réafficher (facultatif)." },
      }),
      allowed: a_moi,
      label: "Brouillons consultés",
      run: async (entree) => {
        const reprendre = typeof entree.reprendre === "string" ? entree.reprendre.trim() : "";
        if (reprendre) {
          if (propositions.length > 0) return REFUS_SECONDE_CARTE;
          const i = await prisma.assistantActionIntent.findFirst({
            where: { id: reprendre, userId: user.id, status: "PROPOSED" },
            select: { id: true, kind: true, title: true, summary: true, payload: true, level: true, confirmText: true },
          });
          if (!i) return JSON.stringify({ statut: "REFUS", raison: "Carte introuvable, déjà confirmée ou annulée." });
          propositions.push({ intentId: i.id, proposition: { kind: i.kind, title: i.title, fields: [{ label: "Résumé", value: i.summary ?? i.title }], payload: i.payload, ...(i.level === "CRITICAL" && i.confirmText ? { level: "CRITICAL" as const, confirmText: i.confirmText } : {}) } });
          return JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", titre: i.title, consigne: "La carte est réaffichée : rien n'est rejoué avant la confirmation." });
        }
        const depuis = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const [evenements, postes, cartes] = await Promise.all([
          prisma.event.findMany({ where: { createdById: user.id, status: "DRAFT", requestStatus: null }, select: { id: true, name: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
          prisma.adProItem.findMany({ where: { createdById: user.id, status: "DRAFT" }, select: { id: true, label: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
          prisma.assistantActionIntent.findMany({ where: { userId: user.id, status: "PROPOSED", proposedAt: { gte: depuis } }, select: { id: true, title: true, proposedAt: true }, take: 10, orderBy: { proposedAt: "desc" } }),
        ]);
        return JSON.stringify({
          evenementsEnBrouillon: evenements.map((x) => ({ nom: x.name, lien: `/events/${x.id}`, depuis: x.createdAt.toISOString().slice(0, 10) })),
          postesEnBrouillon: postes.map((x) => ({ poste: x.label, depuis: x.createdAt.toISOString().slice(0, 10) })),
          cartesNonConfirmees: cartes.map((x) => ({ identifiant: x.id, titre: x.title, depuis: x.proposedAt.toISOString().slice(0, 10) })),
          count: evenements.length + postes.length + cartes.length,
        });
      },
    },
  ];
}
