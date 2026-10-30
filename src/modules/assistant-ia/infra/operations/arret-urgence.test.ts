import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARRÊT D'URGENCE DES ACTIONS DE L'IA VAUT AUSSI POUR L'ASSISTANT IA (audit 27/10, IA-ASSISTANT-02).
 *
 * `aiExternalActionsDisabled` (Administration › Réglages) promet : « aucune action externe de l'IA ne
 * s'exécute, même confirmée ». Seul `performAction` (Adam) le lisait ; le registre de l'Assistant IA
 * (`executerOperationIA` : demandes Ad & Pro, bons de commande, messages, rendez-vous, relances,
 * dépôts) exécutait quand même. Ce banc l'exige dans les deux sens : levé, l'opération n'est JAMAIS
 * appelée ; baissé, elle passe comme avant.
 *
 * Les réglages sont SIMULÉS : la ligne `AppSetting` est globale et partagée par la suite (§118.115).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const reglages = vi.hoisted(() => ({ arret: false }));
vi.mock("@/lib/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/settings")>()),
  getAppSettings: async () => ({ aiExternalActionsDisabled: reglages.arret }),
}));

import { executerOperationIA, OPERATIONS_IA, REFUS_ARRET_URGENCE } from "./";

const user = { id: "u-arret", role: "SUPER_ADMIN" } as unknown as CurrentUser;
const op = OPERATIONS_IA.find((o) => o.nom === "programmer_routine")!;

afterEach(() => {
  reglages.arret = false;
  vi.restoreAllMocks();
});

describe("executerOperationIA lit l'arrêt d'urgence AVANT d'exécuter", () => {
  it("levé : refus dit, et l'action métier n'est JAMAIS appelée", async () => {
    reglages.arret = true;
    const executer = vi.spyOn(op, "executer").mockResolvedValue({ ok: true, message: "fait" });
    const r = await executerOperationIA(user, { kind: "assistant_ia_op", op: op.nom, args: {} });
    expect(r).toEqual({ ok: false, error: REFUS_ARRET_URGENCE });
    expect(executer).not.toHaveBeenCalled();
  });

  it("baissé : l'opération confirmée s'exécute comme avant", async () => {
    const executer = vi.spyOn(op, "executer").mockResolvedValue({ ok: true, message: "fait" });
    const r = await executerOperationIA(user, { kind: "assistant_ia_op", op: op.nom, args: {} });
    expect(r).toEqual({ ok: true, message: "fait" });
    expect(executer).toHaveBeenCalledOnce();
  });
});
