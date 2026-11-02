import { describe, expect, it } from "vitest";
import {
  actionsNonVerifiees, designerMission, diagnostiquerMission, erreurLisible, noteActionsNonVerifiees, outilsPilotageVoulus, SILENCE_EXECUTANT_MS,
} from "./pilotage";
import { niveauDeCarte } from "../capacites";

/**
 * P1 (décision 0047) — les règles pures du pilotage des missions, sur les phrases RÉELLES de la Direction (02/11).
 */
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const vivant = { dernierPassage: new Date(T0 - 30_000).toISOString(), workerVu: new Date(T0 - 30_000).toISOString() };
const absent = { dernierPassage: new Date(T0 - 12 * 60_000).toISOString(), workerVu: null };
const etapes = [{ titre: "Lire les dossiers", etat: "FILE", erreur: null }, { titre: "Synthèse", etat: "FILE", erreur: null }];
const mission = (etat: string, x: Partial<Parameters<typeof diagnostiquerMission>[0]> = {}) => ({ etat, attente: null, etapes, majLe: new Date(T0).toISOString(), ...x });

describe("P1 — le diagnostic honnête d'une mission (jamais « En cours · 0 % » sans fin)", () => {
  it("prête, mais AUCUN exécutant n'a battu depuis 12 min → « en attente du worker »", () => {
    const d = diagnostiquerMission(mission("EN_COURS"), absent, T0);
    expect(d.code).toBe("ATTENTE_EXECUTANT");
    expect(d.phrase).toContain("en attente du worker");
    expect(d.phrase).toContain("12 min");
  });
  it("jamais aucun passage → le dit (worker absent)", () => {
    expect(diagnostiquerMission(mission("EN_COURS"), { dernierPassage: null, workerVu: null }, T0).phrase).toContain("worker absent");
  });
  it("un exécutant bat → « prête : part au prochain battement », ou l'étape en cours", () => {
    expect(diagnostiquerMission(mission("EN_COURS"), vivant, T0).code).toBe("EN_COURS");
    expect(diagnostiquerMission(mission("EN_COURS", { etapes: [{ titre: "Synthèse", etat: "EN_COURS", erreur: null }] }), vivant, T0).phrase).toBe("en cours : Synthèse");
  });
  it("une étape qui RÉESSAIE dit son erreur — le crédit épuisé, en français", () => {
    const d = diagnostiquerMission(mission("EN_COURS", { etapes: [{ titre: "Synthèse", etat: "EN_COURS", erreur: "429 insufficient_quota: You exceeded your current quota" }] }), vivant, T0);
    expect(d.code).toBe("REESSAIE");
    expect(d.phrase).toContain("crédit du compte OpenAI épuisé");
  });
  it("à approuver, plafond, bloquée, arrêtée par une fusion : chacune dit ce qu'elle attend", () => {
    expect(diagnostiquerMission(mission("A_APPROUVER"), absent, T0).phrase).toContain("attend ton approbation");
    expect(diagnostiquerMission(mission("BUDGET_HOLD", { motifPause: "BUDGET_HOLD — plafond du jour atteint" }), vivant, T0).code).toBe("PLAFOND");
    expect(diagnostiquerMission(mission("BLOQUE", { etapes: [{ titre: "Synthèse", etat: "ECHEC", erreur: "aucune réponse" }] }), vivant, T0).phrase).toContain("« Synthèse » a échoué");
    expect(diagnostiquerMission(mission("ARRETE", { motifPause: "ARRETE — fusionnée dans « AMD — suivi unique »" }), vivant, T0).phrase).toContain("fusionnée dans « AMD — suivi unique »");
  });
  it("le seuil de silence est de 3 minutes (le battement passe chaque minute)", () => {
    expect(SILENCE_EXECUTANT_MS).toBe(180_000);
    expect(erreurLisible("Incorrect API key provided")).toContain("clé");
  });
});

describe("P1 — désigner une mission par son nom (jamais demander un titre qu'on peut lire)", () => {
  const ms = [
    { id: "m1", titre: "Classeur de suivi AMD" },
    { id: "m2", titre: "Planning Redouane / Nesrine" },
    { id: "m3", titre: "AMD Staoueli — suivi consolidé" },
  ];
  it("par identifiant, par mots du titre, et l'ambiguïté NOMME les candidates", () => {
    expect(designerMission(ms, "m2").vises.map((m) => m.id)).toEqual(["m2"]);
    expect(designerMission(ms, "le planning de Redouane").vises.map((m) => m.id)).toEqual(["m2"]);
    expect(designerMission(ms, "consolidé").vises.map((m) => m.id)).toEqual(["m3"]);
    const amb = designerMission(ms, "la mission AMD");
    expect(amb.ambigu).toBe(true);
    expect(amb.vises.map((m) => m.id).sort()).toEqual(["m1", "m3"]);
    expect(designerMission(ms, "recrutement").vises).toEqual([]);
  });
});

describe("P1 — la garde de vérité (une action affirmée sans l'outil qui la prouve est reprise)", () => {
  it("SCÉNARIO DE LA DIRECTION : « Je prends en compte la mission unique que tu as déjà fusionnée » sans rien lire → repris", () => {
    const msg = "Je prends en compte la mission unique que tu as déjà fusionnée et je prépare les mails.";
    expect(actionsNonVerifiees(msg, [])).toEqual(expect.arrayContaining(["fusion", "verification"]));
    expect(noteActionsNonVerifiees(msg, [])?.texte).toContain("Non vérifié");
    // Après avoir LU ses missions, la même phrase n'est plus une invention.
    expect(actionsNonVerifiees(msg, ["mes_missions"])).toEqual([]);
  });
  it("« j'ai fusionné les missions » : prouvé seulement par fusionner_missions (ou une lecture des missions)", () => {
    expect(actionsNonVerifiees("C'est bon, j'ai fusionné les deux missions.", ["lancer_un_travail"])).toEqual(["fusion"]);
    expect(actionsNonVerifiees("C'est bon, j'ai fusionné les deux missions.", ["fusionner_missions"])).toEqual([]);
  });
  it("« c'est envoyé » sur une CARTE affichée → repris (une carte n'est pas un envoi) ; « c'est enregistré » idem", () => {
    expect(actionsNonVerifiees("C'est envoyé à Redouane et Nesrine.", ["envoyer_mail"], true)).toEqual(["envoi"]);
    expect(actionsNonVerifiees("Le brouillon est enregistré.", ["microsoft-mail__saveDraft"], true)).toEqual(["enregistrement"]);
    expect(actionsNonVerifiees("La carte « Envoyer » attend ta confirmation.", ["envoyer_mail"], true)).toEqual([]);
  });
  it("« j'ai arrêté la mission » sans piloter_mission → repris ; une phrase neutre ne l'est jamais", () => {
    expect(actionsNonVerifiees("J'ai arrêté la mission Staoueli.", [])).toEqual(["mission"]);
    expect(actionsNonVerifiees("J'ai arrêté la mission Staoueli.", ["piloter_mission"])).toEqual([]);
    expect(actionsNonVerifiees("Voici tes trois missions et ce qui les bloque.", [])).toEqual([]);
  });
});

describe("P1 — présélection et ressaisie", () => {
  it("les mots de la Direction présélectionnent les outils de missions et de mails", () => {
    expect(outilsPilotageVoulus("Non, merge-les dans le même tableau")).toEqual(expect.arrayContaining(["fusionner_missions", "mes_missions"]));
    expect(outilsPilotageVoulus("Bah oui mais là je vois 3 missions")).toContain("mes_missions");
    expect(outilsPilotageVoulus("Tu as accès à ton Gmail ?")).toContain("mes_boites_mail");
    expect(outilsPilotageVoulus("prépare même des mails à envoyer aux 2")).toContain("envoyer_mail");
    expect(outilsPilotageVoulus("Quel est le budget du congrès ?")).toEqual([]);
  });
  it("DÉCISION DE LA DIRECTION : R3 réversible → le bouton suffit ; R4 et R3 sans annulation → ressaisie", () => {
    expect(niveauDeCarte("R3", "compensation")).toBe("SENSITIVE"); // envoi sous fenêtre d'annulation
    expect(niveauDeCarte("R3", "retour")).toBe("SENSITIVE"); // brouillon Microsoft
    expect(niveauDeCarte("R3", "aucune")).toBe("CRITICAL");
    expect(niveauDeCarte("R3")).toBe("CRITICAL");
    expect(niveauDeCarte("R4", "retour")).toBe("CRITICAL");
  });
});
