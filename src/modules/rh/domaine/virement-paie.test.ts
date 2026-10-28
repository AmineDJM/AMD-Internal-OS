import { describe, expect, it } from "vitest";
import {
  deMois,
  etatSalaire,
  etatVirement,
  libelleVirementPaie,
  lireSommeAVirer,
  moisDeLaPaie,
  moisDeLEntite,
  noteVirementPaie,
  saisiAvantLeCentre,
  SOMME_A_VIRER_MANQUANTE,
  virementCouvre,
  virementEnCours,
  type EtatSalaire,
  type EtatVirement,
  type VirementDuMois,
} from "./virement-paie";

/**
 * LA PAIE AU CENTRE DE PAIEMENT — les règles PURES (§118.176).
 *
 * Le banc de flux (`centre-paie-caisse-flow.test.ts`) les exerce par les vraies actions, sur la
 * vraie base. Celui-ci les tient une par une, sans base : chaque cas nomme la situation qui le
 * ferait tomber (§118.17). L'en-tête du module annonçait « testé » avant que ce fichier existe —
 * une documentation qui promet un banc absent promet une garde que personne ne joue (§118.116).
 */

const ordre = (status: string, centralStatus: string) => ({ status, centralStatus });

describe("etatVirement — l'état se lit sur l'ORDRE, sauf le FAIT du virement", () => {
  it("le fait du virement l'emporte sur tout, même un ordre disparu de l'historique", () => {
    // Sans cette règle, une paie virée dont l'ordre a été purgé redeviendrait « à envoyer »,
    // donc partirait deux fois.
    expect(etatVirement({ paidAt: new Date("2026-10-01"), ordre: null })).toBe("VIRE");
    expect(etatVirement({ paidAt: "2026-10-01T10:00:00Z", ordre: ordre("PENDING", "AWAITING") })).toBe("VIRE");
  });

  it("un ordre DISPARU sans règlement n'a rien payé : le virement est annulé, ses salaires repartent", () => {
    expect(etatVirement({ paidAt: null, ordre: null })).toBe("ANNULE");
  });

  it("un ordre RÉGLÉ dont le crochet n'a pas posé le fait est quand même viré", () => {
    // Le croire « à virer » le ferait renvoyer.
    expect(etatVirement({ paidAt: null, ordre: ordre("PAID", "APPROVED") })).toBe("VIRE");
  });

  it("annulé, refusé, autorisé, historique, en attente — chacun son état", () => {
    expect(etatVirement({ paidAt: null, ordre: ordre("CANCELLED", "APPROVED") })).toBe("ANNULE");
    expect(etatVirement({ paidAt: null, ordre: ordre("PENDING", "REFUSED") })).toBe("REFUSE");
    expect(etatVirement({ paidAt: null, ordre: ordre("PENDING", "APPROVED") })).toBe("A_VIRER");
    // `NOT_REQUIRED` est l'état des ordres d'AVANT le centre : il est payable.
    expect(etatVirement({ paidAt: null, ordre: ordre("PENDING", "NOT_REQUIRED") })).toBe("A_VIRER");
    expect(etatVirement({ paidAt: null, ordre: ordre("PENDING", "AWAITING") })).toBe("EN_ATTENTE");
  });

  it("en cours = envoyé, ni réglé ni refusé ; un refusé ou un annulé LIBÈRE ses salaires", () => {
    const tous: EtatVirement[] = ["EN_ATTENTE", "A_VIRER", "VIRE", "REFUSE", "ANNULE"];
    expect(tous.filter(virementEnCours)).toEqual(["EN_ATTENTE", "A_VIRER"]);
    expect(tous.filter(virementCouvre)).toEqual(["EN_ATTENTE", "A_VIRER", "VIRE"]);
  });
});

describe("etatSalaire — par la LIGNE et son virement, jamais stocké une seconde fois", () => {
  it("une ligne non payée n'est pas saisie, quoi qu'en dise un virement", () => {
    expect(etatSalaire({ status: "UNPAID", virement: "VIRE" })).toBe("NON_SAISI");
  });

  it("l'ANCIEN circuit (décaissement écrit salarié par salarié) reste viré", () => {
    // Le faire repasser « à envoyer » enverrait au centre une paie déjà sortie de la banque.
    expect(etatSalaire({ status: "PAID", transactionId: "tx1", virement: null })).toBe("VIRE");
    expect(etatSalaire({ status: "PAID", budgetTransferredAt: new Date(), virement: null })).toBe("VIRE");
  });

  it("couverte par un virement : envoyée tant qu'il est en cours, virée quand il est réglé", () => {
    expect(etatSalaire({ status: "PAID", virement: "EN_ATTENTE" })).toBe("ENVOYE");
    expect(etatSalaire({ status: "PAID", virement: "A_VIRER" })).toBe("ENVOYE");
    expect(etatSalaire({ status: "PAID", virement: "VIRE" })).toBe("VIRE");
  });

  it("marqué payé AVANT la bascule : versé par l'ancien circuit — jamais « à envoyer »", () => {
    // L'ancien « marquer payé » voulait dire « versé » (le salarié en était prévenu). La première
    // version ne regardait que le transfert au budget : le reste ressortait payable une seconde fois.
    expect(etatSalaire({ status: "PAID", virement: null, avantLeCentre: true })).toBe("VIRE");
    expect(etatSalaire({ status: "PAID", virement: null, avantLeCentre: false })).toBe("SAISI");
    // Un salaire non payé reste non saisi, bascule ou pas.
    expect(etatSalaire({ status: "DRAFT", virement: null, avantLeCentre: true })).toBe("NON_SAISI");
  });

  it("un virement refusé ou annulé rend la ligne à envoyer — elle n'est pas perdue", () => {
    expect(etatSalaire({ status: "PAID", virement: "REFUSE" })).toBe("SAISI");
    expect(etatSalaire({ status: "PAID", virement: "ANNULE" })).toBe("SAISI");
    expect(etatSalaire({ status: "PAID", virement: null })).toBe("SAISI");
  });
});

describe("saisiAvantLeCentre — par le jour où la ligne a été marquée payée, contre l'instant de la bascule", () => {
  const BASCULE = new Date("2026-10-03T09:00:00Z");
  it("avant, versé ; après, saisi ; au même instant, saisi (l'instant appartient au nouveau circuit)", () => {
    expect(saisiAvantLeCentre({ paidDate: new Date("2026-09-30T10:00:00Z") }, BASCULE)).toBe(true);
    expect(saisiAvantLeCentre({ paidDate: new Date("2026-10-03T09:00:01Z") }, BASCULE)).toBe(false);
    expect(saisiAvantLeCentre({ paidDate: BASCULE }, BASCULE)).toBe(false);
  });
  it("sans date de paiement, la création fait foi ; sans rien, on ne déclare rien", () => {
    expect(saisiAvantLeCentre({ paidDate: null, createdAt: "2026-09-01T00:00:00Z" }, BASCULE)).toBe(true);
    expect(saisiAvantLeCentre({ paidDate: null, createdAt: null }, BASCULE)).toBe(false);
  });
  it("sans l'instant de la bascule, rien n'est requalifié — une garde qui ne lit pas son fait ne décide pas", () => {
    expect(saisiAvantLeCentre({ paidDate: new Date("2020-01-01") }, null)).toBe(false);
    expect(saisiAvantLeCentre({ paidDate: new Date("2020-01-01") }, undefined)).toBe(false);
  });
});

describe("lireSommeAVirer — obligatoire, positive, lue sans deviner", () => {
  it("les espaces de milliers — ordinaires, insécables, fines — se retirent ; la virgule décimale se lit", () => {
    expect(lireSommeAVirer("215 000")).toEqual({ ok: true, montant: 215_000 });
    expect(lireSommeAVirer("1 250 000,50")).toEqual({ ok: true, montant: 1_250_000.5 });
    expect(lireSommeAVirer("2 966 153")).toEqual({ ok: true, montant: 2_966_153 });
  });

  it("absente : le refus est la MÊME phrase que l'action dit", () => {
    expect(lireSommeAVirer("")).toEqual({ ok: false, erreur: SOMME_A_VIRER_MANQUANTE });
    expect(lireSommeAVirer("   ")).toEqual({ ok: false, erreur: SOMME_A_VIRER_MANQUANTE });
    expect(lireSommeAVirer(null)).toEqual({ ok: false, erreur: SOMME_A_VIRER_MANQUANTE });
  });

  it("rien d'autre n'est interprété — « 1,2 M » ou un format à deux séparateurs n'est pas recopié sur un ordre", () => {
    for (const brut of ["1,2 M", "12.345,67", "1,234,567", "-5", "2e6", "environ 200 000"]) {
      const r = lireSommeAVirer(brut);
      expect(r.ok, `« ${brut} » ne doit pas se lire comme un montant`).toBe(false);
    }
  });

  it("zéro n'est pas une paie", () => {
    const r = lireSommeAVirer("0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreur).toMatch(/positive/);
  });
});

describe("les phrases — le mois tel qu'on le dit, avec son élision", () => {
  it("le mois sans locale de serveur", () => {
    expect(moisDeLaPaie(2026, 10)).toBe("octobre 2026");
    expect(moisDeLaPaie(2026, 8)).toBe("août 2026");
  });

  it("« d'octobre », « d'avril », « d'août » — et « de septembre »", () => {
    // La première rédaction écrivait « la paie de octobre » : juste sur le fond, fausse en français,
    // dans la phrase même que la RH lit après avoir cliqué.
    expect(deMois("octobre 2026")).toBe("d'octobre 2026");
    expect(deMois("avril 2026")).toBe("d'avril 2026");
    expect(deMois("août 2026")).toBe("d'août 2026");
    expect(deMois("septembre 2026")).toBe("de septembre 2026");
    expect(deMois("mai 2026")).toBe("de mai 2026");
  });

  it("le libellé de l'ordre — reconnaissable au centre, aux Finances et au livre", () => {
    expect(libelleVirementPaie("ADV", 2026, 10)).toBe("Paie octobre 2026 — ADV");
    expect(libelleVirementPaie("ADV", 2026, 10, true)).toBe("Complément de paie octobre 2026 — ADV");
  });

  it("la note du centre nomme l'écart AVEC son signe, et se tait quand il n'y en a pas", () => {
    expect(noteVirementPaie({ declare: 210_000, salaires: 2, nets: 210_000 })).not.toMatch(/écart/);
    expect(noteVirementPaie({ declare: 215_000, salaires: 2, nets: 210_000 })).toMatch(/écart \+5\s000 DZD/);
    expect(noteVirementPaie({ declare: 205_000, salaires: 2, nets: 210_000 })).toMatch(/écart −5\s000 DZD/);
    expect(noteVirementPaie({ declare: 100_000, salaires: 1, nets: 100_000 })).toMatch(/1 salaire saisi,/);
  });
});

describe("moisDeLEntite — ce que la carte affiche ET ce que l'envoi revérifie", () => {
  const ENTITE = "ADV";
  const virement = (etat: EtatVirement, id = "w1"): VirementDuMois => ({
    id, reference: `FIN-${id}`, montant: 210_000, etat, envoyeLe: "2026-10-01T00:00:00Z", vireLe: null,
  });
  const salaire = (etat: EtatSalaire, net = 100_000) => ({ etat, net });
  const mois = (salaires: { etat: EtatSalaire; net: number }[], virements: VirementDuMois[] = []) =>
    moisDeLEntite({ entite: ENTITE, year: 2026, month: 10, salaires, virements });

  it("rien de saisi : le refus dit le geste qui précède", () => {
    const m = mois([salaire("NON_SAISI")]);
    expect(m.aEnvoyer).toBe(0);
    expect(m.refus).toBe("Aucun salaire saisi pour octobre 2026 chez ADV : saisissez d'abord les salaires du mois (un clic sur le mois de chaque salarié).");
  });

  it("deux salaires saisis : le bouton est ouvert, et la carte compte leurs nets", () => {
    const m = mois([salaire("SAISI", 100_000), salaire("SAISI", 110_000), salaire("NON_SAISI")]);
    expect(m).toMatchObject({ aEnvoyer: 2, netsAEnvoyer: 210_000, envoyes: 0, vires: 0, complement: false, refus: null });
  });

  it("un envoi qui attend le centre ferme le bouton — un seul à la fois, et il le DIT avec sa référence", () => {
    const m = mois([salaire("ENVOYE"), salaire("SAISI")], [virement("EN_ATTENTE")]);
    expect(m.enCours?.id).toBe("w1");
    expect(m.refus).toBe("La paie d'octobre 2026 de ADV attend déjà le centre de paiement (FIN-w1) — un seul envoi à la fois.");
  });

  it("un envoi autorisé, pas encore viré, ferme aussi le bouton — et nomme les Finances", () => {
    const m = mois([salaire("ENVOYE")], [virement("A_VIRER")]);
    expect(m.refus).toBe("La paie d'octobre 2026 de ADV est autorisée et attend son virement par les Finances (FIN-w1) — un seul envoi à la fois.");
  });

  it("un envoi REFUSÉ libère ses salaires : on renvoie, et ce n'est PAS un complément", () => {
    // Un refus n'a rien viré : appeler l'envoi suivant « complément » mentirait sur l'argent parti.
    const m = mois([salaire("SAISI"), salaire("SAISI")], [virement("REFUSE")]);
    expect(m).toMatchObject({ aEnvoyer: 2, enCours: null, complement: false, refus: null });
  });

  it("une partie virée + un salaire saisi depuis : l'envoi suivant est un COMPLÉMENT", () => {
    const m = mois([salaire("VIRE"), salaire("SAISI", 90_000)], [virement("VIRE")]);
    expect(m).toMatchObject({ aEnvoyer: 1, netsAEnvoyer: 90_000, vires: 1, complement: true, refus: null });
  });

  it("des salaires virés par l'ANCIEN circuit font aussi de l'envoi suivant un complément", () => {
    const m = mois([salaire("VIRE"), salaire("SAISI")]);
    expect(m.complement).toBe(true);
  });

  it("tout est viré : rien à envoyer, et le refus dit pourquoi un complément n'a pas lieu d'être", () => {
    const m = mois([salaire("VIRE"), salaire("VIRE")], [virement("VIRE")]);
    expect(m.refus).toBe("Toute la paie saisie d'octobre 2026 de ADV est déjà virée : un complément ne s'envoie que pour des salaires saisis depuis.");
  });
});
