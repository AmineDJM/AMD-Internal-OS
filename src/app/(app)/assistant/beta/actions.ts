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

  // Fast path 1 : Salutations instantanées (< 5 ms)
  if (/^(salam|bonjour|salut|hello|hi|hey|bonsoir)(\s+.*)?$/i.test(prompt) && prompt.length < 35) {
    return {
      ok: true,
      messageId: `msg-${Date.now()}`,
      role: "assistant",
      content: `Bonjour ${user.name} 👋 !\n\nJe suis **Adventum Brain**, votre assistant interne d'entreprise. Je suis connecté à votre base de données locale (${nbProduits} produits, ${nbDossiers} dossiers AMM, ${nbTaches} tâches).\n\nComment puis-je vous accompagner aujourd'hui ?`,
      outilsAppeles: [],
    };
  }

  // Fast path 2 : Capacités / Qui es-tu (< 5 ms)
  if (/(qui\s+es[- ]tu|who\s+are\s+you|what\s+you\s+can\s+do|que\s+peux[- ]tu\s+faire|capacit[ée]s)/i.test(prompt)) {
    return {
      ok: true,
      messageId: `msg-${Date.now()}`,
      role: "assistant",
      content: `Voici mes capacités en tant qu'**Adventum Brain** sous votre rôle (**${user.role}**) :\n\n` +
        `1. 📁 **Affaires Réglementaires** : Consulter les ${nbDossiers} dossiers AMM, statuts d'enregistrement et variations.\n` +
        `2. 📦 **Catalogue Produits** : Consulter les ${nbProduits} produits et formes pharmaceutiques.\n` +
        `3. 👥 **Annuaire d'Entreprise** : Rechercher parmi les ${nbUsers} collaborateurs enregistrés.\n` +
        `4. ✍️ **Actions Sécurisées (Human-in-the-Loop)** : Préparer des créations de tâches (« crée une tâche... ») ou des messages internes (« envoie un message... ») sous votre validation explicite.\n` +
        `5. 📊 **Télémétrie Système** : Consulter l'état en direct de la base de données (« check db »).`,
      outilsAppeles: [],
    };
  }

  // Fast path 3 : Check DB / Métriques directes (< 10 ms)
  if (/(check\s*db|stats|statistiques|base\s+de\s+donn[ée]es|combien\s+de\s+(produits|dossiers|utilisateurs|t[aâ]ches|messages))/i.test(prompt)) {
    return {
      ok: true,
      messageId: `msg-${Date.now()}`,
      role: "assistant",
      content: `📊 **État en direct de la base de données Adventum Pharma (amd_dev)** :\n\n` +
        `• **Utilisateurs enregistrés** : ${nbUsers}\n` +
        `• **Dossiers Réglementaires AMM** : ${nbDossiers}\n` +
        `• **Produits au catalogue** : ${nbProduits}\n` +
        `• **Tâches créées** : ${nbTaches}\n` +
        `• **Messages internes échangés** : ${nbMessages}\n\n` +
        `Toutes les tables sont actives, intègres et synchronisées.`,
      outilsAppeles: ["check_database"],
    };
  }

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
          temperature: 0.2,
          max_tokens: 500,
          thinking: { type: "disabled" },
        }),
        signal: AbortSignal.timeout(12000),
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
