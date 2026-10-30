import { describe, expect, it } from "vitest";
import { corrigerContenu, signatureContenu } from "./contenu";
import { correspondance } from "./correspondance";
import { decisionExtraction, estResponsable, statutDeLaRecette } from "./etats";
import { extraireRecette, motifMontrable, seuilRond, type DossierObserve } from "./extraction";
import { delaiCite, ecartsALaDemande, ecartsAuPlan, montantCite, planDeLaRecette, signaturePlan } from "./plan";
import { decrireCircuit, processusExclusPar } from "./processus";

const J = 86_400_000;
const t0 = new Date("2030-01-01T08:00:00Z");
const desc = decrireCircuit("WF:CONGRESS_NATIONAL")!;

function dossier(i: number, montant: number, avecDg: boolean, renvoi = false): DossierObserve {
  let t = t0.getTime() + i * J;
  const debut = new Date(t);
  const ev: DossierObserve["evenements"] = [];
  if (renvoi) { t += J; ev.push({ quand: new Date(t), etape: "marketing", nature: "renvoi", note: `Devis manquant ${montant} DZD` }); t += J; ev.push({ quand: new Date(t), etape: "marketing", nature: "resoumission" }); }
  t += 2 * J; ev.push({ quand: new Date(t), etape: "marketing", libelle: "Marketing", nature: "avance", role: "PRODUCT_MANAGER" });
  if (avecDg) { t += 3 * J; ev.push({ quand: new Date(t), etape: "dg", libelle: "DG", nature: "avance", role: "GENERAL_MANAGER" }); }
  else { ev.push({ quand: new Date(t), etape: "dg", nature: "auto" }); }
  return { id: `d${i}`, debut, fin: new Date(t), issue: "ACCEPTE", montant, evenements: ev, pieces: ["DEVIS"] };
}

describe("extraction d'une recette (pur)", () => {
  const dossiers = [dossier(0, 300_000, false, true), dossier(1, 600_000, false, true), dossier(2, 900_000, false), dossier(3, 1_500_000, true), dossier(4, 2_000_000, true)];

  it("sous le seuil d'occurrences : rien", () => {
    expect(extraireRecette(desc, dossiers.slice(0, 4), null, { seuil: 5 })).toBeNull();
    expect(extraireRecette(desc, [...dossiers.slice(0, 4), { ...dossiers[4], issue: "EN_COURS", fin: null }], null, { seuil: 5 })).toBeNull();
  });

  it("étapes, validateurs observés, seuil observé arrondi à un palier, pièces, piège répété (chiffres masqués)", () => {
    const c = extraireRecette(desc, dossiers, null, { seuil: 5 })!;
    expect(c.etapes.map((e) => e.cle)).toEqual(["marketing", "dg"]);
    expect(c.etapes[1].validateurs).toEqual(["GENERAL_MANAGER"]);
    expect(c.seuils).toEqual([expect.objectContaining({ etape: "dg", montant: 1_000_000, source: "OBSERVE" })]);
    expect(c.pieces.map((p) => p.nature)).toEqual(["DEVIS"]);
    expect(c.pieges.some((p) => p.texte.includes("Devis manquant …"))).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/300000|600000|d0|d1/);
  });

  it("le réglage du circuit l'emporte : « franchie automatiquement jusqu'à… »", () => {
    const c = extraireRecette(desc, dossiers, [{ cle: "marketing", libelle: "Marketing", roles: ["PRODUCT_MANAGER"], seuilAutoMax: null }, { cle: "dg", libelle: "Directeur Général", roles: ["GENERAL_MANAGER"], seuilAutoMax: 1_000_000 }], { seuil: 5 })!;
    expect(c.seuils[0]).toMatchObject({ source: "DEFINITION", montant: 1_000_000 });
    expect(c.etapes[1].condition).toMatch(/franchie automatiquement jusqu'à 1 M DZD/);
  });

  it("le palier n'est jamais le montant d'un dossier", () => {
    expect(seuilRond(1_100_000, 1_500_000)).toBe(1_200_000);
    expect(seuilRond(500_000, 650_000)).toBe(600_000);
    expect(seuilRond(1_000_000, 1_000_001)).toBeNull();
    expect(motifMontrable("Appeler le 0555 12 34 56 ou a@b.dz")).toBe("Appeler le … ou …");
  });

  it("la signature ignore les pièges et les dates, pas la structure", () => {
    const c = extraireRecette(desc, dossiers, null, { seuil: 5 })!;
    expect(signatureContenu({ ...c, pieges: [], observation: { ...c.observation, au: "2099-01-01" } })).toBe(signatureContenu(c));
    expect(signatureContenu({ ...c, pieces: [] })).not.toBe(signatureContenu(c));
  });
});

describe("états : rien n'est appris en silence", () => {
  it("l'extraction propose, rafraîchit, ou ouvre une nouvelle version — jamais ne valide", () => {
    expect(decisionExtraction(null, null, "a")).toBe("CREER");
    expect(decisionExtraction({ statut: "PROPOSEE" }, { statut: "PROPOSEE", signature: "a" }, "a")).toBe("RAFRAICHIR");
    expect(decisionExtraction({ statut: "PROPOSEE" }, { statut: "PROPOSEE", signature: "a" }, "b")).toBe("REMPLACER_PROPOSITION");
    expect(decisionExtraction({ statut: "VALIDEE" }, { statut: "VALIDEE", signature: "a" }, "a")).toBe("RIEN");
    expect(decisionExtraction({ statut: "VALIDEE" }, { statut: "VALIDEE", signature: "a" }, "b")).toBe("NOUVELLE_VERSION");
    expect(decisionExtraction({ statut: "RETIREE" }, { statut: "RETIREE", signature: "a" }, "b")).toBe("RIEN");
    expect(statutDeLaRecette([{ statut: "REJETEE" }], false)).toBe("REJETEE");
  });
  it("le responsable : rôle ou personne désignés — pas le Super Admin d'office", () => {
    expect(estResponsable({ id: "x", role: "SUPER_ADMIN" }, { role: "PRODUCT_MANAGER", userId: null })).toBe(false);
    expect(estResponsable({ id: "x", role: "VIEWER", secondaryRole: "PRODUCT_MANAGER" }, { role: "PRODUCT_MANAGER", userId: null })).toBe(true);
    expect(estResponsable({ id: "x", role: "VIEWER" }, null)).toBe(false);
  });
  it("une correction ne change ni les chiffres ni n'invente d'étape", () => {
    const c = extraireRecette(desc, [dossier(0, 1, false), dossier(1, 2, false), dossier(2, 3, false)], null, { seuil: 3 })!;
    expect(corrigerContenu(c, { etapes: [{ cle: "inventee" }] }).ok).toBe(false);
    const r = corrigerContenu(c, { note: "Joindre le devis", duree: { medianeJours: 0 } });
    expect(r.ok && r.contenu.note).toBe("Joindre le devis");
    expect(r.ok && r.contenu.duree).toEqual(c.duree);
  });
});

describe("plan et écarts", () => {
  const c = extraireRecette(desc, [dossier(0, 300_000, false), dossier(1, 600_000, false), dossier(2, 900_000, false), dossier(3, 1_500_000, true), dossier(4, 2_000_000, true)], null, { seuil: 5 })!;
  const v = { version: 2, par: "Samia", le: "2030-03-04T10:00:00Z" };

  it("le gabarit dit d'où il vient, finit par un livrable, et sa signature ignore les titres", () => {
    const p = planDeLaRecette(c, v, "Prise en charge de 3 médecins")!;
    expect(p.objectif).toMatch(/selon la recette « Prise en charge nationale » \(version 2\) validée par Samia le 04\/03\/2030/);
    expect(p.etapes.some((e) => e.type === "LIVRABLE")).toBe(true);
    expect(signaturePlan({ etapes: p.etapes.map((e) => ({ ...e, titre: "autre" })) })).toBe(signaturePlan(p));
    expect(ecartsAuPlan(p, { etapes: p.etapes })).toEqual([]);
    expect(ecartsAuPlan(p, { etapes: p.etapes.slice(1) })[0]).toMatch(/retirée/);
  });

  it("écarts de la demande : seuil franchi, délai court", () => {
    expect(montantCite("budget de 2,5 M DZD")).toBe(2_500_000);
    expect(montantCite("1 200 000 DA pour 3 médecins")).toBe(1_200_000);
    expect(montantCite("3 médecins")).toBeNull();
    expect(delaiCite("validé sous 3 jours")).toBe(3);
    expect(ecartsALaDemande(c, "2,5 M DZD, sous 1 jour").join(" ")).toMatch(/au-delà du seuil.*délai demandé/);
  });
});

describe("correspondance et droits", () => {
  const candidats = [
    { id: "nat", titre: "Prise en charge nationale", motsCles: decrireCircuit("WF:CONGRESS_NATIONAL")!.motsCles },
    { id: "intl", titre: "Prise en charge internationale", motsCles: decrireCircuit("WF:CONGRESS_INTERNATIONAL")!.motsCles },
    { id: "rec", titre: "Recrutement", motsCles: decrireCircuit("REC")!.motsCles },
  ];
  it("un mot discriminant tranche ; sans lui, une question ; sans rien, rien", () => {
    expect(correspondance("prise en charge nationale à Oran", candidats)).toMatchObject({ verdict: "UNE", id: "nat" });
    expect(correspondance("prise en charge pour un congrès", candidats).verdict).toBe("AMBIGU");
    expect(correspondance("quel temps fait-il ?", candidats).verdict).toBe("AUCUNE");
    expect(correspondance("recruter un délégué", candidats)).toMatchObject({ verdict: "UNE", id: "rec" });
  });
  it("une famille fermée retire ses processus ; la forme d'Adam est au Super Admin seul", () => {
    expect(processusExclusPar(["AD_PRO", "FICHES"]).sort()).toEqual(["AD_PRO", "MARKETING", "RH"]);
    expect(decrireCircuit("FORME:abc")!.superAdminSeul).toBe(true);
    expect(decrireCircuit("VAL:REGULATORY")!.processus).toBe("REGLEMENTAIRE");
    expect(decrireCircuit("WF:INCONNU")).toBeNull();
  });
});
