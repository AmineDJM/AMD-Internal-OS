import type { CurrentUser } from "@/lib/session";
import { userCan, MODULES, type Module } from "@/lib/rbac";
import { MODULE_LABELS, ROLE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { censurerTexte } from "@/lib/agent/filtre-confidentialite";

/**
 * COUCHE DE CONTEXTE (Q9, Q11, Q14, Q17, C10).
 *
 * `compileContext` assemble, avant chaque tour, ce que le modèle sait de la situation :
 *   1. l'interlocuteur et son périmètre RBAC (ses modules ouverts, rien d'autre) ;
 *   2. l'heure d'Alger ;
 *   3. la page ouverte — son ADRESSE seulement. Le contenu d'un objet ne vient JAMAIS d'ici :
 *      l'agent le lit par un outil, qui applique le droit et les droits par ligne (Q11). Rien de
 *      ce qu'envoie le navigateur n'entre dans le prompt ;
 *   4. la mémoire active et l'historique du fil, filtrés (Q14) ;
 *   5. les consignes du rôle et les règles fondamentales.
 *
 * ÉCHEC FERMÉ (Q17) : une erreur de base n'est plus avalée. Un contexte incomplet ferait répondre
 * l'agent sans savoir qui lui parle ; l'appelant transforme l'erreur en « service indisponible ».
 */

export interface ContextePage {
  pathname?: string;
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
  tokensEstimes: { systemPrompt: number; messages: number; total: number };
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
  return texte ? Math.ceil(texte.length / 4) : 0;
}

/** Une adresse de page, et rien d'autre : pas de requête, pas de fragment, longueur bornée. */
function adresseSure(pathname?: string): string | null {
  if (!pathname) return null;
  const p = pathname.split(/[?#]/)[0].trim();
  return /^\/[\w\-/[\]().]*$/.test(p) ? p.slice(0, 200) : null;
}

async function chargerMemoireUtilisateur(userId: string): Promise<string[]> {
  const items = await prisma.assistantMemoryItem.findMany({
    where: { userId, active: true },
    select: { content: true },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  return items.map((i) => i.content);
}

async function chargerMessagesConversation(
  userId: string,
  threadId: string | undefined,
  limite: number,
): Promise<{ messages: MessageHistorique[]; aCensure: boolean }> {
  if (!threadId) return { messages: [], aCensure: false };
  const raw = await prisma.assistantMessage.findMany({
    where: { threadId, userId },
    select: { role: true, content: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
  let aCensure = false;
  const messages = raw.reverse().map((m) => {
    const { texte, censure } = censurerTexte(m.content);
    if (censure) aCensure = true;
    return { role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: texte };
  });
  return { messages, aCensure };
}

/**
 * LES RÈGLES DE RÉPONSE — tirées du prompt « Generative UI » fourni (C10,
 * `docs/assistant/prompt-systeme-ui-generative.md`), en français. La sortie structurée en
 * composants viendra à l'étape R5 ; d'ici là, le texte naturel.
 */
const REGLES = [
  "Zéro invention : un fait, une personne, un produit, un statut ou un chiffre que tes outils ou ce contexte ne donnent pas, tu dis que tu ne l'as pas.",
  "Confidentialité : tu ne manipules ni coordonnée bancaire (RIB, IBAN, CCP), ni rémunération individuelle, ni numéro de pièce d'identité.",
  "Actions : tu ne modifies jamais rien toi-même. Une demande d'action (tâche, message) est préparée par l'outil, puis confirmée par l'utilisateur. Tu ne prétends jamais qu'une action est faite si l'application ne l'a pas exécutée.",
  "Concision : réponds clairement et brièvement, sans répéter la question. Texte simple pour une question simple.",
  "Tu ne produis jamais de HTML, de JSX ni de code exécutable.",
];

export async function compileContext({
  user,
  threadId,
  page,
  consignesRole,
  maxMessagesHistorique = 12,
}: OptionsContexte): Promise<ContexteCompile> {
  let censureGlobale = false;

  const maintenant = new Date();
  const dateLisible = maintenant.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Algiers" });
  const heureLisible = maintenant.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

  const roleLabel = ROLE_LABELS[user.role] ?? user.role;
  const modulesAccessibles = (MODULES as readonly Module[])
    .filter((m) => userCan(user, m, "VIEW"))
    .map((m) => MODULE_LABELS[m] ?? m);

  const [memoireFaits, { messages, aCensure: censureMessages }] = await Promise.all([
    chargerMemoireUtilisateur(user.id),
    chargerMessagesConversation(user.id, threadId, maxMessagesHistorique),
  ]);
  if (censureMessages) censureGlobale = true;

  const sections: string[] = [
    "Tu es l'assistant interne d'Adventum Pharma, un laboratoire pharmaceutique algérien. Tu réponds en français, avec rigueur et clarté, en t'appuyant uniquement sur les données de l'entreprise que te donnent tes outils.",
    `### HORODATAGE\nNous sommes le ${dateLisible}. Heure locale d'Alger : ${heureLisible}.`,
    `### INTERLOCUTEUR\nNom : ${user.name}\nRôle : ${roleLabel}${user.secondaryRole ? ` (rôle secondaire : ${ROLE_LABELS[user.secondaryRole] ?? user.secondaryRole})` : ""}`,
    `### PÉRIMÈTRE D'ACCÈS (RBAC)\nModules ouverts à cet utilisateur :\n- ${modulesAccessibles.join("\n- ")}\nHors de ce périmètre, tu indiques avec courtoisie que le module ne lui est pas ouvert.`,
  ];

  const adresse = adresseSure(page?.pathname);
  if (adresse) sections.push(`### ÉCRAN OUVERT\nPage : ${adresse}. Pour en connaître le contenu, utilise tes outils de lecture.`);

  if (memoireFaits.length > 0) {
    const faits = memoireFaits.map((f) => {
      const { texte, censure } = censurerTexte(f);
      if (censure) censureGlobale = true;
      return `- ${texte}`;
    });
    sections.push(`### MÉMOIRE DE L'INTERLOCUTEUR\n${faits.join("\n")}`);
  }

  if (consignesRole) {
    const { texte, censure } = censurerTexte(consignesRole);
    if (censure) censureGlobale = true;
    sections.push(`### CONSIGNES DU RÔLE\n${texte}`);
  }

  sections.push(`### RÈGLES FONDAMENTALES\n${REGLES.map((r, i) => `${i + 1}. ${r}`).join("\n")}`);

  const systemPrompt = sections.join("\n\n");
  const tokensSys = estimerTokens(systemPrompt);
  const tokensMsg = messages.reduce((acc, m) => acc + estimerTokens(m.content), 0);

  return {
    systemPrompt,
    messages,
    tokensEstimes: { systemPrompt: tokensSys, messages: tokensMsg, total: tokensSys + tokensMsg },
    provenance: {
      userId: user.id,
      role: user.role,
      modulesCount: modulesAccessibles.length,
      threadId,
      pagePath: adresse ?? undefined,
      censureAppliquee: censureGlobale,
    },
  };
}
