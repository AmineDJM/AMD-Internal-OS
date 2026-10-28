/**
 * PROPOSITIONS — Espace de travail et courrier : tâche, dossier, demande administrative, message
 * interne, courriel préparé, politique d'envoi, e-mail.
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import {
  userCan, hasGlobalView, getCommunicationPolicy, parseMailPolicyPhrase, POLICY_LABEL, POLICY_HELP,
  createOutboundIntent, resolveOutboundIdentity, isIdentity, findPeople as findDirectoryPeople, decideAddress,
  askWhichAddress,
} from "@/lib/assistant/coeur/erp";
import { inferMailSubject, defaultMailBody, firstNameOf } from "@/lib/assistant/chief-style";
import { PRIORITY, ADMIN_REQUEST_TYPE } from "@/lib/labels";
import { lirePersonne, direCeQuiEstArrive, collectifDesigne, CONSEIL_COLLECTIF } from "@/lib/personnes/designation";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/lib/assistant/outils/arguments";
import {
  normPriority, isoDate, pastWarning, mailApprovalCard, type ContexteProposition,
} from "@/lib/assistant/propositions/aides";

/** La famille « espace-et-courrier » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerEspaceEtCourrier(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings, resolve } = c;

  if (toolName === "create_task") {
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

  if (toolName === "create_dossier") {
    const title = asStr(input, "title");
    if (!title) return { error: "Sujet du dossier manquant." };
    const assignee = await resolve("Responsable", input.assigneeName);
    const due = asStr(input, "dueDate") ? isoDate(asStr(input, "dueDate")) : null;
    const priority = asStr(input, "priority") ? normPriority(asStr(input, "priority")) : null;
    const category = asStr(input, "category") || null;
    const fields = [{ label: "Dossier", value: title }];
    if (category) fields.push({ label: "Catégorie", value: category });
    fields.push({ label: "Responsable", value: assignee.name ?? "à assigner" });
    if (asStr(input, "description")) fields.push({ label: "Brief", value: asStr(input, "description") });
    if (due) fields.push({ label: "Échéance", value: due });
    if (priority) fields.push({ label: "Priorité", value: PRIORITY[priority]?.label ?? priority });
    return {
      kind: "create_dossier", module: "DOSSIERS", title: "Ouvrir un sujet", fields, warnings,
      payload: {
        kind: "create_dossier", title, description: asStr(input, "description") || null, category,
        assigneeId: assignee.id, assigneeName: assignee.name, priority, dueDate: due,
      },
    };
  }

  if (toolName === "create_admin_request") {
    const type = asStr(input, "type").toUpperCase();
    // Plus de `HR_SIMPLE` : une demande RH se pose dans le module RH (§118.138).
    // Plus de `DRIVER` non plus : les missions chauffeur ne se créent plus (Direction, 10/2026).
    const validTypes = ["TRAVEL", "MAIL", "SIGNATURE", "PURCHASE", "QUOTE", "PAYMENT", "GUEST_VISA", "OTHER"];
    const title = asStr(input, "title");
    if (!validTypes.includes(type)) return { error: "Type de demande invalide." };
    if (!title) return { error: "Titre de demande manquant." };
    const startDate = asStr(input, "startDate") ? isoDate(asStr(input, "startDate")) : null;
    const endDate = asStr(input, "endDate") ? isoDate(asStr(input, "endDate")) : null;
    const deadline = asStr(input, "deadline") ? isoDate(asStr(input, "deadline")) : null;
    const priority = asStr(input, "priority") ? normPriority(asStr(input, "priority")) : null;
    pastWarning("La date de début", startDate, warnings);
    pastWarning("La date de fin", endDate, warnings);
    pastWarning("L'échéance", deadline, warnings);
    const fields = [
      { label: "Type", value: ADMIN_REQUEST_TYPE[type] ?? type },
      { label: "Objet", value: title },
    ];
    if (asStr(input, "description")) fields.push({ label: "Détails", value: asStr(input, "description") });
    fields.push({ label: "À traiter par", value: "L'assistante de direction" });
    if (startDate || endDate) fields.push({ label: "Dates", value: [startDate, endDate].filter(Boolean).join(" → ") });
    if (deadline) fields.push({ label: "Échéance", value: deadline });
    if (priority) fields.push({ label: "Priorité", value: PRIORITY[priority]?.label ?? priority });
    return {
      kind: "create_admin_request", module: "ADMIN_REQUESTS", title: "Créer une demande administrative", fields, warnings,
      payload: {
        kind: "create_admin_request", type, title, description: asStr(input, "description") || null,
        deadline, startDate, endDate, priority,
      },
    };
  }

  if (toolName === "send_message") {
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

  if (toolName === "send_prepared_mail") {
    return mailApprovalCard(asStr(input, "intentId"), user, warnings);
  }

  if (toolName === "set_mail_policy") {
    if (!hasGlobalView(user)) return { error: "Seul le PDG (ou le Super Admin) règle la politique d'envoi." };
    const raw = asStr(input, "policy") || asStr(input, "value");
    const parsed = parseMailPolicyPhrase(raw)
      ?? (["REQUIRE_APPROVAL", "AUTO_SEND", "DRAFT_ONLY"].includes(raw.toUpperCase()) ? (raw.toUpperCase() as "REQUIRE_APPROVAL" | "AUTO_SEND" | "DRAFT_ONLY") : null);
    if (!parsed) {
      return { error: "Politique d'envoi non comprise. Trois valeurs : « approbation requise », « envoi autonome », « brouillons seulement »." };
    }
    const current = await getCommunicationPolicy();
    if (current.mailSendPolicy === parsed) {
      return { error: `La politique est DÉJÀ « ${POLICY_LABEL[parsed]} » — rien à changer.` };
    }
    const fields = [
      { label: "Politique actuelle", value: POLICY_LABEL[current.mailSendPolicy] },
      { label: "Nouvelle politique", value: POLICY_LABEL[parsed] },
      { label: "Ce que cela change", value: POLICY_HELP[parsed] },
    ];
    if (parsed === "AUTO_SEND") {
      warnings.push("ENVOI AUTONOME : Adam pourra expédier des messages en votre nom SANS vous les montrer — y compris depuis une mission de fond, la nuit.");
      warnings.push("Le coupe-circuit sortant et les freins anti-boucle continuent de s'appliquer.");
    } else {
      warnings.push("Retour à la prudence : effet immédiat, y compris sur les messages déjà préparés qui attendaient.");
    }
    return {
      kind: "set_mail_policy", module: "WORKSPACE", title: `Politique d'envoi → ${POLICY_LABEL[parsed]}`,
      fields, warnings, level: "SENSITIVE",
      // Ressaisie exigée UNIQUEMENT pour ouvrir l'envoi autonome (cf. payloadRequiresStrongConfirm).
      ...(parsed === "AUTO_SEND" ? { confirmText: "ENVOI AUTONOME" } : {}),
      payload: { kind: "set_mail_policy", policy: parsed, before: POLICY_LABEL[current.mailSendPolicy] },
    };
  }

  if (toolName === "send_email") {
    // « ENVOIE UN MAIL À … » — UNE SEULE MARCHE, ET ELLE EST CANONIQUE.
    //
    // Cet outil PRÉPARE l'intention puis rend la carte d'approbation : la préparation ne demande
    // aucune permission, donc rien ne justifie de la faire confirmer à part. Le circuit d'avant
    // — préparer, ANNONCER, attendre un « je confirme » en français, PUIS afficher la carte —
    // faisait confirmer deux fois le même envoi. Ici il n'y a qu'un accord possible : celui de
    // la carte.
    // Le destinataire arrive en chaîne, en « Nom <adresse> », ou en objet résolu par une étape
    // de mission : on le SÉPARE avant de décider, au lieu de le refuser parce qu'il n'a pas la
    // forme attendue.
    const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
    const lu = lirePersonne(input.to);
    if (!lu) return { error: `À qui ? (reçu : ${direCeQuiEstArrive(input.to)})` };
    const rawTo = lu.nom ?? lu.adresse ?? "";

    // LE DESTINATAIRE PEUT ÊTRE UN NOM. « Envoie un mail à Raihana » doit marcher : on interroge
    // l'annuaire interne AVANT de renoncer. Deux adresses vérifiées et aucun indice pour
    // trancher → UNE question courte, jamais un choix au hasard.
    let to = (lu.adresse ?? rawTo).toLowerCase();
    if (!lu.adresse) {
      const people = await findDirectoryPeople(rawTo, 3);
      if (people.length === 0) return { error: `Aucune trace de « ${rawTo} » dans l'annuaire — donnez-moi son adresse.` };
      if (people.length > 1) {
        return { error: `Plusieurs personnes portent ce nom : ${people.map((p) => p.name).join(", ")}. Laquelle ?` };
      }
      const decision = decideAddress(people[0].endpoints, asStr(input, "addressHint") || rawTo);
      if (decision.kind === "none") return { error: `Je n'ai aucune adresse pour ${people[0].name}.` };
      if (decision.kind === "ask") return { error: askWhichAddress(people[0].name, decision.options) };
      to = decision.address.value;
    }
    if (!isEmail(to)) return { error: "Adresse e-mail du destinataire manquante ou invalide." };

    // OBJET ET CORPS SE DÉDUISENT. Demander « quel objet ? » pour une prise de nouvelles fait
    // perdre un tour et n'améliore rien : la carte montre le texte, et il se corrige d'un geste
    // avant l'envoi. Un défaut VISIBLE et rectifiable vaut mieux qu'une question de plus.
    const body = asStr(input, "body") || defaultMailBody(firstNameOf(to));
    const subject = asStr(input, "subject") || inferMailSubject(body);
    const cc = asStr(input, "cc").trim();
    if (cc && !cc.split(",").every((p) => isEmail(p.trim()))) return { error: "Adresse(s) en copie invalide(s)." };

    // L'EXPÉDITEUR NE SE DEVINE PAS. Il vient de la connexion canonique, jamais du destinataire
    // ni de l'adresse ERP de la personne. Sans identité autorisée, on n'envoie PAS.
    const identity = await resolveOutboundIdentity(user.id);
    if (!isIdentity(identity)) return { error: identity.message };

    const intent = await createOutboundIntent({
      connectionId: identity.connectionId,
      userId: user.id,
      recipients: [to],
      cc: cc ? cc.split(",").map((p) => p.trim()).filter(Boolean) : [],
      subject: subject || "(sans objet)",
      bodyText: body,
      reason: "Demandé par vous",
      generatedBy: "chief",
    }).catch((e: unknown) => (e instanceof Error ? e : new Error("Préparation impossible.")));
    if (intent instanceof Error) return { error: intent.message };

    return mailApprovalCard(intent.id, user, warnings);
  }

  return undefined;
}
