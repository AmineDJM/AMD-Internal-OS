import { describe, expect, it } from "vitest";
import { classerLimite, complementDeLimite, gardeAbsence, gardeImpossibilite, paraitImpossibilite, RAPPEL_DECOUVERTE, RAPPEL_ELARGISSEMENT, prometUnSuivi, gardePromesse, avertirPromesseSansObjet, OUTILS_DURABLES, absenceDiteVerifiee, avertirAbsenceNonProuvable } from "./limites";

/**
 * LES LIMITES DITES JUSTE — la découverte avant l'impossible (une fois), l'acceptation après, et
 * la nature d'une limite classée par le code : permission, ressource, donnée, capacité.
 */
const OUTILS = ["search_products", "run_analysis", "run_code", "launch_mission", "executive_alerts"];

describe("paraître impossible", () => {
  it("reconnaît les refus de capacité, ignore les limites déjà nommées et les réponses ordinaires", () => {
    expect(paraitImpossibilite("Je ne peux pas calculer la médiane des montants : je n'ai pas d'outil pour cela.")).toBe(true);
    expect(paraitImpossibilite("Ce n'est pas prévu dans mes fonctions.")).toBe(true);
    expect(paraitImpossibilite("Hors de mon périmètre, désolé.")).toBe(true);
    expect(paraitImpossibilite("Ce module ne vous est pas ouvert : je ne peux pas consulter cette information.")).toBe(false);
    expect(paraitImpossibilite("Python est indisponible sur ce serveur ; je ne peux pas exécuter ce script, mais je peux le réécrire en JavaScript.")).toBe(false);
    expect(paraitImpossibilite("Aucun enregistrement ne porte cette référence.")).toBe(false);
    expect(paraitImpossibilite("La médiane des 14 bons de commande de 2026 est 1 250 000 DZD.")).toBe(false);
  });
});

describe("la garde d'impossibilité", () => {
  const base = { question: "Calcule la médiane des montants des BC de 2026.", outilsDisponibles: OUTILS };
  it("« impossible » sans aucun outil appelé → REDÉCOUVRIR, une fois ; après la carte, le refus est ACCEPTÉ", () => {
    const reponse = "Je ne peux pas calculer cela, je n'ai pas d'outil de calcul.";
    expect(gardeImpossibilite({ ...base, reponse, outilsUtilises: [], dejaRedecouvert: false })).toBe("REDECOUVRIR");
    expect(gardeImpossibilite({ ...base, reponse, outilsUtilises: [], dejaRedecouvert: true })).toBe("ACCEPTER");
  });
  it("un outil a tourné, ou aucune capacité n'est ouverte, ou la limite est nommée → RAS", () => {
    const reponse = "Je ne peux pas calculer cela.";
    expect(gardeImpossibilite({ ...base, reponse, outilsUtilises: ["run_analysis"], dejaRedecouvert: false })).toBe("RAS");
    expect(gardeImpossibilite({ ...base, reponse, outilsUtilises: [], outilsDisponibles: [], dejaRedecouvert: false })).toBe("RAS");
    expect(gardeImpossibilite({ ...base, reponse: "Ce module ne vous est pas ouvert.", outilsUtilises: [], dejaRedecouvert: false })).toBe("RAS");
    expect(gardeImpossibilite({ ...base, reponse: "La médiane est 1 250 000 DZD.", outilsUtilises: [], dejaRedecouvert: false })).toBe("RAS");
  });
  it("le rappel exige un nouvel essai avec la carte, puis la NATURE de la limite — jamais « pas prévu »", () => {
    expect(RAPPEL_DECOUVERTE).toMatch(/carte complète/);
    expect(RAPPEL_DECOUVERTE).toMatch(/run_analysis|run_code/);
    expect(RAPPEL_DECOUVERTE).toMatch(/jamais « ce n'est pas prévu »/);
  });
});

describe("classer une limite", () => {
  it("permission, ressource, donnée, capacité — et la précision", () => {
    expect(classerLimite("Le module FINANCES ne vous est pas ouvert.")).toMatchObject({ nature: "PERMISSION", precise: true });
    expect(classerLimite("Python est indisponible sur ce serveur (python3 absent).")).toMatchObject({ nature: "RESSOURCE", precise: true });
    expect(classerLimite("Aucune réunion ne porte ce titre parmi les vôtres.")).toMatchObject({ nature: "DONNEE", precise: true });
    expect(classerLimite("Ce n'est pas prévu dans mes fonctions.")).toMatchObject({ nature: "CAPACITE", precise: false });
    expect(classerLimite("Aucun outil ne permet de piloter la climatisation du bâtiment : c'est une capacité qui n'existe pas dans l'ERP.")).toMatchObject({ nature: "CAPACITE", precise: true });
    expect(classerLimite("Voici le tableau demandé.")).toBeNull();
  });
  it("le complément du serveur ne s'ajoute qu'à un refus de capacité imprécis", () => {
    expect(complementDeLimite("Ce n'est pas prévu dans mes fonctions.", 42)).toMatch(/42 capacités ouvertes/);
    expect(complementDeLimite("Le module FINANCES ne vous est pas ouvert.", 42)).toBeNull();
    expect(complementDeLimite("Voici le tableau demandé.", 42)).toBeNull();
  });
});

/**
 * NOT_FOUND ≠ VERIFIED_ABSENT. Le cas fondateur : une question sur ce qui existe autour d'une
 * personne, UNE recherche, zéro résultat, et « je n'ai rien trouvé » remis comme une réponse.
 * La donnée était là, sous un autre libellé.
 *
 * Le deuxième test est celui qui compte autant : une CONCLUSION tirée de données bien lues
 * (« aucun dossier n'est en retard ») n'est pas une absence de résultat. Faire réélargir là
 * ferait payer un tour de plus pour rien, à chaque bilan.
 */
describe("une absence ne s'affirme qu'après élargissement", () => {
  it("« je n'ai rien trouvé » après une seule façon de chercher rouvre la recherche", () => {
    expect(gardeAbsence({ reponse: "Je n'ai rien trouvé concernant Radia sur les réseaux sociaux.", outilsUtilises: ["find_documents"], dejaElargi: false })).toBe("ELARGIR");
    expect(gardeAbsence({ reponse: "Aucun contrat ne correspond à ce nom.", outilsUtilises: ["search_legal"], dejaElargi: false })).toBe("ELARGIR");
    expect(gardeAbsence({ reponse: "Ce document est introuvable.", outilsUtilises: ["find_documents", "read_document"], dejaElargi: false })).toBe("ELARGIR");
  });

  it("une CONCLUSION n'est pas une absence de résultat — et n'est jamais rouverte", () => {
    for (const r of [
      "Aucun dossier n'est en retard : les 69 sont dans les délais.",
      "Aucune anomalie sur le budget du T3.",
      "Aucun paiement ne dépasse l'enveloppe validée.",
      "Voici les quatre contrats qui arrivent à échéance.",
    ]) {
      expect(gardeAbsence({ reponse: r, outilsUtilises: ["read_budget"], dejaElargi: false }), r).toBe("RAS");
    }
  });

  it("elle se tait quand la recherche a déjà été élargie, ou quand aucun outil n'a tourné", () => {
    const abs = "Je n'ai rien trouvé.";
    expect(gardeAbsence({ reponse: abs, outilsUtilises: ["a", "b", "c"], dejaElargi: false })).toBe("RAS");
    expect(gardeAbsence({ reponse: abs, outilsUtilises: ["a"], dejaElargi: true })).toBe("RAS");
    // Zéro outil appartient à `gardeImpossibilite` : deux gardes sur le même cas se contrediraient.
    expect(gardeAbsence({ reponse: abs, outilsUtilises: [], dejaElargi: false })).toBe("RAS");
  });

  it("l'échelle rendue au modèle nomme des MANIÈRES de chercher, pas des outils", () => {
    for (const barreau of [/EXACT/, /APPROCHÉ/, /ALIAS/, /PAR LA PERSONNE/, /PAR L'HISTOIRE/, /ENTITÉS LIÉES/, /AUTRES GRENIERS/]) {
      expect(RAPPEL_ELARGISSEMENT).toMatch(barreau);
    }
    expect(RAPPEL_ELARGISSEMENT).toMatch(/Une absence se prouve, elle ne se constate pas/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PROMESSE SANS OBJET DURABLE — la troisième garde, et ce qui la fait SE TAIRE.
 *
 * Mesuré : « Je t'avais dit de me rappeler hier quand t'as des réponses mais tu l'as pas
 * fait. » — « Tu as raison : aucun rappel ni suivi conditionnel n'était planifié. » Adam avait
 * dit oui, rien n'avait été créé, et rien n'avait signalé le vide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("une promesse ne vit pas dans une phrase", () => {
  const durable = ["gmail_search", "plan_reminder"];
  const lecture = ["gmail_search", "inspect_record"];

  it("« je te préviens dès qu'ils répondent » sans rien de durable est refusé", () => {
    const r = "Je te préviens dès qu'ils répondent.";
    expect(prometUnSuivi(r)).toBe(true);
    expect(gardePromesse({ reponse: r, outilsUtilises: lecture, dejaRappele: false })).toBe("SANS_OBJET");
  });

  it("la même phrase AVEC un rappel posé ne dit rien — l'objet existe", () => {
    expect(gardePromesse({ reponse: "Je te préviens dès qu'ils répondent.", outilsUtilises: durable, dejaRappele: false })).toBe("RAS");
  });

  /**
   * CE QUI FERAIT TOMBER CES TROIS-LÀ : élargir les motifs jusqu'à attraper le passé, le tour
   * lui-même ou la promesse de quelqu'un d'autre. Un refus à tort coûte un aller-retour et de
   * la confiance (§118.27) — et une garde qui crie tout le temps finit désactivée.
   */
  it("se tait sur le PASSÉ — « je t'ai prévenu » n'engage rien", () => {
    expect(prometUnSuivi("Je t'ai prévenu hier soir, tu as reçu la notification.")).toBe(false);
  });

  it("se tait sur ce qui est livré DANS le tour", () => {
    expect(prometUnSuivi("Je te le montre ci-dessous : trois dossiers en retard.")).toBe(false);
  });

  it("se tait sur la promesse de QUELQU'UN D'AUTRE", () => {
    expect(prometUnSuivi("Radia dit qu'elle reviendra vers toi avec l'heure.")).toBe(false);
  });

  it("une seule relance : au second passage la garde laisse passer", () => {
    expect(gardePromesse({ reponse: "Je te rappellerai vendredi.", outilsUtilises: lecture, dejaRappele: true })).toBe("RAS");
  });

  it("si la promesse survit au rappel, le serveur AJOUTE la phrase qui manque", () => {
    const p = avertirPromesseSansObjet("Je te tiens au courant.", lecture);
    expect(p).toMatch(/Rien n'a été programmé/);
    expect(p).toMatch(/ne survivra pas à cette conversation/);
    // Et il se tait dès qu'un objet durable porte la promesse.
    expect(avertirPromesseSansObjet("Je te tiens au courant.", durable)).toBeNull();
  });

  it("les outils durables sont ceux qui SURVIVENT au tour — la liste est fermée", () => {
    expect(OUTILS_DURABLES).toContain("plan_reminder");
    expect(OUTILS_DURABLES).toContain("watch_entity");
    expect(OUTILS_DURABLES).toContain("run_mission");
    expect(OUTILS_DURABLES, "une lecture n'est pas un suivi").not.toContain("gmail_search");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « FAIT VÉRIFIÉ : aucun X » — la plus forte étiquette sur ce qu'on n'a PAS vu.
 *
 * Mesuré : « FAIT VÉRIFIÉ : aucun rappel ni suivi conditionnel n'était planifié. » Cette
 * phrase-là était juste — la table des rappels fait foi sur son propre contenu — mais RIEN dans
 * le code ne le savait au moment de l'écrire. La même phrase après une recherche dans l'index
 * de contenu du Drive aurait porté la même étiquette, et elle aurait été fausse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("une absence n'est « vérifiée » que si une source peut la démontrer", () => {
  const affirmation = "FAIT VÉRIFIÉ : aucun rappel n'était planifié.";

  it("sans source capable de démontrer une absence, l'étiquette est nuancée", () => {
    const n = avertirAbsenceNonProuvable({ reponse: affirmation, faitsProuvantUneAbsence: 0 });
    expect(n).toMatch(/ne permet de DÉMONTRER une absence/);
    expect(n, "la reformulation juste doit être donnée, pas seulement le reproche")
      .toMatch(/rien trouvé dans ce que j'ai pu consulter/);
  });

  it("AVEC une source qui fait foi sur l'absence, on se tait — « vérifié » est le mot juste", () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : nuancer tout le temps. Affaiblir une réponse correcte
     * apprend à ignorer la nuance, et la garde suivante ne sera plus lue (§118.32).
     */
    expect(avertirAbsenceNonProuvable({ reponse: affirmation, faitsProuvantUneAbsence: 2 })).toBeNull();
  });

  it("une absence dite SANS étiquette forte ne déclenche rien — c'est déjà honnête", () => {
    expect(absenceDiteVerifiee("Je n'ai rien trouvé sur ce contrat.")).toBe(false);
    expect(avertirAbsenceNonProuvable({ reponse: "Je n'ai rien trouvé sur ce contrat.", faitsProuvantUneAbsence: 0 })).toBeNull();
  });

  it("une étiquette forte SANS absence ne déclenche rien — un fait positif se vérifie très bien", () => {
    expect(absenceDiteVerifiee("FAIT VÉRIFIÉ : le montant est de 142 800 DZD.")).toBe(false);
  });

  it("la garde est branchée au PASSAGE COMMUN des deux boucles, pas sur un return (§118.49)", async () => {
    const fs = await import("node:fs");
    // `assistant.ts` découpé (lot V4) : ses deux boucles vivent dans `boucle/tour.ts` et `boucle/flux.ts`.
    const src = ["src/lib/assistant/boucle/tour.ts", "src/lib/assistant/boucle/flux.ts"].map((f) => fs.readFileSync(f, "utf8")).join("\n");
    // Deux chemins de réponse, deux `avecProvenance` : la garde doit être dans les DEUX.
    expect(src.split("avertirAbsenceNonProuvable({").length - 1, "un des deux chemins ne l'appelle pas").toBe(2);
    expect(src).toMatch(/f\.preuveNegative === true/);
  });
});
