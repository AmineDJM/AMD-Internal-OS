"use server";

import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { compileContext } from "@/lib/agent/contexte";
import { creerAgent, repondre } from "@/lib/agent/agent";
import { getRoleConfig } from "@/lib/agent/role-config";
import { outilCreerTache, outilEnvoyerMessage, executerActionConfirmee } from "@/lib/agent/ecritures";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";

export interface ReponseBetaAction {
  ok: boolean;
  messageId: string;
  role: "assistant";
  content: string;
  outilsAppeles: string[];
  intent?: {
    id: string;
    kind: string;
    title: string;
    summary?: string;
    fields?: { label: string; value: string }[];
    status?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
    resultLink?: string;
    resultMessage?: string;
  } | null;
  error?: string;
}

/**
 * Charge les métriques live de l'ERP pour la barre KPI en verre.
 */
export async function chargerKpiBeta() {
  const user = await requireUser();
  const [nbUsers, nbDossiers, nbProduits, nbTaches] = await Promise.all([
    prisma.user.count(),
    prisma.regulatoryDossier.count(),
    prisma.product.count(),
    prisma.task.count(),
  ]);

  return {
    ok: true,
    data: {
      nbUsers,
      nbDossiers,
      nbProduits,
      nbTaches,
      userName: user.name,
      userRole: user.role,
    },
  };
}

/**
 * Valide et exécute une intention d'action sous confirmation humaine.
 */
export async function confirmerActionBeta(intentId: string) {
  const user = await requireUser();
  return executerActionConfirmee(intentId, user);
}

/**
 * Envoie un message à l'assistant neuf avec résolution RBAC et modèle MiMo.
 */
export async function envoyerMessageBeta(
  userPrompt: string,
  moduleFilter?: string,
  historique: { role: string; content: string }[] = []
): Promise<ReponseBetaAction> {
  const user = await requireUser();
  const prompt = (userPrompt ?? "").trim();
  if (!prompt) return { ok: false, messageId: `err-${Date.now()}`, role: "assistant", content: "", outilsAppeles: [], error: "Message vide." };

  const [nbUsers, nbDossiers, nbProduits, nbTaches, nbMessages] = await Promise.all([
    prisma.user.count(),
    prisma.regulatoryDossier.count(),
    prisma.product.count(),
    prisma.task.count(),
    prisma.message.count(),
  ]);

  const roleConfig = await getRoleConfig(user.role);
  const contexte = await compileContext({
    user,
    consignesRole: roleConfig?.customInstructions ?? undefined,
  });

  const promptEnrichi =
    contexte.systemPrompt +
    `\n\n### DONNÉES EN DIRECT DE L'ERP (BASE DE DONNÉES)\n` +
    `- Utilisateurs enregistrés : ${nbUsers}\n` +
    `- Dossiers réglementaires AMM : ${nbDossiers}\n` +
    `- Produits au catalogue : ${nbProduits}\n` +
    `- Tâches créées : ${nbTaches}\n` +
    `- Messages internes : ${nbMessages}\n\n` +
    `Tu es « Adventum Brain », l'assistant d'entreprise interne d'Adventum Pharma en Algérie. Tu réponds sous une forme limpide, élégante, structurée et soignée en français (ou dans la langue de la question). Tu ne dois JAMAIS mentionner de nom de modèle d'IA, de fournisseur ou d'infrastructure technique (interdiction formelle de citer « MiMo », « Xiaomi » ou équivalent). Reste toujours focalisé sur les données métier de l'ERP, les dossiers réglementaires, le catalogue produits et les tâches à accomplir.`;

  // 1. Détection de création de tâche (Action sécurisée Human-in-the-Loop)
  if (/cr[eé]e.*t[aâ]che/i.test(prompt) || /t[aâ]che.*urgente/i.test(prompt)) {
    if (!outilCreerTache.allowed(user)) {
      return {
        ok: true,
        messageId: `msg-${Date.now()}`,
        role: "assistant",
        content: `🔒 Vos privilèges (${user.role}) ne vous autorisent pas à créer des tâches dans l'espace de travail.`,
        outilsAppeles: [],
      };
    }

    const titreTache = prompt
      .replace(/^(cr[eé]e.*t[aâ]che(\s+pour|\s+de)?|ajoute.*t[aâ]che)\s*/i, "")
      .trim() || "Action préparée via Assistant";

    const { modele } = modeleFactice([
      {
        appel: {
          outil: "create_task",
          entree: {
            title: titreTache,
            priority: /urgent/i.test(prompt) ? "HIGH" : "MEDIUM",
            description: `Demande formulée par ${user.name} via l'Assistant IA.`,
          },
        },
      },
      {
        texte: `J'ai préparé la proposition de tâche « ${titreTache} ». Une carte de confirmation est affichée ci-dessous pour validation avant création effective.`,
      },
    ]);

    const agent = creerAgent({
      user,
      modele: modele as never,
      outils: [outilCreerTache],
      instructions: promptEnrichi,
      config: roleConfig,
    });

    const rep = await repondre(agent, prompt);

    const intentCree = await prisma.assistantActionIntent.findFirst({
      where: { userId: user.id, status: "PROPOSED" },
      orderBy: { proposedAt: "desc" },
    });

    return {
      ok: true,
      messageId: `msg-${Date.now()}`,
      role: "assistant",
      content: rep.texte,
      outilsAppeles: rep.outilsAppeles,
      intent: intentCree
        ? {
            id: intentCree.id,
            kind: intentCree.kind,
            title: intentCree.title,
            summary: intentCree.summary || undefined,
            status: intentCree.status as any,
          }
        : null,
    };
  }

  // 2. Détection d'envoi de message interne (Action sécurisée Human-in-the-Loop)
  if (/envoie.*message/i.test(prompt) || /écris.*à/i.test(prompt)) {
    if (!outilEnvoyerMessage.allowed(user)) {
      return {
        ok: true,
        messageId: `msg-${Date.now()}`,
        role: "assistant",
        content: `🔒 La messagerie interne ne vous est pas ouverte en écriture.`,
        outilsAppeles: [],
      };
    }

    const destinataire = await prisma.user.findFirst({
      where: { role: "SUPER_ADMIN", isActive: true },
      select: { id: true, name: true },
    });

    const { modele } = modeleFactice([
      {
        appel: {
          outil: "send_message",
          entree: {
            destinataireId: destinataire?.id || user.id,
            body: prompt,
          },
        },
      },
      {
        texte: `Le message à destination de ${destinataire?.name || "la direction"} a été préparé sous forme de proposition.`,
      },
    ]);

    const agent = creerAgent({
      user,
      modele: modele as never,
      outils: [outilEnvoyerMessage],
      instructions: promptEnrichi,
      config: roleConfig,
    });

    const rep = await repondre(agent, prompt);

    const intentCree = await prisma.assistantActionIntent.findFirst({
      where: { userId: user.id, status: "PROPOSED" },
      orderBy: { proposedAt: "desc" },
    });

    return {
      ok: true,
      messageId: `msg-${Date.now()}`,
      role: "assistant",
      content: rep.texte,
      outilsAppeles: rep.outilsAppeles,
      intent: intentCree
        ? {
            id: intentCree.id,
            kind: intentCree.kind,
            title: intentCree.title,
            summary: intentCree.summary || undefined,
            status: intentCree.status as any,
          }
        : null,
    };
  }

  // 3. Appel direct au modèle Xiaomi MiMo (Amsterdam Token Plan)
  const mimoKey = (process.env.mimo || process.env.MIMO || "").trim();
  if (mimoKey) {
    try {
      const messages = [
        { role: "system", content: promptEnrichi },
        ...historique.slice(-6),
        { role: "user", content: prompt },
      ];

      const res = await fetch("https://token-plan-ams.xiaomimimo.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${mimoKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-v2.6-flash",
          messages,
          temperature: 0.3,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(18000),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";
        if (content) {
          return {
            ok: true,
            messageId: `msg-${Date.now()}`,
            role: "assistant",
            content,
            outilsAppeles: [],
          };
        }
      }
    } catch (e: any) {
      console.error("[Adventum Brain] Erreur modèle:", e.message);
    }
  }

  // 4. Repli intelligent local
  return {
    ok: true,
    messageId: `msg-${Date.now()}`,
    role: "assistant",
    content: `Bien reçu votre message : « ${prompt} ». En tant qu'assistant interne d'Adventum Pharma (${user.role}), je peux consulter les dossiers, les effectifs ou préparer des tâches sous validation humaine.`,
    outilsAppeles: [],
  };
}
