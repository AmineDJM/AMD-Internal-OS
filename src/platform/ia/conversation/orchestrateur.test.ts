import { describe, expect, it } from "vitest";
import {
  affichageEcrit, ATTENTE_BLOQUANTE, decider, estQuestion, etatInitial, transition, vieillir,
  type Action, type ElementAgenda, type EtatConversation, type Evenement,
} from "./orchestrateur";

/**
 * L'ORCHESTRATEUR DE CONVERSATION (lot O1, décision 0046) — la machine à états, en pur. Tous les croisements que la
 * Direction a décrits : un résultat qui tombe pendant une question, pendant que la personne parle, pendant que la voix
 * parle, juste après la réponse ; une réponse qui change le format ; un agenda vide ; deux travaux.
 *
 * MESURE tenue à chaque scénario : 0 annonce qui coupe une question en attente, 0 « j'attends » bloquant.
 */

const format: ElementAgenda = { id: "a1", travail: "t1", nature: "precision", texte: "Tu préfères un rendu Excel ou PDF ?", choix: ["Excel", "PDF"] };
const periode: ElementAgenda = { id: "a2", travail: "t1", nature: "precision", texte: "Sur quelle période ?" };
const envoi: ElementAgenda = { id: "a3", travail: "t1", nature: "suite", texte: "Quand ce sera prêt, je l'envoie à quelqu'un ?" };

/** Un banc : rejoue des événements, décide après chacun, « dit » ce qui est décidé ; garde la mesure. */
function banc(silenceMs = 900) {
  let e: EtatConversation = etatInitial();
  const dits: Extract<Action, { type: "dire" }>[] = [];
  const coupures: string[] = [];
  const pas = (ev: Evenement) => { e = transition(e, ev); };
  const tic = (ms: number) => {
    e = vieillir(e, ms);
    const a = decider(e, ms, { silenceMs });
    if (a.type === "dire") {
      // LA MESURE : une annonce dite alors qu'une question attend sa réponse — interdit.
      if (a.annonce && e.question && !a.accuse) coupures.push(a.contenu);
      dits.push(a);
      e = transition(e, { type: "dit", ms, action: a });
    }
    return a;
  };
  return { get e() { return e; }, pas, tic, dits, coupures };
}

const lancer = (ms: number, agenda: ElementAgenda[] = [format, periode, envoi]): Evenement => ({
  type: "reponse_prise_en_compte", ms, accuse: "Je regarde, je te préviens dès que c'est prêt.", delegationId: "d1", lance: { id: "t1", agenda, avancement: "Deux étapes faites sur quatre, environ une minute." },
});

describe("orchestrateur — les états de dialogue", () => {
  it("une question se reconnaît à sa fin ; « j'attends » est repéré", () => {
    expect(estQuestion("Tu préfères un rendu Excel ou PDF ?")).toBe(true);
    expect(estQuestion("Tu confirmes ? »")).toBe(true);
    expect(estQuestion("C'est noté.")).toBe(false);
    expect(ATTENTE_BLOQUANTE.test("Ok, j'attends que l'autre ait fini.")).toBe(true);
    expect(ATTENTE_BLOQUANTE.test("Je te préviendrai quand l'autre aura fini.")).toBe(true);
    expect(ATTENTE_BLOQUANTE.test("Je reste disponible pendant que ça avance.")).toBe(false);
  });

  it("lancement : l'accusé, collé à la PREMIÈRE précision de l'agenda — une seule question", () => {
    const b = banc();
    b.pas({ type: "personne_parle", ms: 0 });
    b.pas({ type: "reponse_envoyee", ms: 1000 });
    expect(b.tic(1100)).toEqual({ type: "rien", raison: "réponse de la personne en route" });
    b.pas(lancer(1500));
    const a = b.tic(1500);
    expect(a).toMatchObject({ type: "dire", accuse: true, element: { id: "a1" } });
    expect(a.type === "dire" && a.contenu).toMatch(/Je regarde.*Excel ou PDF \?/);
    expect(b.e.question).toMatchObject({ element: "a1", travail: "t1" });
    // La question attend : rien d'autre ne se dit, même libre.
    expect(b.tic(5000)).toEqual({ type: "rien", raison: "question en attente" });
  });

  it("RÉSULTAT PENDANT LA QUESTION : tenu, puis dit COLLÉ à l'accusé de la réponse (« Noté, PDF. Et justement… »)", () => {
    const b = banc();
    b.pas(lancer(0)); b.tic(0);
    b.pas({ type: "assistant_parle", ms: 100 });
    b.pas({ type: "replique_assistant", ms: 2000, texte: "Je regarde. Tu préfères un rendu Excel ou PDF ?" });
    // Le résultat tombe pendant que la question attend.
    b.pas({ type: "resultat", ms: 2500, travail: "t1", contenu: "Le chiffre d'affaires d'octobre : 46 millions." });
    expect(b.tic(3000)).toEqual({ type: "rien", raison: "question en attente" });
    expect(affichageEcrit(b.e)).toEqual({ tenus: ["t1"], question: "a1" });
    // Elle répond — sans changer le travail (le format s'applique au rendu déjà prêt).
    b.pas({ type: "personne_parle", ms: 4000 });
    b.pas({ type: "reponse_envoyee", ms: 4800 });
    expect(b.tic(4900).type).toBe("rien");
    b.pas({ type: "reponse_prise_en_compte", ms: 5200, accuse: "Noté, PDF.", delegationId: "d2", repondA: "a1" });
    const a = b.tic(5200);
    expect(a.type === "dire" && a.contenu).toBe("Noté, PDF. Et justement, le résultat vient d'arriver : Le chiffre d'affaires d'octobre : 46 millions.");
    expect(b.e.annonces).toEqual([]);
    expect(b.coupures).toEqual([]);
  });

  it("RÉSULTAT PENDANT QUE LA PERSONNE PARLE ou que la voix parle : tenu jusqu'au silence", () => {
    const b = banc();
    b.pas(lancer(0, [])); b.tic(0);
    b.pas({ type: "assistant_parle", ms: 10_000 });
    b.pas({ type: "resultat", ms: 10_200, travail: "t1", contenu: "Prêt." });
    expect(b.tic(10_300)).toEqual({ type: "rien", raison: "l'assistant parle" });
    b.pas({ type: "personne_parle", ms: 10_500 });
    expect(b.tic(10_800)).toEqual({ type: "rien", raison: "la personne parle" });
    // Elle s'arrête sans rien demander (un « hmm ») : au silence, l'annonce passe — seule.
    const a = b.tic(11_500);
    expect(a).toMatchObject({ type: "dire", accuse: false, annonce: { travail: "t1" } });
    expect(b.tic(11_600)).toEqual({ type: "rien", raison: "prise de parole en vol" });
  });

  it("RÉPONSE QUI CHANGE LE FORMAT : le résultat tenu est CADUC ; le travail ajusté est dit, lui", () => {
    const b = banc();
    b.pas(lancer(0)); b.tic(0);
    b.pas({ type: "resultat", ms: 3000, travail: "t1", contenu: "Le tableau en Excel." });
    b.pas({ type: "reponse_envoyee", ms: 4000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 4500, accuse: "Noté, PDF : j'adapte le rendu.", delegationId: "d2", repondA: "a1", change: { travail: "t1", nouveau: "t2" } });
    const a = b.tic(4500);
    // Pas l'ancien résultat : la question suivante de l'agenda (la période), collée à l'accusé.
    expect(a).toMatchObject({ type: "dire", accuse: true, annonce: null, element: { id: "a2" } });
    expect(b.e.travaux[0]).toMatchObject({ id: "t2", etat: "ajuste" });
    b.pas({ type: "reponse_envoyee", ms: 8000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 8200, accuse: "D'accord, octobre.", delegationId: "d3", repondA: "a2" });
    b.tic(8200);
    b.pas({ type: "assistant_parle", ms: 8300 });
    b.pas({ type: "resultat", ms: 9000, travail: "t2", contenu: "Le rapport en PDF, octobre." });
    b.pas({ type: "replique_assistant", ms: 9100, texte: "Quand ce sera prêt, je l'envoie à quelqu'un ?" });
    expect(b.tic(12_000)).toEqual({ type: "rien", raison: "question en attente" });
    b.pas({ type: "reponse_envoyee", ms: 13_000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 13_200, accuse: "Entendu, à Amel.", delegationId: "d4" });
    const fin = b.tic(13_200);
    expect(fin.type === "dire" && fin.contenu).toContain("Le rapport en PDF, octobre.");
    expect(b.dits.some((d) => d.contenu.includes("Excel."))).toBe(false);
    expect(b.coupures).toEqual([]);
  });

  it("AGENDA VIDE : l'avancement réel UNE fois, puis la voix ne meuble pas ; jamais « j'attends »", () => {
    const b = banc();
    b.pas(lancer(0, []));
    const a = b.tic(0);
    // L'accusé + l'avancement (agenda vide).
    expect(a.type === "dire" && a.contenu).toMatch(/Je regarde.*Deux étapes faites sur quatre/);
    b.pas({ type: "assistant_parle", ms: 200 });
    expect(b.tic(3000)).toEqual({ type: "rien", raison: "disponible" });
    expect(b.tic(60_000)).toEqual({ type: "rien", raison: "disponible" });
    // Une demande sans rapport : l'accusé, puis « je reste disponible » (pas « j'attends »).
    b.pas({ type: "reponse_envoyee", ms: 61_000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 61_500, accuse: "Il est 15 h.", delegationId: "d5" });
    const d = b.tic(61_500);
    expect(d.type === "dire" && d.contenu).toMatch(/Il est 15 h\. Puis dis en une phrase que tu restes disponible/);
    for (const x of b.dits) expect(ATTENTE_BLOQUANTE.test(x.contenu)).toBe(false);
  });

  it("une question sans réponse expire : l'annonce passe, l'agenda se tait jusqu'à ce que la personne reparle", () => {
    const b = banc();
    b.pas(lancer(0)); b.tic(0);
    b.pas({ type: "resultat", ms: 5000, travail: "t1", contenu: "Prêt." });
    expect(b.tic(19_000)).toEqual({ type: "rien", raison: "question en attente" });
    const a = b.tic(20_001);
    expect(a).toMatchObject({ type: "dire", annonce: { travail: "t1" } });
    expect(b.e.agendaSuspendu).toBe(true);
    // Plus de question dans le vide.
    expect(b.tic(40_000)).toEqual({ type: "rien", raison: "disponible" });
  });

  it("un accusé qui POSE une question (« tu confirmes ? ») : rien ne s'y colle, l'annonce attend la réponse", () => {
    const b = banc();
    b.pas(lancer(0, [])); b.tic(0);
    b.pas({ type: "resultat", ms: 1000, travail: "t1", contenu: "Prêt." });
    b.pas({ type: "reponse_envoyee", ms: 1500 });
    b.pas({ type: "reponse_prise_en_compte", ms: 2000, accuse: "Je relis : 150 000 DZD. Tu confirmes ?", delegationId: "d6", questionPosee: true });
    const a = b.tic(2000);
    expect(a).toMatchObject({ type: "dire", annonce: null, element: null, contenu: "Je relis : 150 000 DZD. Tu confirmes ?" });
    expect(b.e.question).not.toBeNull();
    expect(b.tic(5000)).toEqual({ type: "rien", raison: "question en attente" });
    b.pas({ type: "reponse_envoyee", ms: 6000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 6200, accuse: "C'est fait.", delegationId: "d7" });
    expect(b.tic(6200)).toMatchObject({ contenu: expect.stringMatching(/^C'est fait\. Et justement/) });
    expect(b.coupures).toEqual([]);
  });

  it("DEUX TRAVAUX : chacun son agenda ; annonces dans l'ordre d'arrivée, une par prise de parole", () => {
    const b = banc();
    b.pas(lancer(0, [])); b.tic(0);
    b.pas({ type: "assistant_parle", ms: 100 });
    b.pas({ type: "reponse_envoyee", ms: 2000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 2200, accuse: "Je lance aussi le stock.", delegationId: "d8", lance: { id: "t9", agenda: [{ id: "b1", travail: "t9", nature: "precision", texte: "Tous les dépôts ou seulement Alger ?" }] } });
    expect(b.tic(2200)).toMatchObject({ element: { id: "b1" } });
    b.pas({ type: "resultat", ms: 3000, travail: "t1", contenu: "Ventes prêtes." });
    b.pas({ type: "resultat", ms: 3100, travail: "t9", contenu: "Stock prêt." });
    b.pas({ type: "reponse_envoyee", ms: 4000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 4200, accuse: "Alger seulement, noté.", delegationId: "d9", repondA: "b1" });
    const a = b.tic(4200);
    expect(a.type === "dire" && a.contenu).toContain("Ventes prêtes.");
    expect(a.type === "dire" && a.contenu).not.toContain("Stock prêt.");
    b.pas({ type: "assistant_parle", ms: 4300 });
    expect(b.tic(4600)).toEqual({ type: "rien", raison: "l'assistant parle" });
    const s = b.tic(5300);
    expect(s.type === "dire" && s.contenu).toContain("Stock prêt.");
    expect(b.coupures).toEqual([]);
  });

  it("un résultat partiel se partage, même quand l'agenda est suspendu ; un doublon de résultat n'est pas redit", () => {
    const b = banc();
    b.pas(lancer(0, [])); b.tic(0);
    b.pas({ type: "assistant_parle", ms: 100 });
    b.pas({ type: "agenda", travail: "t1", elements: [{ id: "p1", travail: "t1", nature: "partiel", texte: "la sous-mission « Concurrents » est finie : 3 laboratoires repérés." }] });
    const a = b.tic(2000);
    expect(a).toMatchObject({ element: { id: "p1" } });
    expect(b.e.question).toBeNull();
    b.pas({ type: "agenda", travail: "t1", elements: [{ id: "p1", travail: "t1", nature: "partiel", texte: "redit" }] });
    expect(b.e.travaux[0].agenda).toEqual([]);
    b.pas({ type: "resultat", ms: 9000, travail: "t1", contenu: "Prêt." });
    b.tic(9000 + 6000);
    b.pas({ type: "resultat", ms: 16_000, travail: "t1", contenu: "Prêt." });
    expect(b.e.annonces).toEqual([]);
  });

  it("le résultat d'un travail FINI efface ses précisions restantes (jamais une question dont la réponse ne servira pas)", () => {
    const b = banc();
    b.pas(lancer(0)); b.tic(0);
    b.pas({ type: "resultat", ms: 1000, travail: "t1", contenu: "Prêt." });
    b.pas({ type: "reponse_envoyee", ms: 2000 });
    b.pas({ type: "reponse_prise_en_compte", ms: 2100, accuse: "Noté, PDF.", delegationId: "d2", repondA: "a1" });
    expect(b.tic(2100)).toMatchObject({ annonce: { travail: "t1" } });
    expect(b.e.travaux[0].agenda.map((x) => x.id)).toEqual(["a3"]);
  });
});
