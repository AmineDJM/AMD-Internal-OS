import { describe, it, expect } from "vitest";
import { breakdown, canEmitOrder, canSubmitItem, canRequestPurchaseOrder, canRemoveItem, budgetKindLocked, plannedGaps, ITEM_KINDS, ITEM_KIND_LABELS ,
  parentDuPoste, PARENT_COLONNE, PARENT_ENTITE, AD_PRO_PARENTS} from "./postes";

/**
 * La ventilation décide de ce que la Direction voit et de ce que les Finances paient. Une
 * erreur ici ne plante rien : elle fait simplement passer un dépassement pour un équilibre,
 * et on le découvre à la facture.
 */

describe("breakdown — ventiler l'enveloppe accordée", () => {
  it("sans enveloppe accordée, rien n'est équilibré : il n'y a pas encore de cible", () => {
    const b = breakdown([{ amountEstimated: 50_000 }], null);
    expect(b.envelopeDzd).toBeNull();
    expect(b.estimatedDzd).toBe(50_000);
    expect(b.balanced).toBe(false);
    expect(b.overrunDzd).toBe(0);
  });

  it("additionne estimations et affectations séparément — ce sont deux moments différents", () => {
    const b = breakdown(
      [
        { amountEstimated: 60_000, amountGranted: 50_000 },
        { amountEstimated: 40_000, amountGranted: 30_000 },
      ],
      100_000,
    );
    expect(b.estimatedDzd).toBe(100_000);
    expect(b.allocatedDzd).toBe(80_000);
  });

  it("signale ce qui reste à affecter", () => {
    const b = breakdown([{ amountGranted: 70_000 }], 100_000);
    expect(b.unallocatedDzd).toBe(30_000);
    expect(b.overrunDzd).toBe(0);
    expect(b.balanced).toBe(false);
  });

  it("une ventilation qui tombe juste est équilibrée", () => {
    const b = breakdown([{ amountGranted: 60_000 }, { amountGranted: 40_000 }], 100_000);
    expect(b.balanced).toBe(true);
    expect(b.unallocatedDzd).toBe(0);
    expect(b.overrunDzd).toBe(0);
  });

  it("EXPOSE le dépassement au lieu de le masquer — c'est tout l'intérêt de l'écran", () => {
    const b = breakdown([{ amountGranted: 90_000 }, { amountGranted: 40_000 }], 100_000);
    expect(b.overrunDzd).toBe(30_000);
    expect(b.unallocatedDzd).toBe(0);
    expect(b.balanced).toBe(false);
  });

  it("dit qu'un poste a été ajouté après décision — ce qui explique le dépassement", () => {
    const b = breakdown(
      [{ amountGranted: 100_000 }, { amountGranted: 25_000, addedAfterDecision: true }],
      100_000,
    );
    expect(b.overrunDzd).toBe(25_000);
    expect(b.hasLateAdditions).toBe(true);
  });

  it("aucun poste : l'enveloppe entière reste à affecter, et ce n'est pas « équilibré »", () => {
    const b = breakdown([], 100_000);
    expect(b.unallocatedDzd).toBe(100_000);
    expect(b.balanced).toBe(false);
    expect(b.itemCount).toBe(0);
  });

  it("ignore les montants absents plutôt que de produire NaN", () => {
    const b = breakdown([{ amountGranted: null }, { amountGranted: 40_000 }, {}], 100_000);
    expect(b.allocatedDzd).toBe(40_000);
    expect(Number.isNaN(b.unallocatedDzd)).toBe(false);
  });

  it("n'invente pas d'écart à cause des décimaux flottants", () => {
    const b = breakdown([{ amountGranted: 33_333.33 }, { amountGranted: 33_333.33 }, { amountGranted: 33_333.34 }], 100_000);
    expect(b.allocatedDzd).toBe(100_000);
    expect(b.balanced).toBe(true);
  });
});

describe("canEmitOrder — trois garde-fous financiers", () => {
  it("émet quand le sponsoring est accordé et le poste chiffré", () => {
    expect(canEmitOrder({ amountGranted: 50_000 }, true).ok).toBe(true);
  });

  it("refuse de payer ce qui n'est pas décidé", () => {
    const r = canEmitOrder({ amountGranted: 50_000 }, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("pas encore été accordé");
  });

  it("refuse de payer un poste sans montant", () => {
    expect(canEmitOrder({ amountGranted: null }, true).ok).toBe(false);
    expect(canEmitOrder({ amountGranted: 0 }, true).ok).toBe(false);
  });

  it("refuse de payer deux fois", () => {
    const r = canEmitOrder({ amountGranted: 50_000, expenseOrderId: "od_1" }, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("déjà été émis");
  });

  it("le double paiement prime sur toute autre objection — c'est le risque le plus coûteux", () => {
    expect(canEmitOrder({ amountGranted: null, expenseOrderId: "od_1" }, false).reason).toContain("déjà été émis");
  });
});

/**
 * Un congrès annonce un stand ou un symposium via `hasBooth` / `hasSymposium`. Ces intentions
 * n'ont jamais porté d'argent : on annonçait un stand et le budget n'en disait pas un mot.
 * Ce rapprochement est le seul endroit où l'écart se voit avant la facture.
 */
describe("plannedGaps — annoncé mais pas chiffré", () => {
  it("un stand annoncé sans poste STAND est signalé", () => {
    const g = plannedGaps([{ kind: "SERVICE" }], { hasBooth: true });
    expect(g.boothUnbudgeted).toBe(true);
    expect(g.any).toBe(true);
  });

  it("un stand annoncé ET chiffré ne déclenche rien", () => {
    expect(plannedGaps([{ kind: "STAND" }], { hasBooth: true }).boothUnbudgeted).toBe(false);
  });

  it("le symposium a sa propre nature — un poste « prestation » ne le couvre pas", () => {
    expect(plannedGaps([{ kind: "SERVICE" }], { hasSymposium: true }).symposiumUnbudgeted).toBe(true);
    expect(plannedGaps([{ kind: "SYMPOSIUM" }], { hasSymposium: true }).symposiumUnbudgeted).toBe(false);
  });

  it("rien d'annoncé, rien à signaler — y compris quand le drapeau est absent", () => {
    expect(plannedGaps([], {}).any).toBe(false);
    expect(plannedGaps([], { hasBooth: false, hasSymposium: null }).any).toBe(false);
  });

  it("les deux manques se cumulent", () => {
    const g = plannedGaps([], { hasBooth: true, hasSymposium: true });
    expect(g.boothUnbudgeted && g.symposiumUnbudgeted).toBe(true);
  });
});

describe("breakdown — rallonges, postes refusés et postes en attente", () => {
  it("un poste REFUSÉ ne pèse plus sur rien : ni estimé, ni affecté, ni compte", () => {
    const b = breakdown(
      [
        { amountEstimated: 100, amountGranted: 100, status: "APPROVED" },
        { amountEstimated: 400, amountGranted: 400, status: "REJECTED" },
      ],
      1000,
    );
    expect(b.allocatedDzd).toBe(100);
    expect(b.estimatedDzd).toBe(100);
    expect(b.itemCount).toBe(1);
    expect(b.unallocatedDzd).toBe(900);
  });

  it("un poste « budget supplémentaire » est une RALLONGE : il ne ventile pas l'enveloppe", () => {
    const b = breakdown(
      [
        { amountGranted: 800, status: "APPROVED", budgetKind: "INCLUDED" },
        { amountGranted: 300, status: "APPROVED", budgetKind: "ADDITIONAL" },
      ],
      1000,
    );
    // 800 sur 1000 → il reste 200 ; les 300 de rallonge sont comptés à part, PAS en dépassement.
    expect(b.allocatedDzd).toBe(800);
    expect(b.unallocatedDzd).toBe(200);
    expect(b.overrunDzd).toBe(0);
    expect(b.additionalDzd).toBe(300);
    expect(b.totalRequestedDzd).toBe(1100);
  });

  it("un poste inclus qui dépasse reste un DÉPASSEMENT (la rallonge ne masque rien)", () => {
    const b = breakdown([{ amountGranted: 1200, status: "APPROVED", budgetKind: "INCLUDED" }], 1000);
    expect(b.overrunDzd).toBe(200);
    expect(b.additionalDzd).toBe(0);
  });

  it("compte l'argent EN ATTENTE de décision (estimation à défaut de montant accordé)", () => {
    const b = breakdown(
      [
        { amountEstimated: 500, status: "PENDING" },
        { amountEstimated: 200, amountGranted: 150, status: "REVISION" },
        { amountGranted: 100, status: "APPROVED" },
      ],
      1000,
    );
    expect(b.pendingDzd).toBe(650); // 500 (estimé) + 150 (montant en jeu de la révision)
  });
});

describe("canSubmitItem — ce qui part en validation", () => {
  it("refuse un poste sans chiffre : la Direction déciderait sur rien", () => {
    expect(canSubmitItem({ status: "DRAFT" }).ok).toBe(false);
    expect(canSubmitItem({ status: "DRAFT", amountEstimated: 0 }).ok).toBe(false);
  });

  it("accepte un brouillon chiffré, et la RESOUMISSION d'un poste à revoir ou refusé", () => {
    expect(canSubmitItem({ status: "DRAFT", amountEstimated: 1000 }).ok).toBe(true);
    expect(canSubmitItem({ status: "REVISION", amountEstimated: 900 }).ok).toBe(true);
    expect(canSubmitItem({ status: "REJECTED", amountEstimated: 900 }).ok).toBe(true);
  });

  it("refuse de resoumettre ce qui est déjà en attente ou déjà accordé", () => {
    expect(canSubmitItem({ status: "PENDING", amountEstimated: 1000 }).ok).toBe(false);
    expect(canSubmitItem({ status: "APPROVED", amountGranted: 1000 }).ok).toBe(false);
  });

  it("UNE FICHE PAR PERSONNE (Direction, 06/10) : billetterie sans voyageur, hôtellerie sans fiche — refusées, sauf en sponsoring indirect", () => {
    const billet = { status: "DRAFT" as const, amountEstimated: 1000, kind: "TICKETING" as const };
    const hotel = { status: "DRAFT" as const, amountEstimated: 1000, kind: "ACCOMMODATION" as const };
    expect(canSubmitItem({ ...billet, fichesPersonnes: 0 }).reason).toMatch(/au moins un voyageur/);
    expect(canSubmitItem({ ...hotel, fichesPersonnes: 0 }).reason).toMatch(/au moins une fiche hôtellerie/);
    expect(canSubmitItem({ ...billet, fichesPersonnes: 1 }).ok).toBe(true);
    expect(canSubmitItem({ ...hotel, fichesPersonnes: 2 }).ok).toBe(true);
    // Sponsoring indirect : les fiches restent possibles, jamais exigées.
    expect(canSubmitItem({ ...billet, fichesPersonnes: 0, priseEnChargeIndirecte: true }).ok).toBe(true);
    expect(canSubmitItem({ ...hotel, fichesPersonnes: 0, priseEnChargeIndirecte: true }).ok).toBe(true);
    // Témoin : une autre nature n'en demande pas.
    expect(canSubmitItem({ status: "DRAFT", amountEstimated: 1000, kind: "DINNER", fichesPersonnes: 0 }).ok).toBe(true);
    // Le chiffre passe d'abord : un poste vide se chiffre avant de se peupler.
    expect(canSubmitItem({ ...billet, amountEstimated: 0, fichesPersonnes: 0 }).reason).toMatch(/Chiffrez/);
  });
});

describe("canRequestPurchaseOrder — le bon de commande ne part pas trop tôt", () => {
  const base = { status: "APPROVED" as const, amountGranted: 1000, budgetCategoryId: "cat1", orderStage: "NONE" as const };

  it("exige un poste accordé, chiffré ET imputé à un budget", () => {
    expect(canRequestPurchaseOrder(base).ok).toBe(true);
    expect(canRequestPurchaseOrder({ ...base, status: "PENDING" }).ok).toBe(false);
    expect(canRequestPurchaseOrder({ ...base, amountGranted: null }).ok).toBe(false);
    expect(canRequestPurchaseOrder({ ...base, budgetCategoryId: null }).ok).toBe(false);
  });

  it("ne redemande pas ce qui est en cours ou déjà émis — mais rouvre après un refus", () => {
    expect(canRequestPurchaseOrder({ ...base, orderStage: "REQUESTED" }).ok).toBe(false);
    expect(canRequestPurchaseOrder({ ...base, orderStage: "DIRECTION_OK" }).ok).toBe(false);
    expect(canRequestPurchaseOrder({ ...base, orderStage: "ISSUED" }).ok).toBe(false);
    expect(canRequestPurchaseOrder({ ...base, orderStage: "REFUSED" }).ok).toBe(true);
  });
});

describe("canEmitOrder — un poste non accordé ne se paie pas", () => {
  it("refuse d'émettre sur un poste en attente ou refusé, même si l'opération est accordée", () => {
    expect(canEmitOrder({ amountGranted: 500, status: "PENDING" }, true).ok).toBe(false);
    expect(canEmitOrder({ amountGranted: 500, status: "REJECTED" }, true).ok).toBe(false);
    expect(canEmitOrder({ amountGranted: 500, status: "APPROVED" }, true).ok).toBe(true);
  });
});

describe("canRemoveItem — retirer un poste sans effacer une pièce comptable", () => {
  const direction = { canAllocate: true };
  const editor = { canAllocate: false };

  it("laisse retirer librement un poste sans ordre de dépense", () => {
    expect(canRemoveItem({}, editor).ok).toBe(true);
    expect(canRemoveItem({ expenseOrderId: null }, editor).ok).toBe(true);
  });

  it("réserve à la Direction le retrait d'un poste dont l'ordre est parti", () => {
    const withOrder = { expenseOrderId: "eo1", expenseOrderStatus: "PENDING" };
    expect(canRemoveItem(withOrder, editor).ok).toBe(false);
    expect(canRemoveItem(withOrder, editor).reason).toMatch(/Direction/);
    expect(canRemoveItem(withOrder, direction).ok).toBe(true);
  });

  it("refuse à TOUT LE MONDE de retirer un poste dont l'ordre est réglé", () => {
    const paid = { expenseOrderId: "eo1", expenseOrderStatus: "PAID" };
    expect(canRemoveItem(paid, direction).ok).toBe(false);
    expect(canRemoveItem(paid, direction).reason).toMatch(/réglé/i);
  });
});

describe("budgetKindLocked — on ne réécrit pas ce sur quoi la Direction s'est prononcée", () => {
  it("verrouille la nature de budget une fois la décision rendue, pas avant", () => {
    expect(budgetKindLocked({ status: "DRAFT" })).toBe(false);
    expect(budgetKindLocked({ status: "PENDING" })).toBe(false);
    expect(budgetKindLocked({ status: "REVISION" })).toBe(false);
    expect(budgetKindLocked({ status: "APPROVED" })).toBe(true);
    expect(budgetKindLocked({ status: "REJECTED" })).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES NATURES DE POSTE — le cliquet qui garde la liste écrite à la main.
 *
 * `ITEM_KIND_LABELS` est un `Record<AdProItemKind, …>` : une nature ajoutée à l'énumération sans
 * libellé NE COMPILE PAS. `ITEM_KINDS`, l'ordre d'affichage, est un simple tableau : une nature
 * ajoutée sans y figurer compile parfaitement et devient INVISIBLE dans le menu de saisie, en
 * silence — donc INSAISISSABLE, ce qui est exactement le défaut qu'on vient de fermer pour
 * quatre natures que le métier nommait déjà (§118.130).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les natures de poste — l'ordre d'affichage est EXHAUSTIF", () => {
  it("toute nature portant un libellé figure dans l'ordre d'affichage, et réciproquement", () => {
    const labellisees = Object.keys(ITEM_KIND_LABELS).sort();
    const affichees = [...ITEM_KINDS].sort();
    // Ce qui le ferait tomber : ajouter `DINNER` à l'énumération et au Record sans l'ajouter à
    // l'ordre — la nature existerait en base et aucun écran ne permettrait de la choisir.
    expect(affichees, "une nature absente de l'ordre est insaisissable dans le menu").toEqual(labellisees);
    // …et l'autre sens : un nom mal orthographié dans l'ordre afficherait une entrée vide.
    for (const k of ITEM_KINDS) {
      expect(ITEM_KIND_LABELS[k], `« ${k} » doit porter un libellé non vide`).toBeTruthy();
    }
  });

  it("les QUATRE natures que la Direction a nommées sont là, et distinctes de leurs voisines", () => {
    // §118.144 : ce que la Direction nomme, l'écran doit l'offrir. Et le cas qui compte est la
    // DISTINCTION — un traiteur n'est pas un dîner pris en charge, un déplacement n'est pas
    // l'hôtellerie : les confondre reventilerait le montant sous le mauvais poste.
    for (const k of ["ASSOCIATION_SUPPORT", "TICKETING", "ACCOMMODATION", "DINNER"] as const) {
      expect(ITEM_KINDS, `« ${k} » doit être choisissable`).toContain(k);
    }
    const libelles = Object.values(ITEM_KIND_LABELS);
    expect(new Set(libelles).size, "deux natures de même libellé feraient choisir la mauvaise").toBe(libelles.length);
    // Le libellé de TRAVEL disait « Déplacement / hébergement » — faux depuis qu'ACCOMMODATION
    // existe. Une prose qui contredit le code est pire que pas de prose (§118.112b).
    expect(ITEM_KIND_LABELS.TRAVEL).not.toContain("hébergement");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DE QUI CE POSTE DÉPEND-IL ? — la question que l'ACCÈS doit poser.
 *
 * Un poste n'a pas de droits à lui. Le rattacher à un module écrit à la main était une
 * devinette, et elle était FAUSSE (`ENTITY_MODULE` annonçait `SPONSORING` pour TOUS les postes).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("le PARENT d'un poste — jamais deviné, jamais plausible", () => {
  const vide = {
    sponsoringId: null, congressNationalId: null, congressInternationalId: null,
    eventId: null, trainingId: null,
  };

  it("chacun des quatre parents se lit par SA colonne", () => {
    for (const p of AD_PRO_PARENTS) {
      const c = { ...vide, [PARENT_COLONNE[p]]: `id-${p}` };
      expect(parentDuPoste(c), `« ${p} » doit se lire`).toEqual({ parent: p, id: `id-${p}` });
      // L'entité du parent est ce qui porte les droits — un parent sans entité rendrait
      // l'accès indécidable.
      expect(PARENT_ENTITE[p], p).toBeTruthy();
    }
  });

  it("aucun parent, ou PLUSIEURS, rend null — on ne choisit pas à la place d'un humain", () => {
    // Les deux cas sont interdits par la contrainte `AdProItem_one_parent`, donc les rencontrer
    // signifie qu'on ne sait PAS lire la ligne. Retenir le premier ferait juger l'accès d'un
    // poste sur une opération qui n'est pas la sienne (§104.7).
    expect(parentDuPoste(vide)).toBeNull();
    expect(parentDuPoste({ ...vide, sponsoringId: "a", eventId: "b" })).toBeNull();
  });

  it("le parent DORMANT (une formation) rend null, et c'est une ignorance déclarée", () => {
    // `AdProItem.trainingId` existe au schéma et n'a AUCUN lecteur dans le dépôt — recensé.
    // Aucune entité du registre ne porte les droits d'une formation : rendre un parent
    // plausible ici ferait juger l'accès sur un objet qui n'est pas celui-là (§118.26).
    expect(parentDuPoste({ ...vide, trainingId: "f1" })).toBeNull();
    // Et un poste qui porterait les DEUX n'est pas « une opération avec un détail en plus ».
    expect(parentDuPoste({ ...vide, sponsoringId: "a", trainingId: "f1" })).toBeNull();
  });
});
