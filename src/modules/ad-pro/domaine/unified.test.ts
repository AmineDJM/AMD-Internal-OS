import { describe, it, expect } from "vitest";
import {
  adProState, sortAdPro, countByState, kindLabel, kindSpec, creatableKinds, AD_PRO_KINDS, AD_PRO_STATE,
  type AdProRequest,
} from "./unified";

const req = (over: Partial<AdProRequest> & { id: string; status: string }): AdProRequest => ({
  kind: "SPONSORING", reference: `REF-${over.id}`, title: `Demande ${over.id}`,
  beneficiary: null, amount: null, requester: null, createdAt: "2026-08-01T10:00:00.000Z",
  href: "/sponsoring", state: adProState(over.status), ...over,
});

describe("Cinq circuits, un seul vocabulaire", () => {
  it("ramène les statuts de chaque nature à l'état commun", () => {
    expect(adProState("PAID")).toBe("DONE");
    expect(adProState("COMPLETED")).toBe("DONE");
    expect(adProState("PAYMENT_DONE")).toBe("DONE");
    expect(adProState("REFUSED")).toBe("REFUSED");
    expect(adProState("CANCELLED")).toBe("REFUSED");
    expect(adProState("VALIDATED")).toBe("APPROVED");
    expect(adProState("BC_VALIDATED")).toBe("APPROVED");
    expect(adProState("DRAFT")).toBe("DRAFT");
  });

  it("tout ce qui n'est pas tranché ATTEND — et c'est le défaut, volontairement", () => {
    // Une demande dont on ne sait rien dire attend forcément quelque chose de quelqu'un : mieux
    // vaut la montrer que la ranger dans une case rassurante.
    expect(adProState("AWAITING_PRELIMINARY")).toBe("AWAITING");
    expect(adProState("IN_ANALYSIS")).toBe("AWAITING");
    expect(adProState("QUOTES_UPLOADED")).toBe("AWAITING");
    expect(adProState("UN_STATUT_QUI_N_EXISTE_PAS_ENCORE")).toBe("AWAITING");
  });

  it("chaque état a un libellé et une teinte", () => {
    for (const s of Object.values(AD_PRO_STATE)) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.tone.length).toBeGreaterThan(0);
    }
  });
});

describe("Les natures, décrites dans les mots du demandeur", () => {
  it("couvre toutes les portes d'entrée d'Ad & Pro, « Autre » comprise", () => {
    // « Autre » ferme la liste, et c'est volontaire : sans elle, une dépense inhabituelle se
    // déclare « en sponsoring » faute de mieux, et l'on perd la trace de ce qu'elle était.
    expect(AD_PRO_KINDS.map((k) => k.kind)).toEqual([
      "SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "PROMO_MATERIAL",
      "CONSULTING", "OTHER",
    ]);
    expect(AD_PRO_KINDS[AD_PRO_KINDS.length - 1].kind).toBe("OTHER");
  });

  it("un contrat actif est « validé », un contrat expiré est « terminé »", () => {
    // Deux fins qui ne se confondent pas : la liste unifiée doit les distinguer comme les
    // écrans de la nature le font.
    expect(adProState("ACTIVE")).toBe("APPROVED");
    expect(adProState("EXPIRED")).toBe("DONE");
    expect(adProState("CANCELLED")).toBe("REFUSED");
    expect(adProState("AWAITING_VALIDATION")).toBe("AWAITING");
    expect(adProState("AWAITING_DECISION")).toBe("AWAITING");
  });

  it("chaque nature dit CE QU'ON VEUT FAIRE, pas son nom technique", () => {
    for (const k of AD_PRO_KINDS) {
      expect(k.hint.length, k.kind).toBeGreaterThan(20);
      expect(k.href.startsWith("/"), k.kind).toBe(true);
      expect(k.module.length, k.kind).toBeGreaterThan(0);
    }
  });

  it("un libellé inconnu ne casse pas l'écran", () => {
    expect(kindLabel("SPONSORING")).toBe("Sponsoring");
    expect(kindLabel("N_EXISTE_PAS" as never)).toBe("N_EXISTE_PAS");
    expect(kindSpec("N_EXISTE_PAS" as never)).toBeUndefined();
  });
});

describe("Ce qui attend une décision passe devant", () => {
  const rows = [
    req({ id: "done", status: "PAID", createdAt: "2026-08-10T10:00:00.000Z" }),
    req({ id: "vieille-bloquee", status: "IN_ANALYSIS", createdAt: "2026-07-01T10:00:00.000Z" }),
    req({ id: "recente", status: "AWAITING_FINAL", createdAt: "2026-08-12T10:00:00.000Z" }),
    req({ id: "refusee", status: "REFUSED", createdAt: "2026-08-11T10:00:00.000Z" }),
  ];

  it("les demandes en attente arrivent en tête, même plus anciennes", () => {
    // Un tri par date seule enterre les demandes bloquées depuis trois semaines sous celles de
    // ce matin — or ce sont précisément celles-là qu'il faut voir.
    const sorted = sortAdPro(rows);
    expect(sorted.slice(0, 2).map((r) => r.id).sort()).toEqual(["recente", "vieille-bloquee"]);
  });

  it("à état égal, la plus récente d'abord", () => {
    const sorted = sortAdPro(rows);
    expect(sorted[0].id).toBe("recente");
  });

  it("le refusé et le terminé ferment la marche", () => {
    expect(sortAdPro(rows)[3].id).toBe("refusee");
  });

  it("ne modifie pas la liste reçue", () => {
    const copy = [...rows];
    sortAdPro(rows);
    expect(rows.map((r) => r.id)).toEqual(copy.map((r) => r.id));
  });

  it("compte par état, sans en oublier un", () => {
    const c = countByState(rows);
    expect(c).toEqual({ DRAFT: 0, AWAITING: 2, RETURNED: 0, APPROVED: 0, DONE: 1, REFUSED: 1 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });

  /**
   * « À CORRIGER » (§118.186) A SA CASE, et elle n'est pas « en attente de décision ». Sans branche
   * propre, `RETURNED` tombait dans le défaut — « en attente » — et passait en tête de la file des
   * validateurs, alors que c'est le DEMANDEUR qui a la main. Un compteur à zéro ne prouverait rien :
   * le cas porte une vraie demande renvoyée.
   */
  it("une demande renvoyée pour correction est « À corriger » — comptée à part, après ce qui attend une décision", () => {
    expect(adProState("RETURNED")).toBe("RETURNED");
    const avec = [...rows, req({ id: "a-corriger", status: "RETURNED", createdAt: "2026-08-13T10:00:00.000Z" })];
    expect(countByState(avec).RETURNED).toBe(1);
    expect(countByState(avec).AWAITING, "elle ne gonfle pas « en attente de décision »").toBe(2);
    const ordre = sortAdPro(avec).map((r) => r.id);
    expect(ordre.indexOf("a-corriger"), "la plus récente de toutes, et pourtant après ce qui attend une décision").toBe(2);
  });
});

describe("Le lien direct vers le formulaire d'une nature", () => {
  it("ouvre le FORMULAIRE de la nature, pas une liste de plus", () => {
    // Ce lien ne sert plus à Ad & Pro — le formulaire s'y ouvre sur place. Il reste la façon de
    // pointer quelqu'un droit sur le formulaire d'un module, depuis un message ou un favori.
    for (const k of AD_PRO_KINDS) {
      expect(k.createHref, k.kind).not.toBe(k.href);
      expect(k.createHref.startsWith(k.href), k.kind).toBe(true);
      expect(k.createHref.endsWith("?new=1"), k.kind).toBe(true);
    }
  });
});

describe("Ce que « Nouvelle demande » propose", () => {
  it("ne propose que ce que la personne peut CRÉER", () => {
    // Consulter n'est pas créer. Ouvrir un formulaire qui sera refusé à l'enregistrement fait
    // arriver le refus après la saisie — au pire moment.
    const only = creatableKinds((m) => m === "SPONSORING" || m === "EVENTS");
    expect(only.map((k) => k.kind)).toEqual(["SPONSORING", "EVENT"]);
  });

  it("ne propose rien à qui ne peut rien créer — le bouton disparaît alors", () => {
    expect(creatableKinds(() => false)).toEqual([]);
  });

  it("garde l'ordre de référence — la liste ne change pas de forme selon les droits", () => {
    expect(creatableKinds(() => true).map((k) => k.kind)).toEqual(AD_PRO_KINDS.map((k) => k.kind));
  });

  it("chaque nature proposable désigne un module RBAC réel", () => {
    for (const k of AD_PRO_KINDS) expect(k.module.length, k.kind).toBeGreaterThan(0);
  });
});
