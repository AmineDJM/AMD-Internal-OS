import { describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import * as origin from "./origin";
import { adProInit, adProOriginRank } from "./origin";
import { parcoursEffectif, SLUG_DG, SLUG_DIRECTION, SLUG_MARKETING, SLUG_PRELIMINAIRE } from "./parcours";

/** Une nature ordinaire : l'ENTRÉE ne dépend pas de la nature (§118.156), seule la suite en dépend. */
const C = "CONGRESS_NATIONAL" as const;

const u = (role: UserRole, secondaryRole: UserRole | null = null) => ({ role, secondaryRole });

/** La colonne vertébrale, dans l'ordre de la définition (§118.138) — la porte du DG est hors route depuis le 27/10/2026. */
const SPINE = [SLUG_PRELIMINAIRE, SLUG_DG, SLUG_DIRECTION, SLUG_MARKETING];

describe("Routage Ad & Pro selon le rang du créateur (origin)", () => {
  it("un délégué part de l'étape préliminaire (circuit complet)", () => {
    const init = adProInit(u("MEDICAL_DELEGATE"), C);
    expect(adProOriginRank(u("MEDICAL_DELEGATE"))).toBe(0);
    expect(init.stage).toBe("PRELIMINARY");
    expect(init.status).toBe("AWAITING_PRELIMINARY");
    expect(init.productManagerId).toBeNull();
    expect(init.preliminaryBySelf).toBe(false);
  });

  it("le National Sales n'approuve pas sa propre demande : elle entre chez le Directeur des opérations", () => {
    expect(adProOriginRank(u("NATIONAL_SALES"))).toBe(1);
    const init = adProInit(u("NATIONAL_SALES"), C, "pm-1");
    expect(init.stage).toBe("ANALYSIS");
    expect(init.status).toBe("PRELIMINARY_APPROVED");
    expect(init.productManagerId, "le référent nommé est enregistré").toBe("pm-1");
    expect(init.preliminaryBySelf).toBe(true);
  });

  it("National Sales SANS référent nommé : la demande part QUAND MÊME", () => {
    // Le référent est un ENREGISTREMENT, plus une condition : la décision appartient au RÔLE
    // Direction Marketing tout entier. L'exiger ferait échouer une demande légitime le jour où
    // la personne qui suit la gamme est absente de la liste.
    const init = adProInit(u("NATIONAL_SALES"), C);
    expect(init.stage).toBe("ANALYSIS");
    expect(init.status).toBe("PRELIMINARY_APPROVED");
    expect(init.productManagerId).toBeNull();
    expect(init.preliminaryBySelf).toBe(true);
  });

  it("TOUT AUTRE DEMANDEUR — ni KAM, ni de la chaîne commerciale — entre au même endroit", () => {
    // Un demandeur hors force de vente n'a pas de superviseur national : l'étape préliminaire
    // serait un accord demandé à quelqu'un qui n'a pas autorité sur lui. Son N+1 est le
    // Directeur des opérations (27/10/2026).
    for (const role of ["DIRECTION_ASSISTANT", "FINANCE_BUDGET_MANAGER", "COORDINATOR"] as UserRole[]) {
      const init = adProInit(u(role), C);
      expect(adProOriginRank(u(role)), role).toBe(0);
      expect(init.stage, role).toBe("ANALYSIS");
      expect(init.status, role).toBe("PRELIMINARY_APPROVED");
    }
  });

  it("SEUL le KAM passe par le préliminaire — puis le Directeur des opérations ; et le RANG l'emporte sur le métier", () => {
    // Un délégué médical de rang 0 : National Sales, puis Directeur des opérations, puis Direction
    // Marketing — la porte du DG seule est hors route (le DG valide le total des postes, à la fin).
    expect(adProInit(u("MEDICAL_DELEGATE"), C).stage).toBe("PRELIMINARY");
    const kam = parcoursEffectif(u("MEDICAL_DELEGATE"), SPINE, 0, C);
    expect(kam.decision, "Direction Marketing prévalide, et c'est la dernière étape").toBeNull();
    expect(kam.ignorees, "le National Sales ET le Directeur des opérations valident").toEqual([SLUG_DG]);
    // Un délégué qui porte aussi le National Sales suit la branche de son rang : pas son propre
    // préliminaire, le Directeur des opérations directement.
    const nsDelegue = u("MEDICAL_DELEGATE", "NATIONAL_SALES");
    expect(adProInit(nsDelegue, C).stage).toBe("ANALYSIS");
    expect(parcoursEffectif(nsDelegue, SPINE, 1, C).entree).toBe(SLUG_DIRECTION);
  });

  it("Direction Marketing entre sur SA propre étape, prévalidée d'office ; le Manager Promotion médicale passe par le Directeur des opérations", () => {
    // Ce qui le ferait tomber : l'ancienne route du rang 2 (porte du DG, puis la Direction des
    // opérations qui tranchait à sa place). Depuis le 27/10/2026, la demande de la Direction
    // Marketing n'attend personne ; le Manager Promotion médicale, lui, n'est pas la Direction
    // Marketing — son N+1 est le Directeur des opérations.
    expect(adProOriginRank(u("PRODUCT_MANAGER"))).toBe(2);
    const dm = adProInit(u("PRODUCT_MANAGER"), C, "pm-1");
    expect([dm.stage, dm.status, dm.preliminaryBySelf]).toEqual(["FINAL", "AWAITING_FINAL", true]);
    const pDm = parcoursEffectif(u("PRODUCT_MANAGER"), SPINE, 2, C);
    expect(pDm.entree).toBe(SLUG_MARKETING);
    expect(pDm.dOffice, "prévalidée d'office").toBe(true);
    expect(pDm.ignorees).toEqual([SLUG_PRELIMINAIRE, SLUG_DG, SLUG_DIRECTION]);

    expect(adProOriginRank(u("MEDICAL_PROMOTION_MANAGER"))).toBe(2);
    const mpm = adProInit(u("MEDICAL_PROMOTION_MANAGER"), C, "pm-1");
    expect([mpm.stage, mpm.status, mpm.preliminaryBySelf]).toEqual(["ANALYSIS", "PRELIMINARY_APPROVED", true]);
    const pMpm = parcoursEffectif(u("MEDICAL_PROMOTION_MANAGER"), SPINE, 2, C);
    expect([pMpm.entree, pMpm.decision, pMpm.dOffice]).toEqual([SLUG_DIRECTION, null, false]);
  });

  it("la Direction et le Super Admin vont DIRECTEMENT chez Direction Marketing, qui prévalide", () => {
    // Tout ce qui précède est soit leur propre accord, soit une étape qui n'est plus sur la route.
    // Ce qui le ferait tomber : les faire passer par le Directeur des opérations — la Direction
    // attendrait l'accord de quelqu'un de son propre rang.
    for (const role of ["DIRECTION", "SUPER_ADMIN"] as UserRole[]) {
      expect(adProOriginRank(u(role))).toBe(3);
      expect(adProInit(u(role), C).stage, role).toBe("FINAL");
      expect(adProInit(u(role), C).status, role).toBe("AWAITING_FINAL");
      expect(parcoursEffectif(u(role), SPINE, 3, C).dOffice, `${role} : la prévalidation d'office est réservée à la Direction Marketing`).toBe(false);
    }
  });

  // Le Directeur Général et le Directeur des Opérations n'ont pas la VUE GLOBALE (cloisonnement
  // voulu), mais ils n'ont personne au-dessus d'eux pour approuver : sans rang explicite, ils
  // retombaient au rang 0 et attendaient l'accord d'un superviseur qu'ils dirigent.
  it("le Directeur Général et le Directeur des Opérations vont eux aussi directement à la prévalidation", () => {
    for (const role of ["GENERAL_MANAGER", "OPERATIONS_DIRECTOR"] as UserRole[]) {
      expect(adProOriginRank(u(role)), role).toBe(3);
      const init = adProInit(u(role), C);
      expect(init.stage, role).toBe("FINAL");
      expect(init.status, role).toBe("AWAITING_FINAL");
      expect(init.preliminaryBySelf, role).toBe(true);
    }
  });

  it("le rang tient compte du rôle secondaire (ex. délégué avec National Sales en secondaire)", () => {
    expect(adProOriginRank(u("MEDICAL_DELEGATE", "NATIONAL_SALES"))).toBe(1);
    expect(adProOriginRank(u("MEDICAL_DELEGATE", "DIRECTION"))).toBe(3);
    expect(adProOriginRank(u("NATIONAL_SALES", "PRODUCT_MANAGER"))).toBe(2);
  });
});

/**
 * PLUS PERSONNE NE DÉSIGNE DE RÉFÉRENT, ET LE CIRCUIT NE SE CHOISIT PLUS.
 *
 * Deux réglages retirés pour la même raison — ils ne changeaient plus rien.
 * `canChooseAnalysisAtCreation` est partie avec `viaProductManager` quand Direction Marketing
 * est devenue l'étape qui TRANCHE toute demande Ad & Pro (§118.138) ;
 * `canDesignateProductManagerAtCreation` est partie avec le menu du référent, sur décision de
 * la Direction (22/09/2026 : « ça va DIRECT chez le directeur/directrice du département
 * marketing »). Un réglage d'écran sans effet est un mensonge fait à qui le règle (§118.14,
 * §118.50).
 *
 * `adProInit` CONTINUE d'accepter un référent : les actions serveur le prennent encore, et le
 * référent se configurera par Business Unit. Ce qui a disparu est le MENU, pas le champ — et
 * ces deux cas tiennent la nuance.
 */
describe("le référent Direction Marketing, quand une action en fournit encore un", () => {
  it("le référent nommé est enregistré là où il a un sens, et ignoré ailleurs", () => {
    expect(adProInit({ role: "DIRECTION" }, C, "pm_1").productManagerId).toBe("pm_1");
    expect(adProInit({ role: "MEDICAL_DELEGATE" }, C, "pm_1").productManagerId, "un KAM entre par son superviseur").toBeNull();
    expect(adProInit({ role: "DIRECTION" }, C, "   ").productManagerId, "un nom vide ne désigne personne").toBeNull();
  });

  it("le CHOIX de circuit n'existe plus — l'export a disparu avec le champ qu'il posait", () => {
    // Ce qui le ferait tomber : réintroduire l'export sans réintroduire son effet. Une porte
    // d'écran qui ne change rien est pire que pas de porte du tout.
    expect((origin as Record<string, unknown>).canChooseAnalysisAtCreation).toBeUndefined();
  });
});

