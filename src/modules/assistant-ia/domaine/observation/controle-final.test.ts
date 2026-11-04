import { describe, expect, it } from "vitest";
import { observer } from "./contrat";
import { projeterCarte, projeterLecture, projeterMission } from "./projecteurs";
import { aReprendre, controlerMessage, extraireAffirmations, noteDeReprise, rectifier, type GesteObserve, type PreuvesDuTour } from "./controle-final";

/**
 * I5 (décision 0069) — le contrôle final, PUR : les cas réels de la Direction (03–04/11) et les phrases honnêtes qui ne
 * doivent PAS être reprises (faux positifs).
 */
const geste = (outil: string, statut: string | null = null, echec = false): GesteObserve => ({ outil, libelle: outil, statut, echec });
const preuves = (p: Partial<PreuvesDuTour> = {}): PreuvesDuTour => ({ observations: [], gestes: [], sources: [], ...p });
const verdicts = (message: string, p: PreuvesDuTour) => controlerMessage(message, p).map((c) => `${c.affirmation.type}/${c.verdict}`);
const ecarts = (message: string, p: PreuvesDuTour) => aReprendre(controlerMessage(message, p)).map((c) => `${c.affirmation.type}/${c.verdict}`);

const mailCharte = projeterCarte({
  id: "int1", titre: "Envoyer par le Gmail d'Adam", statut: "PROPOSED",
  mails: [{ expediteur: "adam@adventum.dz", a: ["radia@adventum.dz"], objet: "Réunion décalée", texte: "Bonjour Radia, la réunion est décalée.", html: '<div style="background:#087084">Adventum</div><p>Bonjour</p>' }],
});
const mailBrut = projeterCarte({
  id: "int2", titre: "Envoyer par le Gmail d'Adam", statut: "PROPOSED",
  mails: [{ expediteur: "adam@adventum.dz", a: ["radia@adventum.dz"], objet: "Réunion décalée", texte: "Bonjour Radia, la réunion est décalée.", html: null }],
});
const ilYa2h = new Date(Date.now() - 2 * 3600_000).toISOString();
const missionImmobile = projeterMission({ id: "m1", titre: "Veille prix anti-infectieux", etat: "EN_COURS", etapes: { faites: 0, total: 2 }, majLe: ilYa2h, diagnostic: "aucune étape démarrée depuis 2 h ; le balayage est passé il y a 30 s sans la démarrer" });
const produitsLus = projeterLecture({ outil: "lire", libelle: "Produits lus", lignes: 3, ids: ["p1", "p2", "p3"] });

describe("I5 — le contrôle final : les cas réels", () => {
  it("mail « simple » : le message dit « texte brut » alors que la carte est à la charte → contredite", () => {
    const p = preuves({ observations: [mailCharte], gestes: [geste("envoyer_mail", "EN_ATTENTE_DE_CONFIRMATION")] });
    const c = aReprendre(controlerMessage("J'ai préparé le mail pour Radia. Il est en texte brut, sans aucune mise en forme.", p));
    expect(c.map((x) => `${x.affirmation.type}/${x.verdict}`)).toEqual(["rendu/contredite"]);
    expect(c[0]!.observe).toContain("à la charte");
    // Le même message sur une carte réellement en texte brut : confirmé.
    expect(aReprendre(controlerMessage("J'ai préparé le mail pour Radia. Il est en texte brut, sans aucune mise en forme.", preuves({ observations: [mailBrut] })))).toEqual([]);
  });

  it("mail : le tour suivant décrit la mise en forme d'après le bloc « Observé » de l'historique", () => {
    const historique = "[Observé par le serveur — état actuel, relu en base :\n- carte (id int1) — état : proposée ; titre : Envoyer par le Gmail d'Adam ; expéditeur : adam@adventum.dz ; rendu : HTML à la charte — bandeau #087084]";
    expect(ecarts("Le mail que je t'ai proposé est un mail simple, sans design.", preuves({ historique }))).toEqual(["rendu/contredite"]);
    expect(verdicts("Le mail que je t'ai proposé est un mail simple, sans design.", preuves())).toEqual(["rendu/non_observee", "prepare/non_observee"]);
  });

  it("« produits infectieux commercialisés » : « je ne peux pas confirmer » alors que la lecture a rendu des lignes → contredite", () => {
    const c = aReprendre(controlerMessage("Je ne peux pas confirmer lesquels sont commercialisés.", preuves({ observations: [produitsLus], gestes: [geste("lire")] })));
    expect(c.map((x) => x.verdict)).toEqual(["contredite"]);
    expect(c[0]!.observe).toContain("3 ligne(s)");
    // Aucune lecture tentée : non observée ; une lecture tentée sans résultat : confirmée.
    expect(verdicts("Je n'ai trouvé aucun produit commercialisé.", preuves())).toEqual(["introuvable/non_observee"]);
    expect(verdicts("Je n'ai trouvé aucun produit commercialisé.", preuves({ gestes: [geste("lire")] }))).toEqual(["introuvable/confirmee"]);
  });

  it("« où en est la mission » : prévision et « prête » contre une mission immobile depuis 2 h", () => {
    const p = preuves({ observations: [missionImmobile], gestes: [geste("mes_missions")] });
    expect(verdicts("La mission Veille prix va partir dans moins d'une minute.", p)).toEqual(["prevision/non_observee"]);
    expect(verdicts("Ta mission est prête.", p)).toEqual(["etat_mission/contredite"]);
    expect(aReprendre(controlerMessage("Ta mission est prête.", p))[0]!.observe).toContain("/missions/m1");
    // Sans lecture : l'état n'est pas observé.
    expect(verdicts("Ta mission est prête.", preuves())).toEqual(["etat_mission/non_observee"]);
    // Une prévision démentie n'est pas une prévision.
    expect(ecarts("Je ne peux pas garantir que la mission partira bientôt.", p)).toEqual([]);
  });

  it("masse salariale : un chiffre qu'aucune lecture ne rend → non observé ; rendu par la lecture → confirmé", () => {
    expect(verdicts("La masse salariale d'Adventum ce mois-ci est de 14 250 000 DZD.", preuves({ sources: ["Quelle est la masse salariale ?"] }))).toEqual(["chiffre/non_observee"]);
    expect(ecarts("La masse salariale d'Adventum ce mois-ci est de 14 250 000 DZD.", preuves({ sources: ['{"total":14250000}'] }))).toEqual([]);
  });

  it("une action affirmée sans outil : « c'est envoyé » → non observée ; sur une carte proposée → contredite", () => {
    expect(verdicts("C'est envoyé à Redouane.", preuves())).toEqual(["envoye/non_observee"]);
    expect(verdicts("C'est envoyé à Redouane.", preuves({ observations: [mailCharte] }))).toEqual(["envoye/contredite"]);
    expect(verdicts("J'ai créé la tâche pour Karim.", preuves({ observations: [projeterCarte({ id: "t1", titre: "Créer la tâche", statut: "PROPOSED" })] }))).toEqual(["accompli/contredite"]);
    expect(ecarts("J'ai arrêté la mission Staoueli.", preuves({ gestes: [geste("piloter_mission", "FAIT")], observations: [] }))).toEqual([]);
    expect(ecarts("C'est fait.", preuves({ observations: [observer("effet", { type: "mail_adam", id: "e1", lien: null }, "PROGRAMME", {})] }))).toEqual([]);
  });

  it("fichier : un nom que rien du tour ne produit → non observé", () => {
    expect(verdicts("Le fichier salaries.xlsx contient 12 lignes.", preuves())).toEqual(["fichier/non_observee"]);
    expect(ecarts("Le fichier salaries.xlsx contient 12 lignes.", preuves({ sources: ['{"nom":"salaries.xlsx"}'] }))).toEqual([]);
  });
});

describe("I5 — « je n'ai pas trouvé » : la lecture vide relue, l'action, l'accès", () => {
  it("une lecture vide RELUE sans ses filtres porte des lignes → contredite, le filtre nommé", () => {
    const relue = observer("lecture", { type: "lecture", id: "relue-1", lien: null }, "LU", { titre: "RegulatoryProduct", lignes: 0, elargir: ["sans « status = COMMERCIALISE » → 2 ligne(s)"] });
    const c = aReprendre(controlerMessage("Je n'ai trouvé aucun produit commercialisé.", preuves({ observations: [relue], gestes: [geste("lire")] })));
    expect(c.map((x) => x.verdict)).toEqual(["contredite"]);
    expect(c[0]!.observe).toContain("status = COMMERCIALISE");
  });

  it("rejeu réel S5 : « je ne peux pas confirmer que le mail est parti » est honnête, même après une recherche qui a rendu une ligne", () => {
    const p = preuves({ observations: [projeterLecture({ outil: "action_history", libelle: "Recherche effectuée", lignes: 1 })], gestes: [geste("action_history")] });
    expect(ecarts("Amine, je ne peux pas confirmer que le mail à Karim est parti : je n'ai trouvé aucune preuve d'envoi.", p)).toEqual([]);
  });

  it("« je n'ai pas accès » après un refus du tour : honnête", () => {
    expect(ecarts("Je n'ai pas accès à la paie.", preuves({ observations: [produitsLus], gestes: [geste("lire_paie", "REFUS", true)] }))).toEqual([]);
  });
});

describe("I5 — ce qui n'est PAS repris (faux positifs)", () => {
  it("les phrases honnêtes, conditionnelles ou interrogatives passent", () => {
    const p = preuves({ observations: [mailCharte] });
    for (const m of [
      "La carte « Envoyer » attend ta confirmation : rien n'est parti.",
      "Il partira dès que tu confirmes.",
      "Veux-tu que je l'envoie ?",
      "Le mail n'est pas encore envoyé.",
      "Voici le texte : « J'ai envoyé le rapport hier. »",
      "Rédige un post de 3 lignes.",
      "Le délégué est parti en tournée.",
      "Tu as 3 missions en cours.",
    ]) expect([m, aReprendre(controlerMessage(m, p))]).toEqual([m, []]);
  });

  it("les liens et identifiants ne sont pas des chiffres cités", () => {
    expect(extraireAffirmations("Ouvre-la : [Veille](/missions/cm3k9z123abcdefghijklmno).").filter((a) => a.type === "chiffre")).toEqual([]);
  });
});

describe("I5 — reprise et rectification", () => {
  it("la note de reprise énonce l'écart comme un fait ; la rectification remplace la phrase, marquée", () => {
    const c = aReprendre(controlerMessage("Voilà. C'est envoyé à Redouane. Bonne journée.", preuves({ observations: [mailCharte] })));
    expect(noteDeReprise(c)).toContain("Tu as écrit « C'est envoyé à Redouane. » ; l'observation dit : la carte « Envoyer par le Gmail d'Adam » est PROPOSÉE");
    const r = rectifier("Voilà. C'est envoyé à Redouane. Bonne journée.", c);
    expect(r).toContain("⚠️ _Rectifié par le contrôle : la carte « Envoyer par le Gmail d'Adam » est PROPOSÉE");
    expect(r).not.toContain("C'est envoyé");
    expect(r.startsWith("Voilà.")).toBe(true);
  });
});
