import { prisma } from "@/lib/prisma";
import { getManagerOfUser, getDepartmentPath } from "@/lib/departments";
import { typedMemoryContext } from "@/lib/assistant/memory-context";
import { sansBloquer } from "@/lib/journal";

/**
 * MÉMOIRE DE L'ASSISTANT — strictement personnelle.
 *
 * ⚠️ RÈGLE ABSOLUE : ce fichier est la **seule porte d'entrée** vers les fils, messages et
 * mémoires d'assistant. Aucun autre module ne doit interroger `assistantThread`,
 * `assistantMessage` ou `assistantMemory` directement.
 *
 * Le cloisonnement n'est pas une convention, c'est une **structure** :
 *   1. toute fonction exige le `userId` du DEMANDEUR en premier paramètre ;
 *   2. tout `where` contient ce `userId` — un identifiant de fil deviné ne donne rien ;
 *   3. `AssistantMessage` porte lui aussi le `userId` (redondant avec son fil) : même une
 *      erreur de jointure ne peut pas exposer le message d'autrui ;
 *   4. le `userId` vient TOUJOURS de la session serveur, jamais du client.
 *
 * Conséquence : l'assistant du directeur des opérations ne peut pas atteindre celui du
 * Direction Marketing, littéralement — il n'existe aucun chemin de code pour le faire.
 */

// ───────────────────────────── Fils de conversation ─────────────────────────────

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}

/** Les fils de CETTE personne, du plus récent au plus ancien. */
export async function listThreads(userId: string, limit = 30): Promise<ThreadSummary[]> {
  const rows = await prisma.assistantThread.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title?.trim() || "Nouvelle conversation",
    updatedAt: t.updatedAt.toISOString(),
    messages: t._count.messages,
  }));
}

/**
 * CE QU'UNE COLONNE JSON ACCEPTE — déclaré ICI plutôt qu'importé de Prisma.
 *
 * La première version écrivait `as Prisma.InputJsonValue`, et le cliquet de frontière l'a
 * refusé : 429 franchissements pour un plafond de 428. Il avait raison, et le remède n'est pas
 * de relever le plafond (§118.72) — importer tout un espace de noms pour UNE conversion de
 * type est précisément le franchissement qu'il existe pour empêcher. La forme, elle, est
 * publique et stable : c'est celle de JSON.
 */
type ValeurJson = string | number | boolean | null | ValeurJson[] | { [cle: string]: ValeurJson };
/**
 * CE QU'ON ÉCRIT — jamais `null` NU. Prisma distingue « écris la valeur JSON null » de
 * « laisse la colonne vide », et le second est ce qu'on veut : un tour sans espace de
 * travail n'en a pas, et la colonne absente se relit « rien à rendre ». L'appelant a déjà
 * écarté `null` et `undefined` avant d'arriver ici ; le type ne fait que le dire.
 */
type JsonEcrit = Exclude<ValeurJson, null>;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /**
   * CE QU'ADAM AVAIT CONSTRUIT à ce tour — `WorkspaceComposition[]`, tel quel.
   *
   * Typé `unknown` ici parce que ce module est la MÉMOIRE, pas l'écran : lui donner le type
   * du protocole d'espace de travail le ferait dépendre d'une forme d'affichage, et le jour
   * où cette forme évolue, la mémoire refuserait de relire ce qu'elle a écrit. Elle rend ce
   * qu'elle a rangé ; c'est l'écran qui sait le lire, et qui ignore ce qu'il ne reconnaît pas.
   */
  workspace?: unknown;
}

/**
 * Messages d'un fil — **uniquement si ce fil appartient au demandeur**.
 * Renvoie `null` si le fil n'existe pas OU ne lui appartient pas : de l'extérieur, les
 * deux cas sont indiscernables (on ne révèle pas l'existence du fil d'autrui).
 *
 * PLAFONNÉ aux `limit` derniers messages : le fil principal vit des mois — on ne recharge
 * JAMAIS tout l'historique, le passé lointain se retrouve par `searchOwnMessages` et par la
 * mémoire distillée/typée.
 */
export async function getThreadMessages(
  userId: string, threadId: string, limit = 300,
  /**
   * FAUT-IL RAPPORTER CE QU'ADAM AVAIT CONSTRUIT ? Par défaut NON, et le défaut est le point.
   *
   * Quatre appelants lisent ce fil ; DEUX seulement rendent un écran. Les deux autres — la voix
   * temps réel (60 tours) et son orchestrateur (12) — n'en lisent que `role` et `content` pour
   * bâtir un contexte de modèle. Sélectionner la colonne pour tout le monde ferait traverser à
   * chaque tour de voix les tableaux et les graphiques de soixante tours, pour les jeter : le
   * genre de coût qu'on ne voit pas parce qu'il ne casse rien. Le défaut à FAUX est ce qui
   * garantit qu'un appelant futur paie ce qu'il a demandé, pas ce qu'un autre a eu besoin.
   */
  opts: { avecWorkspace?: boolean } = {},
): Promise<StoredMessage[] | null> {
  const thread = await prisma.assistantThread.findFirst({
    where: { id: threadId, userId }, // ← les DEUX conditions, toujours
    select: { id: true },
  });
  if (!thread) return null;
  const rows = await prisma.assistantMessage.findMany({
    where: { threadId, userId }, // ← ceinture ET bretelles
    // L'id (cuid, monotone) départage les messages écrits dans la même milliseconde
    // (question + réponse arrivent ensemble) : l'ordre reste strictement chronologique.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, limit),
    select: { role: true, content: true, createdAt: true, ...(opts.avecWorkspace ? { workspace: true as const } : {}) },
  });
  return rows
    .reverse()
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      // On ne rend la clé QUE si elle porte quelque chose : une clé présente à `null` ferait
      // croire à l'écran qu'un espace de travail existe et qu'il est vide (§118.71).
      ...(m.workspace == null ? {} : { workspace: m.workspace as unknown }),
    }));
}

/**
 * LE FIL PRINCIPAL — la conversation continue du Chief of Staff, une par personne.
 * La retrouve ou la crée ; si plusieurs existent (course), la plus ancienne fait foi.
 */
export async function ensurePrimaryThread(userId: string): Promise<string> {
  const existing = await prisma.assistantThread.findFirst({
    where: { userId, isPrimary: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const t = await prisma.assistantThread.create({
    data: { userId, isPrimary: true, title: "Fil principal" },
    select: { id: true },
  });
  return t.id;
}

export interface IdentifiedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/**
 * LES MESSAGES D'UN FIL POSTÉRIEURS À UN MESSAGE DONNÉ — la matière brute d'un ÉPISODE.
 *
 * ── POURQUOI CETTE FONCTION EXISTE PLUTÔT QU'UNE REQUÊTE AILLEURS ────────────────────────
 *
 * L'en-tête de ce fichier pose une règle sans exception : il est la SEULE porte vers
 * `assistantMessage`. Le découpage de la mémoire en épisodes (`missions/memory/`) a besoin des
 * tours bruts ET de leurs identifiants — que `getThreadMessages` ne rend pas, puisqu'il sert à
 * réafficher une conversation. Plutôt que d'ouvrir une seconde porte, on élargit celle-ci.
 *
 * Les IDENTIFIANTS sont ce qui rend l'épisode idempotent : la tranche est bornée par le premier
 * et le dernier message, et l'unicité en base porte sur ce couple. Sans eux, deux passages
 * enregistreraient deux souvenirs du même moment.
 *
 * `apres` est exclusif : on reprend là où le dernier épisode s'est arrêté.
 */
export async function messagesApres(
  userId: string, threadId: string, apres: string | null, limit = 200,
): Promise<IdentifiedMessage[]> {
  const thread = await prisma.assistantThread.findFirst({
    where: { id: threadId, userId },
    select: { id: true },
  });
  if (!thread) return [];

  let borne: { createdAt: Date; id: string } | null = null;
  if (apres) {
    const m = await prisma.assistantMessage.findFirst({
      where: { id: apres, userId },
      select: { id: true, createdAt: true },
    });
    // UN MARQUEUR INTROUVABLE NE FAIT PAS REPARTIR DE ZÉRO : le message a pu être effacé, et
    // relire tout le fil recréerait des épisodes déjà enregistrés. On ne rend rien, et le
    // prochain tour reposera la question avec un marqueur à jour.
    if (!m) return [];
    borne = m;
  }

  const rows = await prisma.assistantMessage.findMany({
    where: {
      threadId,
      userId,
      // « APRÈS » SE LIT SUR LE COUPLE (date, identifiant), pas sur la date seule. Une question
      // et sa réponse sont écrites d'un même geste et partagent leur milliseconde : un `>` sur la
      // date seule ferait disparaître de la mémoire la réponse dont la question a été mémorisée.
      // C'est le même ordre composite que la lecture d'un fil, pour la même raison.
      ...(borne
        ? {
            OR: [
              { createdAt: { gt: borne.createdAt } },
              { createdAt: borne.createdAt, id: { gt: borne.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.max(1, limit),
    select: { id: true, role: true, content: true, createdAt: true },
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role === "assistant" ? "assistant" as const : "user" as const,
    content: m.content,
    createdAt: m.createdAt,
  }));
}

export interface OwnMessageHit {
  threadId: string;
  threadTitle: string;
  role: "user" | "assistant";
  when: string;
  snippet: string;
}

/**
 * RECHERCHE dans SES PROPRES archives de conversation (« de quoi avait-on parlé au sujet
 * de… ? »). Jamais celles d'autrui : le `userId` borne les deux requêtes.
 */
export async function searchOwnMessages(userId: string, query: string, limit = 12): Promise<OwnMessageHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await prisma.assistantMessage.findMany({
    where: { userId, content: { contains: q, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 30),
    select: { threadId: true, role: true, content: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  const threads = await prisma.assistantThread.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.threadId))] }, userId },
    select: { id: true, title: true },
  });
  const titles = new Map(threads.map((t) => [t.id, t.title?.trim() || "Conversation"]));
  const needle = q.toLowerCase();
  return rows.map((r) => {
    const at = r.content.toLowerCase().indexOf(needle);
    const start = Math.max(0, (at < 0 ? 0 : at) - 120);
    const end = Math.min(r.content.length, (at < 0 ? 0 : at) + needle.length + 160);
    return {
      threadId: r.threadId,
      threadTitle: titles.get(r.threadId) ?? "Conversation",
      role: r.role === "assistant" ? "assistant" as const : "user" as const,
      when: r.createdAt.toISOString().slice(0, 10),
      snippet: `${start > 0 ? "…" : ""}${r.content.slice(start, end)}${end < r.content.length ? "…" : ""}`,
    };
  });
}

/** Crée un fil pour cette personne. Le titre est dérivé de sa première question. */
export async function createThread(userId: string, firstMessage?: string): Promise<string> {
  const title = firstMessage?.trim().slice(0, 80) || null;
  const t = await prisma.assistantThread.create({ data: { userId, title }, select: { id: true } });
  return t.id;
}

/**
 * Ajoute un échange (question puis réponse) à un fil appartenant au demandeur.
 * Si le fil ne lui appartient pas, on n'écrit RIEN et on renvoie false.
 */
export async function appendExchange(
  userId: string, threadId: string, userMessage: string, assistantReply: string,
  workspace?: unknown,
): Promise<boolean> {
  const owned = await prisma.assistantThread.findFirst({ where: { id: threadId, userId }, select: { id: true, title: true } });
  if (!owned) return false;
  await prisma.assistantMessage.createMany({
    data: [
      { threadId, userId, role: "user", content: userMessage },
      // `undefined` laisserait Prisma écrire NULL, ce qui est le bon défaut : un tour sans
      // espace de travail n'en a pas, et une colonne vide se relit comme « rien à rendre ».
      { threadId, userId, role: "assistant", content: assistantReply,
        ...(workspace === undefined || workspace === null ? {} : { workspace: workspace as JsonEcrit }) },
    ],
  });
  await prisma.assistantThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date(), ...(owned.title ? {} : { title: userMessage.trim().slice(0, 80) }) },
  });
  return true;
}

/** Supprime un fil — seulement s'il appartient au demandeur. */
export async function deleteThread(userId: string, threadId: string): Promise<boolean> {
  const { count } = await prisma.assistantThread.deleteMany({ where: { id: threadId, userId } });
  return count > 0;
}

/**
 * Efface TOUTE la mémoire d'une personne (droit à l'oubli, à sa main) : fils, messages,
 * mémoire distillée ET mémoire typée. Les registres de décisions/engagements restent —
 * ce sont des registres métier tenus volontairement, pas des souvenirs de conversation.
 */
export async function forgetEverything(userId: string): Promise<void> {
  await prisma.assistantThread.deleteMany({ where: { userId } });
  await prisma.assistantMessage.deleteMany({ where: { userId } });
  await prisma.assistantMemory.deleteMany({ where: { userId } });
  await prisma.assistantMemoryItem.deleteMany({ where: { userId } });
}

// ───────────────────────────── Mémoire distillée ─────────────────────────────

export async function getMemory(userId: string): Promise<string | null> {
  const m = await prisma.assistantMemory.findUnique({ where: { userId }, select: { summary: true } });
  return m?.summary ?? null;
}

/**
 * La distillation est-elle due ? On compare le nombre total de messages de la personne au
 * nombre déjà distillé (`turns`). Au-delà du seuil, la mémoire est réécrite (un seul appel
 * IA économique, très épisodique) — inutile de le faire à chaque échange.
 */
export async function distillationDue(userId: string, every = 12): Promise<boolean> {
  const [total, mem] = await Promise.all([
    prisma.assistantMessage.count({ where: { userId } }),
    prisma.assistantMemory.findUnique({ where: { userId }, select: { turns: true } }),
  ]);
  return total - (mem?.turns ?? 0) >= every;
}

/** Nombre de messages mémorisés pour cette personne (base du compteur de distillation). */
export async function countMessages(userId: string): Promise<number> {
  return prisma.assistantMessage.count({ where: { userId } });
}

export async function saveMemory(userId: string, summary: string, turns: number): Promise<void> {
  await prisma.assistantMemory.upsert({
    where: { userId },
    create: { userId, summary: summary.slice(0, 4000), turns },
    update: { summary: summary.slice(0, 4000), turns },
  });
}

/** Les N derniers échanges de la personne, toutes conversations confondues (distillation). */
export async function recentMessages(userId: string, limit = 60): Promise<StoredMessage[]> {
  const rows = await prisma.assistantMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { role: true, content: true, createdAt: true },
  });
  return rows
    .reverse()
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content, createdAt: m.createdAt.toISOString() }));
}

// ───────────────────────────── Contexte personnel ─────────────────────────────

/**
 * Ce que l'assistant sait de SA personne : identité, rattachement, hiérarchie, et ce qu'il
 * a retenu d'elle. Uniquement des données que la personne peut déjà voir sur son profil.
 */
export async function personalContext(userId: string): Promise<string> {
  const [user, memory, typed] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true, email: true, role: true, secondaryRole: true,
        department: { select: { name: true, id: true } },
        employee: { select: { id: true, position: true, departmentId: true, company: { select: { name: true, shortName: true } } } },
      },
    }),
    getMemory(userId),
    typedMemoryContext(userId).catch(sansBloquer("assistant-memory.personalContext.typedMemoryContext", "")),
  ]);
  if (!user) return "";

  const lines: string[] = [];
  lines.push(`Tu assistes ${user.name} (${user.email}).`);
  if (user.employee?.position) lines.push(`Poste : ${user.employee.position}.`);
  if (user.employee?.company) lines.push(`Entité : ${user.employee.company.shortName ?? user.employee.company.name}.`);

  // Rattachement : fil d'Ariane complet du département.
  const deptId = user.employee?.departmentId ?? user.department?.id ?? null;
  if (deptId) {
    const path = await getDepartmentPath(deptId).catch(sansBloquer("assistant-memory.personalContext.getDepartmentPath", []));
    if (path.length) lines.push(`Département : ${path.map((p) => p.name).join(" › ")}.`);
  }

  // N+1 réel (manager désigné → responsable de département → parent).
  const mgr = await getManagerOfUser(userId).catch(sansBloquer("assistant-memory.personalContext.getManagerOfUser", null));
  if (mgr) lines.push(`Son responsable hiérarchique (N+1) est ${mgr.fullName} — c'est lui qui valide ses demandes.`);

  if (memory) lines.push(`\nCE QUE TU AS RETENU DE CETTE PERSONNE (mémoire de vos échanges précédents) :\n${memory}`);
  if (typed) lines.push(typed);

  // ── LES RÈGLES ENSEIGNÉES (Teach Adam, §119) ────────────────────────────────────────
  //
  // Ce que la personne, son département et sa société ont APPRIS à Adam : résolu (périmètre,
  // précédence, dates d'effet) et composé sous budget par le code. Avant les souvenirs : une
  // règle en vigueur pèse plus qu'un épisode. Import différé pour les mêmes raisons que le
  // composeur de missions ci-dessous — et parce que la porte des conversations reste légère.
  const regles = await import("@/platform/in-process/teach/store")
    .then((m) => m.contexteRegles(userId))
    .catch(sansBloquer("assistant-memory.personalContext", ""));
  if (regles) lines.push(`\n${regles}`);

  // ── LA MÉMOIRE ÉPISODIQUE, COMPOSÉE SOUS BUDGET ────────────────────────────────────
  //
  // Ce que la note distillée ci-dessus ne sait pas faire : distinguer « ce qui s'est dit en
  // mars » de « ce qui s'est dit hier », et remonter une approbation encore en attente ou un
  // engagement qui n'est pas tenu. C'est l'objet des épisodes, et c'est ici qu'ils servent —
  // le seul endroit du produit où un souvenir daté atteint réellement le modèle.
  //
  // L'import est DIFFÉRÉ : ce module est la porte des conversations et il est chargé partout,
  // alors que le composeur de missions tire derrière lui la passerelle des modèles. Il l'est
  // aussi pour éviter un cycle — le composeur, lui, lit les tours bruts par ce fichier-ci.
  const episodique = await import("@/platform/in-process/missions/memory")
    .then((m) => m.contexteMemoire(userId))
    .catch(sansBloquer("assistant-memory.personalContext", ""));
  if (episodique) lines.push(episodique);

  lines.push(
    "\nCette mémoire et ces conversations sont STRICTEMENT PERSONNELLES : tu n'as jamais accès " +
    "aux conversations d'un autre collaborateur, et tu ne dois jamais prétendre le contraire.",
  );
  return lines.join("\n");
}

/**
 * LES RÈGLES SEULES — pour une personne dont la mémoire personnelle n'est PAS activée.
 *
 * Une règle enseignée (Teach Adam, §119) n'est pas un souvenir : c'est l'attestation d'une
 * personne, et elle s'applique que le drapeau « mémoire » soit posé ou non. Sans ce repli, la
 * route de conversation ne passait `personalContext` — qui porte le bloc de règles — qu'aux
 * comptes en mode test tant que le drapeau restait au stade TEST : une règle « pour toute la
 * société » posée par la Direction n'atteignait alors personne. `null` quand rien ne s'applique,
 * pour ne pas dépenser un bloc vide.
 */
export async function contexteReglesSeules(userId: string): Promise<string | null> {
  const regles = await import("@/platform/in-process/teach/store").then((m) => m.contexteRegles(userId)).catch(sansBloquer("assistant-memory.contexteReglesSeules", ""));
  return regles ? regles : null;
}
