import type { ClaudeToolDef } from "@/lib/models/compat";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { userCan, scopeRegulatory } from "@/lib/rbac";
import { PRIORITY, REGULATORY_STATUS, ROLE_LABELS, TASK_STATUS } from "@/lib/labels";
import { ACTOR_SCOPES, CATEGORY_LABELS, POWER_LABELS, SCOPE_LABELS, WORKFLOW_CATEGORIES, WORKFLOW_POWERS } from "@/lib/workflow/types";
import { collectifDesigne, CONSEIL_COLLECTIF, designationDePersonne, direCeQuiEstArrive } from "@/lib/personnes/designation";
import { sansBloquer } from "@/lib/journal";
import { resultatListe, resultatVide } from "@/platform/ia/lectures/empty-result";
import { readWorkflowState, resolveWorkflowCategory } from "@/platform/ia/lectures/workflow-admin";
import { asStr, isoDate, normPriority, resolvePerson } from "@/platform/ia/outils/arguments";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS QUE LES DEUX ASSISTANTS PARTAGENT — trois lectures, deux propositions d'écriture.
 *
 * L'Assistant IA (`lib/agent/outils-v1.ts`) réutilise cinq outils d'Adam tels quels (Q7, Q20 de sa
 * décision 0001 : « tous existants, aucun réécrit ») : `read_workflow`, `list_my_tasks`,
 * `search_products`, `create_task`, `send_message`. Il les obtenait en important le cœur d'Adam
 * (`assistantToolsFor`, `executeReadTool`, `buildProposal`) — c'est-à-dire tout Adam, son catalogue
 * d'outils et d'opérations, pour cinq outils.
 *
 * Les cinq vivent ici, DÉPLACÉS (pas recopiés) : leurs schémas, l'exécution des trois lectures, la
 * construction des deux cartes. Adam les reprend à leur rang dans ses catalogues, son exécuteur et
 * sa chaîne de propositions — il n'y a qu'une version de chacun.
 *
 * Ce que l'Assistant IA ne refait pas par ce chemin : le passage par `executePowerTool` qu'Adam fait
 * avant son `switch` (les skills dynamiques) — aucun skill ne peut porter l'un de ces cinq noms
 * (`nomOutil` préfixe toujours : `skill_…`, `playbook_…`, `<plugin>_…`), il rendait donc `null`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ───────────────────────────── Les schémas, tels que le modèle les voit ─────────────────────────────

export const DEF_READ_WORKFLOW: ClaudeToolDef = {
  name: "read_workflow",
  description:
    "Lit le CIRCUIT DE VALIDATION configurable d'une catégorie Ad&Pro (Sponsoring, Prise en charge "
    + "Internationale, Prise en charge Nationale, Événements) : étapes ordonnées avec titre, slug, qui agit "
    + "(portée + rôles, libellés ET codes), pouvoirs, options d'automatisme — plus les dictionnaires de codes "
    + "valides. À APPELER AVANT toute modification de circuit (configure_workflow attend la liste COMPLÈTE "
    + "recomposée). Les autres circuits de l'ERP (congés, recrutement, matériel promo…) sont codés en dur et "
    + "ne se configurent pas ici.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Catégorie : SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS (ou son libellé français)." },
    },
    required: ["category"],
  },
};

export const DEF_LIST_MY_TASKS: ClaudeToolDef = {
  name: "list_my_tasks",
  description: "Liste les tâches de l'utilisateur (assignées ou créées par lui). Par défaut les tâches non terminées.",
  input_schema: {
    type: "object",
    properties: { includeDone: { type: "boolean", description: "Inclure les tâches terminées." } },
  },
};

export const DEF_SEARCH_PRODUCTS: ClaudeToolDef = {
  name: "search_products",
  description:
    "Liste ou recherche les produits Regulatory que l'utilisateur a le droit de voir. " +
    "La recherche porte sur la DCI, le nom commercial, la référence, la CLASSE THÉRAPEUTIQUE (« oncologie », « biosimilaire »…), la forme galénique, le laboratoire partenaire et l'entité. " +
    "Sans `query`, renvoie TOUT le portefeuille (utiliser pour « donne-moi tous les produits »). " +
    "Augmenter `limit` pour un inventaire complet. Ne jamais inventer un produit.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Terme libre : DCI, nom commercial, référence, classe thérapeutique, forme, laboratoire ou entité. Omettre pour tout lister." },
      limit: { type: "number", description: "Nombre maximum de produits (défaut 40, maximum 300)." },
      category: { type: "string", enum: ["MEDICINE", "MEDICAL_DEVICE"], description: "Restreindre aux médicaments ou aux dispositifs médicaux." },
      withoutCompany: { type: "boolean", description: "Vrai pour ne remonter que les produits SANS entité rattachée." },
    },
  },
};

export const DEF_CREATE_TASK: ClaudeToolDef = {
  name: "create_task",
  description:
    "PROPOSE la création d'une tâche — LE MÊME CIRCUIT QUE L'ÉCRAN : pour soi c'est une to-do ; "
    + "pour un COLLÈGUE c'est une DEMANDE DE TÂCHE (il la reçoit en pop-up et l'ACCEPTE ou la REFUSE, "
    + "avec fil d'échange et dépôt du travail). Se PLANIFIE avec dueDate (échéance AAAA-MM-JJ) et une "
    + "priorité. N'exécute rien : confirmation requise. Résoudre d'abord le collègue avec search_people si besoin.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Intitulé clair de la tâche." },
      description: { type: "string", description: "Détails utiles." },
      assigneeName: { type: "string", description: "Nom du collègue à qui la demander (sinon soi-même)." },
      dueDate: { type: "string", description: "Échéance au format AAAA-MM-JJ (planification)." },
      priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
    },
    required: ["title"],
  },
};

export const DEF_SEND_MESSAGE: ClaudeToolDef = {
  name: "send_message",
  description:
    "PROPOSE l'envoi d'un message interne (messagerie) à un collègue. N'exécute rien : confirmation requise. Résoudre le destinataire avec search_people d'abord. Réservé aux utilisateurs ayant la messagerie.",
  input_schema: {
    type: "object",
    properties: {
      recipientName: { type: "string", description: "Nom d'UN collègue (une personne, jamais une équipe ni un service : pour écrire à une équipe, lister ses membres avec directory_list et écrire à chacun)." },
      body: { type: "string", description: "Texte du message à envoyer." },
    },
    required: ["recipientName", "body"],
  },
};

const DEFS_PARTAGEES: ClaudeToolDef[] = [DEF_READ_WORKFLOW, DEF_LIST_MY_TASKS, DEF_SEARCH_PRODUCTS, DEF_CREATE_TASK, DEF_SEND_MESSAGE];

/**
 * Les schémas des cinq outils pour une personne. Chez Adam, aucun des cinq n'est conditionné
 * (`READ_TOOLS` en entier ; `create_task` et `send_message` hors `ECRITURES_SOUS_CONDITION`) : la
 * liste est la même pour tous. Le DROIT se juge à l'exécution (`search_products` exige REGULATORY,
 * `send_message` la messagerie), comme chez Adam.
 */
export function outilsPartagesPour(_user: CurrentUser): ClaudeToolDef[] {
  return DEFS_PARTAGEES;
}

// ───────────────────────────── Les lectures ─────────────────────────────

/** Exécute l'une des trois lectures partagées. Elles ne rendent que des données déjà visibles par la personne. */
export async function executerLecturePartagee(name: string, input: Record<string, unknown>, user: CurrentUser): Promise<string> {
  switch (name) {
    case "read_workflow": {
      const cat = resolveWorkflowCategory(asStr(input, "category"));
      if (!cat) {
        return `Catégorie inconnue. Circuits configurables : ${WORKFLOW_CATEGORIES.map((c) => `${c} (${CATEGORY_LABELS[c]})`).join(", ")}. Les autres circuits de l'ERP sont codés en dur.`;
      }
      const state = await readWorkflowState(cat);
      return JSON.stringify({
        categorie: state.category,
        libelle: state.categoryLabel,
        nomDuCircuit: state.name,
        actif: state.isActive,
        etapes: state.steps ?? "Circuit PAR DÉFAUT (aucune personnalisation enregistrée) — la première sauvegarde via configure_workflow créera la définition.",
        dictionnaires: {
          portees: Object.fromEntries(ACTOR_SCOPES.map((s) => [s, SCOPE_LABELS[s]])),
          pouvoirs: Object.fromEntries(WORKFLOW_POWERS.map((p) => [p, POWER_LABELS[p]])),
          rolesValides: ROLE_LABELS,
        },
        regle: "Pour modifier : recomposer la LISTE COMPLÈTE des étapes (slugs existants conservés) et appeler configure_workflow — remplacement intégral, les demandes en cours gardent leur étape par slug.",
      });
    }
    case "list_my_tasks": {
      const includeDone = input.includeDone === true;
      const tasks = await prisma.task.findMany({
        where: {
          OR: [{ assignedToId: user.id }, { createdById: user.id }],
          ...(includeDone ? {} : { status: { in: ["TODO", "IN_PROGRESS"] } }),
        },
        select: { title: true, status: true, priority: true, dueDate: true, assignedTo: { select: { name: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: 20,
      });
      if (tasks.length === 0) return resultatVide("Aucune tâche.");
      return JSON.stringify(tasks.map((t) => ({
        titre: t.title, statut: TASK_STATUS[t.status]?.label ?? t.status, priorite: PRIORITY[t.priority]?.label ?? t.priority,
        echeance: t.dueDate?.toISOString().slice(0, 10) ?? null, assigneA: t.assignedTo?.name ?? null,
      })));
    }
    case "search_products": {
      if (!userCan(user, "REGULATORY", "VIEW")) return "Accès non autorisé au module Regulatory.";
      const q = asStr(input, "query");
      // Un inventaire complet doit être possible : « donne-moi tous les produits » échouait
      // parce que la recherche s'arrêtait à 12 lignes et ne regardait que DCI / nom / référence.
      const rawLimit = Number(input.limit);
      const take = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 40, 1), 300);
      const category = asStr(input, "category");
      const withoutCompany = input.withoutCompany === true;

      const like = (field: string) => ({ [field]: { contains: q, mode: "insensitive" as const } });
      const products = await prisma.regulatoryProduct.findMany({
        where: {
          AND: [
            scopeRegulatory(user),
            // La classe thérapeutique porte « oncologie », « biosimilaire », « anticorps
            // monoclonal » : sans elle, ces recherches ne remontaient rien.
            q
              ? {
                  OR: [
                    like("dci"), like("brandName"), like("reference"), like("therapeuticClass"),
                    like("pharmaceuticalForm"), like("partnerLab"), like("countryOfOrigin"),
                    { company: { is: { name: { contains: q, mode: "insensitive" } } } },
                    { company: { is: { shortName: { contains: q, mode: "insensitive" } } } },
                  ],
                }
              : {},
            category === "MEDICINE" || category === "MEDICAL_DEVICE" ? { category } : {},
            withoutCompany ? { companyId: null } : {},
          ],
        },
        select: {
          reference: true, dci: true, brandName: true, status: true, therapeuticClass: true,
          category: true, companyId: true, company: { select: { name: true, shortName: true } },
          // Le responsable et la priorité : sans eux, « un tableau de tous les dossiers avec leur
          // responsable » coûtait une fiche complète (`product_360`) PAR produit — mesuré au banc
          // des défis : sept appels et dix-sept secondes pour sept lignes.
          priority: true, responsible: { select: { name: true } },
        },
        take, orderBy: { createdAt: "desc" },
      });
      const total = await prisma.regulatoryProduct.count({ where: { AND: [scopeRegulatory(user)] } }).catch(sansBloquer("assistant.executeReadTool.regulatoryProduct", products.length));
      if (products.length === 0) {
        // Le compte du PORTEFEUILLE est conservé à part : il dit autre chose que le compte du
        // résultat, et le confondre ferait croire à 69 résultats trouvés.
        return resultatVide(
          `Aucun produit ne correspond${q ? ` à « ${q} »` : ""}. Le portefeuille compte ${total} produit(s) au total (ne pas inventer).`,
          { totalPortefeuille: total },
        );
      }
      // MÊME ENVELOPPE QUE LE CAS VIDE (§118.20) : `items` / `count` / `message` dans les deux,
      // et ce qui est propre au portefeuille à côté. Avant, les deux sorties de cette capacité
      // n'avaient pas une seule clé en commun.
      const lignes = products.map((p) => ({
          reference: p.reference, dci: p.dci, nomCommercial: p.brandName ?? null,
          classeTherapeutique: p.therapeuticClass ?? null,
          categorie: p.category,
          entite: p.company?.shortName ?? p.company?.name ?? null,
          statut: REGULATORY_STATUS[p.status]?.label ?? p.status,
          priorite: p.priority ?? null,
          responsable: p.responsible?.name ?? null,
      }));
      return resultatListe(lignes, `${lignes.length} produit(s) sur un portefeuille de ${total}.`, {
        total_portefeuille: total,
        renvoyes: lignes.length,
        tronque: lignes.length >= take,
        produits: lignes,
        // Une liste coupée qui ne le dit pas devient « les 40 produits » dans la réponse. `null`
        // et non l'absence de clé : `JSON.stringify` efface une clé indéfinie, et une clé qui
        // apparaît selon la donnée est le défaut qu'on répare ici.
        avertissement: lignes.length >= take
          ? `Liste TRONQUÉE à ${take} (portefeuille : ${total}) : pour un inventaire complet, rappeler avec un limit plus grand. Ne jamais présenter une liste tronquée comme complète.`
          : null,
      });
    }
    default:
      return `Outil de lecture inconnu : ${name}.`;
  }
}

// ───────────────────────────── Les propositions d'écriture ─────────────────────────────

/** Une carte à confirmer : rien ne s'écrit avant le geste de la personne. */
export interface PropositionPartagee {
  kind: "create_task" | "send_message";
  module: "WORKSPACE" | "MESSAGING";
  title: string;
  fields: { label: string; value: string }[];
  warnings: string[];
  payload:
    | { kind: "create_task"; title: string; description: string | null; assigneeId: string | null; assigneeName: string | null; dueDate: string | null; priority: string | null }
    | { kind: "send_message"; recipientId: string | null; recipientName: string | null; body: string };
}

/** Ce qu'une proposition reçoit : l'appel, la personne, les avertissements (mutés), la résolution de personne qui les alimente. */
export interface AppelProposition {
  toolName: string;
  input: Record<string, unknown>;
  user: CurrentUser;
  warnings: string[];
  resolve: (label: string, brut: unknown) => Promise<{ id: string | null; name: string | null }>;
}

/**
 * Résout une DÉSIGNATION de personne et alimente les avertissements.
 *
 * Elle n'arrive pas toujours en chaîne. Un éventail de mission déploie la sortie de
 * `resolve_person` — un objet `{ nom, adresse, source, detail }` — directement sur l'entrée.
 * Le lecteur d'avant appelait `asStr`, obtenait `""`, et refusait « Destinataire «  »
 * introuvable » sur une personne dont il tenait le nom ET l'adresse. `designationDePersonne`
 * traduit ; il rend `null` sur ce qu'il ne lit pas à coup sûr, et le refus dit alors ce qu'il
 * a réellement reçu au lieu d'un vide trompeur.
 */
export function resolveurDePersonnes(warnings: string[]): AppelProposition["resolve"] {
  return async function resolve(label, brut) {
    const name = designationDePersonne(brut);
    if (!name) {
      // « Rien fourni » n'est pas « fourni et illisible » : le premier est banal, le second est
      // une anomalie qui doit se voir.
      const vide = brut === undefined || brut === null || (typeof brut === "string" && !brut.trim())
        || (Array.isArray(brut) && brut.length === 0);
      if (!vide) warnings.push(`${label} illisible : ${direCeQuiEstArrive(brut)} — ni nom ni adresse exploitable.`);
      return { id: null, name: null };
    }
    const r = await resolvePerson(name);
    if (!r) {
      warnings.push(`${label} « ${name} » introuvable dans l'annuaire — à préciser.`);
      return { id: null, name };
    }
    if ("ambiguous" in r) {
      warnings.push(`Plusieurs « ${name} » : ${r.ambiguous.map((m) => m.name).join(", ")}. À préciser.`);
      return { id: null, name };
    }
    return { id: r.id, name: r.name };
  };
}

/** `create_task` : une to-do pour soi, une DEMANDE de tâche pour un collègue (le circuit de l'écran). */
export async function proposerTache(c: AppelProposition): Promise<PropositionPartagee | { error: string }> {
  const { input, user, warnings, resolve } = c;
  const title = asStr(input, "title");
  if (!title) return { error: "Intitulé de tâche manquant." };
  const assignee = await resolve("Destinataire", input.assigneeName);
  const due = asStr(input, "dueDate") ? isoDate(asStr(input, "dueDate")) : null;
  const priority = asStr(input, "priority") ? normPriority(asStr(input, "priority")) : null;
  // LE MÊME CIRCUIT QUE L'ÉCRAN : pour un collègue, c'est une DEMANDE qui s'accepte ou se
  // refuse — la carte le dit avant la confirmation, pas après.
  const isRequest = Boolean(assignee.id) && assignee.id !== user.id;
  const fields = [
    { label: "Tâche", value: title },
    { label: isRequest ? "Demandée à" : "Assignée à", value: assignee.name ?? `${user.name} (vous)` },
  ];
  if (asStr(input, "description")) fields.push({ label: "Détails", value: asStr(input, "description") });
  if (due) fields.push({ label: "Échéance", value: due });
  if (priority) fields.push({ label: "Priorité", value: PRIORITY[priority]?.label ?? priority });
  if (isRequest) {
    warnings.push(`${assignee.name} recevra la demande en POP-UP et pourra l'ACCEPTER ou la REFUSER — même circuit que l'écran.`);
  }
  return {
    kind: "create_task", module: "WORKSPACE",
    title: isRequest ? `Demander une tâche à ${assignee.name}` : "Créer une tâche",
    fields, warnings,
    payload: {
      kind: "create_task", title, description: asStr(input, "description") || null,
      assigneeId: assignee.id, assigneeName: assignee.name, dueDate: due, priority,
    },
  };
}

/** `send_message` : un message interne à UN collègue. */
export async function proposerMessage(c: AppelProposition): Promise<PropositionPartagee | { error: string }> {
  const { input, user, warnings, resolve } = c;
  if (!userCan(user, "MESSAGING", "VIEW")) return { error: "Vous n'avez pas accès à la messagerie." };
  const body = asStr(input, "body");
  if (!body) return { error: "Le message est vide." };
  const recipient = await resolve("Destinataire", input.recipientName);
  if (!recipient.id) {
    /**
     * UN REFUS NOMME LE REMÈDE DE CELUI QUI LE LIT (§118.68).
     *
     * « Précisez le bon collègue » est écrit pour une personne devant un écran. Dans une
     * MISSION, c'est le planificateur qui lit — et il l'a suivi à la lettre : le sous-plan
     * suivant posait la question au DIRIGEANT, et la mission s'est arrêtée là. Quand la
     * désignation est un COLLECTIF, le remède est le même pour les deux lecteurs et il est
     * ailleurs : lister les personnes, puis déployer.
     */
    const collectif = collectifDesigne(input.recipientName);
    return { error: collectif
      ? `Destinataire « ${direCeQuiEstArrive(input.recipientName)} » : « ${collectif} » désigne un GROUPE, pas une personne. ${CONSEIL_COLLECTIF}`
      : `Destinataire « ${direCeQuiEstArrive(input.recipientName)} » introuvable ou ambigu — précisez le bon collègue (search_people).` };
  }
  return {
    kind: "send_message", module: "MESSAGING", title: "Envoyer un message", warnings,
    fields: [
      { label: "À", value: recipient.name ?? "" },
      { label: "Message", value: body },
    ],
    payload: { kind: "send_message", recipientId: recipient.id, recipientName: recipient.name, body },
  };
}

/** La carte d'un des deux outils d'écriture partagés — ce que l'Assistant IA appelle à la place de `buildProposal`. */
export async function construirePropositionPartagee(toolName: string, input: Record<string, unknown>, user: CurrentUser): Promise<PropositionPartagee | { error: string }> {
  const warnings: string[] = [];
  const c: AppelProposition = { toolName, input, user, warnings, resolve: resolveurDePersonnes(warnings) };
  if (toolName === "create_task") return proposerTache(c);
  if (toolName === "send_message") return proposerMessage(c);
  return { error: `Action non prise en charge : ${toolName}.` };
}
