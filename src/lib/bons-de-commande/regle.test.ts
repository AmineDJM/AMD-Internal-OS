import { describe, expect, it } from "vitest";
import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import {
  centreDeLOrigine, etatDepuisValidation, etatDepuisVisa, etatDepuisPoste,
  blocageParLeBC, reserveBC, reserveSansPorte, gesteAiguillage, chantierBCClos,
  validationRequiseBC, etapeBC, reserveEtapeBC, reserveDeLAiguillage, motifNonSignable,
  PHRASE_SIGNATURE_RETIREE,
  type PorteBC,
} from "./regle";

/**
 * LA RÈGLE DES BONS DE COMMANDE, PURE (§118.148).
 *
 * « Concernant les BC, ils doivent tous passer soit par le centre de validation Ad&Pro si la
 * demande est depuis Ad&Pro, soit par le centre de validation normal. » Chaque cas nomme le
 * défaut qu'il ferait tomber : une assertion dont on ne sait pas nommer le cas qui la ferait
 * échouer n'en est pas une (§118.17).
 */

const AD_PRO = new Set(["SPONSORING", "EVENT", "CONGRESS_NATIONAL", "AD_PRO_ITEM"]);
const porte = (p: Partial<PorteBC>): PorteBC => ({ centre: "VALIDATION", etat: "EN_ATTENTE", source: "DOCUMENT", note: null, ...p });

describe("centreDeLOrigine — quel centre ?", () => {
  it("un BC sans origine va au centre de validations", () => {
    expect(centreDeLOrigine([], AD_PRO)).toBe("VALIDATION");
  });
  it("un maillon Ad & Pro suffit, même au bout d'un chemin qui transite par le secrétariat", () => {
    expect(centreDeLOrigine(["DOCUMENT_REQUEST", "AD_PRO_ITEM"], AD_PRO)).toBe("AD_PRO");
    expect(centreDeLOrigine(["PAYMENT_REQUEST", "EXPENSE_ORDER", "SPONSORING"], AD_PRO)).toBe("AD_PRO");
  });
  it("un chemin sans aucun maillon Ad & Pro reste au centre de validations", () => {
    expect(centreDeLOrigine(["DOCUMENT_REQUEST", "ADMIN_REQUEST", "PCH_ORDER"], AD_PRO)).toBe("VALIDATION");
  });
});

describe("lecture des états", () => {
  it("une validation RETIRÉE ne dit plus rien — ni validée, ni en attente", () => {
    expect(etatDepuisValidation("CANCELLED")).toBeNull();
    expect(etatDepuisValidation("PENDING")).toBe("EN_ATTENTE");
    expect(etatDepuisValidation("APPROVED")).toBe("VALIDE");
    expect(etatDepuisValidation("REJECTED")).toBe("REFUSE");
    expect(etatDepuisValidation("CHANGES_REQUESTED")).toBe("A_REVOIR");
  });
  it("un visa d'état inconnu ATTEND — le sens sûr, jamais « validé »", () => {
    expect(etatDepuisVisa("APPROVED")).toBe("VALIDE");
    expect(etatDepuisVisa("REFUSED")).toBe("REFUSE");
    expect(etatDepuisVisa("PENDING")).toBe("EN_ATTENTE");
    expect(etatDepuisVisa("QUELQUE_CHOSE")).toBe("EN_ATTENTE");
  });
  it("le poste : un BC émis a forcément été validé ; « aucun BC demandé » n'est pas une porte", () => {
    expect(etatDepuisPoste("NONE")).toBeNull();
    expect(etatDepuisPoste("REQUESTED")).toBe("EN_ATTENTE");
    expect(etatDepuisPoste("DIRECTION_OK")).toBe("VALIDE");
    expect(etatDepuisPoste("ISSUED")).toBe("VALIDE");
    expect(etatDepuisPoste("REFUSED")).toBe("REFUSE");
  });
});

describe("blocageParLeBC — la facture qui découle d'un BC non validé ne part pas au règlement", () => {
  it("un BC sans porte (antérieur à la règle) ne bloque RIEN — sinon tout le registre gèlerait", () => {
    expect(blocageParLeBC(null, "BC-1")).toBeNull();
  });
  it("un BC validé ne bloque rien", () => {
    expect(blocageParLeBC(porte({ etat: "VALIDE" }), "BC-1")).toBeNull();
  });
  it("en attente : le refus NOMME le BC et le centre", () => {
    const r = blocageParLeBC(porte({ centre: "AD_PRO" }), "BC-2026-012");
    expect(r).toContain("BC-2026-012");
    expect(r).toContain("centre de validation Ad & Pro");
  });
  it("à revoir : le motif du centre voyage dans le refus", () => {
    expect(blocageParLeBC(porte({ etat: "A_REVOIR", note: "prix unitaire faux" }), "BC-3")).toContain("prix unitaire faux");
  });
  it("refusé : la facture ne part pas, et la phrase le dit", () => {
    expect(blocageParLeBC(porte({ etat: "REFUSE" }), null)).toMatch(/refusé/);
  });
});

describe("reserveBC — la phrase qui annonce un BC ne le fait pas passer pour validé (§118.32)", () => {
  it("se tait sur un BC validé ou sans porte — une réserve permanente cesse d'être lue", () => {
    expect(reserveBC(null)).toBeNull();
    expect(reserveBC(porte({ etat: "VALIDE" }))).toBeNull();
  });
  it("en attente : ne pas l'envoyer au fournisseur, en nommant le centre", () => {
    const r = reserveBC(porte({ centre: "VALIDATION" }));
    expect(r).toMatch(/ne l'envoyez pas au fournisseur/);
    expect(r).toContain("centre de validations");
  });
});

/**
 * UN BC SANS PORTE LE DIT, ET DIT POURQUOI (§118.148). Deux causes, deux gestes : personne ne siège
 * (il faut un Super Admin), ou l'écriture a échoué (on rattrape d'un clic). La fabrique et les
 * actions Legal portaient deux rédactions de la première et aucune de la seconde.
 */
describe("reserveSansPorte — l'aiguillage qui n'a rien posé ne se tait pas", () => {
  it("aucun siège : ce n'est PAS validé, et il faut un Super Admin", () => {
    const r = reserveSansPorte({ sansSiege: true });
    expect(r).toMatch(/n'est PAS validé/);
    expect(r).toMatch(/Super Admin/);
  });
  it("un échec : ce n'est PAS validé, et le rattrapage est nommé", () => {
    const r = reserveSansPorte({ enEchec: true });
    expect(r).toMatch(/erreur technique/);
    expect(r).toMatch(/n'est PAS validé/);
    expect(r).toMatch(/« Adresser au centre »/);
  });
  it("une porte a été posée : rien à dire ici — c'est `reserveBC` qui parle", () => {
    expect(reserveSansPorte({})).toBeNull();
    expect(reserveSansPorte({ sansSiege: false, enEchec: false })).toBeNull();
  });
});

describe("gesteAiguillage — que faire de la porte quand le BC change ?", () => {
  it("aucune porte → la POSER", () => {
    expect(gesteAiguillage({ actuelle: null, centreVoulu: "VALIDATION" })).toEqual({ geste: "POSER" });
  });
  it("porte du POSTE → RIEN : poser une seconde porte ferait valider deux fois le même engagement", () => {
    expect(gesteAiguillage({ actuelle: porte({ centre: "AD_PRO", source: "POSTE" }), centreVoulu: "AD_PRO" })).toEqual({ geste: "RIEN" });
  });
  it("en attente dans l'AUTRE centre → TRANSFÉRER (rattaché à une fiche Ad & Pro après coup)", () => {
    expect(gesteAiguillage({ actuelle: porte({ centre: "VALIDATION" }), centreVoulu: "AD_PRO" })).toEqual({ geste: "TRANSFERER" });
  });
  it("en attente, montant changé par la personne → ACTUALISER ; relu sans modification → RIEN", () => {
    expect(gesteAiguillage({ actuelle: porte({}), centreVoulu: "VALIDATION", montantAvant: 100, montantApres: 120, modifie: true })).toEqual({ geste: "ACTUALISER" });
    expect(gesteAiguillage({ actuelle: porte({}), centreVoulu: "VALIDATION", montantAvant: 100, montantApres: 120 })).toEqual({ geste: "RIEN" });
  });
  it("VALIDÉ puis RELEVÉ → ROUVRIR, en disant de combien (§118.16)", () => {
    const g = gesteAiguillage({ actuelle: porte({ etat: "VALIDE" }), centreVoulu: "VALIDATION", montantAvant: 100_000, montantApres: 150_000, modifie: true });
    expect(g.geste).toBe("ROUVRIR");
    expect(g.geste === "ROUVRIR" ? g.motif : "").toContain("100");
  });
  it("VALIDÉ puis BAISSÉ → RIEN : un geste qui réduit ne rouvre rien", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "VALIDE" }), centreVoulu: "VALIDATION", montantAvant: 150, montantApres: 100, modifie: true })).toEqual({ geste: "RIEN" });
  });
  it("VALIDÉ sur un montant d'abord INCONNU qu'on renseigne → RIEN : la saisie recopie la pièce validée", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "VALIDE" }), centreVoulu: "VALIDATION", montantAvant: null, montantApres: 100, modifie: true })).toEqual({ geste: "RIEN" });
  });
  it("À REVOIR puis modifié → ROUVRIR (c'est la resoumission demandée) ; relu seulement → RIEN", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "A_REVOIR" }), centreVoulu: "VALIDATION", modifie: true }).geste).toBe("ROUVRIR");
    expect(gesteAiguillage({ actuelle: porte({ etat: "A_REVOIR" }), centreVoulu: "VALIDATION" })).toEqual({ geste: "RIEN" });
  });
  it("REFUSÉ → RIEN, même retouché, même rattaché ailleurs : un refus ne se contourne pas", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "REFUSE" }), centreVoulu: "AD_PRO", montantAvant: 10, montantApres: 99, modifie: true })).toEqual({ geste: "RIEN" });
  });
  it("une décision prise n'est jamais DÉPLACÉE d'un centre à l'autre", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "VALIDE", centre: "VALIDATION" }), centreVoulu: "AD_PRO" })).toEqual({ geste: "RIEN" });
  });
});

describe("chantierBCClos — le chantier « bon de commande » ne se clôt plus d'un clic", () => {
  it("sans BC : refus qui nomme le geste qui en enregistre un", () => {
    const r = chantierBCClos([]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toContain("Pièces liées");
  });
  it("un BC jamais vu par un centre : refus qui nomme « Adresser au centre »", () => {
    const r = chantierBCClos([{ reference: "BC-9", porte: null }]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toMatch(/Adressez-le au centre/);
  });
  it("UN seul BC encore en attente tient le chantier ouvert — « deux sur trois » n'est pas fait", () => {
    const r = chantierBCClos([
      { reference: "BC-1", porte: porte({ etat: "VALIDE" }) },
      { reference: "BC-2", porte: porte({ etat: "EN_ATTENTE" }) },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toContain("BC-2");
    expect(r.ok ? "" : r.raison).not.toContain("BC-1");
  });
  it("tous validés → le chantier se clôt", () => {
    expect(chantierBCClos([{ reference: "BC-1", porte: porte({ etat: "VALIDE" }) }]).ok).toBe(true);
  });
});

// ───────────────────────── §118.149 — le seuil et la signature ─────────────────────────

describe("validationRequiseBC — au-dessus du seuil, un centre ; en deçà, directement à la signature", () => {
  it("STRICTEMENT au-dessus : le montant égal au seuil n'y va pas", () => {
    expect(validationRequiseBC(500_001, 500_000)).toBe(true);
    expect(validationRequiseBC(500_000, 500_000)).toBe(false);
    expect(validationRequiseBC(12_000, 500_000)).toBe(false);
  });
  it("AUCUN seuil (0, absent, illisible) : tout BC passe par un centre — le comportement d'avant la règle", () => {
    expect(validationRequiseBC(1, 0)).toBe(true);
    expect(validationRequiseBC(1, null)).toBe(true);
    expect(validationRequiseBC(1, undefined)).toBe(true);
    expect(validationRequiseBC(1, Number.NaN)).toBe(true);
    expect(validationRequiseBC(1, -5)).toBe(true);
  });
  it("un montant INCONNU n'est pas « petit » : il passe par un centre, quel que soit le seuil", () => {
    expect(validationRequiseBC(null, 500_000)).toBe(true);
    expect(validationRequiseBC(undefined, 500_000)).toBe(true);
    expect(validationRequiseBC(0, 500_000)).toBe(true);
    expect(validationRequiseBC(Number.NaN, 500_000)).toBe(true);
  });
});

describe("gesteAiguillage avec le seuil — ce qui attend s'efface, ce qui est décidé reste", () => {
  it("un BC neuf SOUS le seuil ne reçoit aucune porte ; au-dessus, il en reçoit une", () => {
    expect(gesteAiguillage({ actuelle: null, centreVoulu: "VALIDATION", montantApres: 1_000, seuil: 5_000 }).geste).toBe("RIEN");
    expect(gesteAiguillage({ actuelle: null, centreVoulu: "VALIDATION", montantApres: 9_000, seuil: 5_000 }).geste).toBe("POSER");
  });
  it("une porte EN ATTENTE dont le BC passe sous le seuil est RETIRÉE — avec le motif qui nomme le seuil", () => {
    const g = gesteAiguillage({ actuelle: porte({ etat: "EN_ATTENTE" }), centreVoulu: "VALIDATION", montantAvant: 9_000, montantApres: 1_000, modifie: true, seuil: 5_000 });
    expect(g.geste).toBe("RETIRER");
    expect(g.geste === "RETIRER" ? g.motif : "").toMatch(/5\s000 DZD/);
  });
  it("un REFUS ne se contourne pas en baissant le montant sous le seuil", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "REFUSE" }), centreVoulu: "VALIDATION", montantAvant: 9_000, montantApres: 1_000, modifie: true, seuil: 5_000 }).geste).toBe("RIEN");
  });
  it("une validation acquise ne se rouvre que si le montant RELEVÉ dépasse le seuil", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "VALIDE" }), centreVoulu: "VALIDATION", montantAvant: 1_000, montantApres: 4_000, modifie: true, seuil: 5_000 }).geste).toBe("RIEN");
    expect(gesteAiguillage({ actuelle: porte({ etat: "VALIDE" }), centreVoulu: "VALIDATION", montantAvant: 1_000, montantApres: 9_000, modifie: true, seuil: 5_000 }).geste).toBe("ROUVRIR");
  });
  it("à revoir, corrigé SOUS le seuil : la validation n'a plus d'objet — elle est retirée, pas rouverte", () => {
    expect(gesteAiguillage({ actuelle: porte({ etat: "A_REVOIR" }), centreVoulu: "VALIDATION", montantAvant: 9_000, montantApres: 1_000, modifie: true, seuil: 5_000 }).geste).toBe("RETIRER");
    expect(gesteAiguillage({ actuelle: porte({ etat: "A_REVOIR" }), centreVoulu: "VALIDATION", montantAvant: 9_000, montantApres: 8_000, modifie: true, seuil: 5_000 }).geste).toBe("ROUVRIR");
  });
});

describe("etapeBC — une seule lecture de « où en est ce BC », pour la file, la fiche et la signature", () => {
  const e = (a: Partial<Parameters<typeof etapeBC>[0]>) => etapeBC({ porte: null, validationRequise: true, signe: false, dansLeCircuit: true, renvoye: false, ...a });
  it("la SIGNATURE l'emporte sur tout", () => {
    expect(e({ signe: true, porte: porte({ etat: "EN_ATTENTE" }) })).toBe("SIGNE");
  });
  it("la porte dit l'étape tant qu'elle n'est pas validée", () => {
    expect(e({ porte: porte({ etat: "EN_ATTENTE" }) })).toBe("A_VALIDER");
    expect(e({ porte: porte({ etat: "A_REVOIR" }) })).toBe("A_REVOIR");
    expect(e({ porte: porte({ etat: "REFUSE" }) })).toBe("REFUSE");
  });
  it("validée et dans le circuit → à signer ; validée HORS du circuit (BC ancien) → ni à valider ni à signer", () => {
    expect(e({ porte: porte({ etat: "VALIDE" }) })).toBe("A_SIGNER");
    expect(e({ porte: porte({ etat: "VALIDE" }), dansLeCircuit: false })).toBe("HORS_CIRCUIT");
  });
  it("sans porte : sous le seuil → à signer ; au-dessus → à adresser ; hors circuit → antérieur", () => {
    expect(e({ validationRequise: false })).toBe("A_SIGNER");
    expect(e({ validationRequise: true })).toBe("SANS_PORTE");
    expect(e({ dansLeCircuit: false, validationRequise: false })).toBe("HORS_CIRCUIT");
  });
  it("RENVOYÉ à son émetteur (R09) : ce qui serait « à signer » attend sa correction — et rien d'autre ne change", () => {
    expect(e({ renvoye: true, porte: porte({ etat: "VALIDE" }) })).toBe("A_CORRIGER");
    expect(e({ renvoye: true, validationRequise: false })).toBe("A_CORRIGER");
    expect(e({ renvoye: true, porte: porte({ etat: "EN_ATTENTE" }) }), "une porte qui attend garde la main").toBe("A_VALIDER");
    expect(e({ renvoye: true, porte: porte({ etat: "REFUSE" }) })).toBe("REFUSE");
    expect(e({ renvoye: true, signe: true }), "la signature l'emporte").toBe("SIGNE");
    expect(e({ renvoye: true, dansLeCircuit: false, validationRequise: false })).toBe("HORS_CIRCUIT");
    expect(e({ renvoye: true, validationRequise: true }), "au-dessus du seuil sans porte, c'est le centre qu'il faut d'abord").toBe("SANS_PORTE");
  });
});

describe("les phrases de l'étape — ce qu'on lit avant d'envoyer, ce qu'on lit avant de signer", () => {
  it("un BC à signer SANS porte dit pourquoi aucun centre ne l'a vu — avec le seuil", () => {
    const r = reserveEtapeBC("A_SIGNER", null, 500_000) ?? "";
    expect(r).toMatch(/Sous le seuil/);
    expect(r).toMatch(/500\s000 DZD/);
    expect(r).toMatch(/ne l'envoyez pas au fournisseur avant/);
  });
  it("un BC à signer VALIDÉ nomme son centre ; un BC signé ou ancien se tait", () => {
    expect(reserveEtapeBC("A_SIGNER", porte({ etat: "VALIDE", centre: "AD_PRO" }), 0)).toMatch(/Ad & Pro/);
    expect(reserveEtapeBC("SIGNE", null, 0)).toBeNull();
    expect(reserveEtapeBC("HORS_CIRCUIT", null, 0)).toBeNull();
  });
  it("la réserve de l'aiguillage : l'absence de siège d'abord, puis la signature retirée, puis l'étape", () => {
    expect(reserveDeLAiguillage({ porte: null, sansSiege: true, etape: "A_SIGNER" })).toMatch(/Aucun siège/);
    const r = reserveDeLAiguillage({ porte: null, etape: "A_SIGNER", seuil: 10, signatureRetiree: true }) ?? "";
    expect(r.startsWith(PHRASE_SIGNATURE_RETIREE)).toBe(true);
    expect(r).toMatch(/signature des Finances/);
    // Sans étape (appelant d'avant la règle), la porte seule parle — comme avant.
    expect(reserveDeLAiguillage({ porte: porte({ etat: "EN_ATTENTE" }) })).toBe(reserveBC(porte({ etat: "EN_ATTENTE" })));
  });
  it("un BC RENVOYÉ dit qu'il ne part pas, et le geste qui le rend à la signature (R09)", () => {
    const r = reserveEtapeBC("A_CORRIGER", null, 0) ?? "";
    expect(r).toMatch(/modifiez-le/);
    expect(r).toMatch(/Ne l'envoyez pas au fournisseur/);
    expect(motifNonSignable("A_CORRIGER", null)).toMatch(/renvoyé à son émetteur/);
    const c = chantierBCClos([{ reference: "BC-7", porte: porte({ etat: "VALIDE" }), etape: "A_CORRIGER" }]);
    expect(c.ok, "un BC renvoyé n'est pas signé : le chantier reste ouvert").toBe(false);
    expect(c.ok ? "" : c.raison).toMatch(/BC-7 \(renvoyé à l'émetteur pour correction\)/);
  });
  it("motifNonSignable : seul « à signer » se signe, et chaque refus nomme ce qui le lève", () => {
    expect(motifNonSignable("A_SIGNER", null)).toBeNull();
    expect(motifNonSignable("A_VALIDER", porte({ etat: "EN_ATTENTE" }))).toMatch(/attend encore la validation/);
    expect(motifNonSignable("REFUSE", porte({ etat: "REFUSE" }))).toMatch(/ne se signe pas/);
    expect(motifNonSignable("SANS_PORTE", null)).toMatch(/Adresser au centre/);
    expect(motifNonSignable("HORS_CIRCUIT", null)).toMatch(/antérieur au circuit/);
    expect(motifNonSignable("SIGNE", null)).toMatch(/déjà signé/);
  });
});

describe("chantierBCClos avec l'étape — validé ne suffit plus, il faut la signature (§118.149)", () => {
  it("un BC validé mais pas encore signé tient le chantier ouvert — en nommant la file où il attend", () => {
    const r = chantierBCClos([{ reference: "BC-1", porte: porte({ etat: "VALIDE" }), etape: "A_SIGNER" }]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toMatch(/pas encore signé/);
    // Le chemin du MENU d'aujourd'hui (§118.176) — « Finances › Bons de commande » n'existe plus.
    expect(r.ok ? "" : r.raison).toContain(MENU_BONS_DE_COMMANDE);
    expect(r.ok ? "" : r.raison).not.toMatch(/Finances › Bons de commande/);
  });
  it("un BC SOUS le seuil n'a pas de porte à attendre : il n'est pas « vu par aucun centre », il est à signer", () => {
    const r = chantierBCClos([{ reference: "BC-2", porte: null, etape: "A_SIGNER" }]);
    expect(r.ok ? "" : r.raison).not.toMatch(/aucun centre/);
    expect(r.ok ? "" : r.raison).toMatch(/pas encore signé/);
  });
  it("un BC antérieur au circuit se renvoie au geste qui l'y fait entrer", () => {
    const r = chantierBCClos([{ reference: "BC-3", porte: null, etape: "HORS_CIRCUIT" }]);
    expect(r.ok ? "" : r.raison).toMatch(/Adressez-le au centre/);
  });
  it("tous SIGNÉS → le chantier se clôt ; un seul non signé suffit à le tenir ouvert", () => {
    expect(chantierBCClos([{ reference: "BC-4", porte: porte({ etat: "VALIDE" }), etape: "SIGNE" }]).ok).toBe(true);
    const r = chantierBCClos([
      { reference: "BC-4", porte: porte({ etat: "VALIDE" }), etape: "SIGNE" },
      { reference: "BC-5", porte: null, etape: "A_SIGNER" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toContain("BC-5");
    expect(r.ok ? "" : r.raison).not.toContain("BC-4");
  });
});

describe("seuilDuCentre — un seuil par centre (Direction, 10/2026)", () => {
  it("le BC d'Ad & Pro lit le seuil du centre Ad & Pro, les autres celui du centre de validations", async () => {
    const { seuilDuCentre } = await import("./regle");
    const seuils = { adPro: 1_000_000, validation: 200_000 };
    expect(seuilDuCentre(seuils, "AD_PRO")).toBe(1_000_000);
    expect(seuilDuCentre(seuils, "VALIDATION")).toBe(200_000);
  });
});
