import { describe, expect, it } from "vitest";
import {
  circuitDuDepart, departEchu, lireSoldeSaisi, refusSaisieDepart, soldePrerempli, statutApresValidation, tachesDeSortie,
  totauxSolde, SOURCE_COMPTE, SOURCE_TRANSFERT_TACHES, type SourcesSortie,
} from "./regles";
import { corpsCertificatParDefaut, lireCertificatSaisi, refusCertificat, type ChampsCertificat } from "./certificat";
import { decisionCompteSalarie, emailDeConnexion, roleDuCompteSalarie } from "../compte-salarie";

describe("le circuit de la fin de contrat — RH → N+1 → DG", () => {
  it("trois personnes distinctes : trois marches, dans cet ordre", () => {
    const c = circuitDuDepart({ rhId: "rh", n1Id: "chef", dgId: "dg", salarieUserId: "sal" });
    expect(c.ok && c.etapes.map((e) => [e.marche, e.validatorId])).toEqual([["RH", "rh"], ["N1", "chef"], ["DG", "dg"]]);
  });
  it("pas de N+1 résolu : la marche est sautée, et la note le dit", () => {
    const c = circuitDuDepart({ rhId: "rh", n1Id: null, dgId: "dg", salarieUserId: "sal" });
    expect(c.ok && c.etapes.map((e) => e.marche)).toEqual(["RH", "DG"]);
    expect(c.ok && c.notes[0]).toMatch(/Aucun supérieur hiérarchique/);
  });
  it("le N+1 est le DG : une seule décision, au nom des deux marches", () => {
    const c = circuitDuDepart({ rhId: "rh", n1Id: "dg", dgId: "dg", salarieUserId: "sal" });
    expect(c.ok && c.etapes.map((e) => e.validatorId)).toEqual(["rh", "dg"]);
    expect(c.ok && c.etapes[1].libelle).toBe("Supérieur hiérarchique et Direction générale");
  });
  it("le N+1 est la RH qui ouvre : on ne valide pas deux fois", () => {
    const c = circuitDuDepart({ rhId: "rh", n1Id: "rh", dgId: "dg", salarieUserId: "sal" });
    expect(c.ok && c.etapes.map((e) => e.validatorId)).toEqual(["rh", "dg"]);
  });
  it("la DG ouvre elle-même : sa marche vaut RH + DG, le N+1 tranche ensuite", () => {
    const c = circuitDuDepart({ rhId: "dg", n1Id: "chef", dgId: "dg", salarieUserId: "sal" });
    expect(c.ok && c.etapes.map((e) => [e.marche, e.validatorId])).toEqual([["RH", "dg"], ["N1", "chef"]]);
  });
  it("le salarié n'ouvre pas sa propre fin de contrat ; sans DG, le refus dit le remède", () => {
    expect(circuitDuDepart({ rhId: "sal", n1Id: "chef", dgId: "dg", salarieUserId: "sal" })).toMatchObject({ ok: false });
    const r = circuitDuDepart({ rhId: "rh", n1Id: "chef", dgId: null, salarieUserId: "sal" });
    expect(r.ok === false && r.refus).toMatch(/Administration › Comptes/);
  });
  it("les statuts suivent la demande de validation", () => {
    expect(statutApresValidation("APPROVED")).toBe("VALIDE");
    expect(statutApresValidation("REJECTED")).toBe("REFUSE");
    expect(statutApresValidation("CHANGES_REQUESTED")).toBe("A_CORRIGER");
    expect(statutApresValidation("PENDING")).toBeNull();
  });
});

describe("la saisie et la date de fermeture", () => {
  it("motif, date, préavis, note exigée pour « Autre »", () => {
    expect(refusSaisieDepart({ motif: null, dateFin: "2026-12-31", preavisJours: null, note: null })).toMatch(/motif/);
    expect(refusSaisieDepart({ motif: "DEMISSION", dateFin: "2026-02-30", preavisJours: null, note: null })).toMatch(/date de fin/);
    expect(refusSaisieDepart({ motif: "DEMISSION", dateFin: "2026-12-31", preavisJours: -1, note: null })).toMatch(/préavis/);
    expect(refusSaisieDepart({ motif: "AUTRE", dateFin: "2026-12-31", preavisJours: null, note: " " })).toMatch(/Précisez/);
    expect(refusSaisieDepart({ motif: "FIN_CDD", dateFin: "2026-12-31", preavisJours: 0, note: null })).toBeNull();
  });
  it("le compte se ferme le lendemain du dernier jour, à minuit à Alger (23 h UTC)", () => {
    const fin = new Date("2026-12-31T00:00:00.000Z");
    expect(departEchu(fin, new Date("2026-12-31T22:59:00.000Z"))).toBe(false);
    expect(departEchu(fin, new Date("2026-12-31T23:00:00.000Z"))).toBe(true);
  });
});

describe("la liste de sortie préremplie", () => {
  const base: SourcesSortie = {
    moyens: [], promo: [], parcInformatique: null, tachesOuvertes: 0, sujetsOuverts: 0, validationsEnAttente: 0,
    siegeCentrePaiement: false, accesPersonnalises: 0, accesEntites: 0, aUnCompte: true, repreneur: "Chef", dateFin: "31/12/2026",
  };
  it("véhicule et matériel promotionnel réels, une ligne par source", () => {
    const l = tachesDeSortie({
      ...base,
      moyens: [{ id: "v1", type: "VEHICULE", libelle: "Clio", identifiant: "12345-116-16", reference: "MG-2026-001" }],
      promo: [{ itemId: "p1", nom: "Présentoir", quantite: 3, unite: "pièce" }],
    });
    const v = l.find((x) => x.source === "MoyenGeneral:v1");
    expect(v).toMatchObject({ categorie: "VEHICULE", libelle: "Restituer le véhicule Clio" });
    expect(l.find((x) => x.source === "PromoStockItem:p1")).toMatchObject({ categorie: "MATERIEL_PROMO", quantite: 3 });
    expect(new Set(l.map((x) => x.source)).size).toBe(l.length);
  });
  it("sans registre du parc informatique : une ligne libre ; badge, documents et compte toujours là", () => {
    const l = tachesDeSortie(base);
    expect(l.map((x) => x.source)).toEqual(expect.arrayContaining(["LIBRE:INFORMATIQUE", "LIBRE:BADGE_CLES", "AUTO:CERTIFICAT", "AUTO:SOLDE", SOURCE_COMPTE]));
    expect(tachesDeSortie({ ...base, aUnCompte: false }).some((x) => x.source === SOURCE_COMPTE)).toBe(false);
  });
  it("les transferts nomment le repreneur ; les accès n'apparaissent que s'il y en a", () => {
    const l = tachesDeSortie({ ...base, tachesOuvertes: 2, siegeCentrePaiement: true });
    expect(l.find((x) => x.source === SOURCE_TRANSFERT_TACHES)?.libelle).toBe("Transférer 2 tâches en cours à Chef");
    expect(l.some((x) => x.source === "AUTO:SIEGE_PAIEMENT")).toBe(true);
    expect(l.some((x) => x.source === "AUTO:ACCES_PERSO")).toBe(false);
  });
});

describe("le solde de tout compte — prérempli, jamais calculé", () => {
  it("salaire de la fiche, congés À SAISIR, frais en gain, avances en retenue", () => {
    const l = soldePrerempli({
      salaireBase: 120000, joursCongesRestants: 12.5,
      avances: [{ id: "a", montant: 20000, versee: "01/10/2026" }],
      notesDeFrais: [{ id: "f", montant: 4500, mois: "2026-11", statut: "Note soumise" }],
    });
    expect(l.find((x) => x.id === "salaire")?.montant).toBe(120000);
    expect(l.find((x) => x.id === "conges")).toMatchObject({ montant: null });
    expect(l.find((x) => x.id === "conges")?.detail).toMatch(/12,5 jour/);
    expect(l.find((x) => x.id === "avance-a")).toMatchObject({ sens: "RETENUE", montant: 20000 });
    expect(totauxSolde(l)).toEqual({ gains: 124500, retenues: 20000, net: 104500, aSaisir: 1 });
  });
  it("relit ce que l'écran envoie, refuse ce qui ne se lit pas", () => {
    expect(lireSoldeSaisi([{ libelle: "Prime", montant: "1500.555", sens: "GAIN" }])).toEqual({ ok: true, lignes: [{ id: "l1", libelle: "Prime", detail: null, montant: 1500.56, sens: "GAIN" }] });
    expect(lireSoldeSaisi([{ libelle: "", montant: 1 }])).toMatchObject({ ok: false });
    expect(lireSoldeSaisi([{ libelle: "x", montant: -5 }])).toMatchObject({ ok: false });
    expect(lireSoldeSaisi("n'importe quoi")).toMatchObject({ ok: false });
  });
});

describe("le certificat de travail", () => {
  const c: ChampsCertificat = {
    reference: "", civilite: "Madame", salarie: "KACI Lina", dateNaissance: "1990-03-05", lieuNaissance: "Tizi Ouzou",
    societe: "SARL ADVENTUM PHARMA", societeSignature: "ADVENTUM PHARMA", poste: "Déléguée médicale", dateEmbauche: "2025-07-01",
    signataireCivilite: "Monsieur", signataire: "SAIDI Karim", signataireFonction: "Gérant", lieuSignature: "Alger",
    dateSignature: "2026-12-31", dateFin: "2026-12-31", corps: "",
  };
  it("le texte proposé accorde et date à la française", () => {
    const t = corpsCertificatParDefaut(c);
    expect(t).toContain("Je soussigné, Monsieur SAIDI Karim, agissant en qualité de Gérant, certifie que Madame KACI Lina, née le 05 mars 1990 à Tizi Ouzou, a été employée");
    expect(t).toContain("du 01/07/2025 au 31/12/2026");
    expect(t).toContain("Elle quitte la société libre de tout engagement.");
  });
  it("ce qui manque pour émettre est nommé ; la saisie est relue", () => {
    expect(refusCertificat(c)).toMatch(/le texte du certificat/);
    expect(refusCertificat({ ...c, corps: "x" })).toBeNull();
    expect(lireCertificatSaisi({ ...c, civilite: "Docteur" })?.civilite).toBe("");
    expect(lireCertificatSaisi(null)).toBeNull();
  });
});

describe("le compte créé avec la fiche", () => {
  const f = { userId: null, email: "Lina.Kaci@Adventum.dz ", isActive: true, fullName: "KACI Lina" };
  it("crée, relie, refuse — une seule fois", () => {
    expect(emailDeConnexion(f.email)).toBe("lina.kaci@adventum.dz");
    expect(decisionCompteSalarie(f, null)).toEqual({ geste: "CREER", email: "lina.kaci@adventum.dz" });
    expect(decisionCompteSalarie(f, { id: "u1", ficheId: null })).toEqual({ geste: "RELIER", userId: "u1" });
    expect(decisionCompteSalarie(f, { id: "u1", ficheId: "autre" }).geste).toBe("EMAIL_PRIS");
    expect(decisionCompteSalarie({ ...f, userId: "u9" }, null).geste).toBe("DEJA_LIE");
    expect(decisionCompteSalarie({ ...f, email: "" }, null).geste).toBe("SANS_EMAIL");
  });
  it("le rôle : Lecteur, sauf choix d'un administrateur — jamais Super Admin par ce chemin", () => {
    const roles = ["VIEWER", "MEDICAL_DELEGATE", "SUPER_ADMIN"];
    expect(roleDuCompteSalarie("MEDICAL_DELEGATE", false, roles)).toBe("VIEWER");
    expect(roleDuCompteSalarie("MEDICAL_DELEGATE", true, roles)).toBe("MEDICAL_DELEGATE");
    expect(roleDuCompteSalarie("SUPER_ADMIN", true, roles)).toBe("VIEWER");
    expect(roleDuCompteSalarie("INVENTE", true, roles)).toBe("VIEWER");
  });
});
