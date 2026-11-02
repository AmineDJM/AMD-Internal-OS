import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { searchOwnMessages } from "@/lib/assistant-memory";
import { algiersToUtc } from "@/lib/assistant/reminders";
import { MEMORY_TYPES, MEMORY_TYPE_LABEL, isMemoryType, foldText, type MemoryType } from "@/lib/assistant/memory-context";

/**
 * MÉMOIRE, DÉCISIONS, ENGAGEMENTS — les registres personnels du Chief of Staff.
 *
 * Ces outils écrivent DIRECTEMENT (sans carte de confirmation) parce qu'ils ne touchent que
 * le carnet privé de la personne connectée : sa mémoire, son registre de décisions, ses
 * engagements suivis. Rien ici ne contacte, n'assigne, ne modifie ni ne décide à la place de
 * qui que ce soit — c'est la frontière exacte avec les actions EXTERNES, qui passent toutes
 * par proposition + confirmation (ACTION_POLICY).
 *
 * Trois règles :
 *   • tout est cloisonné par `user.id` — un identifiant deviné ne donne rien ;
 *   • la mémoire n'est JAMAIS la source de vérité d'une donnée métier ;
 *   • enregistrer une décision ou un engagement n'exécute JAMAIS ses conséquences —
 *     un retard se VOIT (alertes), il ne déclenche rien tout seul.
 */

/** Le siège exécutif : registres de décisions et d'engagements (PDG + Super Admin). */
const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const strList = (input: Record<string, unknown>, key: string): string[] =>
  Array.isArray(input[key])
    ? (input[key] as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()).slice(0, 12)
    : [];

/** « AAAA-MM-JJ » ou « AAAA-MM-JJ HH:mm » (heure d'Alger) → instant UTC. */
function dateOf(raw: string, defaultTime: string): Date | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/);
  if (!m) return null;
  return algiersToUtc(m[1], m[2] ?? defaultTime);
}

const ymd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * « fournisseur seringues » doit trouver « Fournisseur B retenu pour les seringues » :
 * CHAQUE mot doit apparaître dans AU MOINS UN des champs — pas la phrase exacte.
 */
function tokenSearch(q: string, fields: string[]): { AND: { OR: Record<string, { contains: string; mode: "insensitive" }>[] }[] } | null {
  const tokens = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 6);
  if (tokens.length === 0) return null;
  return {
    AND: tokens.map((t) => ({
      OR: fields.map((f) => ({ [f]: { contains: t, mode: "insensitive" as const } })),
    })),
  };
}

/** Plafond d'hygiène : au-delà, c'est que quelque chose spamme la mémoire. */
const MAX_ACTIVE_MEMORIES = 400;

const MEMORY_KEEP_NOTE =
  "La mémoire n'est jamais la source de vérité d'une donnée métier : salaires, stocks, statuts se relisent toujours à la source.";

// ─────────────────────────── MÉMOIRE TYPÉE ───────────────────────────

export const MEMORY_TOOLS: PowerTool[] = [
  {
    def: {
      name: "remember",
      description:
        "RETIENT durablement quelque chose que dit l'utilisateur (« Retiens que… », « Désormais appelle X Y », « Je préfère… »). " +
        "Pour un ALIAS ou un terme maison, remplir `alias` + `target` (ex. alias « pembro », target « Pembrolizumab ») : la recherche " +
        "s'en servira automatiquement. Sinon, `content` en une phrase claire. Types : USER_PREFERENCE (préférence), WORKING_STYLE, " +
        "TERMINOLOGY, ENTITY_ALIAS, STRATEGIC_PRIORITY, RECURRING_INTEREST, REPORTING_PREFERENCE, ORGANIZATIONAL_CONTEXT, EXECUTIVE_PRINCIPLE. " +
        "NE PAS transformer chaque phrase en mémoire : ne retenir que ce qui est explicitement demandé ou manifestement durable. " +
        "Une RÈGLE de conduite (comment agir, un standard de document, un seuil, un workflow, une correspondance de termes valable pour la société, une exception) se donne à teach_adam, pas ici. " +
        "⚠️ Ne JAMAIS y stocker une donnée métier (salaire, montant, stock) comme vérité — elle se relit à la source.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "La mémoire, en une phrase (obligatoire sauf si alias+target sont donnés)." },
          type: { type: "string", enum: [...MEMORY_TYPES], description: "Type de mémoire. Défaut : USER_PREFERENCE (ou ENTITY_ALIAS si alias+target)." },
          alias: { type: "string", description: "Pour un alias/terme maison : le raccourci employé (ex. « pembro », « la DT »)." },
          target: { type: "string", description: "Ce que l'alias désigne réellement (ex. « Pembrolizumab », « Direction technique »)." },
        },
      },
    },
    allowed: () => true,
    label: "Mémoire enregistrée",
    run: async (input, user) => {
      const alias = str(input, "alias");
      const target = str(input, "target");
      const rawType = str(input, "type");
      let content = str(input, "content");

      let type: MemoryType;
      if (rawType && isMemoryType(rawType)) type = rawType;
      else if (rawType) return `Type de mémoire inconnu « ${rawType} ». Types possibles : ${MEMORY_TYPES.join(", ")}.`;
      else type = alias && target ? "ENTITY_ALIAS" : "USER_PREFERENCE";

      let structuredData: { alias: string; target: string } | undefined;
      if (alias && target) {
        structuredData = { alias, target };
        if (!content) content = `${alias} = ${target}`;
      }
      // §118.20 : même forme qu'un enregistrement réussi — une phrase nue tuerait toute
      // référence qu'un plan aurait écrite sur `retenu`.
      if (!content) {
        return JSON.stringify({
          retenu: null, type: null, id: null,
          precision: "Rien à retenir : donner `content`, ou `alias` + `target` pour un terme maison.",
        });
      }
      if (content.length > 600) content = content.slice(0, 600);

      // Un alias déjà connu se MET À JOUR (« finalement, la DT c'est la Direction Technique ») —
      // on ne laisse pas deux versions se contredire.
      if (structuredData) {
        const candidates = await prisma.assistantMemoryItem.findMany({
          where: { userId: user.id, active: true, type: { in: ["ENTITY_ALIAS", "TERMINOLOGY"] } },
          select: { id: true, structuredData: true, content: true },
          take: 300,
        });
        const same = candidates.find((c) => {
          const d = c.structuredData as { alias?: unknown } | null;
          const prev = d && typeof d.alias === "string" ? d.alias : c.content.split("=")[0] ?? "";
          return foldText(prev.trim()) === foldText(alias);
        });
        if (same) {
          await prisma.assistantMemoryItem.update({
            where: { id: same.id },
            data: { type, content, structuredData, active: true, lastUsedAt: new Date() },
          });
          await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Mémoire mise à jour — ${content.slice(0, 120)}` });
          return JSON.stringify({ retenu: content, type: MEMORY_TYPE_LABEL[type], misAJour: true, note: MEMORY_KEEP_NOTE });
        }
      } else {
        const dup = await prisma.assistantMemoryItem.findFirst({
          where: { userId: user.id, active: true, type, content: { equals: content, mode: "insensitive" } },
          select: { id: true },
        });
        if (dup) {
          await prisma.assistantMemoryItem.update({ where: { id: dup.id }, data: { lastUsedAt: new Date() } });
          return JSON.stringify({ retenu: content, type: MEMORY_TYPE_LABEL[type], dejaConnu: true });
        }
      }

      const active = await prisma.assistantMemoryItem.count({ where: { userId: user.id, active: true } });
      if (active >= MAX_ACTIVE_MEMORIES) {
        return `La mémoire compte déjà ${active} éléments actifs — en oublier avant d'en ajouter (forget_memory), ou me dire lesquels fusionner.`;
      }

      const created = await prisma.assistantMemoryItem.create({
        data: { userId: user.id, type, content, structuredData },
        select: { id: true },
      });
      await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Mémoire retenue — ${content.slice(0, 120)}` });
      return JSON.stringify({ retenu: content, type: MEMORY_TYPE_LABEL[type], id: created.id, note: MEMORY_KEEP_NOTE });
    },
  },
  {
    def: {
      name: "list_memories",
      description:
        "Liste ce que l'assistant a RETENU de l'utilisateur (mémoire durable) : alias, préférences, priorités, principes. " +
        "À utiliser pour « qu'as-tu retenu de moi ? », « quels alias connais-tu ? », ou avant d'oublier quelque chose.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...MEMORY_TYPES], description: "Filtrer sur un type. Omettre pour tout." },
        },
      },
    },
    allowed: () => true,
    label: "Mémoire consultée",
    run: async (input, user) => {
      const rawType = str(input, "type");
      const rows = await prisma.assistantMemoryItem.findMany({
        where: { userId: user.id, active: true, ...(rawType && isMemoryType(rawType) ? { type: rawType } : {}) },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, type: true, content: true, updatedAt: true, lastUsedAt: true },
      });
      if (rows.length === 0) return rawType ? `Aucune mémoire de type ${rawType}.` : "Je n'ai encore rien retenu durablement pour vous.";
      return JSON.stringify({
        total: rows.length,
        elements: rows.map((r) => ({
          id: r.id,
          type: isMemoryType(r.type) ? MEMORY_TYPE_LABEL[r.type] : r.type,
          contenu: r.content,
          depuis: ymd(r.updatedAt),
          dernierUsage: ymd(r.lastUsedAt),
        })),
      });
    },
  },
  {
    def: {
      name: "forget_memory",
      description:
        "OUBLIE une mémoire durable (« Oublie ça », « Ne retiens plus que… »). `reference` = l'identifiant exact (via list_memories) " +
        "ou un fragment du contenu. Si plusieurs mémoires correspondent, l'outil les liste au lieu de choisir à votre place.",
      input_schema: {
        type: "object",
        properties: { reference: { type: "string", description: "Identifiant de la mémoire, ou fragment de son contenu." } },
        required: ["reference"],
      },
    },
    allowed: () => true,
    label: "Mémoire oubliée",
    run: async (input, user) => {
      const ref = str(input, "reference");
      if (!ref) return "Préciser quelle mémoire oublier (identifiant ou fragment du contenu).";

      const exact = await prisma.assistantMemoryItem.findFirst({
        where: { id: ref, userId: user.id, active: true },
        select: { id: true, content: true },
      });
      let victim = exact;
      if (!victim) {
        const matches = await prisma.assistantMemoryItem.findMany({
          where: { userId: user.id, active: true, content: { contains: ref, mode: "insensitive" } },
          select: { id: true, content: true },
          take: 8,
        });
        // §118.20 : une seule forme — `oublie` porte ce qui a été oublié (null si rien),
        // `candidats` l'ambiguïté (vide si aucune), `precision` toujours la phrase.
        if (matches.length === 0) {
          return JSON.stringify({ oublie: null, candidats: [], precision: `Aucune mémoire ne contient « ${ref} ».` });
        }
        if (matches.length > 1) {
          return JSON.stringify({
            oublie: null,
            candidats: matches.map((m) => ({ id: m.id, contenu: m.content })),
            precision: `${matches.length} mémoires contiennent « ${ref} » — préciser laquelle (par son id). Aucune n'a été oubliée.`,
          });
        }
        victim = matches[0];
      }
      // Désactivée, pas effacée : l'audit garde la trace, et « oublie » reste réversible côté admin.
      await prisma.assistantMemoryItem.update({ where: { id: victim.id }, data: { active: false } });
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Mémoire oubliée — ${victim.content.slice(0, 120)}` });
      return JSON.stringify({ oublie: victim.content, candidats: [], precision: "Mémoire désactivée, pas effacée : l'audit garde la trace." });
    },
  },
  {
    def: {
      name: "recall_conversation",
      description:
        "RETROUVE un échange passé dans VOS conversations avec l'assistant (« de quoi avait-on parlé au sujet de… ? », " +
        "« qu'est-ce que je t'avais dit sur X ? »). Cherche dans tout votre historique, toutes conversations confondues, et " +
        "renvoie les extraits datés. Ne voit JAMAIS les conversations d'autrui.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Le sujet recherché (mots du message)." },
          limit: { type: "number", description: "Nombre maximum d'extraits (défaut 8, max 20)." },
        },
        required: ["query"],
      },
    },
    allowed: () => true,
    label: "Archives de conversation consultées",
    run: async (input, user) => {
      /**
       * UNE SEULE FORME (§118.20) : les clés ne changent pas selon ce qu'on trouve. Cet outil
       * rendait une PHRASE quand la requête était trop courte ou vide de résultats, et un OBJET
       * sinon — un plan qui écrit `{{archives.extraits.0.extrait}}` mourait donc exactement le
       * jour où il n'y avait rien à citer. C'est la liste VIDE qui dit l'absence, et `precision`
       * qui dit pourquoi : « rien trouvé » et « je n'ai pas cherché » ne se corrigent pas de la
       * même façon.
       */
      const repondre = (extraits: Record<string, unknown>[], precision: string): string =>
        JSON.stringify({ recherche: str(input, "query"), total: extraits.length, extraits, precision });

      const q = str(input, "query");
      if (q.length < 2) {
        return repondre([], "La liste est vide parce que la RECHERCHE n'a pas été posée : donner au moins deux caractères.");
      }
      const rawLimit = typeof input.limit === "number" ? input.limit : 8;
      const hits = await searchOwnMessages(user.id, q, Math.min(Math.max(Math.round(rawLimit), 1), 20));
      if (hits.length === 0) {
        return repondre([], `Aucune trace de « ${q} » dans vos conversations — la recherche a bien eu lieu, sur vos messages seuls.`);
      }
      return repondre(
        hits.map((h) => ({
          conversation: h.threadTitle,
          date: h.when,
          qui: h.role === "user" ? "vous" : "l'assistant",
          extrait: h.snippet,
        })),
        `${hits.length} extrait(s) de VOS conversations — pas celles des autres.`,
      );
    },
  },

  // ─────────────────────────── REGISTRE DES DÉCISIONS ───────────────────────────
  {
    def: {
      name: "record_decision",
      description:
        "ENREGISTRE une décision exécutive au registre (« Note la décision : on choisit le fournisseur B parce que… »), pour la " +
        "retrouver des mois plus tard avec son contexte, ses options écartées, son résultat attendu — et plus tard son résultat RÉEL. " +
        "ENREGISTRER n'EXÉCUTE RIEN : aucune conséquence n'est déclenchée. `review_on` planifie une date de relecture (elle remontera " +
        "dans les décisions « à revoir », sans aucune action automatique).",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "La décision, en une phrase (ex. « Fournisseur B retenu pour les seringues »)." },
          context: { type: "string", description: "Le contexte au moment de décider." },
          problem: { type: "string", description: "Le problème que la décision tranche." },
          options: { type: "array", items: { type: "string" }, description: "Les options envisagées, y compris celles écartées." },
          recommendation: { type: "string", description: "Ce que l'assistant recommandait, le cas échéant." },
          decision: { type: "string", description: "Ce qui a été décidé, précisément." },
          status: { type: "string", enum: ["PROPOSED", "DECIDED"], description: "PROPOSED = à l'étude ; DECIDED (défaut) = tranchée." },
          decided_on: { type: "string", description: "Date de la décision AAAA-MM-JJ (défaut : aujourd'hui si DECIDED)." },
          expected_outcome: { type: "string", description: "Le résultat attendu (mesurable si possible)." },
          review_on: { type: "string", description: "Date de relecture AAAA-MM-JJ (« on rejuge dans 3 mois »)." },
          entities: { type: "array", items: { type: "string" }, description: "Références concernées (PAY-…, fournisseur, produit…)." },
        },
        required: ["title"],
      },
    },
    allowed: EXEC,
    label: "Décision enregistrée au registre",
    run: async (input, user) => {
      const title = str(input, "title");
      if (!title) return "Donner la décision en une phrase (`title`).";
      const status = str(input, "status") === "PROPOSED" ? "PROPOSED" : "DECIDED";
      const decidedOn = str(input, "decided_on") ? dateOf(str(input, "decided_on"), "12:00") : null;
      const reviewOn = str(input, "review_on") ? dateOf(str(input, "review_on"), "09:00") : null;
      if (str(input, "review_on") && !reviewOn) return "Date de relecture illisible (AAAA-MM-JJ).";
      const options = strList(input, "options");
      const entities = strList(input, "entities");

      const created = await prisma.executiveDecision.create({
        data: {
          ownerId: user.id,
          title: title.slice(0, 300),
          context: str(input, "context") || null,
          problem: str(input, "problem") || null,
          options: options.length ? options : undefined,
          recommendation: str(input, "recommendation") || null,
          decision: str(input, "decision") || null,
          status,
          decidedAt: decidedOn ?? (status === "DECIDED" ? new Date() : null),
          expectedOutcome: str(input, "expected_outcome") || null,
          reviewDate: reviewOn,
          entities: entities.length ? entities : undefined,
        },
        select: { id: true },
      });
      await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Décision enregistrée — ${title.slice(0, 120)}` });
      return JSON.stringify({
        enregistree: title,
        statut: status === "PROPOSED" ? "à l'étude" : "tranchée",
        relecture: ymd(reviewOn),
        id: created.id,
        note: "Enregistrer une décision n'exécute jamais ses conséquences — les actions restent à décider une à une.",
      });
    },
  },
  {
    def: {
      name: "list_decisions",
      description:
        "Consulte le REGISTRE DES DÉCISIONS : « qu'avait-on décidé sur X ? », « pourquoi avait-on choisi B ? », « quelles décisions " +
        "sont à revoir ? ». `due_for_review` = seulement celles dont la date de relecture est atteinte et sans résultat consigné.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Mots du titre, du contexte ou de la décision." },
          status: { type: "string", enum: ["PROPOSED", "DECIDED", "REVIEWED", "ABANDONED"], description: "Filtrer sur un statut." },
          due_for_review: { type: "boolean", description: "true = décisions dont la relecture est due." },
          limit: { type: "number", description: "Nombre maximum (défaut 10, max 30)." },
        },
      },
    },
    allowed: EXEC,
    label: "Registre des décisions consulté",
    run: async (input, user) => {
      const q = str(input, "query");
      const status = str(input, "status");
      const dueForReview = input.due_for_review === true;
      const rawLimit = typeof input.limit === "number" ? input.limit : 10;
      const limit = Math.min(Math.max(Math.round(rawLimit), 1), 30);

      const search = q ? tokenSearch(q, ["title", "context", "decision", "problem"]) : null;
      const rows = await prisma.executiveDecision.findMany({
        where: {
          ownerId: user.id,
          ...(status ? { status } : {}),
          ...(dueForReview ? { reviewDate: { lte: new Date() }, status: { in: ["PROPOSED", "DECIDED"] } } : {}),
          ...(search ?? {}),
        },
        orderBy: dueForReview ? { reviewDate: "asc" } : { createdAt: "desc" },
        take: limit,
        select: {
          id: true, title: true, status: true, decidedAt: true, decision: true, recommendation: true,
          expectedOutcome: true, reviewDate: true, actualOutcome: true, lessonsLearned: true,
          context: true, problem: true, options: true, entities: true,
        },
      });
      if (rows.length === 0) {
        return dueForReview
          ? "Aucune décision n'attend de relecture."
          : q
            ? `Aucune décision au registre ne mentionne « ${q} ».`
            : "Le registre des décisions est vide pour l'instant.";
      }
      const STATUS_FR: Record<string, string> = { PROPOSED: "à l'étude", DECIDED: "tranchée", REVIEWED: "relue (résultat consigné)", ABANDONED: "abandonnée" };
      return JSON.stringify({
        total: rows.length,
        decisions: rows.map((r) => ({
          id: r.id,
          titre: r.title,
          statut: STATUS_FR[r.status] ?? r.status,
          decideLe: ymd(r.decidedAt),
          probleme: r.problem,
          contexte: r.context,
          options: r.options ?? undefined,
          recommandation: r.recommendation,
          decision: r.decision,
          resultatAttendu: r.expectedOutcome,
          relecturePrevue: ymd(r.reviewDate),
          resultatReel: r.actualOutcome,
          lecons: r.lessonsLearned,
          references: r.entities ?? undefined,
        })),
      });
    },
  },
  {
    def: {
      name: "update_decision_outcome",
      description:
        "CONSIGNE le RÉSULTAT RÉEL d'une décision du registre (« résultat : les délais ont doublé, leçon : … »), ou change son statut " +
        "(REVIEWED = relue, ABANDONED = abandonnée). Une bonne décision peut produire un mauvais résultat : consigner les deux séparément. " +
        "`reference` = identifiant exact ou fragment du titre.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Identifiant de la décision, ou fragment de son titre." },
          actual_outcome: { type: "string", description: "Le résultat réellement observé." },
          lessons_learned: { type: "string", description: "Ce qu'on en retient pour la prochaine fois." },
          status: { type: "string", enum: ["DECIDED", "REVIEWED", "ABANDONED"], description: "Nouveau statut (défaut REVIEWED quand un résultat est consigné)." },
          decision: { type: "string", description: "Corriger l'énoncé de ce qui a été décidé." },
          expected_outcome: { type: "string", description: "Corriger le résultat attendu." },
          review_on: { type: "string", description: "Nouvelle date de relecture AAAA-MM-JJ." },
        },
        required: ["reference"],
      },
    },
    allowed: EXEC,
    label: "Résultat de décision consigné",
    run: async (input, user) => {
      const ref = str(input, "reference");
      if (!ref) return "Préciser la décision (identifiant ou fragment du titre).";
      const exact = await prisma.executiveDecision.findFirst({ where: { id: ref, ownerId: user.id }, select: { id: true, title: true } });
      let target = exact;
      if (!target) {
        const matches = await prisma.executiveDecision.findMany({
          where: { ownerId: user.id, title: { contains: ref, mode: "insensitive" } },
          select: { id: true, title: true },
          take: 6,
        });
        if (matches.length === 0) {
          return JSON.stringify({ decision: null, misAJour: false, candidats: [], precision: `Aucune décision du registre ne correspond à « ${ref} ».` });
        }
        if (matches.length > 1) {
          return JSON.stringify({
            decision: null, misAJour: false,
            candidats: matches.map((m) => ({ id: m.id, titre: m.title })),
            precision: "Plusieurs décisions correspondent — préciser par l'id. Aucune n'a été modifiée.",
          });
        }
        target = matches[0];
      }

      const actualOutcome = str(input, "actual_outcome");
      const reviewOn = str(input, "review_on") ? dateOf(str(input, "review_on"), "09:00") : null;
      if (str(input, "review_on") && !reviewOn) {
        return JSON.stringify({ decision: null, misAJour: false, candidats: [], precision: "Date de relecture illisible (AAAA-MM-JJ)." });
      }
      const rawStatus = str(input, "status");
      const status = ["DECIDED", "REVIEWED", "ABANDONED"].includes(rawStatus) ? rawStatus : actualOutcome ? "REVIEWED" : null;

      await prisma.executiveDecision.update({
        where: { id: target.id },
        data: {
          ...(actualOutcome ? { actualOutcome } : {}),
          ...(str(input, "lessons_learned") ? { lessonsLearned: str(input, "lessons_learned") } : {}),
          ...(str(input, "decision") ? { decision: str(input, "decision") } : {}),
          ...(str(input, "expected_outcome") ? { expectedOutcome: str(input, "expected_outcome") } : {}),
          ...(reviewOn ? { reviewDate: reviewOn } : {}),
          ...(status ? { status } : {}),
        },
      });
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Décision « ${target.title.slice(0, 100)} » — résultat/statut consigné` });
      return JSON.stringify({ decision: target.title, misAJour: true, candidats: [], statut: status ?? null, precision: "Décision mise à jour au registre." });
    },
  },

  // ─────────────────────────── ENGAGEMENTS ───────────────────────────
  {
    def: {
      name: "record_commitment",
      description:
        "ENREGISTRE un ENGAGEMENT à suivre (« le fournisseur X livrera le 15 », « Nesrine rend le rapport vendredi », « j'ai promis " +
        "une réponse à la banque lundi »). AUCUNE relance automatique n'en découle : un engagement en retard REMONTE dans les alertes " +
        "du propriétaire, c'est tout. Pour une vraie surveillance avec rappel, utiliser plan_reminder en plus (sur instruction).",
      input_schema: {
        type: "object",
        properties: {
          who: { type: "string", description: "QUI s'est engagé (personne, fournisseur, équipe — texte libre)." },
          what: { type: "string", description: "Ce qui est promis, précisément." },
          to_whom: { type: "string", description: "Envers qui (omettre si c'est envers vous)." },
          due_on: { type: "string", description: "Échéance AAAA-MM-JJ (ou AAAA-MM-JJ HH:mm, heure d'Alger)." },
          promised_on: { type: "string", description: "Date de la promesse AAAA-MM-JJ (défaut : aujourd'hui)." },
          source: { type: "string", description: "D'où vient l'engagement — la preuve (e-mail du…, CR de réunion du…, conversation)." },
          related_ref: { type: "string", description: "Référence liée (PAY-…, ORD-…, dossier…)." },
        },
        required: ["who", "what"],
      },
    },
    allowed: EXEC,
    label: "Engagement enregistré",
    run: async (input, user) => {
      const who = str(input, "who");
      const what = str(input, "what");
      if (!who || !what) return "Préciser QUI s'engage (`who`) et sur QUOI (`what`).";
      const dueOn = str(input, "due_on") ? dateOf(str(input, "due_on"), "18:00") : null;
      if (str(input, "due_on") && !dueOn) return "Échéance illisible (AAAA-MM-JJ, ou AAAA-MM-JJ HH:mm).";
      const promisedOn = str(input, "promised_on") ? dateOf(str(input, "promised_on"), "12:00") : new Date();

      const created = await prisma.executiveCommitment.create({
        data: {
          ownerId: user.id,
          who: who.slice(0, 200),
          toWhom: str(input, "to_whom") || null,
          what: what.slice(0, 500),
          relatedRef: str(input, "related_ref") || null,
          promisedAt: promisedOn,
          dueAt: dueOn,
          source: str(input, "source") || null,
        },
        select: { id: true },
      });
      await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Engagement suivi — ${who} : ${what.slice(0, 100)}` });
      return JSON.stringify({
        engagement: `${who} — ${what}`,
        echeance: ymd(dueOn),
        id: created.id,
        note: "Aucune relance automatique : un retard remontera dans vos alertes, à vous de décider la suite.",
      });
    },
  },
  {
    def: {
      name: "list_commitments",
      description:
        "Liste les ENGAGEMENTS suivis : « qui me doit quoi ? », « qu'est-ce qui est en retard ? », « qu'ai-je promis ? ». " +
        "`overdue_only` = seulement les engagements OUVERTS dont l'échéance est dépassée.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["OPEN", "DONE", "BROKEN", "CANCELLED", "ALL"], description: "Filtre de statut (défaut OPEN)." },
          overdue_only: { type: "boolean", description: "true = seulement les engagements ouverts en retard." },
          query: { type: "string", description: "Mots du qui/quoi/référence." },
          limit: { type: "number", description: "Nombre maximum (défaut 15, max 40)." },
        },
      },
    },
    allowed: EXEC,
    label: "Engagements consultés",
    run: async (input, user) => {
      const status = str(input, "status") || "OPEN";
      const overdueOnly = input.overdue_only === true;
      const q = str(input, "query");
      const rawLimit = typeof input.limit === "number" ? input.limit : 15;
      const limit = Math.min(Math.max(Math.round(rawLimit), 1), 40);

      const search = q ? tokenSearch(q, ["who", "what", "toWhom", "relatedRef"]) : null;
      const rows = await prisma.executiveCommitment.findMany({
        where: {
          ownerId: user.id,
          ...(overdueOnly ? { status: "OPEN", dueAt: { lt: new Date() } } : status !== "ALL" ? { status } : {}),
          ...(search ?? {}),
        },
        orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
        take: limit,
        select: { id: true, who: true, toWhom: true, what: true, dueAt: true, promisedAt: true, status: true, source: true, relatedRef: true, evidence: true },
      });
      const now = Date.now();
      const STATUS_FR: Record<string, string> = { OPEN: "ouvert", DONE: "tenu", BROKEN: "non tenu", CANCELLED: "annulé" };
      // UNE SEULE FORME (§118.20) : « aucun engagement » rendait une PHRASE, et une étape qui
      // référençait `engagements` mourait le jour où il n'y en avait pas — c'est-à-dire le jour
      // où la réponse était la meilleure nouvelle possible.
      if (rows.length === 0) {
        return JSON.stringify({
          total: 0, engagements: [],
          precision: overdueOnly ? "Aucun engagement en retard." : "Aucun engagement suivi ne correspond à ce filtre.",
        });
      }
      return JSON.stringify({
        total: rows.length,
        precision: `${rows.length} engagement(s) suivis${overdueOnly ? " et en retard" : ""} — l'issue se constate, elle ne se suppose pas.`,
        engagements: rows.map((r) => ({
          id: r.id,
          qui: r.who,
          enversQui: r.toWhom,
          quoi: r.what,
          echeance: ymd(r.dueAt),
          enRetard: r.status === "OPEN" && r.dueAt !== null && r.dueAt.getTime() < now,
          statut: STATUS_FR[r.status] ?? r.status,
          promisLe: ymd(r.promisedAt),
          preuve: r.source,
          reference: r.relatedRef,
          issue: r.evidence,
        })),
      });
    },
  },
  {
    def: {
      name: "close_commitment",
      description:
        "CLÔT un engagement suivi : TENU (DONE), NON TENU (BROKEN) ou ANNULÉ (CANCELLED), avec la preuve (« livré le 14, BL n°… »). " +
        "`reference` = identifiant exact ou fragment du qui/quoi.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Identifiant de l'engagement, ou fragment du qui/quoi." },
          outcome: { type: "string", enum: ["DONE", "BROKEN", "CANCELLED"], description: "Issue : tenu, non tenu, ou annulé (défaut DONE)." },
          evidence: { type: "string", description: "La preuve ou le constat (« livré le…, reçu n°… », « aucune livraison au… »)." },
        },
        required: ["reference"],
      },
    },
    allowed: EXEC,
    label: "Engagement clos",
    run: async (input, user) => {
      const ref = str(input, "reference");
      if (!ref) return "Préciser l'engagement (identifiant ou fragment du qui/quoi).";
      const outcome = ["DONE", "BROKEN", "CANCELLED"].includes(str(input, "outcome")) ? str(input, "outcome") : "DONE";

      const exact = await prisma.executiveCommitment.findFirst({ where: { id: ref, ownerId: user.id }, select: { id: true, who: true, what: true } });
      let target = exact;
      if (!target) {
        const matches = await prisma.executiveCommitment.findMany({
          where: {
            ownerId: user.id,
            status: "OPEN",
            OR: [
              { who: { contains: ref, mode: "insensitive" } },
              { what: { contains: ref, mode: "insensitive" } },
              { relatedRef: { contains: ref, mode: "insensitive" } },
            ],
          },
          select: { id: true, who: true, what: true },
          take: 6,
        });
        if (matches.length === 0) {
          return JSON.stringify({ engagement: null, issue: null, candidats: [], precision: `Aucun engagement ouvert ne correspond à « ${ref} ».` });
        }
        if (matches.length > 1) {
          return JSON.stringify({
            engagement: null, issue: null,
            candidats: matches.map((m) => ({ id: m.id, qui: m.who, quoi: m.what })),
            precision: "Plusieurs engagements correspondent — préciser par l'id. Aucun n'a été clos.",
          });
        }
        target = matches[0];
      }

      await prisma.executiveCommitment.update({
        where: { id: target.id },
        data: { status: outcome, ...(str(input, "evidence") ? { evidence: str(input, "evidence") } : {}) },
      });
      const FR: Record<string, string> = { DONE: "tenu", BROKEN: "non tenu", CANCELLED: "annulé" };
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Engagement ${FR[outcome]} — ${target.who} : ${target.what.slice(0, 100)}` });
      return JSON.stringify({ engagement: `${target.who} — ${target.what}`, issue: FR[outcome], candidats: [], precision: `Engagement ${FR[outcome]} — l'issue est constatée, pas supposée.` });
    },
  },
];
