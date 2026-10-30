import { CONSIGNE_CONTENU_NON_FIABLE } from "../domaine/contenu-non-fiable";
import type { CurrentUser } from "@/lib/session";
import { userCan, MODULES, type Module } from "@/lib/rbac";
import { MODULE_LABELS, ROLE_LABELS } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { censurerTexte } from "../domaine/filtre-confidentialite";
import { CONSIGNE_COMPOSANTS } from "../domaine/ui/composants";
import { memoirePourContexte } from "./memoire";
import { souvenirsPourQuestion } from "../domaine/assembleur";

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
  /**
   * J4 : les outils offerts au DÉBUT du tour. Donnés, les règles propres à une famille d'outils (agir, documents,
   * routines, web) ne sont dites que si l'un d'eux est offert — `trouver_outil` rend la règle des outils qu'il ajoute.
   * Absents (routines, anciens appelants) : toutes les règles.
   */
  outilsActifs?: readonly string[];
  /** J4 : consignes du PRODUIT, les mêmes pour tous (confidentialité, sélection d'outils, fond) — dans le préfixe stable. */
  consignesGenerales?: readonly string[];
  /** J4 : consignes propres à la personne (familles réglées, gestes fermés) — stables d'un tour à l'autre. */
  consignesPersonne?: readonly string[];
  /** J4 : la question du tour — l'assembleur y choisit les souvenirs pertinents, dans leur enveloppe. */
  question?: string;
  /** J4 : la partie VARIABLE du tour (mémoire assemblée, résumé de la conversation…), posée APRÈS le préfixe stable. */
  sectionsDuTour?: readonly string[];
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

/** La mémoire personnelle (`memoire.ts`) : ce que la personne a confirmé, à elle seule. */
const chargerMemoireUtilisateur = (userId: string) => memoirePourContexte(userId);

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
 * composants (R5) suit, dans sa propre section : `CONSIGNE_COMPOSANTS`.
 */
export const REGLES = [
  "Zéro invention : un fait, une personne, un produit, un statut ou un chiffre que tes outils ou ce contexte ne donnent pas, tu dis que tu ne l'as pas.",
  "Confidentialité : tu ne vois jamais une rémunération, une coordonnée bancaire (RIB, IBAN, CCP) ni un numéro de pièce d'identité — tes outils te les rendent en repères ⟦S1⟧ que tu recopies tels quels ; le serveur les montre à qui en a le droit. Tes outils appliquent les droits de la personne : ne refuse jamais une demande de toi-même, appelle l'outil et rapporte son refus s'il en fait un. Un refus se formule par le DROIT qui manque (son rôle, une famille fermée par la Direction), jamais par « les outils disponibles ».",
  "Actions : tu ne modifies jamais rien toi-même. Une demande d'action (tâche, message) est préparée par l'outil, puis confirmée par l'utilisateur. Tu ne prétends jamais qu'une action est faite si l'application ne l'a pas exécutée.",
  "Concision : réponds clairement et brièvement, sans répéter la question. Texte simple pour une question simple.",
  "Tu ne produis jamais de HTML, de JSX ni de code exécutable.",
  "Agir : pour créer une demande (sponsoring, prise en charge, événement, matériel promotionnel, demande « autre »), ajouter un poste de coût ou tout autre geste, appelle l'outil preparer_* DÈS les premiers éléments, même incomplets. S'il répond INCOMPLET, pose UNE seule question — la première de `manque` —, puis rappelle-le avec tout ce que tu sais. Ne remplis jamais une valeur que tu n'as ni lue ni entendue ; reprends tels quels les identifiants des pièces jointes. Quand la carte récapitulative est affichée, résume-la en une phrase et cite ses avertissements.",
  "Documents : un devis ou une facture → lire_devis_facture, puis preparer_bc_depuis_devis pour en faire un bon de commande (les lignes viennent de la lecture, jamais de toi). Résumer ou interroger un document → lire_document ; deux versions → comparer_versions ; une lettre, une note, un compte rendu → preparer_document ; traduire → preparer_traduction ; un formulaire PDF → lire_formulaire_pdf puis preparer_formulaire_pdf. Un PASSEPORT → preparer_voyageur_passeport : tu n'en vois rien et tu n'en demandes ni n'en répètes jamais le nom, le numéro ou les dates.",
  "Routines : quand l'utilisateur te DEMANDE de faire quelque chose à un moment donné ou régulièrement (« chaque dimanche à 8 h », « tous les matins », « le 1er du mois », « demain à 9 h ») → programmer_routine ; ne devine jamais l'heure ni le jour, demande-les. Ses routines : mes_routines ; pause, reprise, suppression, exécution immédiate : gerer_routine. Jamais de routine ni de relance de ta propre initiative.",
  "Web : une information EXTÉRIEURE à l'entreprise (marché, actualité d'un laboratoire, réglementation étrangère, congrès) → web_research, en citant ses sources et leur date ; jamais pour une donnée de l'ERP.",
  CONSIGNE_CONTENU_NON_FIABLE,
  "Mémoire : « retiens que…, « souviens-toi… », ou un fait durable sur l'utilisateur lui-même (sa société, ses produits, une préférence, une habitude) → outil proposer_memoire, JAMAIS une tâche, et aucun composant pour la montrer : la carte « Retenir » s'affiche seule. Rien n'est retenu avant son geste.",
];

/**
 * LES RÈGLES D'UNE FAMILLE D'OUTILS (J4) — dites seulement quand l'un de ces outils est offert : un « bonjour » n'a
 * pas à relire le mode d'emploi des formulaires PDF. Clé = rang dans `REGLES` ; valeur = l'outil qui la rend utile.
 */
const REGLE_SI_OUTIL: Record<number, (nom: string) => boolean> = {
  5: (n) => /^(preparer_|create_|update_|send_message|assign_|set_regulatory|request_regulatory)|_operation$/.test(n),
  6: (n) => /^(lire_devis_facture|preparer_bc_depuis_devis|lire_document|comparer_versions|preparer_document|preparer_traduction|lire_formulaire_pdf|preparer_formulaire_pdf|preparer_voyageur_passeport)$/.test(n),
  7: (n) => /^(programmer_routine|mes_routines|gerer_routine)$/.test(n),
  8: (n) => n === "web_research",
};

/** Les règles à dire pour ces outils : toutes les règles générales, et celles des familles offertes. */
export function reglesPour(outils?: readonly string[]): string[] {
  if (!outils) return REGLES;
  return REGLES.filter((_, i) => !REGLE_SI_OUTIL[i] || outils.some(REGLE_SI_OUTIL[i]));
}

/** Les règles qu'ajoutent des outils TROUVÉS en cours de tour (rendues par `trouver_outil`). */
export function reglesAjoutees(dejaOfferts: readonly string[], trouves: readonly string[]): string[] {
  return REGLES.filter((_, i) => REGLE_SI_OUTIL[i] && !dejaOfferts.some(REGLE_SI_OUTIL[i]) && trouves.some(REGLE_SI_OUTIL[i]));
}

export async function compileContext({
  user,
  threadId,
  page,
  consignesRole,
  maxMessagesHistorique = 12,
  outilsActifs,
  sectionsDuTour = [],
  consignesGenerales = [],
  consignesPersonne = [],
  question,
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

  // LE PRÉFIXE STABLE D'ABORD (J4) : ce qui ne change pas d'un tour à l'autre, ni d'une personne à l'autre, ouvre
  // la consigne — le fournisseur le garde en cache (≈ 10 % du tarif, et plus vite). L'heure, qui change chaque
  // minute, la ferme : placée en tête, elle invalidait le cache de tout ce qui la suivait.
  const sections: string[] = [
    "Tu es l'assistant interne d'Adventum Pharma, un laboratoire pharmaceutique algérien. Tu réponds en français, avec rigueur et clarté, en t'appuyant uniquement sur les données de l'entreprise que te donnent tes outils.",
    `### RÈGLES FONDAMENTALES\n${reglesPour(outilsActifs).map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    `### PRÉSENTATION (UI générative)\n${CONSIGNE_COMPOSANTS}`,
    ...consignesGenerales.filter(Boolean),
    `### INTERLOCUTEUR\nNom : ${user.name}\nRôle : ${roleLabel}${user.secondaryRole ? ` (rôle secondaire : ${ROLE_LABELS[user.secondaryRole] ?? user.secondaryRole})` : ""}`,
    `### PÉRIMÈTRE D'ACCÈS (RBAC)\nModules ouverts à cet utilisateur :\n- ${modulesAccessibles.join("\n- ")}\nHors de ce périmètre, tu indiques avec courtoisie que le module ne lui est pas ouvert.`,
  ];

  if (consignesRole) {
    const { texte, censure } = censurerTexte(consignesRole);
    if (censure) censureGlobale = true;
    sections.push(`### CONSIGNES DU RÔLE\n${texte}`);
  }

  sections.push(...consignesPersonne.filter(Boolean));

  const adresse = adresseSure(page?.pathname);
  if (adresse) sections.push(`### ÉCRAN OUVERT\nPage : ${adresse}. Pour en connaître le contenu, utilise tes outils de lecture.`);

  // LA MÉMOIRE PERSONNELLE (couche c) : les souvenirs pertinents pour la question d'abord, dans leur enveloppe.
  const souvenirs = question === undefined ? memoireFaits : souvenirsPourQuestion(memoireFaits, question);
  if (souvenirs.length > 0) {
    const faits = souvenirs.map((f) => {
      const { texte, censure } = censurerTexte(f);
      if (censure) censureGlobale = true;
      return `- ${texte}`;
    });
    sections.push(`### MÉMOIRE DE L'INTERLOCUTEUR\n${faits.join("\n")}`);
  }

  sections.push(...sectionsDuTour.filter(Boolean));
  sections.push(`### HORODATAGE\nNous sommes le ${dateLisible}. Heure locale d'Alger : ${heureLisible}.`);

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
