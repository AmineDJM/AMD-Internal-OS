/**
 * EXÉCUTION APRÈS CONFIRMATION — Regulatory (chargé, étape ANPP), corbeille, trésorerie, circuits,
 * champs personnalisés, comptes.
 * Des séries de branches de l'ancienne chaîne de `performAction` qui n'écrivent pas elles-mêmes en
 * base, recopiées telles quelles ; `actions-confirmees/executer.ts` appelle chacune à son rang, et
 * elle rend `undefined` quand l'action n'est pas la sienne.
 */

import {
  prisma, setRegulatoryResponsible, setRegulatoryStepState, setRegulatoryPresubOutcome,
  requestRegulatoryStatusUpdate, superAdminDelete, restoreDeletedRecord, destroyDeletedRecord, toggleUserActive,
  updateUserRole, setSecondaryRole, requestTreasuryUpdate, upsertCustomFieldDef, deleteCustomFieldDef,
} from "@/lib/assistant/coeur/erp";
// Les demandes Ad & Pro, le secrétariat et les circuits : par le pont (frontière Adam ↔ ERP).
import { advanceWorkflow, saveWorkflowDefinition, resetWorkflowDefinition } from "@/platform/in-process/demandes";
import { ROLE_LABELS } from "@/lib/labels";
import type { ExecuteResult, ContexteExecution } from "@/lib/assistant/actions-confirmees/aides";

/** Branches de `performAction` : chargé d'un dossier Regulatory et étape ANPP. */
export async function executerChargeEtEtapeRegulatory(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { payload } = c;

  if (payload?.kind === "assign_regulatory_responsible") {
    // RÉUTILISATION DE L'ACTION CANONIQUE de l'écran : même porte (Super Admin), même audit,
    // même notification, même gestion du cadenas — jamais une deuxième logique métier.
    const fd = new FormData();
    fd.set("id", payload.productId);
    fd.set("responsibleId", payload.responsibleId ?? "");
    const r = await setRegulatoryResponsible(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "L'assignation a été refusée." };
    return {
      ok: true,
      message: payload.responsibleName
        ? `${payload.reference} confié à ${payload.responsibleName}${r.message ? ` — ${r.message}` : ""}.`
        : `${payload.reference} — chargé du dossier retiré.`,
      link: `/regulatory/${payload.productId}`,
      revalidate: ["/regulatory", `/regulatory/${payload.productId}`],
    };
  }

  if (payload?.kind === "set_regulatory_step") {
    // Même principe : les actions canoniques des étapes ANPP font foi (validation des clés,
    // avis de présoumission dérivant le statut, audit, revalidation d'écran).
    const fd = new FormData();
    fd.set("productId", payload.productId);
    if (payload.outcome) {
      fd.set("outcome", payload.outcome);
      if (payload.note) fd.set("note", payload.note);
      const r = await setRegulatoryPresubOutcome(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de la présoumission a été refusée." };
    } else {
      fd.set("stepKey", payload.stepKey);
      fd.set("status", payload.status ?? "");
      if (payload.note) fd.set("note", payload.note);
      if (payload.date) fd.set("date", payload.date);
      const r = await setRegulatoryStepState(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de l'étape a été refusée." };
    }
    return {
      ok: true,
      message: `${payload.reference} — étape « ${payload.stepLabel} » : ${payload.outcome ?? payload.status}.`,
      link: `/regulatory/${payload.productId}`,
      revalidate: ["/regulatory", `/regulatory/${payload.productId}`],
    };
  }

  return undefined;
}

/** Branches de `performAction` : corbeille (suppression, restauration, purge), relance de trésorerie, circuits, champs personnalisés, relance Regulatory, comptes (activation, rôle). */
export async function executerCorbeilleEtAdministration(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload } = c;

  if (payload?.kind === "delete_record") {
    // RÉUTILISATION DE L'ACTION CANONIQUE du bouton « Supprimer définitivement » : même porte
    // (rôle revérifié dans l'action), même instantané en corbeille, même audit, même nettoyage
    // des Documents/Commentaires polymorphes — jamais un `prisma.delete` improvisé.
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "La suppression définitive est réservée au Super Admin." };
    const fd = new FormData();
    fd.set("kind", payload.deleteKind);
    fd.set("id", payload.targetId);
    const r = await superAdminDelete(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La suppression a été refusée." };
    return {
      ok: true,
      message: `« ${payload.name} » (${payload.label}) supprimé — restaurable depuis la corbeille (Administration → Corbeille).`,
      link: "/admin/corbeille",
      revalidate: [payload.redirect, "/admin/corbeille"],
    };
  }

  if (payload?.kind === "restore_record") {
    // ACTION CANONIQUE de la corbeille : même porte (Super Admin revérifié), même recréation à
    // l'identique (ligne + pièces + commentaires), même audit.
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "La restauration est réservée au Super Admin." };
    const fd = new FormData();
    fd.set("id", payload.recordId);
    const r = await restoreDeletedRecord(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La restauration a été refusée." };
    return {
      ok: true,
      message: `« ${payload.name} » (${payload.label}) restauré — l'élément est de retour à sa place.`,
      link: r.redirect ?? "/admin/corbeille",
      revalidate: ["/admin/corbeille", ...(r.redirect ? [r.redirect] : [])],
    };
  }

  if (payload?.kind === "purge_record") {
    // ACTION CANONIQUE de la destruction réelle : fichiers effacés, entrée marquée purgée.
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "La destruction définitive est réservée au Super Admin." };
    const fd = new FormData();
    fd.set("id", payload.recordId);
    const r = await destroyDeletedRecord(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La destruction a été refusée." };
    return {
      ok: true,
      message: `« ${payload.name} » (${payload.label}) détruit définitivement — fichiers effacés, aucun retour possible.`,
      link: "/admin/corbeille",
      revalidate: ["/admin/corbeille"],
    };
  }

  if (payload?.kind === "request_treasury_update") {
    // L'ACTION NATIVE du bouton Finances — porte revérifiée dans l'action (Super Admin /
    // vision globale), notification des responsables Finances, audit identique à l'écran.
    const fd = new FormData();
    if (payload.note) fd.set("note", payload.note);
    const r = await requestTreasuryUpdate(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande d'actualisation a été refusée." };
    // Sans entité précisée, l'action prend l'entité par défaut (Adventum) ; sa phrase dit laquelle.
    return {
      ok: true,
      message: r.message ?? "Demande d'actualisation des soldes envoyée aux responsables Finance.",
      link: r.id ? `/finances/actualisation-soldes/${r.id}` : "/finances/paiements-a-faire",
      revalidate: ["/finances"],
    };
  }

  if (payload?.kind === "configure_workflow") {
    // LE BUILDER CANONIQUE de l'écran : porte Super Admin revérifiée, validation intégrale des
    // étapes (rôles, pouvoirs, APPROVE obligatoire), audit — jamais une deuxième logique.
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "La configuration des circuits est réservée au Super Admin." };
    const fd = new FormData();
    if (payload.reset) {
      fd.set("category", payload.category);
      const r = await resetWorkflowDefinition(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La réinitialisation a été refusée." };
      return { ok: true, message: `Circuit ${payload.categoryLabel} réinitialisé au défaut.`, link: "/admin/workflows", revalidate: ["/admin/workflows"] };
    }
    fd.set("payload", payload.payloadJson ?? "");
    const r = await saveWorkflowDefinition(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La reconfiguration a été refusée." };
    return {
      ok: true,
      message: `Circuit ${payload.categoryLabel} reconfiguré — ${payload.stepTitles.length} étape·s : ${payload.stepTitles.join(" → ")}.`,
      link: "/admin/workflows",
      revalidate: ["/admin/workflows"],
    };
  }

  if (payload?.kind === "advance_workflow") {
    // L'ACTION CANONIQUE du circuit : le MOTEUR décide qui peut agir (mêmes règles que l'écran),
    // trace l'événement, notifie l'étape suivante — SKIP inclus (raison obligatoire).
    const fd = new FormData();
    fd.set("entityType", payload.entityType);
    fd.set("entityId", payload.entityId);
    fd.set("action", payload.action);
    if (payload.note) fd.set("note", payload.note);
    if (payload.amount != null) fd.set("amount", String(payload.amount));
    const r = await advanceWorkflow(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La décision a été refusée par le moteur du circuit." };
    const verb = payload.action === "APPROVE" ? "approuvée" : payload.action === "REJECT" ? "refusée" : "étape sautée (raison tracée)";
    return {
      ok: true,
      message: `« ${payload.display} » — ${verb}.`,
      revalidate: ["/mon-espace"],
    };
  }

  if (payload?.kind === "manage_custom_field") {
    // LES ACTIONS CANONIQUES de l'écran Champs personnalisés — porte ADMIN revérifiée dedans.
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "La gestion des champs personnalisés est réservée au Super Admin." };
    const fd = new FormData();
    if (payload.op === "DELETE") {
      fd.set("id", payload.defId ?? "");
      const r = await deleteCustomFieldDef(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression du champ a été refusée." };
      return { ok: true, message: `Champ « ${payload.label} » retiré de ${payload.entityTypeLabel}.`, link: "/admin/fields", revalidate: ["/admin/fields"] };
    }
    if (payload.op === "UPDATE" && payload.defId) fd.set("id", payload.defId);
    fd.set("entityType", payload.entityType);
    fd.set("label", payload.label);
    fd.set("type", payload.type);
    if (payload.options) fd.set("options", payload.options);
    if (payload.order != null) fd.set("order", String(payload.order));
    fd.set("required", payload.required ? "true" : "false");
    const r = await upsertCustomFieldDef(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "L'enregistrement du champ a été refusé." };
    return {
      ok: true,
      message: `Champ « ${payload.label} » ${payload.op === "CREATE" ? "ajouté à" : "modifié sur"} ${payload.entityTypeLabel}${payload.required ? " — OBLIGATOIRE" : ""}.`,
      link: "/admin/fields",
      revalidate: ["/admin/fields"],
    };
  }

  if (payload?.kind === "request_regulatory_status_update") {
    // ACTION CANONIQUE du bouton de la fiche : porte supervision revérifiée, notifications aux
    // mêmes destinataires, audit identique.
    const fd = new FormData();
    fd.set("id", payload.productId);
    if (payload.note) fd.set("note", payload.note);
    const r = await requestRegulatoryStatusUpdate(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La relance a été refusée." };
    return {
      ok: true,
      message: `Relance envoyée sur ${payload.reference} — ${payload.recipients.length} destinataire(s) notifié(s) (${payload.recipients.join(", ")}).`,
      link: `/regulatory/${payload.productId}`,
      revalidate: [`/regulatory/${payload.productId}`],
    };
  }

  if (payload?.kind === "set_account_active") {
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "L'activation / désactivation des comptes est réservée au Super Admin." };
    // `toggleUserActive` BASCULE l'état : on relit d'abord l'état réel pour rendre l'exécution
    // idempotente — si quelqu'un a déjà fait le geste entre l'aperçu et le clic, on ne défait pas.
    const current = await prisma.user.findUnique({ where: { id: payload.userId }, select: { isActive: true, name: true } });
    if (!current) return { ok: false, error: "Compte introuvable." };
    if (current.isActive === payload.active) {
      return { ok: true, message: `Le compte de ${payload.userName} est déjà ${payload.active ? "actif" : "inactif"}.`, link: "/admin", revalidate: ["/admin"] };
    }
    const fd = new FormData();
    fd.set("id", payload.userId);
    const r = await toggleUserActive(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "Le changement d'état du compte a été refusé." };
    return {
      ok: true,
      message: payload.active ? `Compte de ${payload.userName} réactivé — connexion à nouveau possible.` : `Compte de ${payload.userName} désactivé — connexion bloquée (réversible à tout moment).`,
      link: "/admin",
      revalidate: ["/admin"],
    };
  }

  if (payload?.kind === "set_account_role") {
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Le changement de rôle des comptes est réservé au Super Admin." };
    const done: string[] = [];
    if (payload.role) {
      const fd = new FormData();
      fd.set("id", payload.userId);
      fd.set("role", payload.role);
      const r = await updateUserRole(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement de rôle a été refusé." };
      done.push(`rôle → ${ROLE_LABELS[payload.role as keyof typeof ROLE_LABELS] ?? payload.role}`);
    }
    if (payload.secondaryRole !== null) {
      const fd = new FormData();
      fd.set("id", payload.userId);
      fd.set("secondaryRole", payload.secondaryRole);
      const r = await setSecondaryRole(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement de l'autre rôle a été refusé." };
      done.push(payload.secondaryRole ? `autre rôle → ${ROLE_LABELS[payload.secondaryRole as keyof typeof ROLE_LABELS] ?? payload.secondaryRole}` : "autre rôle retiré");
    }
    return {
      ok: true,
      message: `Compte de ${payload.userName} : ${done.join(" ; ")}. Les droits sont effectifs immédiatement.`,
      link: "/admin",
      revalidate: ["/admin"],
    };
  }

  return undefined;
}
