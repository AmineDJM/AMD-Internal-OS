import type { CurrentUser } from "@/lib/session";
import { userCan, MODULES, type Module } from "@/lib/rbac";
import { MODULE_LABELS, ROLE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { censurerTexte, censurerObjet } from "@/lib/agent/filtre-confidentialite";

/**
 * COUCHE DE CONTEXTE — Jalon 3 (Décisions Q9 et Q14).
 *
 * `compileContext` est une fonction déterministe qui assemble le contexte opérationnel
 * de l'agent avant chaque invocation :
 *
 * 1. Identité de l'interlocuteur & Périmètre RBAC (ses modules autorisés uniquement)
 * 2. Horodatage exact au fuseau horaire d'Alger (Africa/Algiers)
 * 3. Page active et objet en cours de consultation (ex. Dossier AMM, Tâche, Produit)
 * 4. Mémoire active persistante de l'utilisateur (AssistantMemoryItem)
 * 5. Historique fenêtré de la conversation (AssistantMessage)
 * 6. Application stricte du filtre anti-fuite de données sensibles (Q14)
 *
 * Budget cible : ~8 000 tokens maximum.
 */

export interface ContextePage {
  pathname?: string;
  objetType?: "DOSSIER" | "PRODUIT" | "EMPLOYE" | "EVENEMENT" | "TACHE" | string;
  objetId?: string;
  donneesObjet?: Record<string, unknown>;
}

export interface OptionsContexte {
  user: CurrentUser;
  threadId?: string;
  page?: ContextePage;
  consignesRole?: string;
  maxMessagesHistorique?: number;
}

export interface MessageHistorique {
  role: "user" | "assistant";
  content: string;
}

export interface ContexteCompile {
  systemPrompt: string;
  messages: MessageHistorique[];
  tokensEstimes: {
    systemPrompt: number;
    messages: number;
    total: number;
  };
  provenance: {
    userId: string;
    role: string;
    modulesCount: number;
    threadId?: string;
    pagePath?: string;
    censureAppliquee: boolean;
  };
}

/** Approximation déterministe : ~4 caractères par token pour le français. */
function estimerTokens(texte: string): number {
  if (!texte) return 0;
  return Math.ceil(texte.length / 4);
}

/**
 * Charge un résumé non confidentiel de l'objet actuellement consulté à l'écran.
 */
async function chargerResumeObjet(page?: ContextePage): Promise<{ resume: string | null; aCensure: boolean }> {
  if (!page?.objetType || !page?.objetId) {
    if (page?.donneesObjet && Object.keys(page.donneesObjet).length > 0) {
      const { resultat, censure } = censurerObjet(page.donneesObjet);
      return { resume: JSON.stringify(resultat, null, 2), aCensure: censure };
    }
    return { resume: null, aCensure: false };
  }

  try {
    switch (page.objetType.toUpperCase()) {
      case "DOSSIER": {
        const dossier = await prisma.regulatoryDossier.findUnique({
          where: { id: page.objetId },
          select: {
            reference: true,
            title: true,
            procedureType: true,
            status: true,
          },
        });
        if (!dossier) return { resume: null, aCensure: false };
        const { resultat, censure } = censurerObjet(dossier);
        return {
          resume: `Dossier réglementaire consulté : [${resultat.reference}] ${resultat.title} | Procédure : ${resultat.procedureType} | Statut : ${resultat.status}`,
          aCensure: censure,
        };
      }
      case "PRODUIT": {
        const produit = await prisma.product.findUnique({
          where: { id: page.objetId },
          select: {
            code: true,
            canonicalName: true,
            dci: true,
            form: true,
            dosage: true,
            dosageUnit: true,
          },
        });
        if (!produit) return { resume: null, aCensure: false };
        const { resultat, censure } = censurerObjet(produit);
        const dosageStr = [resultat.dosage, resultat.dosageUnit].filter(Boolean).join(" ");
        return {
          resume: `Fiche produit consultée : [${resultat.code}] ${resultat.canonicalName} | DCI : ${resultat.dci} | Forme : ${resultat.form || "N/A"} ${dosageStr}`,
          aCensure: censure,
        };
      }
      case "TACHE": {
        const tache = await prisma.task.findUnique({
          where: { id: page.objetId },
          select: {
            title: true,
            status: true,
            priority: true,
            dueDate: true,
          },
        });
        if (!tache) return { resume: null, aCensure: false };
        const { resultat, censure } = censurerObjet(tache);
        const echeance = resultat.dueDate ? new Date(resultat.dueDate).toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" }) : "aucune";
        return {
          resume: `Tâche consultée : "${resultat.title}" | Statut : ${resultat.status} | Priorité : ${resultat.priority} | Échéance : ${echeance}`,
          aCensure: censure,
        };
      }
      default:
        return { resume: null, aCensure: false };
    }
  } catch {
    // Si la base est inaccessible (ex. test unitaire sans DB), on ignore silencieusement
    return { resume: null, aCensure: false };
  }
}

/**
 * Charge les éléments de mémoire active d'un utilisateur.
 */
async function chargerMemoireUtilisateur(userId: string): Promise<string[]> {
  try {
    const items = await prisma.assistantMemoryItem.findMany({
      where: { userId, active: true },
      select: { content: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    return items.map((i) => i.content);
  } catch {
    return [];
  }
}

/**
 * Charge les derniers messages de la conversation en filtrant les données sensibles.
 */
async function chargerMessagesConversation(
  userId: string,
  threadId?: string,
  limite = 12
): Promise<{ messages: MessageHistorique[]; aCensure: boolean }> {
  if (!threadId) return { messages: [], aCensure: false };

  try {
    const raw = await prisma.assistantMessage.findMany({
      where: { threadId, userId },
      select: { role: true, content: true },
      orderBy: { createdAt: "desc" },
      take: limite,
    });

    let censureAppliquee = false;
    const messages = raw.reverse().map((m) => {
      const { texte, censure } = censurerTexte(m.content);
      if (censure) censureAppliquee = true;
      return {
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: texte,
      };
    });

    return { messages, aCensure: censureAppliquee };
  } catch {
    return { messages: [], aCensure: false };
  }
}

/**
 * Compile le contexte complet pour l'Agent Mastra.
 */
export async function compileContext({
  user,
  threadId,
  page,
  consignesRole,
  maxMessagesHistorique = 12,
}: OptionsContexte): Promise<ContexteCompile> {
  let censureGlobale = false;

  // 1. Date et heure au fuseau d'Alger
  const maintenant = new Date();
  const dateLisible = maintenant.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Algiers",
  });
  const heureLisible = maintenant.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Algiers",
  });

  // 2. Périmètre RBAC de l'utilisateur
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;
  const modulesAccessibles = (MODULES as readonly Module[])
    .filter((m) => userCan(user, m, "VIEW"))
    .map((m) => MODULE_LABELS[m] ?? m);

  // 3. Objet ou écran en cours
  const { resume: resumeObjet, aCensure: censureObjet } = await chargerResumeObjet(page);
  if (censureObjet) censureGlobale = true;
  const memoireFaits = await chargerMemoireUtilisateur(user.id);
  const { messages, aCensure: censureMessages } = await chargerMessagesConversation(
    user.id,
    threadId,
    maxMessagesHistorique
  );
  if (censureMessages) censureGlobale = true;

  // 4. Assemblage des sections du System Prompt
  const sections: string[] = [
    `Tu es l'assistant interne d'Adventum Pharma, un laboratoire pharmaceutique algérien. Tu réponds avec rigueur, clarté et concision, en français, en t'appuyant uniquement sur les données de l'entreprise.`,
    `### HORODATAGE\nNous sommes le ${dateLisible}. Heure locale d'Alger : ${heureLisible} (fuseau Africa/Algiers).`,
    `### INTERLOCUTEUR\nNom : ${user.name}\nEmail : ${user.email}\nRôle : ${roleLabel}${user.secondaryRole ? ` (Rôle secondaire : ${ROLE_LABELS[user.secondaryRole] ?? user.secondaryRole})` : ""}`,
    `### PÉRIMÈTRE D'ACCÈS AUTORISÉ (RBAC)\nL'utilisateur dispose d'un accès aux modules suivants :\n- ${modulesAccessibles.join("\n- ")}\nTu ne dois jamais divulguer d'informations relatives à des modules non autorisés. Si l'utilisateur pose une question hors de son périmètre, indique-lui avec courtoisie que ce module ne lui est pas ouvert.`,
  ];

  if (page?.pathname || resumeObjet) {
    let sectionPage = `### CONTEXTE D'ÉCRAN ACTUEL\n`;
    if (page?.pathname) sectionPage += `Page active : ${page.pathname}\n`;
    if (resumeObjet) sectionPage += `Élément consulté : ${resumeObjet}\n`;
    sections.push(sectionPage.trim());
  }

  if (memoireFaits.length > 0) {
    const faitsNettoyes = memoireFaits.map((f) => {
      const { texte, censure } = censurerTexte(f);
      if (censure) censureGlobale = true;
      return `- ${texte}`;
    });
    sections.push(`### MÉMOIRE ACTIVE DE L'INTERLOCUTEUR\n${faitsNettoyes.join("\n")}`);
  }

  if (consignesRole) {
    const { texte: consignesNettoyees, censure } = censurerTexte(consignesRole);
    if (censure) censureGlobale = true;
    sections.push(`### CONSIGNES DU RÔLE\n${consignesNettoyees}`);
  }

  // 5. Règles fondamentales absolues
  sections.push(
    `### RÈGLES FONDAMENTALES\n` +
      `1. Zéro invention : Si un fait, une personne, un produit, un statut ou un chiffre n'est pas fourni par tes outils ou le contexte, indique que tu n'as pas l'information.\n` +
      `2. Confidentialité stricte : Tu ne manipules aucune donnée bancaire (RIB/IBAN), rémunération individuelle ni numéro de pièce d'identité.\n` +
      `3. Actions : Tu ne modifies jamais la base directement. Toute demande d'action (tâche, message) doit être soumise à validation.`
  );

  const systemPrompt = sections.join("\n\n");
  const tokensSys = estimerTokens(systemPrompt);
  const tokensMsg = messages.reduce((acc, m) => acc + estimerTokens(m.content), 0);

  return {
    systemPrompt,
    messages,
    tokensEstimes: {
      systemPrompt: tokensSys,
      messages: tokensMsg,
      total: tokensSys + tokensMsg,
    },
    provenance: {
      userId: user.id,
      role: user.role,
      modulesCount: modulesAccessibles.length,
      threadId,
      pagePath: page?.pathname,
      censureAppliquee: censureGlobale,
    },
  };
}
