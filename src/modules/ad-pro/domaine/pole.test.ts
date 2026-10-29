import { describe, it, expect } from "vitest";
import { AD_PRO_KINDS } from "./unified";
import { PERMISSIONS, rolesWithModule, type Module } from "@/lib/rbac";

/**
 * LE PÔLE Ad & Pro EST-IL ENTIER POUR CELLE QUI LE TRANCHE ?
 *
 * La Direction a décidé (09/2026) que la Direction Marketing reçoit « la gestion de Ad&Pro, pas
 * que sponsoring et matériel promotionnel » : c'est elle qui tranche toute demande du pôle et qui
 * choisit la sous-catégorie budgétaire. Le lot précédent ne lui avait ouvert que cinq natures sur
 * sept — `CONSULTING` et `AD_PRO_OTHER` manquaient — donc elle décidait de demandes qu'elle ne
 * pouvait pas ouvrir.
 *
 * Réparer les deux à la main ne protège pas la huitième (§118.58). Le cliquet s'arme donc sur le
 * REGISTRE CANONIQUE des natures Ad&Pro (`AD_PRO_KINDS`), l'endroit où toutes les instances
 * passent : `AD_PRO_ENTITY_TYPE` fait déjà échouer le typecheck sur une nature ajoutée sans type
 * d'entité, et ce test fait échouer la suite sur une nature ajoutée sans décision de permission.
 *
 * POURQUOI LE CLIQUET ET NON UNE DÉRIVATION. Une permission est une DÉCISION, déclarée
 * exhaustivement (§118.130) : dériver le tableau de `rbac.ts` depuis `AD_PRO_KINDS` accorderait
 * MANAGE sur une huitième nature dont personne n'aurait décidé, et le socle n'a de toute façon
 * pas le droit de lire `lib/ad-pro/` (`domains.ts` : `socleLeaks` doit rester à 0). Un test, lui,
 * est hors de la carte des domaines — c'est le bon endroit pour le CONSTAT.
 *
 * CE QUI LE FERAIT TOMBER, nommément : retirer `CONSULTING: MANAGE` ou `AD_PRO_OTHER: MANAGE` de
 * `PRODUCT_MANAGER` ; ajouter une huitième nature à `AD_PRO_KINDS` sans dire ce que la Direction
 * Marketing y reçoit ; rabaisser l'un des sept de MANAGE à READ.
 */

/** Les modules du pôle, lus sur le registre canonique — jamais recopiés ici. */
const MODULES_DU_POLE: Module[] = AD_PRO_KINDS.map((k) => k.module);

/**
 * CE QUE « GESTION » VEUT DIRE, ACTION PAR ACTION.
 *
 * On ne compare pas au tableau `MANAGE` de `rbac.ts` (il n'est pas exporté, et s'y adosser ferait
 * passer le test quel que soit son contenu — y compris vidé). On nomme les quatre actions sans
 * lesquelles « trancher une demande » n'a pas de sens : la voir, la corriger, la trancher, et
 * pouvoir en créer une. VALIDATE est la décisive : c'est aussi elle que lit le ciblage des
 * notifications (`rolesWithModule`).
 */
const GESTION = ["VIEW", "CREATE", "UPDATE", "VALIDATE"] as const;

describe("Ad & Pro — le pôle entier pour la Direction Marketing", () => {
  it("le registre canonique compte sept natures, chacune avec son module", () => {
    // Si ce compte change, c'est qu'une nature a été ajoutée ou retirée : les assertions qui
    // suivent le verront, mais on veut d'abord SAVOIR que le pôle a bougé.
    expect(MODULES_DU_POLE).toHaveLength(7);
    expect(new Set(MODULES_DU_POLE).size).toBe(7); // deux natures ne partagent pas un module
  });

  for (const action of GESTION) {
    it(`la Direction Marketing peut ${action} sur CHACUNE des natures du pôle`, () => {
      const manquants = MODULES_DU_POLE.filter(
        (m) => !(PERMISSIONS.PRODUCT_MANAGER[m] ?? []).includes(action),
      );
      expect(
        manquants,
        `PRODUCT_MANAGER n'a pas ${action} sur : ${manquants.join(", ")} — c'est une nature du pôle Ad & Pro (AD_PRO_KINDS). ` +
          "La Direction a décidé qu'elle en reçoit la GESTION : ajoutez le module à PRODUCT_MANAGER dans rbac.ts, " +
          "ou écrivez ici pourquoi cette nature-là lui échappe.",
      ).toEqual([]);
    });
  }

  it("le ciblage des notifications la trouve sur chaque nature du pôle", () => {
    // Le vrai lecteur de production : c'est par là que passe « qui prévenir sur ce module ? ».
    // Sans lui, une demande de consulting partirait sans que sa décideuse en soit avertie.
    const muets = MODULES_DU_POLE.filter((m) => !rolesWithModule(m, "VALIDATE").includes("PRODUCT_MANAGER"));
    expect(muets, `rolesWithModule(…, "VALIDATE") ignore PRODUCT_MANAGER sur : ${muets.join(", ")}`).toEqual([]);
  });

  it("les deux natures qui MANQUAIENT sont nommées, pour que la régression soit lisible", () => {
    // L'assertion générale ci-dessus suffit à attraper le défaut ; celle-ci dit LEQUEL a été
    // payé, de sorte qu'un futur retrait tombe sur un message qui raconte l'histoire.
    expect(PERMISSIONS.PRODUCT_MANAGER.CONSULTING ?? []).toContain("VALIDATE");
    expect(PERMISSIONS.PRODUCT_MANAGER.AD_PRO_OTHER ?? []).toContain("VALIDATE");
  });
});
