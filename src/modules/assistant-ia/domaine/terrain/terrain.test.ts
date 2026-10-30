import { describe, expect, it } from "vitest";
import { indiceVocabulaire, langueDictee, lireCompteRendu } from "./compte-rendu";
import { resoudreMedecin, resoudreProduits, scoreNom } from "./resolution";
import {
  aEnvoyer, apresEnvoi, delaiApresEchec, nouvelElement, phraseFile, reprendreApresRedemarrage, viderFile,
  type ElementFile, type IssueEnvoi, type StockageFile,
} from "./file-hors-ligne";
import { DIT_A_L_ECRAN, mediane, pourLaVoix } from "./voix";
import { lireLecturePhoto, nettoyerFaits } from "./photo";

describe("compte rendu dicté — relecture de la réponse du modèle", () => {
  it("lit un JSON entouré de texte, borne et ferme les natures", () => {
    const r = lireCompteRendu("Voici :\n```json\n" + JSON.stringify({
      medecin: "Dr Benali", etablissement: "CHU Oran", specialite: null, produits: ["Cardiovex", "Cardiovex", ""],
      interet: "très intéressé", objections: "null", revoirDemain: true, synthese: "Le Dr Benali est intéressé par Cardiovex.",
      demandes: [{ nature: "ECHANTILLONS", produit: "Cardiovex", quantite: "10", detail: "dix boîtes" }, { nature: "PIZZA", quantite: -3 }],
      aConfirmer: ["service non précisé"],
    }) + "\n```");
    expect(r).not.toBeNull();
    expect(r!.produits).toEqual(["Cardiovex"]);
    expect(r!.objections).toBeNull();
    expect(r!.demandes).toEqual([
      { nature: "ECHANTILLONS", produit: "Cardiovex", quantite: 10, detail: "dix boîtes" },
      { nature: "AUTRE", produit: null, quantite: null, detail: "Autre demande" },
    ]);
    expect(r!.revoirDemain).toBe(true);
  });

  it("refuse une réponse sans synthèse ou hors forme (la carte le dira, rien n'est inventé)", () => {
    expect(lireCompteRendu("je ne sais pas")).toBeNull();
    expect(lireCompteRendu(JSON.stringify({ medecin: "X" }))).toBeNull();
    expect(lireCompteRendu("{ cassé")).toBeNull();
  });

  it("dit la langue sur l'écriture : français, arabe, mélange", () => {
    expect(langueDictee("Je sors de chez le docteur Benali")).toBe("fr");
    expect(langueDictee("زرت الدكتورة مريم حداد في مستشفى مصطفى باشا")).toBe("ar");
    expect(langueDictee("راني خرجت من عند الدكتور بن علي، هو intéressé بزاف بالـ gamme Cardiovex")).toBe("mixte");
    expect(langueDictee("", "arabic")).toBe("ar");
  });

  it("l'indice de vocabulaire est borné et dédoublonné, produits d'abord", () => {
    const i = indiceVocabulaire(["Dr Benali", "dr benali"], ["Cardiovex"], ["CHU Oran"], 40);
    expect(i).toBe("Cardiovex, Dr Benali, CHU Oran");
    expect(indiceVocabulaire(Array.from({ length: 200 }, (_, k) => `Dr Nom${k}`), [], []).length).toBeLessThanOrEqual(800);
  });
});

describe("résolution dans l'annuaire du délégué", () => {
  const annuaire = [
    { id: "a", nom: "BEN ALI Karim", etablissement: "CHU Oran" },
    { id: "b", nom: "BENALLAL Sofiane", etablissement: "EHU Oran" },
    { id: "c", nom: "HADDAD Meriem", etablissement: "CHU Mustapha Pacha" },
    { id: "d", nom: "OULD ALI Yacine", etablissement: "EHU Oran" },
    { id: "e", nom: "HADDAD Rachid", etablissement: "Clinique El Azhar" },
  ];

  it("« Benali » retrouve BEN ALI (mots collés), pas BENALLAL", () => {
    const r = resoudreMedecin("Dr Benali", "CHU Oran", annuaire);
    expect(r.statut).toBe("RESOLU");
    if (r.statut === "RESOLU") expect(r.medecin.id).toBe("a");
  });

  it("un nom porté par deux médecins reste AMBIGU — sauf si l'établissement départage", () => {
    expect(resoudreMedecin("Haddad", null, annuaire).statut).toBe("AMBIGU");
    const r = resoudreMedecin("Dr Haddad", "CHU Mustapha", annuaire);
    expect(r.statut === "RESOLU" ? r.medecin.id : r.statut).toBe("c");
  });

  it("un nom de famille composé, et l'inconnu dit comme tel", () => {
    const r = resoudreMedecin("Pr Ould Ali", null, annuaire);
    expect(r.statut === "RESOLU" ? r.medecin.id : r.statut).toBe("d");
    expect(resoudreMedecin("Dr Zerrouki", null, annuaire).statut).toBe("INCONNU");
    expect(resoudreMedecin(null, null, annuaire).statut).toBe("INCONNU");
    expect(scoreNom("Benali", "BEN ALI Karim")).toBeGreaterThan(0.85);
  });

  it("les produits dits sont retrouvés au catalogue, sinon nommés sans identifiant", () => {
    const r = resoudreProduits(["Cardiovex", "cardio vex", "Inconnu"], [{ id: "p1", nom: "CARDIOVEX 5 mg" }, { id: "p2", nom: "GLUCORINE" }]);
    expect(r.map((x) => x.produit?.id ?? null)).toEqual(["p1", "p1", null]);
  });
});

describe("file hors ligne — aucune perte", () => {
  function memoire(): StockageFile & { m: Map<string, ElementFile>; retires: string[] } {
    const m = new Map<string, ElementFile>();
    const retires: string[] = [];
    return {
      m, retires,
      lister: async () => [...m.values()],
      ecrire: async (e) => { m.set(e.id, e); },
      retirer: async (id) => { m.delete(id); retires.push(id); },
    };
  }

  it("hors ligne rien ne part ; au retour, tout part dans l'ordre, et ne sort que sur accusé", async () => {
    const s = memoire();
    for (let i = 0; i < 3; i += 1) await s.ecrire(nouvelElement(`v${i}`, "vocal", `vocal ${i}`, 1_000 + i));
    let enLigne = false;
    const vus: string[] = [];
    const envoyer = async (e: ElementFile): Promise<IssueEnvoi> => { vus.push(e.id); return { ok: true, accuse: `cap-${e.id}` }; };
    expect(await viderFile(s, envoyer, () => 5_000, () => enLigne)).toEqual({ envoyes: 0, echecs: 0 });
    expect(phraseFile([...s.m.values()], false)).toContain("partira au retour du réseau");
    enLigne = true;
    expect(await viderFile(s, envoyer, () => 5_000, () => enLigne)).toEqual({ envoyes: 3, echecs: 0 });
    expect(vus).toEqual(["v0", "v1", "v2"]);
    expect(s.m.size).toBe(0);
  });

  it("réseau intermittent sur 50 éléments : chacun finit accusé une fois, aucun perdu, aucun doublon côté serveur", async () => {
    const s = memoire();
    for (let i = 0; i < 50; i += 1) await s.ecrire(nouvelElement(`e${i}`, i % 2 ? "photo" : "vocal", `n°${i}`, i));
    const serveur = new Map<string, number>();
    let graine = 7;
    const hasard = () => { graine = (graine * 1103515245 + 12345) % 2 ** 31; return graine / 2 ** 31; };
    let horloge = 0;
    const envoyer = async (e: ElementFile): Promise<IssueEnvoi> => {
      // Le serveur reçoit parfois l'élément mais la réponse se perd : il l'a, le client ne le sait pas.
      const recu = hasard() < 0.6;
      if (recu) serveur.set(e.id, (serveur.get(e.id) ?? 0) + 1);
      if (!recu || hasard() < 0.3) throw new Error("réseau coupé");
      return { ok: true, accuse: `cap-${e.id}` };
    };
    for (let passage = 0; passage < 200 && s.m.size; passage += 1) {
      horloge += 400_000;
      await viderFile(s, envoyer, () => horloge, () => true);
    }
    expect(s.m.size).toBe(0);
    expect(new Set(s.retires).size).toBe(50);
    // Le serveur a pu recevoir deux fois la même clé : c'est la clé d'idempotence qui l'absorbe (banc serveur).
    expect([...serveur.keys()].length).toBe(50);
  });

  it("un envoi coupé par un redémarrage repart ; un refus définitif reste, en erreur", async () => {
    const coupe = { ...nouvelElement("x", "vocal", "x", 0), etat: "ENVOI" as const };
    expect(reprendreApresRedemarrage([coupe])[0].etat).toBe("EN_ATTENTE");
    const refuse = apresEnvoi(coupe, { ok: false, erreur: "Fichier illisible.", definitif: true }, 10);
    expect(refuse.etat).toBe("REFUSE");
    expect(aEnvoyer([refuse], 1e12, true)).toEqual([]);
    expect(phraseFile([refuse], true)).toContain("refusé");
    const retarde = apresEnvoi(coupe, { ok: false, erreur: "503", definitif: false }, 10);
    expect(retarde.prochainEssai).toBe(10 + delaiApresEchec(1));
    expect(aEnvoyer([retarde], 11, true)).toEqual([]);
    expect(delaiApresEchec(20)).toBe(300_000);
  });
});

describe("voix temps réel — règles", () => {
  it("aucun repère ne part à la voix : la valeur est « affichée à l'écran »", () => {
    expect(pourLaVoix('{"salaire":"⟦S3⟧","iban":"⟦S12⟧"}')).toBe(`{"salaire":"${DIT_A_L_ECRAN}","iban":"${DIT_A_L_ECRAN}"}`);
    expect(pourLaVoix("x".repeat(7000)).length).toBeLessThan(6_100);
  });
  it("médiane des latences", () => {
    expect(mediane([1200, 900, 3000])).toBe(1200);
    expect(mediane([1000, 2000])).toBe(1500);
    expect(mediane([])).toBeNull();
  });
});

describe("photos de terrain", () => {
  it("une ordonnance ne livre jamais le patient", () => {
    const faits = nettoyerFaits("ORDONNANCE", [
      { cle: "Nom du patient", valeur: "Ali X" }, { cle: "Prescription", valeur: "Cardiovex 5 mg, 1/j, 30 jours" },
      { cle: "Note", valeur: "patiente de 54 ans" }, { cle: "Prescripteur", valeur: "Cardiologue" },
    ]);
    expect(faits.map((f) => f.cle)).toEqual(["Prescription", "Prescripteur"]);
  });
  it("la sorte annoncée « ordonnance » garde ses règles même si la vision lit autre chose", () => {
    const l = lireLecturePhoto({ sorte: "FACTURE", resume: "r", faits: [{ cle: "Patient", valeur: "Y" }] }, "ORDONNANCE");
    expect(l?.sorte).toBe("ORDONNANCE");
    expect(l?.faits).toEqual([]);
    expect(lireLecturePhoto("x", null)).toBeNull();
  });
});

describe("erreurs du fournisseur, dites à un délégué", () => {
  it("jamais le corps HTTP brut", async () => {
    const { phraseErreurFournisseur } = await import("./compte-rendu");
    const p = phraseErreurFournisseur('Erreur de transcription (HTTP 401) : { "error": { "message": "Incorrect API key provided: sk-xx" } }', "transcription");
    expect(p).toBe("La transcription est indisponible (accès au fournisseur refusé) : le vocal est gardé ; écrivez le compte rendu ou réessayez plus tard.");
    expect(phraseErreurFournisseur("timeout", "lecture")).toBe("La lecture de la photo a échoué : la photo est gardée au Drive.");
  });
});
