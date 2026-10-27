import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { OPERATIONS_IA, outilsOperations, REFUS_SECONDE_CARTE, type PropositionCarte } from "@/lib/agent/operations";
import { lecturesQuotidien } from "@/lib/agent/lectures";
import { getAccess } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE CARTE PAR TOUR (audit 27/10, IA-ASSISTANT-04).
 *
 * `jouerTour` ne rend à l'écran que `propositions[0]`. Une seconde préparation dans le même tour
 * (« relance Karim et prends rendez-vous avec le Dr X ») persistait une intention PROPOSÉE que
 * personne ne voyait ni ne pouvait confirmer, pendant que le modèle annonçait deux cartes. Le
 * second geste est refusé AVANT d'être préparé — rien n'est écrit, pas même l'intention.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let user: CurrentUser;
beforeAll(async () => {
  // Un compte sans ligne en base : ses droits sont ceux de son rôle — de quoi voir tout le registre.
  const access = await getAccess("u-une-carte", "SUPER_ADMIN");
  user = { id: "u-une-carte", name: "Témoin", email: "temoin@t.dz", role: "SUPER_ADMIN", secondaryRole: null, access, mustChangePassword: false } as unknown as CurrentUser;
});
const carte: PropositionCarte = { intentId: "i-1", proposition: { kind: "assistant_ia_op", title: "Relance", fields: [] } };
const op = OPERATIONS_IA.find((o) => o.nom === "programmer_routine")!;

afterEach(() => vi.restoreAllMocks());

describe("une seule carte se prépare par tour", () => {
  it("une carte déjà préparée : la seconde opération est refusée et `proposer` n'est JAMAIS appelé", async () => {
    const proposer = vi.spyOn(op, "proposer");
    const propositions = [carte];
    const outil = outilsOperations(user, propositions).find((o) => o.def.name === op.nom)!;
    expect(await outil.run({}, user)).toBe(REFUS_SECONDE_CARTE);
    expect(proposer).not.toHaveBeenCalled();
    expect(propositions).toHaveLength(1);
  });

  it("aucune carte encore : l'opération se prépare comme avant", async () => {
    const proposer = vi.spyOn(op, "proposer").mockResolvedValue({ erreur: "témoin" });
    const outil = outilsOperations(user, []).find((o) => o.def.name === op.nom)!;
    expect(JSON.parse(await outil.run({}, user))).toEqual({ statut: "REFUS", raison: "témoin" });
    expect(proposer).toHaveBeenCalledOnce();
  });

  it("« reprendre » un brouillon ne réaffiche pas une seconde carte dans le même tour", async () => {
    const propositions = [carte];
    const brouillons = lecturesQuotidien(user, propositions).find((o) => o.def.name === "mes_brouillons")!;
    expect(await brouillons.run({ reprendre: "i-2" }, user)).toBe(REFUS_SECONDE_CARTE);
    expect(propositions).toHaveLength(1);
  });

  it("le refus dit au modèle de ne rien préparer d'autre — jamais un échec muet", () => {
    const r = JSON.parse(REFUS_SECONDE_CARTE);
    expect(r.statut).toBe("REFUS");
    expect(r.consigne).toMatch(/Ne prépare rien d'autre/);
  });
});
