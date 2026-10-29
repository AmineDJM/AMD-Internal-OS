import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma } from "./dependances";
import {
  REMINDER_RECURRENCES, RECURRENCE_LABEL, algiersToUtc, formatAlgiersDue, type ReminderRecurrence,
} from "@/lib/assistant/reminders";
import { ROLE_LABELS } from "@/lib/labels";
import { resultatListe } from "@/lib/assistant/empty-result";
import { EXEC, str } from "./commun";

/**
 * OUTILS EXÉCUTIFS — la PLANIFICATION : poser, lister, éteindre et reporter un rappel.
 *
 * Morceau de `EXECUTIVE_TOOLS` (`../executive-tools.ts`), recomposé dans l'ordre d'origine : l'ordre
 * des outils fait partie du prompt de l'IA.
 */
export const OUTILS_PLANIFICATION: PowerTool[] = [
  // ───────────────────────── PLANIFICATION ─────────────────────────

  {
    def: {
      name: "plan_reminder",
      description:
        "PLANIFIE un rappel : « rappelle-moi mardi à 10 h de vérifier X », « dans 3 heures » (calculer la date/heure), " +
        "« tous les dimanches relance Regulatory », « tous les dimanches relance Nesrine », « chaque premier lundi du mois ». " +
        "`date` = première échéance (AAAA-MM-JJ, heure d'Alger), `time` = HH:MM (défaut 09:00). " +
        "`recurrence` : NONE (une fois), DAILY, WEEKLY, MONTHLY (même quantième), MONTHLY_WEEKDAY (même Nième jour de semaine — " +
        "pour « chaque premier lundi du mois », donner comme première échéance un premier lundi). " +
        "`target_role` (rôle à RELANCER) et/ou `target_person` (personne NOMMÉE à relancer) — sans eux, seul l'utilisateur est prévenu. " +
        "`canal` : par où le rappel ARRIVE — « notification » (défaut : notification interne + push), « email » (dans sa boîte), " +
        "« les_deux ». OUI, un e-mail différé est possible, à la minute près : « envoie-moi un mail dans 2 minutes », " +
        "« réveille-moi à 20h45 par mail » = plan_reminder avec quand=« dans 2 minutes » et canal=« email ». " +
        "`link` (optionnel) = page interne à rouvrir. Calculer soi-même la date exacte à partir de la date du jour donnée en contexte. " +
        "Pour un POINT QUOTIDIEN (« tous les jours à 8h fais-moi mon point ») : DAILY à 08:00, link=/chief-of-staff, note « Point du matin ».",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Ce qu'il faut rappeler, en quelques mots." },
          quand: {
            type: "string",
            description: "L'ÉCHÉANCE EN FRANÇAIS, telle que dite : « demain à 10h », « dans 48h », "
              + "« vendredi prochain », « chaque vendredi », « le 15 septembre ». À PRÉFÉRER à date/time : "
              + "le moteur calcule lui-même (heure d'Alger) — recopier les mots de la personne évite les "
              + "erreurs de calcul de date. Si l'expression n'est pas comprise, l'outil le dit et il faut "
              + "alors donner date/time explicites.",
          },
          date: { type: "string", description: "Première échéance, AAAA-MM-JJ (heure d'Alger) — si « quand » n'est pas fourni." },
          time: { type: "string", description: "Heure HH:MM (défaut 09:00)." },
          recurrence: { type: "string", enum: [...REMINDER_RECURRENCES], description: "NONE, DAILY, WEEKLY, MONTHLY ou MONTHLY_WEEKDAY." },
          target_role: { type: "string", enum: Object.keys(ROLE_LABELS), description: "Rôle à relancer à chaque échéance (code rôle interne — pas un nom d'équipe : « Équipe Regulatory » se dit HEAD_OF_REGULATORY ou REGULATORY_ASSISTANT)." },
          target_person: { type: "string", description: "Nom d'une personne précise à relancer à chaque échéance." },
          canal: {
            type: "string", enum: ["notification", "email", "les_deux"],
            description: "Par où le rappel arrive chez l'utilisateur : « notification » (défaut), « email », « les_deux ». "
              + "L'e-mail part vers les adresses que la personne a DÉCLARÉES pour elle-même ; sans adresse lisible ou sans boîte "
              + "connectée, le rappel retombe sur la notification et le DIT — il ne disparaît jamais en silence.",
          },
          watch_reference: { type: "string", description: "SURVEILLANCE CONDITIONNELLE : référence d'un règlement (ORD-…), d'une demande de paiement (PAY-…), d'une validation (VAL-…) ou fragment du titre d'une tâche. À l'échéance, le rappel RELIT l'entité : encore en attente → il prévient l'utilisateur ; réglée → il le dit et s'éteint. Pour « si ce paiement n'est pas validé sous 48 h, préviens-moi »." },
          note: { type: "string", description: "Le message de la relance / le détail du rappel." },
          link: { type: "string", description: "Lien interne (/regulatory, /legal/…)." },
          escalations_h: {
            type: "array", items: { type: "number" },
            description: "ÉCHELLE DE RELANCES en heures APRÈS chaque tir : « rappelle-moi demain ; "
              + "si je ne réponds pas, dans deux jours puis vendredi » = date demain + [48, 72]. "
              + "Chaque barreau se consomme ; l'échelle s'arrête seule si la condition surveillée est réglée.",
          },
          stop_on_email_from: {
            type: "string",
            description: "EXTINCTION SUR E-MAIL : le rappel (et toutes ses relances) s'éteint TOUT SEUL "
              + "dès qu'un e-mail arrive de cette personne/adresse — « rappelle-moi dans 7 jours "
              + "SEULEMENT SI Sarah n'a toujours pas répondu ».",
          },
          stop_needs_attachment: {
            type: "boolean",
            description: "Avec stop_on_email_from : l'e-mail doit porter une PIÈCE JOINTE pour éteindre "
              + "le rappel (« …n'a pas envoyé le contrat ») — une simple réponse sans pièce ne suffit pas.",
          },
        },
        required: ["title"],
      },
    },
    allowed: EXEC,
    label: "Rappel planifié",
    run: async (input, user) => {
      const title = str(input, "title");
      if (!title) return "Donnez l'objet du rappel.";

      // LE MOTEUR TEMPOREL D'ABORD (§66) : « demain à 10h », « dans 48h », « chaque vendredi »
      // se calculent en CODE, pas dans la tête du modèle — la même grammaire que les attentes de
      // mission. Le décodeur renonce sur le doute (`null`) : on demande alors la date explicite,
      // on n'attrape jamais une phrase mal comprise.
      let dueAt: Date | null = null;
      let recurrenceDeduite: ReminderRecurrence | null = null;
      const quand = str(input, "quand");
      if (quand) {
        const { interpreterExpressionTemporelle } = await import("@/lib/temporal");
        const lu = interpreterExpressionTemporelle(quand, new Date());
        if (lu) {
          dueAt = lu.echeance;
          recurrenceDeduite = lu.recurrence === "DAILY" ? "DAILY" : lu.recurrence === "WEEKLY" ? "WEEKLY" : null;
        } else if (!str(input, "date")) {
          return `Expression temporelle « ${quand} » non comprise à coup sûr — donnez date (AAAA-MM-JJ) et time (HH:MM, heure d'Alger).`;
        }
      }
      if (!dueAt) dueAt = algiersToUtc(str(input, "date"), str(input, "time"));
      if (!dueAt) return "Date illisible — attendu : « quand » en français, ou date AAAA-MM-JJ et HH:MM (heure d'Alger).";
      if (dueAt.getTime() < Date.now() - 60_000) return "Cette échéance est déjà passée — donnez une date à venir.";
      const recurrence = (REMINDER_RECURRENCES as readonly string[]).includes(str(input, "recurrence"))
        ? (str(input, "recurrence") as ReminderRecurrence)
        : (recurrenceDeduite ?? "NONE");
      const roleRaw = str(input, "target_role");
      if (roleRaw && !(roleRaw in ROLE_LABELS)) {
        return `Rôle « ${roleRaw} » inconnu. Rôles possibles : ${Object.keys(ROLE_LABELS).join(", ")}.`;
      }
      // La PERSONNE NOMMÉE se résout MAINTENANT : un rappel qui relancerait « nesrine » sans
      // savoir qui c'est finirait par relancer personne, en silence.
      let targetUserId: string | null = null;
      let targetUserName: string | null = null;
      const personRaw = str(input, "target_person");
      if (personRaw) {
        const matches = await prisma.user.findMany({
          where: { isActive: true, OR: [{ name: { contains: personRaw, mode: "insensitive" } }, { title: { contains: personRaw, mode: "insensitive" } }] },
          select: { id: true, name: true },
          take: 5,
        });
        if (matches.length === 0) return `Personne « ${personRaw} » introuvable dans l'annuaire (search_people pour vérifier).`;
        if (matches.length > 1) return `Plusieurs personnes correspondent à « ${personRaw} » : ${matches.map((m) => m.name).join(", ")}. Précisez.`;
        targetUserId = matches[0].id;
        targetUserName = matches[0].name;
      }
      const link = str(input, "link");
      // Un lien de rappel reste INTERNE : un rappel qui ouvrirait un site externe serait une
      // porte de sortie déguisée.
      if (link && !link.startsWith("/")) return "Le lien doit être une page interne (commencer par « / »).";

      // SURVEILLANCE : la référence se résout MAINTENANT, dans l'ordre des références les plus
      // spécifiques — un rappel qui surveillerait « rien » ne préviendrait jamais de rien.
      let watchType: string | null = null;
      let watchId: string | null = null;
      let watchLabel: string | null = null;
      const watchRaw = str(input, "watch_reference");
      if (watchRaw) {
        const [order, payment, validation, task] = await Promise.all([
          prisma.expenseOrder.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, label: true } }),
          prisma.paymentRequest.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, title: true } }),
          prisma.validationRequest.findFirst({ where: { reference: { equals: watchRaw, mode: "insensitive" } }, select: { id: true, reference: true, title: true } }),
          prisma.task.findFirst({ where: { title: { contains: watchRaw, mode: "insensitive" }, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } }, orderBy: { createdAt: "desc" }, select: { id: true, title: true } }),
        ]);
        if (order) { watchType = "EXPENSE_ORDER"; watchId = order.id; watchLabel = `${order.reference} — ${order.label}`; }
        else if (payment) { watchType = "PAYMENT_REQUEST"; watchId = payment.id; watchLabel = `${payment.reference} — ${payment.title}`; }
        else if (validation) { watchType = "VALIDATION_REQUEST"; watchId = validation.id; watchLabel = `${validation.reference} — ${validation.title}`; }
        else if (task) { watchType = "TASK"; watchId = task.id; watchLabel = task.title; }
        else {
          return JSON.stringify({
            cree: null, rappel: null, surveille: null,
            precision: `Rien à surveiller sous « ${watchRaw} » — ni règlement, ni demande de paiement, ni validation, `
              + "ni tâche ouverte. Aucun rappel n'a été créé. Vérifier la référence (inspect_record).",
          });
        }
      }

      // L'ÉCHELLE DE RELANCES — bornée (6 barreaux, 1 h à 30 jours chacun) : une échelle
      // infinie serait du harcèlement programmé, pas de la persévérance.
      const echelle = Array.isArray(input.escalations_h)
        ? (input.escalations_h as unknown[])
            .filter((h): h is number => typeof h === "number" && h >= 1 && h <= 720)
            .slice(0, 6)
        : [];

      // L'EXTINCTION SUR E-MAIL — la même grammaire d'attente que les missions : une seule
      // vérité pour « cet e-mail est-il celui-là ? ».
      const stopFrom = str(input, "stop_on_email_from");
      const stopOnEvent = stopFrom
        ? {
            event: "EMAIL_RECEIVED",
            from: stopFrom,
            ...(input.stop_needs_attachment === true ? { attachment: true as const } : {}),
          }
        : null;

      /**
       * LE CANAL — « notification » (défaut), « email », « les_deux ». On ne DEVINE pas : une
       * valeur non reconnue retombe sur la notification, jamais sur un envoi. Un e-mail parti
       * par erreur d'interprétation ne se rattrape pas.
       */
      const canalDemande = str(input, "canal").toLowerCase();
      const channel = canalDemande === "email" ? "EMAIL" : canalDemande === "les_deux" ? "LES_DEUX" : "NOTIFICATION";

      const created = await prisma.assistantReminder.create({
        data: {
          userId: user.id, title, dueAt, recurrence, channel,
          targetRole: roleRaw || null,
          targetUserId,
          watchType, watchId, watchLabel,
          note: str(input, "note") || null,
          link: link || null,
          escalationsH: echelle as never,
          stopOnEvent: (stopOnEvent ?? undefined) as never,
        },
        select: { id: true },
      });
      const relances = [
        roleRaw ? `le rôle « ${ROLE_LABELS[roleRaw] ?? roleRaw} »` : null,
        targetUserName ? targetUserName : null,
      ].filter(Boolean);
      return JSON.stringify({
        cree: created.id,
        rappel: title,
        premiereEcheance: formatAlgiersDue(dueAt),
        recurrence: RECURRENCE_LABEL[recurrence],
        relance: relances.length ? relances.join(" et ") : null,
        surveille: watchLabel,
        echelleRelances: echelle.length > 0 ? `${echelle.length} relance(s) programmée(s) (+${echelle.join(" h, +")} h)` : null,
        extinction: stopFrom
          ? `s'éteint tout seul dès qu'un e-mail ${input.stop_needs_attachment === true ? "AVEC pièce jointe " : ""}arrive de « ${stopFrom} »`
          : null,
        canal: channel === "EMAIL" ? "e-mail" : channel === "LES_DEUX" ? "e-mail et notification" : "notification",
        note: "À l'échéance : "
          + (channel === "NOTIFICATION" ? "pop-up pour vous"
            : channel === "EMAIL" ? "un e-mail vers vos adresses déclarées (sans adresse lisible, la notification prend le relais et le dit)"
              : "un e-mail vers vos adresses déclarées ET un pop-up")
          + (relances.length ? ` et relance envoyée à ${relances.join(" et ")}` : "")
          + (watchLabel ? `. Surveillance : si « ${watchLabel} » est réglé d'ici là, le rappel le dit et s'éteint ; sinon il vous prévient (vous seul).` : "") + ".",
      });
    },
  },

  {
    def: {
      name: "list_reminders",
      description: "Liste les rappels PLANIFIÉS de l'utilisateur (actifs), avec leur échéance, leur récurrence et leur identifiant (pour cancel_reminder).",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "Rappels listés",
    run: async (_input, user) => {
      const rows = await prisma.assistantReminder.findMany({
        where: { userId: user.id, active: true },
        orderBy: { dueAt: "asc" },
        include: { targetUser: { select: { name: true } } },
        take: 50,
      });
      // §118.20 : cet outil rendait une PHRASE quand la liste était vide et un TABLEAU NU
      // sinon — deux formes qui n'ont pas même la même NATURE. `resultatListe` donne aux deux
      // la même enveloppe : `items`, `count`, `message`.
      return resultatListe(rows.map((r) => ({
        id: r.id, rappel: r.title,
        prochaineEcheance: formatAlgiersDue(r.dueAt),
        recurrence: RECURRENCE_LABEL[r.recurrence as ReminderRecurrence] ?? r.recurrence,
        relanceLeRole: r.targetRole ? ROLE_LABELS[r.targetRole] ?? r.targetRole : null,
        relanceLaPersonne: r.targetUser?.name ?? null,
        surveille: r.watchLabel ?? null,
      })), rows.length === 0 ? "Aucun rappel planifié." : `${rows.length} rappel(s) actif(s).`);
    },
  },

  {
    def: {
      name: "cancel_reminder",
      description: "ANNULE un rappel planifié (le sien uniquement). `id` vient de list_reminders.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Identifiant du rappel à annuler." } },
        required: ["id"],
      },
    },
    allowed: EXEC,
    label: "Rappel annulé",
    run: async (input, user) => {
      const id = str(input, "id");
      // `updateMany` filtré par propriétaire : on n'annule pas le rappel d'un autre en devinant
      // son identifiant.
      const done = await prisma.assistantReminder.updateMany({
        where: { id, userId: user.id, active: true },
        data: { active: false },
      });
      // UN SUCCÈS SE REND STRUCTURÉ : une mission distingue ainsi « fait » d'une phrase d'excuse.
      return done.count > 0 ? JSON.stringify({ ok: true, annule: true, message: "Rappel annulé." }) : "Rappel introuvable (ou déjà éteint).";
    },
  },

  {
    def: {
      name: "snooze_reminder",
      description:
        "REPOUSSE un rappel (le sien uniquement) : « repousse-le d'une heure », « redemande-moi demain ». "
        + "`id` vient de list_reminders. Donner `minutes` OU `quand` en français (« demain à 9h », « dans 2 heures »).",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant du rappel à repousser." },
          minutes: { type: "number", description: "De combien de minutes repousser (1 à 10080)." },
          quand: { type: "string", description: "Ou l'échéance en français : « demain à 9h », « dans 2 heures »." },
        },
        required: ["id"],
      },
    },
    allowed: EXEC,
    label: "Rappel repoussé",
    run: async (input, user) => {
      const id = str(input, "id");
      let minutes = typeof input.minutes === "number" && Number.isFinite(input.minutes) ? input.minutes : 0;
      const quand = str(input, "quand");
      if (!minutes && quand) {
        // Le MÊME moteur temporel que la création : une seule grammaire, jamais deux calendriers.
        const { interpreterExpressionTemporelle } = await import("@/lib/temporal");
        const lu = interpreterExpressionTemporelle(quand, new Date());
        if (!lu) return `Expression « ${quand} » non comprise à coup sûr — donnez plutôt « minutes ».`;
        minutes = Math.round((lu.echeance.getTime() - Date.now()) / 60_000);
        if (minutes < 1) return "Cette échéance est déjà passée — donnez un moment à venir.";
      }
      if (!minutes) return "Donnez « minutes » ou « quand » (en français).";
      const { snoozeReminder } = await import("@/lib/assistant/reminders");
      const nouveau = await snoozeReminder(id, user.id, minutes);
      return nouveau
        ? JSON.stringify({ ok: true, repousse: true, prochaineEcheance: formatAlgiersDue(nouveau), message: `Rappel repoussé — prochaine échéance : ${formatAlgiersDue(nouveau)}.` })
        : "Rappel introuvable (ou déjà éteint).";
    },
  },
];
