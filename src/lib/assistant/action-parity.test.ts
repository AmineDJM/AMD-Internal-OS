import { describe, expect, it } from "vitest";
import { clesDesActions } from "@/lib/actions/parc";
import {
  ACTION_CLASSIFICATION, ERP_ACTIONS, matchNativeAction, nativeActionHint, actionsForUser, parityStats,
} from "./action-registry";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";

/**
 * PARITÉ UI ↔ CHIEF COMME INVARIANT DE BUILD (« no more capability whack-a-mole »).
 *
 * Le scan relit le parc des actions (`src/lib/actions/` et les `actions.ts` des modules) À CHAQUE exécution : un développeur qui ajoute un bouton
 * métier (— donc une server action —) sans la classer dans le registre voit ce test échouer
 * avec le nom exact de l'action. Un trou peut être ASSUMÉ (statut GAP, note), jamais SILENCIEUX.
 * Le même test verrouille l'hygiène du registre (ids uniques, alias résolus, portes sûres) et
 * imprime la métrique UI_ACTION_PARITY.
 */

/**
 * Les clés vivantes du PARC (`src/lib/actions/parc.ts`) : `src/lib/actions/` et les `actions.ts` des
 * modules, sous leur clé déclarée — une action rangée dans son module reste classée sous la même clé.
 */
function liveActionKeys(): Set<string> {
  return clesDesActions();
}

function userWith(role: CurrentUser["role"], perms: Record<string, string[]> = {}): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [m, { module: m, actions: new Set(actions), scope: "ALL" as const }]),
  );
  return {
    id: "u1", name: "T", email: "t@x.dz", role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

describe("ZERO-GAP — chaque action serveur de l'ERP est classée, aucun trou silencieux", () => {
  const live = liveActionKeys();

  it("toute action serveur EXISTANTE est classée (NATIVE / COVERED / GAP / EXCLUDED)", () => {
    const missing = [...live].filter((k) => !ACTION_CLASSIFICATION[k]);
    expect(
      missing,
      `ERP ACTION WITHOUT ASSISTANT PARITY CLASSIFICATION:\n${missing.join("\n")}\n→ classer dans src/lib/assistant/action-registry.ts (NATIVE/COVERED/GAP/EXCLUDED avec via/note)`,
    ).toEqual([]);
  });

  it("aucune classification FANTÔME (action disparue du code mais encore classée)", () => {
    const stale = Object.keys(ACTION_CLASSIFICATION).filter((k) => !live.has(k));
    expect(stale, `Classifications périmées à retirer du registre :\n${stale.join("\n")}`).toEqual([]);
  });

  it("le nombre de TROUS assumés ne grandit pas en silence (cliquet)", () => {
    const stats = parityStats();
    // Cliquet : combler un trou ABAISSE ce plafond ; en ouvrir un nouveau exige de le relever
    // ICI, consciemment, dans la même revue de code que la nouvelle action.
    expect(stats.gap).toBe(0);
    expect(stats.native + stats.covered).toBeGreaterThanOrEqual(566);

    console.info(`[UI_ACTION_PARITY] natives=${stats.native} couvertes=${stats.covered} trous=${stats.gap} exclues=${stats.excluded} — parité=${stats.parityPct}% (sur ${stats.total} actions classées)`);
  });

  it("hygiène du registre : ids uniques, chaque NATIVE/COVERED référence un `via` non vide", () => {
    const ids = ERP_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [key, c] of Object.entries(ACTION_CLASSIFICATION)) {
      if (c.status === "NATIVE" || c.status === "COVERED") {
        expect(c.via, `${key} : via manquant`).toBeTruthy();
      } else {
        expect(c.note, `${key} : note manquante`).toBeTruthy();
      }
    }
  });
});

describe("ZERO-GAP — résolution d'intention vers l'action NATIVE (priorité au natif)", () => {
  it("GOLDEN (échec réel) : « actualisation du solde du compte bancaire » → l'action Finances native, PAS une demande générique", () => {
    for (const phrasing of [
      "Est-ce que tu peux demander une actualisation du solde du compte bancaire ?",
      "Demande l'actualisation des soldes.",
      "Il faut rafraîchir les soldes bancaires",
      "demande une mise à jour du solde de trésorerie",
    ]) {
      const m = matchNativeAction(phrasing);
      expect(m.map((a) => a.id), phrasing).toContain("FINANCE_REQUEST_BALANCE_REFRESH");
    }
    const hint = nativeActionHint("Demande l'actualisation des soldes");
    expect(hint).toContain("request_treasury_update");
    expect(hint).toMatch(/jamais une demande administrative générique/);
  });

  it("« Demande à Raihana de vérifier les dossiers Nintedanib » → AUCUNE action native ne matche (repli tâche, par la règle métier)", () => {
    const m = matchNativeAction("Demande à Raihana de vérifier les dossiers Nintedanib");
    expect(m.find((a) => a.id === "FINANCE_REQUEST_BALANCE_REFRESH")).toBeUndefined();
    // « demande à » peut légitimement matcher la demande de tâche — mais jamais une action
    // d'un autre module par un alias trop large.
    for (const a of m) expect(["TASK_CREATE_OR_REQUEST"]).toContain(a.id);
  });

  it("« Supprime définitivement ces deux dossiers » → l'action de suppression native (jamais « je ne peux pas »)", () => {
    const m = matchNativeAction("Supprime définitivement ces deux dossiers");
    expect(m.map((a) => a.id)).toContain("RECORD_DELETE");
  });

  it("phrase sans intention d'action → aucun indice (pas de faux positif qui pousse le modèle)", () => {
    expect(matchNativeAction("Quel est l'état du dossier REG-2026-041 ?")).toEqual([]);
    expect(nativeActionHint("Bonjour, comment vas-tu ?")).toBeNull();
  });

  it("OPS DE DOMAINE — les gestes Drive/Tâches se résolvent vers l'outil de domaine, op affichée dans l'indice", () => {
    expect(matchNativeAction("Range ce fichier dans le dossier Campagne").map((a) => a.id))
      .toContain("OP_DRIVE_OPERATION_MOVE");
    expect(matchNativeAction("Partage le dossier avec Yasmine").map((a) => a.id))
      .toContain("OP_DRIVE_OPERATION_SHARE");
    expect(matchNativeAction("J'accepte la demande de tâche").map((a) => a.id))
      .toContain("OP_TASK_OPERATION_ACCEPT");
    const hint = nativeActionHint("range ce fichier dans le dossier campagne");
    expect(hint).toContain("drive_operation");
    expect(hint).toContain("op « move »");
  });

  it("OPS DE DOMAINE — la reclassification AUTOMATIQUE : les actions couvertes par le catalogue sont NATIVE, via tool:op", () => {
    expect(ACTION_CLASSIFICATION["drive-actions:createFolder"]).toEqual({ status: "NATIVE", via: "drive_operation:create_folder" });
    expect(ACTION_CLASSIFICATION["drive-actions:deleteNode"]).toEqual({ status: "NATIVE", via: "drive_operation:delete" });
    expect(ACTION_CLASSIFICATION["drive-actions:shareNodeWithMany"]?.status).toBe("NATIVE");
    expect(ACTION_CLASSIFICATION["task-actions:respondTaskRequest"]).toEqual({ status: "NATIVE", via: "task_operation:accept" });
    expect(ACTION_CLASSIFICATION["task-actions:submitTaskWork"]?.status).toBe("NATIVE");
    expect(ACTION_CLASSIFICATION["expense-actions:settleExpenseOrder"]).toEqual({ status: "NATIVE", via: "finance_operation:settle_expense_order" });
    expect(ACTION_CLASSIFICATION["petty-cash-actions:decidePettyCashTopUp"]?.status).toBe("NATIVE");
    expect(ACTION_CLASSIFICATION["regulatory-actions:createRegulatoryProduct"]).toEqual({ status: "NATIVE", via: "regulatory_operation:create_product" });
    expect(ACTION_CLASSIFICATION["regulatory-actions:requestBV"]?.status).toBe("NATIVE");
    // Création de compte : couverte par le chemin INVITATION (jamais de mot de passe en chat).
    expect(ACTION_CLASSIFICATION["admin-actions:createUser"]).toEqual({ status: "NATIVE", via: "org_operation:create_account_invite" });
    // FICHIERS FIRST-CLASS : les gestes à fichier passent par le Chief (fichier du Drive
    // résolu par NOM, droits revérifiés à l'exécution) — plus AUCUN trou assumé.
    expect(ACTION_CLASSIFICATION["document-actions:uploadDocument"]).toEqual({ status: "NATIVE", via: "task_operation:upload_document" });
    expect(ACTION_CLASSIFICATION["finance-actions:importTransactions"]).toEqual({ status: "NATIVE", via: "finance_operation:import_transactions" });
  });
});

describe("ZERO-GAP — découverte : « qu'est-ce que je peux faire ici ? »", () => {
  it("le Super Admin voit les actions d'administration ; le module filtre ; la porte écarte les autres", () => {
    const sa = userWith("SUPER_ADMIN");
    const all = actionsForUser(sa);
    expect(all.map((a) => a.id)).toContain("RECORD_DELETE");
    expect(all.map((a) => a.id)).toContain("FINANCE_REQUEST_BALANCE_REFRESH");
    const admin = actionsForUser(sa, "Administration");
    expect(admin.map((a) => a.id)).toContain("ACCOUNT_SET_ACTIVE");
    expect(admin.map((a) => a.id)).not.toContain("SALARY_UPDATE");
  });

  it("un délégué sans droits n'obtient QUE les actions ouvertes à tous — la liste dit la vérité", () => {
    const delegate = userWith("MEDICAL_DELEGATE");
    const ids = actionsForUser(delegate).map((a) => a.id);
    expect(ids).not.toContain("RECORD_DELETE");
    expect(ids).not.toContain("ACCOUNT_SET_ACTIVE");
    expect(ids).not.toContain("REGULATORY_UPDATE_FIELD");
    expect(ids).toContain("MESSAGE_SEND");
    expect(ids).toContain("CALENDAR_EVENT_CREATE");
  });

  it("sur le Centre de paiement : la décision de paiement est là, documentée (sémantique, risque)", () => {
    const sa = userWith("SUPER_ADMIN");
    const payments = actionsForUser(sa, "paiement");
    const decide = payments.find((a) => a.id === "PAYMENT_DECIDE");
    expect(decide).toBeDefined();
    expect(decide?.risk).toBe("SENSITIVE");
    expect(decide?.summary).toMatch(/canonique/);
  });
});
