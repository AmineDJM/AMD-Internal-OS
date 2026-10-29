/**
 * PROPOSITIONS — Administration : circuits (configuration, avancement), champs personnalisés, relance
 * Regulatory, comptes (activation, rôle).
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import {
  prisma, companyScopedWhere, isRegulatorySupervisor, scopeRegulatory, CUSTOM_ENTITY_TYPES, getAppSettings,
} from "@/lib/assistant/coeur/erp";
// Les demandes Ad & Pro, le secrétariat et les circuits : par le pont (frontière Adam ↔ ERP).
import { WORKFLOW_CATEGORIES, CATEGORY_LABELS } from "@/platform/in-process/demandes";
import { readWorkflowState, resolveWorkflowRequest, resolveWorkflowCategory } from "@/lib/assistant/workflow-admin";
import { ROLE_LABELS, ENTITY_TYPE_LABELS } from "@/lib/labels";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/lib/assistant/outils/arguments";
import { normalizeRole, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « administration » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerAdministration(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings } = c;

  if (toolName === "configure_workflow") {
    // LA MÊME PORTE QUE LE BUILDER de l'écran Administration → Circuits : Super Admin.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "La configuration des circuits de validation est réservée au Super Admin — la même règle que le builder de l'écran." };
    }
    const cat = resolveWorkflowCategory(asStr(input, "category"));
    if (!cat) return { error: `Catégorie inconnue. Circuits configurables : ${WORKFLOW_CATEGORIES.join(", ")} — les autres circuits sont codés en dur.` };
    const current = await readWorkflowState(cat);
    const beforeTitles = current.steps?.map((s, i) => `${i + 1}. ${s.title}`) ?? ["(circuit par défaut, non personnalisé)"];

    if (input.reset === true) {
      return {
        kind: "configure_workflow", module: "ADMIN", level: "SENSITIVE",
        title: `Réinitialiser le circuit ${current.categoryLabel} au défaut`,
        fields: [
          { label: "Circuit", value: `${current.categoryLabel}${current.name ? ` — « ${current.name} »` : ""}` },
          { label: "Étapes actuelles", value: beforeTitles.join(" · ") },
          { label: "Après", value: "Circuit par défaut de la plateforme (re-créé à la première demande)" },
        ],
        warnings: ["Refusé par l'action si des demandes EN COURS utilisent ce circuit (modifier les étapes plutôt que réinitialiser).", ...warnings],
        payload: { kind: "configure_workflow", category: cat, categoryLabel: current.categoryLabel, payloadJson: null, reset: true, stepTitles: [] },
      };
    }

    const rawSteps = asStr(input, "steps");
    if (!rawSteps) return { error: "Donner la LISTE COMPLÈTE des étapes recomposée (JSON) — lire d'abord read_workflow." };
    let steps: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(rawSteps);
      if (!Array.isArray(parsed) || parsed.length === 0) return { error: "Le circuit doit comporter au moins une étape." };
      steps = parsed as Record<string, unknown>[];
    } catch {
      return { error: "JSON des étapes invalide." };
    }
    // Pré-validation FIDÈLE aux règles de l'action canonique (qui re-validera de toute façon) :
    // la carte de confirmation ne doit jamais montrer un circuit que l'action refusera.
    const titles: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const t = typeof steps[i].title === "string" ? (steps[i].title as string).trim() : "";
      if (!t) return { error: `Le titre de l'étape ${i + 1} est obligatoire.` };
      titles.push(t);
    }
    const hasApprove = steps.some((s) => Array.isArray(s.powers) && (s.powers as unknown[]).includes("APPROVE"));
    if (!hasApprove) return { error: "Au moins une étape doit permettre d'approuver (APPROVE) — sinon le circuit ne peut jamais aboutir." };
    const name = asStr(input, "name") || current.name || current.categoryLabel;
    const payloadJson = JSON.stringify({ category: cat, name, steps });

    return {
      kind: "configure_workflow", module: "ADMIN", level: "SENSITIVE",
      title: `Reconfigurer le circuit ${current.categoryLabel} (${titles.length} étape·s)`,
      fields: [
        { label: "Circuit", value: `${current.categoryLabel} — « ${name} »` },
        { label: "Avant", value: beforeTitles.join(" · ") },
        { label: "Après", value: titles.map((t, i) => `${i + 1}. ${t}`).join(" · ") },
      ],
      warnings: [
        "REMPLACEMENT INTÉGRAL des étapes — mêmes règles que le builder de l'écran (validation des rôles/pouvoirs par l'action).",
        "Les demandes EN COURS conservent leur étape par slug : garder les slugs des étapes conservées pour ne perdre personne en route.",
        ...warnings,
      ],
      payload: { kind: "configure_workflow", category: cat, categoryLabel: current.categoryLabel, payloadJson, reset: false, stepTitles: titles },
    };
  }

  if (toolName === "advance_workflow") {
    const cat = resolveWorkflowCategory(asStr(input, "category"));
    if (!cat) return { error: `Catégorie inconnue. Circuits : ${WORKFLOW_CATEGORIES.join(", ")}.` };
    const action = asStr(input, "action").toUpperCase();
    if (action !== "APPROVE" && action !== "REJECT" && action !== "SKIP") {
      return { error: "Action invalide — APPROVE, REJECT ou SKIP." };
    }
    const note = asStr(input, "note") || null;
    // LA RÈGLE DE L'ÉCRAN, dite dès la proposition : sauter une étape exige une RAISON.
    if (action === "SKIP" && !note) return { error: "Sauter une étape exige une RAISON (note) — elle est tracée et notifiée à l'étape suivante." };
    const query = asStr(input, "reference");
    if (!query) return { error: "Précisez la référence ou le nom de la demande." };

    const target = await resolveWorkflowRequest(cat, query);
    if (target.status === "none") return { error: `Aucune demande « ${query} » trouvée dans ${CATEGORY_LABELS[cat]}.` };
    if (target.status === "ambiguous") {
      return { error: `Plusieurs demandes correspondent à « ${query} » : ${target.candidates.join(" ; ")} — préciser.` };
    }
    if (target.instanceStatus !== "IN_PROGRESS") {
      return { error: `La demande « ${target.display} » n'a pas de circuit en cours (état : ${target.instanceStatus}).` };
    }
    const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : null;
    const ACTION_FR = { APPROVE: "Approuver l'étape", REJECT: "Refuser la demande", SKIP: "SAUTER l'étape" } as const;
    const fields = [
      { label: "Demande", value: `${target.display} (${CATEGORY_LABELS[cat]})` },
      { label: "Étape courante", value: `${target.currentStepTitle ?? target.currentSlug ?? "?"}${target.currentStepActors ? ` — acteurs : ${target.currentStepActors}` : ""}` },
      { label: "Décision", value: ACTION_FR[action as keyof typeof ACTION_FR] },
    ];
    if (note) fields.push({ label: action === "SKIP" ? "Raison (obligatoire, tracée)" : "Note", value: note });
    if (amount != null) fields.push({ label: "Montant", value: `${amount.toLocaleString("fr-FR")} DZD` });
    return {
      kind: "advance_workflow", module: "ADMIN", level: "SENSITIVE",
      title: `${ACTION_FR[action as keyof typeof ACTION_FR]} — ${target.display}`,
      fields,
      warnings: [
        action === "SKIP"
          ? "Le saut est TRACÉ (audit + fil du circuit) et notifié à l'étape suivante — interdit sur la dernière étape (le moteur refusera)."
          : action === "REJECT"
            ? "Le refus clôt le circuit — le demandeur est notifié."
            : "Le MOTEUR revérifie que vous avez autorité sur l'étape courante (mêmes règles que l'écran).",
        ...warnings,
      ],
      payload: {
        kind: "advance_workflow", category: cat, entityType: target.entityType, entityId: target.entityId,
        display: target.display, action: action as "APPROVE" | "REJECT" | "SKIP", note, amount,
      },
    };
  }

  if (toolName === "manage_custom_field") {
    // LA MÊME PORTE QUE L'ÉCRAN Administration → Champs personnalisés : Super Admin.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "La gestion des champs personnalisés est réservée au Super Admin." };
    }
    const op = asStr(input, "op").toUpperCase();
    if (op !== "CREATE" && op !== "UPDATE" && op !== "DELETE") return { error: "Opération invalide — CREATE, UPDATE ou DELETE." };
    const moduleQuery = asStr(input, "module");
    if (!moduleQuery) return { error: "Précisez le module (ex. « Regulatory », « Demandes administratives »)." };
    // Résolution du module par son libellé français, contre la liste RÉELLE des modules à champs.
    const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const fq = fold(moduleQuery);
    const matches = CUSTOM_ENTITY_TYPES.filter((t) => {
      const lbl = fold(ENTITY_TYPE_LABELS[t] ?? t);
      return lbl.includes(fq) || fq.includes(lbl) || fold(t).includes(fq.replace(/\s+/g, "_"));
    });
    if (matches.length === 0) {
      return { error: `Module « ${moduleQuery} » sans champs personnalisés. Modules possibles : ${CUSTOM_ENTITY_TYPES.map((t) => ENTITY_TYPE_LABELS[t] ?? t).join(", ")}.` };
    }
    if (matches.length > 1) {
      return { error: `Plusieurs modules correspondent à « ${moduleQuery} » : ${matches.map((t) => ENTITY_TYPE_LABELS[t] ?? t).join(", ")} — préciser.` };
    }
    const entityType = matches[0];
    const entityTypeLabel = ENTITY_TYPE_LABELS[entityType] ?? entityType;
    const label = asStr(input, "label");
    if (!label) return { error: "Précisez le libellé du champ." };

    if (op === "CREATE") {
      const type = (asStr(input, "type") || "TEXT").toUpperCase();
      if (!["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT"].includes(type)) return { error: `Type « ${type} » invalide.` };
      const options = asStr(input, "options") || null;
      if (type === "SELECT" && !options) return { error: "Un champ SELECT exige ses choix (options, séparés par des virgules)." };
      const required = input.required === true;
      const fields = [
        { label: "Module", value: entityTypeLabel },
        { label: "Champ", value: `${label} (${type})${options ? ` — choix : ${options}` : ""}` },
        { label: "Obligatoire", value: required ? "OUI — la fiche ne s'enregistre plus sans ce champ" : "non" },
      ];
      return {
        kind: "manage_custom_field", module: "ADMIN", level: "SENSITIVE",
        title: `Ajouter le champ « ${label} » à ${entityTypeLabel}`,
        fields,
        warnings: ["Le champ apparaît immédiatement sur toutes les fiches du module.", ...warnings],
        payload: {
          kind: "manage_custom_field", op: "CREATE", defId: null, entityType, entityTypeLabel,
          label, type, options, required, order: typeof input.order === "number" ? input.order : null,
        },
      };
    }

    // UPDATE / DELETE : résoudre le champ EXISTANT par son libellé sur ce module.
    const defs = await prisma.customFieldDef.findMany({
      where: { entityType, active: true, label: { contains: label, mode: "insensitive" } },
      take: 5,
    });
    if (defs.length === 0) return { error: `Aucun champ « ${label} » sur ${entityTypeLabel}.` };
    if (defs.length > 1) {
      const exact = defs.filter((d) => d.label.toLowerCase() === label.toLowerCase());
      if (exact.length !== 1) return { error: `Plusieurs champs correspondent à « ${label} » : ${defs.map((d) => d.label).join(", ")} — préciser.` };
      defs.splice(0, defs.length, exact[0]);
    }
    const def = defs[0];

    if (op === "DELETE") {
      return {
        kind: "manage_custom_field", module: "ADMIN", level: "SENSITIVE",
        title: `Retirer le champ « ${def.label} » de ${entityTypeLabel}`,
        fields: [
          { label: "Module", value: entityTypeLabel },
          { label: "Champ", value: `${def.label} (${def.type})${def.required ? " — obligatoire" : ""}` },
        ],
        warnings: ["Les valeurs déjà saisies RESTENT dans les fiches (JSON) mais ne s'affichent plus.", ...warnings],
        payload: {
          kind: "manage_custom_field", op: "DELETE", defId: def.id, entityType, entityTypeLabel,
          label: def.label, type: def.type, options: def.options, required: def.required, order: def.order,
        },
      };
    }

    // UPDATE : fusion — ce que l'utilisateur ne précise pas reste tel quel.
    const nextLabel = asStr(input, "newLabel") || def.label;
    const nextType = (asStr(input, "type") || def.type).toUpperCase();
    if (!["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT"].includes(nextType)) return { error: `Type « ${nextType} » invalide.` };
    const nextOptions = asStr(input, "options") || def.options;
    const nextRequired = typeof input.required === "boolean" ? input.required : def.required;
    const nextOrder = typeof input.order === "number" ? input.order : def.order;
    const changes: string[] = [];
    if (nextLabel !== def.label) changes.push(`libellé : ${def.label} → ${nextLabel}`);
    if (nextType !== def.type) changes.push(`type : ${def.type} → ${nextType}`);
    if ((nextOptions ?? "") !== (def.options ?? "")) changes.push("choix modifiés");
    if (nextRequired !== def.required) changes.push(nextRequired ? "devient OBLIGATOIRE" : "devient optionnel");
    if (nextOrder !== def.order) changes.push(`ordre : ${def.order} → ${nextOrder}`);
    if (changes.length === 0) return { error: `Aucun changement demandé sur « ${def.label} ».` };
    return {
      kind: "manage_custom_field", module: "ADMIN", level: "SENSITIVE",
      title: `Modifier le champ « ${def.label} » (${entityTypeLabel})`,
      fields: [
        { label: "Module", value: entityTypeLabel },
        { label: "Changements", value: changes.join(" ; ") },
      ],
      warnings: nextRequired && !def.required
        ? ["Dès la confirmation, les fiches du module ne s'enregistrent plus sans ce champ (le serveur fait foi).", ...warnings]
        : warnings,
      payload: {
        kind: "manage_custom_field", op: "UPDATE", defId: def.id, entityType, entityTypeLabel,
        label: nextLabel, type: nextType, options: nextOptions, required: nextRequired, order: nextOrder,
      },
    };
  }

  if (toolName === "request_regulatory_status_update") {
    // LA MÊME PORTE QUE LE BOUTON de la fiche : la supervision Regulatory (Super Admin + rôles
    // configurés en Administration) — revérifiée par l'action canonique à l'exécution.
    const settings = await getAppSettings();
    if (!isRegulatorySupervisor(user, settings.regulatorySupervisorRoles)) {
      /**
       * LE REFUS NOMME LE REMÈDE DE CELUI QUI LE LIT (§118.69, §118.30).
       *
       * Mesuré en live : la première version disait « réservée à la supervision Regulatory » et
       * s'arrêtait là. Devant un écran, c'est suffisant — la personne sait qu'elle n'a pas ce
       * bouton. Dans une MISSION, c'est le PLANIFICATEUR qui lit : il a reçu une faute sans
       * issue, a replanifié SEPT fois autour du même mur, et la mission a fini BLOCKED — 0
       * livrable, 0,49 $, et un dirigeant à qui l'on avait demandé d'AUTORISER quatre étapes
       * qui ne pouvaient pas partir. La permission, elle, était juste : l'acteur est DIRECTION.
       *
       * Or le geste existe et il est ouvert à cet acteur : une relance traçable est une
       * NOTIFICATION aux personnes du dossier. On donne donc les DEUX gestes dans l'ordre —
       * lire la fiche pour obtenir les personnes, puis un message PAR personne. Sans le second,
       * un plan corrigé écrirait un envoi unique à N destinataires (§118.3).
       */
      return {
        error:
          "La relance de mise à jour est réservée à la supervision Regulatory (Super Admin + rôles configurés en Administration) — "
          + `« ${user.name} » (${user.role}) ne la porte pas. Ce n'est PAS une impossibilité : pour obtenir la même chose, `
          + "lire la fiche du dossier (`inspect_record` sur la référence) pour connaître son responsable, son assistant et ses "
          + "participants, puis envoyer un message à CHACUN d'eux (`send_message`, une étape par personne — jamais un envoi "
          + "unique à plusieurs). Seule la relance TRACÉE sur la fiche exige la supervision ; prévenir les personnes, non.",
      };
    }
    const reference = asStr(input, "reference");
    if (!reference) return { error: "Précisez la référence du dossier (REG-AAAA-NNN)." };
    const product = await prisma.regulatoryProduct.findFirst({
      where: await companyScopedWhere(user.id, { AND: [{ reference }, scopeRegulatory(user)] }),
      select: {
        id: true, reference: true, dci: true,
        responsible: { select: { id: true, name: true } },
        assistant: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, name: true } },
      },
    });
    if (!product) return { error: `Dossier « ${reference} » introuvable dans votre périmètre.` };

    // Les destinataires sont montrés AVANT la confirmation — une relance est un geste de
    // management, on dit à qui elle part.
    const seen = new Set<string>([user.id]);
    const recipients: string[] = [];
    for (const p of [product.responsible, product.assistant, ...product.assignedUsers]) {
      if (p && !seen.has(p.id)) { seen.add(p.id); recipients.push(p.name); }
    }
    if (recipients.length === 0) {
      return { error: `Le dossier ${reference} n'a ni responsable, ni assistant, ni participant à relancer — désigner d'abord un chargé du dossier (assign_regulatory_responsible).` };
    }
    const note = asStr(input, "note") || null;
    const fields = [
      { label: "Dossier", value: `${product.reference} — ${product.dci}` },
      { label: "Destinataires", value: recipients.join(", ") },
    ];
    if (note) fields.push({ label: "Précision", value: note });
    return {
      kind: "request_regulatory_status_update",
      module: "REGULATORY",
      title: `Demander une mise à jour de statut sur ${product.reference}`,
      fields,
      warnings: ["Chaque destinataire est NOTIFIÉ avec un lien vers la fiche (relance traçable) — le statut du dossier n'est PAS modifié.", ...warnings],
      payload: {
        kind: "request_regulatory_status_update",
        productId: product.id, reference: product.reference, dci: product.dci, note, recipients,
      },
    };
  }

  if (toolName === "set_account_active") {
    // LA MÊME PORTE QUE L'ÉCRAN Administration (interrupteur des comptes) : Super Admin.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "L'activation / désactivation des comptes est réservée au Super Admin." };
    }
    const personName = asStr(input, "personName");
    if (personName.length < 2) return { error: "Donnez le nom du compte." };
    if (typeof input.active !== "boolean") return { error: "Précisez active=true (activer) ou active=false (désactiver)." };
    // Les comptes INACTIFS sont cherchés aussi — c'est justement eux qu'on réactive.
    const people = await prisma.user.findMany({
      where: { name: { contains: personName, mode: "insensitive" } },
      select: { id: true, name: true, isActive: true, role: true },
      take: 5,
    });
    if (!people.length) return { error: `Aucun compte « ${personName} » — vérifier avec search_people (les comptes inactifs existent aussi).` };
    if (people.length > 1) {
      return { error: `Plusieurs comptes correspondent à « ${personName} » : ${people.map((p) => `${p.name} (${p.isActive ? "actif" : "inactif"})`).join(", ")} — préciser le nom.` };
    }
    const target = people[0];
    if (target.id === user.id) return { error: "Impossible sur son propre compte — la même règle que l'écran." };
    if (target.isActive === input.active) {
      return { error: `Le compte de ${target.name} est déjà ${input.active ? "actif" : "inactif"}.` };
    }
    return {
      kind: "set_account_active",
      module: "ADMIN",
      level: "SENSITIVE",
      title: input.active ? `Réactiver le compte de ${target.name}` : `Désactiver le compte de ${target.name}`,
      fields: [
        { label: "Compte", value: `${target.name} (${ROLE_LABELS[target.role as keyof typeof ROLE_LABELS] ?? target.role})` },
        { label: "État", value: `${target.isActive ? "actif" : "inactif"} → ${input.active ? "actif" : "inactif"}` },
      ],
      warnings: input.active
        ? ["La personne pourra se reconnecter immédiatement.", ...warnings]
        : ["La personne ne pourra PLUS se connecter dès la confirmation (réversible à tout moment).", ...warnings],
      payload: { kind: "set_account_active", userId: target.id, userName: target.name, active: input.active },
    };
  }

  if (toolName === "set_account_role") {
    // LA MÊME PORTE QUE L'ÉCRAN Administration (rôles des comptes) : Super Admin.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "Le changement de rôle des comptes est réservé au Super Admin." };
    }
    const personName = asStr(input, "personName");
    if (personName.length < 2) return { error: "Donnez le nom du compte." };
    const people = await prisma.user.findMany({
      where: { name: { contains: personName, mode: "insensitive" } },
      select: { id: true, name: true, role: true, secondaryRole: true },
      take: 5,
    });
    if (!people.length) return { error: `Aucun compte « ${personName} ».` };
    if (people.length > 1) {
      return { error: `Plusieurs comptes correspondent à « ${personName} » : ${people.map((p) => p.name).join(", ")} — préciser le nom.` };
    }
    const target = people[0];

    const wantsRole = asStr(input, "role");
    const hasSecondary = typeof input.secondaryRole === "string"; // "" = retirer, absent = inchangé
    const wantsSecondary = hasSecondary ? String(input.secondaryRole).trim() : null;
    if (!wantsRole && !hasSecondary) return { error: "Précisez le nouveau rôle (role) et/ou l'autre rôle (secondaryRole — vide pour le retirer)." };

    const labelOf = (code: string | null): string => (code ? (ROLE_LABELS[code as keyof typeof ROLE_LABELS] ?? code) : "aucun");
    const fields = [{ label: "Compte", value: target.name }];
    let role: string | null = null;
    if (wantsRole) {
      role = normalizeRole(wantsRole);
      if (!role) return { error: `Rôle « ${wantsRole} » inconnu — donner un libellé exact (ex. « Délégué médical »).` };
      if (role === target.role) return { error: `${target.name} a déjà le rôle ${labelOf(role)}.` };
      fields.push({ label: "Rôle", value: `${labelOf(target.role)} → ${labelOf(role)}` });
    }
    let secondaryRole: string | null = null;
    if (hasSecondary) {
      if (wantsSecondary) {
        secondaryRole = normalizeRole(wantsSecondary);
        if (!secondaryRole) return { error: `Rôle secondaire « ${wantsSecondary} » inconnu.` };
        // L'anti-escalade de l'écran, dit dès la proposition (l'action re-refusera aussi).
        if (secondaryRole === "SUPER_ADMIN") return { error: "Le rôle secondaire ne peut pas être Super Admin (anti-escalade) — la même règle que l'écran." };
      } else {
        secondaryRole = ""; // retirer
      }
      fields.push({ label: "Autre rôle", value: `${labelOf(target.secondaryRole)} → ${secondaryRole ? labelOf(secondaryRole) : "aucun"}` });
    }
    return {
      kind: "set_account_role",
      module: "ADMIN",
      level: "SENSITIVE",
      title: `Changer le rôle de ${target.name}`,
      fields,
      warnings: ["Les droits du compte changent IMMÉDIATEMENT à la confirmation (menus, modules, périmètre).", ...warnings],
      payload: {
        kind: "set_account_role",
        userId: target.id, userName: target.name,
        role, roleBefore: target.role,
        secondaryRole, secondaryBefore: target.secondaryRole ?? "",
      },
    };
  }

  return undefined;
}
