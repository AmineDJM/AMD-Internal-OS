import { describe, expect, it } from "vitest";
import { avancementTournee, type EtatVisite } from "@/lib/sfe/tournee";
import {
  cibleDuPraticien, etatDuPlanPourJournee, fusionnerJournee, gesteDeVisite, jourLocal, ligneDeChiffres, prochaineVisite,
} from "./journee-visite";
import { cheminDeDestination, destinationVisite, estDelegue, type FaitsAiguillage } from "./aiguillage-visite";

/**
 * « MA JOURNÉE » DU DÉLÉGUÉ (Visite médicale, 11/2026) — les règles pures : la liste du jour, la prochaine visite, la
 * porte d'un médecin choisi, le compteur unique, l'état du plan, et l'aiguillage de `/medical`.
 */

const AUJ = "2026-11-24";
const v = (id: string, jour: string, etat: EtatVisite, heuresRestantes: number, doctorId = `d-${id}`) =>
  ({ id, date: new Date(`${jour}T09:00:00`).toISOString(), doctorId, etat, heuresRestantes });

describe("le geste d'une carte", () => {
  it("commencer une visite à faire, corriger un rapport dans sa fenêtre, rien sinon", () => {
    expect(gesteDeVisite("A_FAIRE", 30)).toBe("COMMENCER");
    expect(gesteDeVisite("FAITE", 30)).toBe("CORRIGER");
    expect(gesteDeVisite("FAITE", 0)).toBe("AUCUN");
    expect(gesteDeVisite("PERDUE", 0)).toBe("AUCUN");
    expect(gesteDeVisite("ANNULEE", 20)).toBe("AUCUN");
  });
  it("le jour local d'un instant", () => {
    expect(jourLocal(new Date(2026, 10, 4, 23, 30))).toBe("2026-11-04");
  });
});

describe("la liste du jour — l'emploi du temps, puis « À rattraper »", () => {
  const visites = [
    v("faite", AUJ, "FAITE", 40),
    v("hier-ouverte", "2026-11-23", "A_FAIRE", 10),
    v("a-faire-1", AUJ, "A_FAIRE", 44),
    v("hier-faite", "2026-11-23", "FAITE", 10),
    v("avant-hier-perdue", "2026-11-22", "PERDUE", 0),
    v("annulee", AUJ, "ANNULEE", 44),
    v("a-faire-2", AUJ, "A_FAIRE", 44),
  ];
  const rattrapages = [{ doctorId: "d-a-faire-1" }, { doctorId: "d-libre" }, { doctorId: "d-faite" }];
  const j = fusionnerJournee({ visites, rattrapages, aujourdhui: AUJ });

  it("une visite d'hier encore rapportable passe en tête ; faite ou perdue, elle quitte la liste du jour", () => {
    expect(j.aujourdhui.map((c) => c.id)).toEqual(["hier-ouverte", "a-faire-1", "a-faire-2", "faite", "annulee"]);
    expect(j.aujourdhui[0]).toMatchObject({ jourPasse: true, geste: "COMMENCER" });
    expect(j.aujourdhui.find((c) => c.id === "faite")).toMatchObject({ geste: "CORRIGER", jourPasse: false });
  });
  it("« À rattraper » ne repropose pas un médecin déjà dans la liste du jour (fait ou à faire)", () => {
    expect(j.aRattraper.map((r) => r.doctorId)).toEqual(["d-libre"]);
  });
  it("la prochaine visite : la première à commencer ; sinon la première à rattraper ; sinon rien", () => {
    expect(prochaineVisite(j)).toEqual({ sorte: "PLANIFIEE", visitId: "hier-ouverte" });
    // ce qu'on vient d'enregistrer est écarté (la liste n'est pas encore rafraîchie)
    expect(prochaineVisite(j, { visitId: "hier-ouverte", doctorId: "d-hier-ouverte" })).toEqual({ sorte: "PLANIFIEE", visitId: "a-faire-1" });
    const seule = fusionnerJournee({ visites: [v("faite", AUJ, "FAITE", 40)], rattrapages: [{ doctorId: "d-x" }], aujourdhui: AUJ });
    expect(prochaineVisite(seule)).toEqual({ sorte: "HORS_PLAN", doctorId: "d-x" });
    expect(prochaineVisite(seule, { doctorId: "d-x" })).toBeNull();
  });
  it("un médecin choisi hors plan, mais PRÉVU aujourd'hui, ouvre le rapport de SA visite — pas un doublon", () => {
    expect(cibleDuPraticien("d-a-faire-2", j.aujourdhui)).toEqual({ sorte: "PLANIFIEE", visitId: "a-faire-2" });
    // déjà fait aujourd'hui : c'est une seconde visite, hors plan
    expect(cibleDuPraticien("d-faite", j.aujourdhui)).toEqual({ sorte: "HORS_PLAN", doctorId: "d-faite" });
    expect(cibleDuPraticien("d-libre", j.aujourdhui)).toEqual({ sorte: "HORS_PLAN", doctorId: "d-libre" });
  });
});

describe("UN compteur « ce mois » — celui du plan validé", () => {
  const panel = { covered: 12, panelSize: 40, coveragePct: 30 };
  it("le plan fait le chiffre ; le hors plan, le hors délai et le panel vont en sous-texte", () => {
    const a = avancementTournee([
      { etat: "FAITE", imprevue: false }, { etat: "A_FAIRE", imprevue: false }, { etat: "PERDUE", imprevue: false },
      { etat: "ANNULEE", imprevue: false }, { etat: "FAITE", imprevue: true },
    ]);
    const l = ligneDeChiffres(a, panel);
    expect(l).toMatchObject({ fait: 1, sur: 3, libelle: "visites du plan ce mois", pct: 33 });
    expect(l.sousTexte).toEqual(["+ 1 hors plan", "1 hors délai", "1 reportée ou annulée", "30 % du panel vu (12/40)"]);
  });
  it("sans plan, le nombre de visites faites — jamais « 0 / 0 », et le hors plan n'est pas compté deux fois", () => {
    const l = ligneDeChiffres(avancementTournee([{ etat: "FAITE", imprevue: true }, { etat: "FAITE", imprevue: true }]), { covered: 0, panelSize: 0, coveragePct: 0 });
    expect(l).toMatchObject({ fait: 2, sur: null, libelle: "visites ce mois" });
    expect(l.sousTexte).toEqual([]);
  });
});

describe("l'état du plan, avec son remède", () => {
  const now = new Date("2026-11-24T10:00:00");
  it("pas de plan → « Préparer mon plan » ; sauf si des visites remplissent déjà la journée", () => {
    expect(etatDuPlanPourJournee(null, now, false)?.geste).toEqual({ libelle: "Préparer mon plan", href: "/medical/plan-de-tournee" });
    expect(etatDuPlanPourJournee(null, now, true)).toBeNull();
  });
  it("soumis → chez qui, depuis combien de jours", () => {
    const e = etatDuPlanPourJournee({ id: "p1", status: "SUBMITTED", chez: "Nadia B.", depuis: "2026-11-21T08:00:00" }, now, false);
    expect(e?.texte).toBe("Plan en attente de validation par Nadia B. depuis 3 j.");
    expect(e?.geste?.href).toBe("/medical/plan-de-tournee?plan=p1");
  });
  it("validé : rien à dire ; brouillon, rejeté, révision : le geste qui le fait avancer", () => {
    expect(etatDuPlanPourJournee({ id: "p", status: "APPROVED", chez: null, depuis: null }, now, false)).toBeNull();
    expect(etatDuPlanPourJournee({ id: "p", status: "DRAFT", chez: null, depuis: null }, now, false)?.geste?.libelle).toBe("Terminer mon plan");
    expect(etatDuPlanPourJournee({ id: "p", status: "REJECTED", chez: null, depuis: null }, now, false)?.ton).toBe("warning");
  });
});

describe("l'aiguillage de « Visite médicale »", () => {
  const base: FaitsAiguillage = {
    roles: [], peutSaisir: false, estKam: false, aUnPanel: false, busSupervisees: [], voitCockpit: true, voitForceDeVente: true,
  };
  it("la Direction (Super Admin, DO, DG, Direction) va au Cockpit Opérations — même avec un panel de test", () => {
    for (const r of ["SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR"]) {
      expect(destinationVisite({ ...base, roles: [r], peutSaisir: true, aUnPanel: true })).toBe("COCKPIT");
    }
    expect(cheminDeDestination("COCKPIT")).toBe("/operations");
  });
  it("le délégué va sur « Ma journée » — même panel vide, pour y lire la cause et prévenir son superviseur", () => {
    const kam = { ...base, roles: ["MEDICAL_DELEGATE"], peutSaisir: true };
    expect(estDelegue(kam)).toBe(true);
    expect(destinationVisite(kam)).toBe("JOURNEE");
    expect(destinationVisite({ ...base, roles: ["NATIONAL_SALES"], peutSaisir: true })).toBe("JOURNEE");
    // un autre rôle qui saisit et porte un panel est de terrain lui aussi
    expect(destinationVisite({ ...base, roles: ["SALES_USER"], peutSaisir: true, aUnPanel: true })).toBe("JOURNEE");
    // sans le droit de saisir, ce n'est pas un délégué
    expect(estDelegue({ ...base, roles: ["MEDICAL_DELEGATE"] })).toBe(false);
    // un National Sales qui supervise une BU sans tournée à lui est un superviseur ; avec un panel, un délégué
    const ns = { ...base, roles: ["NATIONAL_SALES"], peutSaisir: true, busSupervisees: ["bu-1"] };
    expect(destinationVisite(ns)).toBe("EQUIPE");
    expect(destinationVisite({ ...ns, aUnPanel: true })).toBe("JOURNEE");
    expect(destinationVisite({ ...ns, estKam: true })).toBe("JOURNEE");
  });
  it("le superviseur d'une BU ou le manager va sur l'écran de son équipe, filtré sur sa BU", () => {
    const sup = { ...base, roles: ["HEAD_OF_SALES"], busSupervisees: ["bu-1", "bu-2"] };
    expect(destinationVisite(sup)).toBe("EQUIPE");
    expect(cheminDeDestination("EQUIPE", sup.busSupervisees)).toBe("/planning?bu=bu-1");
    expect(destinationVisite({ ...base, roles: ["MEDICAL_PROMOTION_MANAGER"] })).toBe("EQUIPE");
    expect(cheminDeDestination("EQUIPE")).toBe("/planning");
  });
  it("une tête sans Cockpit ouvert retombe sur l'équipe ; tous les autres, sur le plan de tournée", () => {
    expect(destinationVisite({ ...base, roles: ["DIRECTION"], voitCockpit: false })).toBe("EQUIPE");
    expect(destinationVisite({ ...base, roles: ["VIEWER"] })).toBe("PLAN");
    expect(destinationVisite({ ...base, roles: ["HEAD_OF_SALES"], voitForceDeVente: false })).toBe("PLAN");
    expect(cheminDeDestination("PLAN")).toBe("/medical/plan-de-tournee");
    expect(cheminDeDestination("JOURNEE")).toBe("/medical/ma-journee");
  });
});
