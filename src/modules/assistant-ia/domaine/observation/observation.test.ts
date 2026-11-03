import { describe, expect, it } from "vitest";
import { blocObserve, dureeLisible, empreinteDe, lireObservations, observer, texteDObservation, texteObservable } from "./contrat";
import { lectureDeSortie, natureDuRendu, projeterCarte, projeterFichier, projeterMission, recitDeProjection } from "./projecteurs";

const T = new Date("2026-11-03T12:00:00Z");

describe("I1 — le contrat Observation", () => {
  it("borne la projection, retire tout HTML et calcule une empreinte stable", () => {
    const o = observer("carte", { type: "intention", id: "c1", lien: null }, "proposee", { titre: "<b>Envoyer</b><script>x()</script>", vide: "", rien: null }, T);
    expect(o.etat).toBe("PROPOSEE");
    expect(o.projection).toEqual({ titre: "Envoyer" });
    expect(o.empreinte).toBe(observer("carte", { type: "intention", id: "c1", lien: null }, "PROPOSEE", { titre: "Envoyer" }, T).empreinte);
    expect(empreinteDe("a")).not.toBe(empreinteDe("b"));
    expect(texteObservable("x".repeat(400))).toHaveLength(300);
  });

  it("relit une observation stockée et écarte ce qui n'a pas la forme du contrat", () => {
    const o = observer("mission", { type: "mission", id: "m1", lien: "/missions/m1" }, "EN_COURS", { titre: "Veille" }, T);
    const relues = lireObservations([JSON.parse(JSON.stringify(o)), { nature: "inconnue" }, null, "x"]);
    expect(relues).toHaveLength(1);
    expect(relues[0]!.empreinte).toBe(o.empreinte);
  });

  it("le bloc « Observé » est borné : le texte d'un mail cède quand il déborde", () => {
    const carte = projeterCarte({ id: "c1", titre: "Envoyer", statut: "PROPOSED", mails: [{ expediteur: "adam@x.dz", a: ["Radia <r@x.dz>"], objet: "Réunion", texte: "Bonjour ".repeat(150), html: null }] }, T);
    const plein = blocObserve([carte], 5_000)!;
    expect(plein).toContain("texte tel qu'il partira");
    const court = blocObserve([carte], 400)!;
    expect(court.length).toBeLessThanOrEqual(400);
    expect(court).not.toContain("texte tel qu'il partira");
    expect(blocObserve([])).toBeNull();
  });

  it("dit une durée comme un fait daté", () => {
    expect(dureeLisible(45_000)).toBe("45 s");
    expect(dureeLisible(12 * 60_000)).toBe("12 min");
    expect(dureeLisible(125 * 60_000)).toBe("2 h 05");
    expect(dureeLisible(3 * 86_400_000)).toBe("3 j");
  });
});

describe("I1 — les projecteurs", () => {
  const charte = `<html><head><style>p{}</style></head><body><table role="presentation"><tr><td style="background:#087084;padding:18px"><span>Adventum</span></td></tr>
<tr><td><p style="color:#1F2933">Bonjour,</p><table><tr><th style="background:#087084;color:#FFFFFF">Jour</th></tr><tr><td>Lundi</td></tr></table></td></tr></table></body></html>`;

  it("la nature du rendu est lue sur le HTML réel (bandeau, tableaux, couleurs) ou son absence", () => {
    const r = natureDuRendu(charte, "Bonjour,");
    expect(r.bandeau).toBe(true);
    expect(r.tableaux).toBe(1);
    expect(r.couleurs).toEqual(["#087084"]);
    expect(r.rendu).toMatch(/^HTML à la charte — bandeau #087084, 1 tableau/);
    expect(natureDuRendu(null, "Bonjour").rendu).toBe("texte brut (aucune mise en page)");
    expect(natureDuRendu('<p style="color:#1F2933">Bonjour</p>', "Bonjour").rendu).toBe("HTML sobre (sans couleur de charte)");
    expect(natureDuRendu('<p>Bonjour</p><table><tr><th style="background:#087084">J</th></tr></table>', "x").rendu).toMatch(/^HTML mixte \(charte en partie\)/);
  });

  it("la carte d'un mail projette expéditeur, destinataires, objet, rendu, texte — jamais le HTML", () => {
    const o = projeterCarte({ id: "c9", titre: "Envoyer par le Gmail d'Adam", statut: "PROPOSED", avertissements: ["Fenêtre d'annulation"], mails: [{ expediteur: "adam@adventum.dz (Gmail d'Adam)", a: ["Radia <r@x.dz>"], objet: "Réunion décalée", texte: "Bonjour Radia,\n\nLa réunion est à 15 h.", html: charte }] }, T);
    expect(o.nature).toBe("carte");
    expect(o.etat).toBe("PROPOSEE");
    expect(o.projection.expediteur).toBe("adam@adventum.dz (Gmail d'Adam)");
    expect(o.projection.rendu).toMatch(/à la charte/);
    expect(JSON.stringify(o)).not.toMatch(/<table|<td/);
    expect(texteDObservation(o)).toMatch(/proposée — attend la confirmation/);
    expect(recitDeProjection(o)).toBe("Envoyer par le Gmail d'Adam : à Radia <r@x.dz>, objet « Réunion décalée », HTML à la charte.");
  });

  it("une carte d'opération projette ses champs dits (sans identifiant technique) ; la voix lit la même projection", () => {
    const o = projeterCarte({ id: "c2", titre: "Rendez-vous", statut: "EXECUTED", champs: [{ label: "Avec", value: "Dr Benali" }, { label: "Réf", value: "ckabcdefghijklmnopqrstuvwx" }, { label: "Note", value: "—" }] }, T);
    expect(o.etat).toBe("EXECUTEE");
    expect(o.projection.champs).toEqual(["Avec : Dr Benali"]);
    expect(recitDeProjection(o)).toBe("Rendez-vous : avec Dr Benali.");
  });

  it("la mission porte son lien et son âge LU", () => {
    const o = projeterMission({ id: "m1", titre: "Veille prix", etat: "EN_COURS", libelle: "En cours", etapes: { faites: 0, total: 2 }, majLe: new Date(T.getTime() - 2 * 3_600_000).toISOString(), diagnostic: "aucune étape démarrée" }, T);
    expect(o.objet.lien).toBe("/missions/m1");
    expect(o.projection.derniereActivite).toBe("il y a 2 h");
  });

  it("le fichier et la lecture tabulaire", () => {
    expect(projeterFichier({ id: "f1", nom: "salaries.xlsx", existe: true, lignes: 14, colonnes: ["Nom", "Poste"] }, T).objet.lien).toBe("/api/drive/f1/raw");
    expect(projeterFichier({ id: "f2", nom: "x.pdf", existe: false }, T).etat).toBe("INTROUVABLE");
    const l = lectureDeSortie("mes_missions", "Missions lues", JSON.stringify({ missions: [{ id: "m1", titre: "A" }, { id: "m2", titre: "B" }], total: 2 }))!;
    expect(l.projection).toMatchObject({ lignes: 2, colonnes: ["id", "titre"], ids: ["m1", "m2"] });
    expect(lectureDeSortie("x", "x", "pas du json")).toBeNull();
    expect(lectureDeSortie("x", "x", JSON.stringify({ statut: "FAIT" }))).toBeNull();
  });
});
