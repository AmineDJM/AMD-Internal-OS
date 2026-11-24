import { describe, expect, it } from "vitest";
import { regrouperFile, type ElementFile } from "./aujourdhui";
import { grouperAFaire, libelleDeplier } from "./a-faire";

/**
 * « À FAIRE » EN TROIS GROUPES (maquette validée par le Super Admin, 24/11/2026) — « En retard », « Aujourd'hui »,
 * « Plus tard » : la règle pure qui RANGE les lots de la file, sans rien lire de plus que ce qu'ils portent.
 * Le cas de référence reprend les nombres de la maquette : « À faire · 26 », 6 en retard, 8 aujourd'hui, 12 plus tard.
 */
const NOW = new Date("2026-11-24T10:00:00.000Z");
const jours = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const NBSP = " ";

const el = (o: Partial<ElementFile> & Pick<ElementFile, "key" | "objet" | "title">): ElementFile => ({
  subtitle: "", module: "", href: "/", kind: "request", deadline: null, depuis: null, owner: "", statusLabel: null, ...o,
});

/** 12 ordres (5 en retard), une validation, une demande en retard, 12 déclarations : la file de la maquette. */
function fileMaquette(): ElementFile[] {
  const paiements = Array.from({ length: 12 }, (_, i) => el({
    key: `pay-od${i}`, objet: `EXPENSE_ORDER:od${i}`, title: `Bénéficiaire ${i}`, subtitle: `OD-2026-0${10 + i}`,
    module: "Espace comptable", kind: "payment", montant: 80_000, deadline: i < 5 ? jours(-28) : null, depuis: jours(-35),
  }));
  const declarations = Array.from({ length: 12 }, (_, i) => el({
    key: `mi-${i}`, objet: `MEDICAL_INFO_DECLARATION:d${i}`, title: `Déclaration ${i}`, subtitle: `DIM-2026-0${10 + i}`,
    module: "Information médicale", kind: "validation", statut: "AWAITING_REVIEW", depuis: jours(-10 - i),
  }));
  return [
    ...paiements,
    el({ key: "val-1", objet: "VALIDATION_REQUEST:v1", title: "Validation — BV 25 %", module: "Validations", href: "/validations?focus=s1#val-s1", kind: "validation", depuis: jours(-3) }),
    el({ key: "req-27", objet: "ADMIN_REQUEST:r27", title: "Puce téléphonique", subtitle: "REQ-2026-027", module: "Demandes administratives", href: "/demandes/r27", deadline: jours(-69), depuis: jours(-76) }),
    ...declarations,
  ];
}

describe("« À faire » — trois groupes, le nombre dit une seule fois", () => {
  const a = grouperAFaire(regrouperFile(fileMaquette(), NOW));
  const [retard, aujourdhui, plusTard] = a.groupes;

  it("26 objets : 6 en retard, 8 aujourd'hui, 12 plus tard — des objets, jamais des lots", () => {
    expect(a.total).toBe(26);
    expect(a.groupes.map((g) => [g.libelle, g.n])).toEqual([["En retard", 6], ["Aujourd'hui", 8], ["Plus tard", 12]]);
  });

  it("un lot qui tombe dans deux groupes se coupe : 5 paiements en retard, 7 aujourd'hui (une décision attendue de vous)", () => {
    const enRetard = retard.lignes.find((l) => l.titre.startsWith("5 paiements"))!;
    // Sous « En retard », le titre ne le redit pas ; le sous-titre dit de combien.
    expect(enRetard.titre).toBe(`5 paiements à régler — 400${NBSP}000${NBSP}DZD`);
    expect(enRetard.sousTitre).toBe("Ordres de dépense autorisés · jusqu'à 28 j de retard");
    expect(enRetard.geste.libelle).toBe("Régler");
    expect(enRetard.geste.href).toMatch(/^\/finances\/paiements-a-faire\?focus=(od[0-4],){4}od[0-4]#ord-od/);
    expect(enRetard.sousLignes).toHaveLength(5);
    expect(aujourdhui.lignes.find((l) => l.titre.startsWith("7 paiements"))?.n).toBe(7);
  });

  it("une ligne seule prend son intitulé ; son sous-titre dit sa référence et son délai", () => {
    expect(retard.lignes.find((l) => l.titre === "Puce téléphonique")?.sousTitre).toBe("REQ-2026-027 · Assignées à vous · 69 j de retard");
    const v = aujourdhui.lignes.find((l) => l.titre === "Validation — BV 25 %")!;
    expect(v.geste).toEqual({ libelle: "Valider", href: "/validations?focus=s1#val-s1" });
  });

  it("seule la première ligne a le bouton plein — la plus en retard (jours cumulés) ; « Plus tard » est replié", () => {
    const pleins = a.groupes.flatMap((g) => g.lignes).filter((l) => l.enAvant);
    expect(pleins).toEqual([retard.lignes[0]]);
    expect(retard.lignes.map((l) => l.titre)).toEqual([`5 paiements à régler — 400${NBSP}000${NBSP}DZD`, "Puce téléphonique"]);
    expect(plusTard.replie).toBe(true);
    expect(aujourdhui.replie).toBe(false);
    expect(libelleDeplier(plusTard.n)).toBe("Afficher les 12 autres");
  });
});

describe("congés, corrections et lignes de suivi", () => {
  const conge = (id: string, nom: string, debut: number, depuis: number): ElementFile => el({
    key: `conge-${id}`, objet: `LEAVE_REQUEST:${id}`, title: `Congé — ${nom}`, subtitle: "3 j · Chez le N+1", owner: nom,
    module: "Ressources humaines", href: "/mon-espace#conges-a-signer", kind: "validation", deadline: jours(debut), depuis: jours(depuis),
  });

  it("chaque congé est une ligne « Valider le congé de X » qui ouvre son panneau ; la suite ouvre tous les congés", () => {
    const a = grouperAFaire(regrouperFile([
      conge("c1", "Samir Haddad", -1, -4),
      conge("c2", "Lina Mansouri", 10, -1),
      el({ key: "conge-reste", objet: "LEAVE_REQUEST:reste:", title: "3 autre(s) congé(s) attendent votre signature", module: "Ressources humaines", href: "/mon-espace#conges-a-signer", kind: "validation" }),
    ], NOW));
    const samir = a.groupes[0].lignes[0];
    expect(samir).toMatchObject({ titre: "Valider le congé de Samir Haddad", sousTitre: "3 j · Chez le N+1 · 1 j de retard", panneau: { type: "conge", id: "c1" } });
    expect(samir.geste.libelle).toBe("Ouvrir");
    // Un congé est une décision : sans échéance proche, il reste « plus tard » seulement s'il a une date lointaine.
    expect(a.groupes[2].lignes.map((l) => l.titre)).toEqual(["Valider le congé de Lina Mansouri"]);
    const reste = a.groupes[1].lignes.find((l) => l.panneau?.type === "conges")!;
    expect(reste).toMatchObject({ titre: "3 autre(s) congé(s) attendent votre signature", n: 0 });
    expect(a.total).toBe(2);
  });

  it("une demande à corriger est une ligne à elle, rangée aujourd'hui, et son motif se lit sous le titre", () => {
    const a = grouperAFaire(regrouperFile([
      el({ key: "corriger-TOUR_PLAN-p1", objet: "TOUR_PLAN:p1", title: "À corriger — Plan de tournée du 1er décembre", subtitle: "En révision : Dr Achour en congé — à resoumettre.", statusLabel: "À corriger", depuis: jours(-1) }),
      el({ key: "corriger-SPONSORING-s1", objet: "SPONSORING:s1", title: "À corriger — Sponsoring ASARI", subtitle: "Direction Marketing : devis manquant", statusLabel: "À corriger", module: "Ad & Pro" }),
    ], NOW));
    const lignes = a.groupes[1].lignes;
    expect(lignes.map((l) => l.titre).sort()).toEqual(["À corriger — Plan de tournée du 1er décembre", "À corriger — Sponsoring ASARI"]);
    expect(lignes.find((l) => l.titre.includes("Plan"))?.sousTitre).toContain("En révision : Dr Achour en congé — à resoumettre.");
  });

  it("les pièces que j'attends des autres : une ligne de suivi « Plus tard », jamais comptée ; seule, elle n'est pas repliée", () => {
    const a = grouperAFaire([], { piecesEnAttente: 2 });
    expect(a.total).toBe(0);
    expect(a.groupes[2]).toMatchObject({ n: 0, replie: false });
    expect(a.groupes[2].lignes[0]).toMatchObject({ titre: "Vous attendez 2 pièces d'autres personnes", geste: { libelle: "Voir", href: "/pieces" }, enAvant: true });
    expect(grouperAFaire([]).groupes.every((g) => g.lignes.length === 0)).toBe(true);
  });

  it("échéance demain ou priorité haute : aujourd'hui ; une tâche sans échéance : plus tard", () => {
    const a = grouperAFaire(regrouperFile([
      el({ key: "t1", objet: "TASK:t1", title: "Demain", kind: "task", deadline: jours(1) }),
      el({ key: "t2", objet: "TASK:t2", title: "Prioritaire", kind: "task", priority: "HIGH" }),
      el({ key: "t3", objet: "TASK:t3", title: "Un jour", kind: "task" }),
    ], NOW));
    expect(a.groupes.map((g) => g.n)).toEqual([0, 2, 1]);
    expect(libelleDeplier(1)).toBe("Afficher l'autre");
  });
});
