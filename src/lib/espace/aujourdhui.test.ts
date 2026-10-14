import { describe, expect, it } from "vitest";
import {
  calculerSemaine, composerEquipe, composerRaccourcis, composerTuiles, jourDeReferenceDeLaSemaine, montantDzd,
  natureDe, phraseJournee, regrouperFile, rolesDe, totaux, type ElementFile, type MembreLu,
} from "./aujourdhui";

/**
 * « AUJOURD'HUI » — les règles pures de l'onglet (Direction, 14/10/2026).
 *
 * Le cas de référence est celui du Super Admin RÉEL relevé sur la maquette validée : 12 ordres de dépense
 * à régler pour 2 022 550 DZD dont 5 honoraires en retard de 28 jours, 12 déclarations d'information
 * médicale rangées en 4 familles, la validation DIM-2026-003 qui attend depuis 43 jours, et la demande
 * REQ-2026-027 (puce téléphonique) en retard de 69 jours.
 */

const NOW = new Date("2026-10-14T10:00:00.000Z");
const ilYA = (j: number) => new Date(NOW.getTime() - j * 86_400_000).toISOString();
const NBSP = " ";

const base = (o: Partial<ElementFile> & Pick<ElementFile, "key" | "objet" | "title">): ElementFile => ({
  subtitle: "", module: "", href: "/", kind: "request", deadline: null, depuis: null, owner: "", statusLabel: null, ...o,
});

const PAYS: [string, string, number, number | null, number, string][] = [
  ["od13", "Honoraires Pr Ouyahia", 80000, 28, 35, "Honoraires médecins"],
  ["od14", "Honoraires Pr Mammeri", 80000, 28, 35, "Honoraires médecins"],
  ["od15", "Honoraires Pr Belabes", 80000, 28, 35, "Honoraires médecins"],
  ["od16", "Honoraires Pr Mouffok", 80000, 28, 35, "Honoraires médecins"],
  ["od17", "Honoraires Pr Tabet", 80000, 28, 35, "Honoraires médecins"],
  ["od11", "SPA PROMBATI HOTEL", 400000, null, 37, "Voyages & hébergement"],
  ["od12", "GENIUS TRAVEL", 131800, null, 34, "Voyages & hébergement"],
  ["od22", "Genius Travel", 124750, null, 18, "Voyages & hébergement"],
  ["od20", "EPH Batna", 501000, null, 21, "Établissements de santé"],
  ["od21", "EPH Batna", 10000, null, 21, "Établissements de santé"],
  ["od23", "Traiteur FLASH MED", 400000, null, 12, "Traiteurs"],
  ["od19", "Traiteur HAFIZ", 55000, null, 19, "Traiteurs"],
];
const DIMS: [string, string, number, string][] = [
  ["d07", "Sponsoring SPO-2026-004 — ASARI", 26, "Sponsorings"],
  ["d08", "Sponsoring SPO-2026-005", 24, "Sponsorings"],
  ["d09", "Sponsoring SPO-2026-006 — Sétif", 22, "Sponsorings"],
  ["d10", "Sponsoring SPO-2026-007 — EPH Batna", 21, "Sponsorings"],
  ["d02", "Bannière de stand — congrès", 31, "Bannières"],
  ["d04", "Bannière web — espace médecins", 29, "Bannières"],
  ["d05", "Roll-up — soirée scientifique", 28, "Bannières"],
  ["d06", "Fiche posologique — rosuvastatine", 27, "Fiches posologiques"],
  ["d12", "Fiche posologique — amlodipine", 16, "Fiches posologiques"],
  ["d13", "Post-event — soirée Sétif", 14, "Post-events"],
  ["d14", "Post-event — journée EPH Batna", 12, "Post-events"],
  ["d15", "Post-event — atelier ASARI", 9, "Post-events"],
];

/** La file du Super Admin, telle que le centre d'actions la rend (un `ActionItem` par objet). */
function fileSuperAdmin(): ElementFile[] {
  const paiements = PAYS.map(([id, label, a, late, age, famille]) => base({
    key: `pay-${id}`, objet: `EXPENSE_ORDER:${id}`, title: label,
    subtitle: `OD-2026-0${id.slice(2)} · ${a.toLocaleString("fr-FR")} DZD`, module: "Espace comptable",
    href: `/finances/paiements-a-faire?focus=${id}#ord-${id}`, kind: "payment",
    deadline: late !== null ? ilYA(late) : null, depuis: ilYA(age), montant: a, famille, statusLabel: "À payer",
  }));
  const declarations = DIMS.map(([id, label, age, famille]) => base({
    key: `mi-${id}`, objet: `MEDICAL_INFO_DECLARATION:${id}`, title: label, subtitle: `DIM-2026-0${id.slice(1)}`,
    module: "Information médicale", href: `/information-medicale/${id}`, kind: "validation",
    depuis: ilYA(age), statut: "AWAITING_REVIEW", famille, statusLabel: "À instruire",
  }));
  return [
    ...paiements,
    base({
      key: "val-s1", objet: "VALIDATION_REQUEST:v3", title: "Validation Directeur des opérations — DIM-2026-003",
      subtitle: "Déclaration d'information médicale", module: "Validations", href: "/validations?focus=s1#val-s1",
      kind: "validation", depuis: ilYA(43), statusLabel: "À valider", montant: null,
    }),
    base({
      key: "req-27", objet: "ADMIN_REQUEST:r27", title: "Puce téléphonique", subtitle: "REQ-2026-027",
      module: "Demandes administratives", href: "/demandes/r27", kind: "request",
      deadline: ilYA(69), depuis: ilYA(76), owner: "Nesrine Boukhari", statusLabel: "Nouvelle",
    }),
    ...declarations,
  ];
}

describe("« À faire maintenant » — la file groupée par lot (cas Super Admin réel)", () => {
  const lots = regrouperFile(fileSuperAdmin(), NOW);

  it("quatre lots, triés par urgence : retard d'abord, puis montant, puis ancienneté", () => {
    expect(lots.map((l) => l.nature)).toEqual(["paiement", "demande", "validation", "declaration"]);
  });

  it("12 paiements = 1 ligne : « 12 paiements à régler — 2 022 550 DZD, dont 5 en retard »", () => {
    const pay = lots[0];
    expect(pay.n).toBe(12);
    expect(pay.montant).toBe(2_022_550);
    expect(pay.enRetard).toBe(5);
    expect(pay.titre).toBe(`12 paiements à régler — 2${NBSP}022${NBSP}550${NBSP}DZD, dont 5 en retard`);
    expect(pay.ton).toBe("late");
    // Les sous-lignes : les honoraires en retard d'abord, rangés par famille.
    expect(pay.lignes.slice(0, 5).every((l) => l.retard === 28)).toBe(true);
    expect(pay.familles.map((f) => f.famille)).toEqual(["Honoraires médecins", "Établissements de santé", "Voyages & hébergement", "Traiteurs"]);
    expect(pay.familles[0]).toMatchObject({ n: 5, montant: 400_000, enRetard: 5 });
  });

  it("le geste du lot de paiements MÈNE à l'écran des paiements, les 5 ordres en retard mis en évidence", () => {
    const g = lots[0].geste;
    expect(g.libelle).toBe("Régler les 5 en retard");
    // À retard et montant égaux, l'ordre alphabétique départage : la file est stable d'un rendu à l'autre.
    expect(g.href).toBe("/finances/paiements-a-faire?focus=od15,od14,od16,od13,od17#ord-od15");
  });

  it("12 déclarations = 1 lot en 4 familles, la plus ancienne en tête", () => {
    const dim = lots.find((l) => l.nature === "declaration")!;
    expect(dim.titre).toBe("12 déclarations à faire, en 4 familles");
    expect(dim.familles.map((f) => [f.famille, f.n])).toEqual([["Bannières", 3], ["Fiches posologiques", 2], ["Sponsorings", 4], ["Post-events", 3]]);
    expect(dim.lignes[0].ref).toBe("DIM-2026-002");
    expect(dim.geste).toEqual({ libelle: "Déclarer — tout voir", href: "/information-medicale" });
  });

  it("une ligne seule prend son propre intitulé : REQ-2026-027 en retard de 69 j, DIM-2026-003 qui attend depuis 43 j", () => {
    const req = lots.find((l) => l.nature === "demande")!;
    expect(req.titre).toBe("Puce téléphonique");
    expect(req.lignes[0]).toMatchObject({ ref: "REQ-2026-027", retard: 69, attente: 76 });
    expect(req.geste).toEqual({ libelle: "Traiter", href: "/demandes/r27" });
    const val = lots.find((l) => l.nature === "validation")!;
    expect(val.lignes[0]).toMatchObject({ ref: "DIM-2026-003", retard: null, attente: 43 });
    expect(val.geste.href).toBe("/validations?focus=s1#val-s1");
  });

  it("la phrase « Votre journée » se calcule sur la file", () => {
    expect(totaux(lots)).toEqual({ ouverts: 26, enRetard: 6 });
    const phrase = phraseJournee(lots).map((f) => f.t).join("");
    expect(phrase).toBe(`26 éléments attendent un geste de votre part, dont 6 en retard. Commencez par 12 paiements à régler — 2${NBSP}022${NBSP}550${NBSP}DZD, dont 5 en retard (jusqu'à 28 j de retard).`);
    expect(phraseJournee([]).map((f) => f.t).join("")).toBe("Rien ne vous attend pour l'instant : votre file est à jour.");
  });

  it("les tuiles du Super Admin : à traiter, en retard, paiements en attente, plus longue attente", () => {
    const t = composerTuiles(["SUPER_ADMIN"], lots, {});
    expect(t.map((x) => [x.k, x.v])).toEqual([
      ["À traiter", "26"],
      ["En retard", "6"],
      ["Paiements en attente", `2${NBSP}022${NBSP}550${NBSP}DZD`],
      ["Plus longue attente", `76${NBSP}j`],
    ]);
    expect(t[1].ton).toBe("late");
    expect(t[3].c).toBe("REQ-2026-027 · Puce téléphonique");
  });
});

describe("la nature d'une ligne et les coupes qui se disent", () => {
  it("lit l'identité de l'objet, puis le statut d'une déclaration", () => {
    const d = (statut: string) => base({ key: "k", objet: "MEDICAL_INFO_DECLARATION:x", title: "t", statut });
    expect(natureDe(d("AWAITING_DIRECTION"))).toBe("declaration-finale");
    expect(natureDe(d("READY"))).toBe("declaration-prete");
    expect(natureDe(d("DOCS_REQUESTED"))).toBe("declaration-pieces");
    expect(natureDe(base({ key: "k", objet: "ADMIN_REQUEST:x", title: "t", kind: "validation" }))).toBe("achat");
    expect(natureDe(base({ key: "k", objet: "LEAVE_REQUEST:x", title: "t", kind: "validation" }))).toBe("conge");
    expect(natureDe(base({ key: "k", objet: "AD_PRO_ITEM:x", title: "t", module: "Ad & Pro" }))).toBe("adpro");
    expect(natureDe(base({ key: "k", objet: "SPONSORING:x", title: "t", module: "Ad & Pro", statusLabel: "À corriger" }))).toBe("correction");
  });

  it("une ligne « et d'autres… » n'est pas comptée : elle devient la suite de son lot", () => {
    const lots = regrouperFile([
      base({ key: "a", objet: "LEAVE_REQUEST:1", title: "Congé — A", kind: "validation", href: "/mon-espace#conges-a-signer", depuis: ilYA(3) }),
      base({ key: "b", objet: "LEAVE_REQUEST:2", title: "Congé — B", kind: "validation", href: "/mon-espace#conges-a-signer", depuis: ilYA(1) }),
      base({ key: "r", objet: "LEAVE_REQUEST:reste:", title: "5 autre(s) congé(s) attendent votre signature", kind: "validation", href: "/mon-espace#conges-a-signer" }),
    ], NOW);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ n: 2, titre: "2 congés à signer" });
    expect(lots[0].suite?.libelle).toBe("5 autre(s) congé(s) attendent votre signature");
  });

  it("le montant s'écrit exact, centimes compris quand il y en a", () => {
    expect(montantDzd(2_022_550)).toBe(`2${NBSP}022${NBSP}550${NBSP}DZD`);
    expect(montantDzd(12_500.5)).toBe(`12${NBSP}500,50${NBSP}DZD`);
  });

  it("dû aujourd'hui n'est pas en retard ; le retard commence le lendemain de l'échéance", () => {
    const [lot] = regrouperFile([base({ key: "t", objet: "TASK:1", title: "Tâche", kind: "task", deadline: new Date(NOW.getTime() - 3_600_000).toISOString() })], NOW);
    expect(lot.enRetard).toBe(0);
  });
});

describe("Ma semaine — dimanche → jeudi, sur les horodatages existants", () => {
  const semaine = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  const jours = [
    ...Array(4).fill("2026-10-11"), ...Array(3).fill("2026-10-12"), ...Array(2).fill("2026-10-13"),
    "2026-10-15", // demain : jamais compté (une horloge décalée ne fabrique pas un geste futur)
    "2026-10-08", // la semaine dernière : hors barres
  ];

  it("fait / reste, barres par jour, aujourd'hui et le futur distingués", () => {
    const s = calculerSemaine({ semaine, aujourdhui: "2026-10-14", joursDesGestes: jours, reste: 26, semainePrecedente: 5, mois: 23 });
    expect(s.barres.map((b) => [b.label, b.n, b.etat])).toEqual([
      ["dim.", 4, "passe"], ["lun.", 3, "passe"], ["mar.", 2, "passe"], ["mer.", 0, "aujourdhui"], ["jeu.", 0, "futur"],
    ]);
    expect(s.fait).toBe(9);
    expect(s.pct).toBe(Math.round((9 / 35) * 100));
    expect(s.reconnaissance?.map((f) => f.t).join("")).toBe("9 gestes depuis dimanche, plus que toute la semaine dernière (5). Journée la plus remplie : dimanche (4).");
  });

  it("sans geste cette semaine, pas de reconnaissance inventée — le mois seulement s'il y en a", () => {
    expect(calculerSemaine({ semaine, aujourdhui: "2026-10-14", joursDesGestes: [], reste: 3, semainePrecedente: 0, mois: 0 }).reconnaissance).toBeNull();
    expect(calculerSemaine({ semaine, aujourdhui: "2026-10-14", joursDesGestes: [], reste: 3, semainePrecedente: 0, mois: 7 }).reconnaissance?.map((f) => f.t).join(""))
      .toBe("7 gestes depuis le début du mois.");
    expect(calculerSemaine({ semaine, aujourdhui: "2026-10-14", joursDesGestes: [], reste: 0, semainePrecedente: 0, mois: 0 }).pct).toBe(100);
  });

  it("un vendredi ou un samedi, « Ma semaine » est celle qui vient de finir", () => {
    expect(jourDeReferenceDeLaSemaine("2026-10-14")).toBe("2026-10-14");
    expect(jourDeReferenceDeLaSemaine("2026-10-16")).toBe("2026-10-15");
    expect(jourDeReferenceDeLaSemaine("2026-10-17")).toBe("2026-10-15");
  });
});

describe("la composition par métier", () => {
  const lots = regrouperFile(fileSuperAdmin(), NOW);

  it("les rôles réels, principal puis secondaire, sans doublon", () => {
    expect(rolesDe("FINANCE_BUDGET_MANAGER", "MEDICAL_INFO_PHARMACIST")).toEqual(["FINANCE_BUDGET_MANAGER", "MEDICAL_INFO_PHARMACIST"]);
    expect(rolesDe("VIEWER", "VIEWER")).toEqual(["VIEWER"]);
    expect(rolesDe("VIEWER", null)).toEqual(["VIEWER"]);
  });

  it("Finances : à régler, en retard, réglés cette semaine (lu sur paidDate), plus ancien", () => {
    const t = composerTuiles(["FINANCE_BUDGET_MANAGER"], lots, { reglesSemaine: { n: 3, montant: 180_000 } });
    expect(t.map((x) => x.cle)).toEqual(["paiements_montant", "paiements_retard", "regles_semaine", "plus_longue_attente"]);
    expect(t[1]).toMatchObject({ v: "5", ton: "late" });
    expect(t[2]).toMatchObject({ v: "3", c: `180${NBSP}000${NBSP}DZD` });
  });

  it("un chiffre sans donnée n'a pas de tuile : il est remplacé par une tuile commune réelle", () => {
    const sans = composerTuiles(["MEDICAL_DELEGATE"], [], {});
    expect(sans.map((x) => x.cle)).toEqual(["a_traiter", "en_retard", "plus_longue_attente"]);
    const avec = composerTuiles(["MEDICAL_DELEGATE"], [], { visites30: 38, visitesPlanifiees: 4, medecins: 52, crManquants: 2 });
    expect(avec.map((x) => [x.k, x.v])).toEqual([["Visites planifiées", "4"], ["Visites réalisées", "38"], ["Médecins au panel", "52"], ["Comptes rendus à écrire", "2"]]);
  });

  it("un compte à deux rôles voit l'union, sans doublon, la plus pressante d'abord", () => {
    const t = composerTuiles(["FINANCE_BUDGET_MANAGER", "MEDICAL_INFO_PHARMACIST"], lots, { reglesSemaine: { n: 0, montant: 0 }, declValidees30: 18 });
    expect(t).toHaveLength(4);
    expect(new Set(t.map((x) => x.cle)).size).toBe(4);
    expect(t[0].cle).toBe("paiements_retard");
    expect(t.filter((x) => x.cle === "plus_longue_attente").length).toBeLessThanOrEqual(1);
  });

  it("les raccourcis du métier passent la porte de leur module, sans doublon", () => {
    expect(composerRaccourcis(["MEDICAL_DELEGATE"], (m) => m === "MEDICAL").map((r) => r.label)).toEqual(["Ma journée", "Plan de tournée"]);
    const deux = composerRaccourcis(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], () => true);
    expect(new Set(deux.map((r) => r.href)).size).toBe(deux.length);
    expect(deux.length).toBeLessThanOrEqual(6);
    expect(composerRaccourcis(["VIEWER"], () => false)).toEqual([]);
  });
});

describe("Mon équipe — l'encart du N+1", () => {
  const m = (o: Partial<MembreLu> & Pick<MembreLu, "employeeId" | "nom">): MembreLu => ({
    poste: null, direct: true, aujourdhui: "PRESENT", ouvertes: 0, enRetard: 0, aDecider: 0, alerte: null, sansRapport: null, ...o,
  });

  it("les directs, le plus en retard d'abord ; la relance seulement quand une tâche relançable existe", () => {
    const e = composerEquipe([
      m({ employeeId: "a", nom: "Sarah Hamidi", ouvertes: 15, aujourdhui: "FORMATION" }),
      m({ employeeId: "b", nom: "Karim Benali", ouvertes: 17, enRetard: 5 }),
      m({ employeeId: "c", nom: "Nabil Ait Ali", direct: false, enRetard: 9 }),
    ], new Map([["b", "tache-1"]]));
    expect(e.directs).toBe(2);
    expect(e.retards).toBe(5);
    expect(e.personnesEnRetard).toBe(1);
    expect(e.membres.map((x) => x.nom)).toEqual(["Karim Benali", "Sarah Hamidi"]);
    expect(e.membres[0]).toMatchObject({ initiales: "KB", bloque: "5 tâches en retard", relanceTacheId: "tache-1", statut: null });
    expect(e.membres[1]).toMatchObject({ statut: "Formation", relanceTacheId: null, bloque: "15 tâches ouvertes, rien de bloquant" });
  });
});
