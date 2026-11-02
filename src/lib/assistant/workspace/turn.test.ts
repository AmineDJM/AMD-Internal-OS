import { describe, expect, it } from "vitest";
import { composeTurn, elaguerFil, phasesOf, isWorkspaceTurn, VISIBLE_BEFORE_FOLD, type TurnProposal } from "./turn";
import type { WorkspaceBlock, WorkspaceComposition } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TOUR COMME ESPACE DE TRAVAIL — les quatre défauts, transformés en tests.
 *
 * Le chantier UI précédent a été jugé raté pour quatre raisons précises. Chacune devient ici une
 * assertion, parce qu'un reproche formulé en prose se re-commet, alors qu'un test qui casse se
 * remarque :
 *
 *   1. la prose passait avant l'objet ;
 *   2. le bouton de confirmation vivait loin de la chose qu'il confirme ;
 *   3. l'ordre suivait les appels d'outils au lieu des décisions ;
 *   4. les pastilles affichaient des noms d'outils.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const emailBlock = (statut: "brouillon" | "envoye" = "brouillon"): WorkspaceBlock => ({
  kind: "email",
  title: "Message prêt",
  a: ["amine@adventum.dz"],
  objet: "Situation Regulatory",
  corps: "Voici le point demandé.",
  piecesJointes: ["Regulatory_27-08-2026.xlsx"],
  statut,
});

const dossierBlock = (alerte = true): WorkspaceBlock => ({
  kind: "dossier",
  title: "Nivolumab",
  fields: [{ label: "Statut", value: "En attente ANPP" }],
  ...(alerte ? { alerte: { label: "Complément demandé depuis 2 jours", ton: "alerte" as const } } : {}),
});

const tableBlock: WorkspaceBlock = {
  kind: "table",
  title: "Dossiers en cours",
  columns: [{ key: "ref", label: "Référence" }],
  rows: [{ cells: { ref: "REG-2026-041" } }],
};

const peopleBlock: WorkspaceBlock = {
  kind: "people",
  title: "Amine Djouamai",
  people: [{ nom: "Amine Djouamai", coordonnees: [] }],
};

const comp = (source: string, blocks: WorkspaceBlock[]): WorkspaceComposition => ({ source, blocks });

const proposal = (over: Partial<TurnProposal> = {}): TurnProposal => ({
  kind: "send_email",
  title: "Envoyer un message à Amine Djouamai",
  state: "pending",
  ...over,
});

describe("défaut 1 — l'objet passe avant la prose", () => {
  it("le bloc de tête existe même quand Adam a écrit un paragraphe", () => {
    const t = composeTurn({
      compositions: [comp("send_email", [emailBlock()])],
      reply: "J'ai préparé le message pour Amine.",
    });
    // Le rangement expose l'objet ET la synthèse séparément : c'est l'UI qui les place, et elle
    // ne peut plus mettre la prose en premier sans le faire exprès.
    expect(t.lead?.block.kind).toBe("email");
    expect(t.synthesis).toBe("J'ai préparé le message pour Amine.");
  });

  it("un tour purement verbal n'est PAS encadré comme un espace de travail", () => {
    // « Il est 15 h » est une réponse. L'encadrer donnerait à une phrase l'apparence d'un objet
    // métier, et ferait chercher un bouton là où il n'y en a pas.
    const t = composeTurn({ reply: "Il est 15 h." });
    expect(isWorkspaceTurn(t)).toBe(false);
    expect(t.lead).toBeNull();
  });
});

describe("défaut 2 — le geste vit SOUS son objet", () => {
  it("« envoyer » se rattache à l'aperçu du message", () => {
    const t = composeTurn({
      compositions: [comp("directory_lookup", [peopleBlock]), comp("send_email", [emailBlock()])],
      proposals: [proposal()],
    });
    expect(t.lead?.block.kind).toBe("email");
    // Le geste appartient au bloc email — pas à la fiche de contact, pas à « la fin de la page ».
    expect(t.lead?.proposals).toEqual([0]);
  });

  it("« décider un paiement » se rattache à la file de décisions", () => {
    const queue: WorkspaceBlock = {
      kind: "queue", title: "En attente de votre décision", total: 1,
      items: [{ titre: "Devis Biopharm", detail: "18,4 M DZD" }],
    };
    const t = composeTurn({
      compositions: [comp("list_pending_decisions", [queue])],
      proposals: [proposal({ kind: "decide_payment", title: "Valider le devis Biopharm" })],
    });
    expect(t.lead?.block.kind).toBe("queue");
    expect(t.lead?.proposals).toEqual([0]);
  });

  it("un geste qu'on ne sait pas rattacher retombe sur le bloc de TÊTE, jamais dans le vide", () => {
    const t = composeTurn({
      compositions: [comp("read", [tableBlock])],
      proposals: [proposal({ kind: "update_platform_setting", title: "Changer un réglage obscur" })],
    });
    // Un bouton mal placé reste utilisable ; un bouton invisible ne l'est pas.
    expect(t.lead?.proposals).toEqual([0]);
  });

  it("chaque geste ne se rattache qu'à UN objet", () => {
    const t = composeTurn({
      compositions: [comp("a", [emailBlock()]), comp("b", [dossierBlock()])],
      proposals: [proposal(), proposal({ kind: "create_task", title: "Relancer le responsable" })],
    });
    const all = [t.lead, ...t.rest].flatMap((s) => s?.proposals ?? []);
    expect(all.sort()).toEqual([0, 1]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("défaut 3 — l'ordre suit la DÉCISION, pas les appels d'outils", () => {
  it("un brouillon prêt à partir passe devant un tableau de contexte, même arrivé après", () => {
    const t = composeTurn({
      compositions: [comp("read_table", [tableBlock]), comp("send_email", [emailBlock()])],
      proposals: [proposal()],
    });
    expect(t.lead?.block.kind).toBe("email");
    expect(t.rest[0].block.kind).toBe("table");
  });

  it("un dossier BLOQUÉ passe devant un dossier sain", () => {
    const t = composeTurn({
      compositions: [comp("a", [{ ...dossierBlock(false), title: "Sain" }]), comp("b", [dossierBlock(true)])],
    });
    // Ce qui empêche d'avancer se lit en premier : c'est la question que le PDG se pose.
    expect((t.lead?.block as { title: string }).title).toBe("Nivolumab");
  });

  it("une file de DÉCISIONS passe devant un dossier bloqué", () => {
    // « Qu'est-ce que j'ai raté ? » : un dossier bloqué dit « quelque chose est coincé » ; une
    // file de décisions dit « c'est VOUS qui bloquez ». La seconde répond mieux à la question.
    // Corrigé après avoir REGARDÉ le rendu : le dossier bloqué prenait la tête.
    const queue: WorkspaceBlock = {
      kind: "queue", title: "En attente de votre décision", total: 1,
      items: [{ titre: "Devis Biopharm", detail: "18,4 M DZD" }],
    };
    const t = composeTurn({ compositions: [comp("a", [dossierBlock(true)]), comp("b", [queue])] });
    expect(t.lead?.block.kind).toBe("queue");
    // Mais l'alerte garde son effet là où il compte : devant un dossier SAIN.
    const t2 = composeTurn({
      compositions: [comp("a", [{ ...dossierBlock(false), title: "Sain" }]), comp("b", [dossierBlock(true)])],
    });
    expect((t2.lead?.block as { title: string }).title).toBe("Nivolumab");
  });

  it("un message DÉJÀ ENVOYÉ redescend — il n'appelle plus de décision", () => {
    const t = composeTurn({
      compositions: [comp("send_email", [emailBlock("envoye")]), comp("read", [tableBlock])],
    });
    expect(t.lead?.block.kind).toBe("table");
  });

  it("à poids égal, l'ordre d'arrivée est conservé", () => {
    // Sans tri stable, deux affichages du même tour pourraient différer — déroutant, et inutile.
    const a: WorkspaceBlock = { ...tableBlock, title: "Premier" };
    const b: WorkspaceBlock = { ...tableBlock, title: "Second" };
    const t = composeTurn({ compositions: [comp("x", [a, b])] });
    expect([t.lead, ...t.rest].map((s) => (s!.block as { title: string }).title)).toEqual(["Premier", "Second"]);
  });

  it("le même objet vu par deux outils ne s'affiche qu'une fois", () => {
    // Sinon le PDG le lirait comme deux choses, et compterait deux fois ce qu'il n'y a qu'une fois.
    const t = composeTurn({ compositions: [comp("a", [dossierBlock()]), comp("b", [dossierBlock()])] });
    expect([t.lead, ...t.rest].filter(Boolean)).toHaveLength(1);
  });
});

describe("défaut 4 — des états MÉTIER, jamais des noms d'outils", () => {
  it("traduit la trace en phases lisibles", () => {
    const p = phasesOf(["directory_lookup", "export_xlsx", "send_email"]);
    expect(p.map((x) => x.label)).toEqual([
      "Recherche du destinataire", "Préparation du document", "Préparation du message",
    ]);
  });

  it("aucune phase ne contient un nom d'outil", () => {
    const trace = ["gmail_search", "inspect_record", "read_hr_overview", "domain_op", "bulk_action"];
    for (const phase of phasesOf(trace)) {
      expect(phase.label).not.toMatch(/_|calling|tool/i);
      expect(phase.label[0]).toBe(phase.label[0].toUpperCase());
    }
  });

  it("fusionne les répétitions — trois appels à l'annuaire font UNE recherche", () => {
    const p = phasesOf(["directory_lookup", "directory_list", "directory_lookup"]);
    expect(p).toHaveLength(1);
  });

  it("ne dépasse jamais quatre phases", () => {
    // Quinze étapes techniques ne renseignent pas : elles occupent.
    const long = ["directory", "gmail", "export", "regulatory", "payment", "calendar", "task", "search"];
    expect(phasesOf(long).length).toBeLessThanOrEqual(4);
  });

  it("marque la dernière phase EN COURS tant que le tour n'est pas fini", () => {
    const p = phasesOf(["directory_lookup", "send_email"], false);
    expect(p[p.length - 1].state).toBe("running");
    expect(p[0].state).toBe("done");
  });

  it("un outil inconnu devient vague, pas technique", () => {
    expect(phasesOf(["truc_bidule_v2"])[0].label).toBe("Analyse en cours");
  });
});

describe("§10 — une mission cohérente, une confirmation", () => {
  it("plusieurs gestes en attente forment UN lot", () => {
    const t = composeTurn({
      compositions: [comp("a", [emailBlock()])],
      proposals: [proposal(), proposal({ kind: "create_task", title: "Rappel vendredi" })],
    });
    expect(t.pending).toBe(2);
    expect(t.singleConfirmation).toBe(true);
  });

  it("un seul geste ne déclenche pas de bandeau de lot", () => {
    const t = composeTurn({ compositions: [comp("a", [emailBlock()])], proposals: [proposal()] });
    expect(t.singleConfirmation).toBe(false);
  });

  it("les gestes DÉJÀ exécutés ne comptent plus comme en attente", () => {
    const t = composeTurn({
      compositions: [comp("a", [emailBlock()])],
      proposals: [proposal({ state: "done" }), proposal({ state: "done" })],
    });
    expect(t.pending).toBe(0);
    expect(t.singleConfirmation).toBe(false);
  });
});

describe("§16 — divulgation progressive", () => {
  it("montre peu, et garde le reste accessible", () => {
    // §15 interdit le tableau de bord géant : trois objets d'un coup, pas quinze.
    expect(VISIBLE_BEFORE_FOLD).toBeLessThanOrEqual(3);
  });

  it("ne perd JAMAIS un bloc, même replié", () => {
    const blocks = Array.from({ length: 9 }, (_, i) => ({ ...tableBlock, title: `T${i}` }));
    const t = composeTurn({ compositions: [comp("x", blocks)] });
    expect([t.lead, ...t.rest].filter(Boolean)).toHaveLength(9);
  });
});

describe("robustesse", () => {
  it("des entrées vides rendent un espace vide, pas une exception", () => {
    const t = composeTurn({});
    expect(t.lead).toBeNull();
    expect(t.rest).toEqual([]);
    expect(t.pending).toBe(0);
  });

  it("des propositions sans aucun bloc ne font pas tomber le rangement", () => {
    const t = composeTurn({ proposals: [proposal()] });
    expect(t.lead).toBeNull();
    expect(t.pending).toBe(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÊME OBJET NE S'EMPILE PAS (§21, §22).
 *
 * Le défaut que ces tests empêchent ne se voit qu'à la relecture : trois versions du même
 * brouillon dans le fil, et plus personne ne sait laquelle a été envoyée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("l'élagage du fil — une identité, une seule carte", () => {
  const email = (statut: "brouillon" | "envoye", id = "email:demo"): WorkspaceComposition => ({
    source: "gmail_draft",
    blocks: [{
      kind: "email", title: "Message", a: ["x@y.dz"], objet: "Objet", corps: "Corps",
      statut, blockId: id,
    }],
  });

  it("seule la DERNIÈRE version d'une identité reste affichée", () => {
    const fil = elaguerFil([[email("brouillon")], [email("envoye")]]);
    expect(fil[0]).toHaveLength(0);
    expect(fil[1][0].blocks).toHaveLength(1);
    const b = fil[1][0].blocks[0];
    expect(b.kind === "email" && b.statut).toBe("envoye");
  });

  it("un bloc SANS identité n'est jamais masqué", () => {
    // Deux tableaux qui se ressemblent ne sont pas le même objet. Les confondre effacerait la
    // réponse à une question qu'on a bel et bien posée deux fois.
    const table = (): WorkspaceComposition => ({
      source: "regulatory_workload",
      blocks: [{ kind: "table", title: "Dossiers", columns: [{ key: "a", label: "A" }], rows: [{ cells: { a: "1" } }] }],
    });
    const fil = elaguerFil([[table()], [table()]]);
    expect(fil[0][0].blocks).toHaveLength(1);
    expect(fil[1][0].blocks).toHaveLength(1);
  });

  it("deux identités DIFFÉRENTES coexistent", () => {
    const fil = elaguerFil([[email("brouillon", "email:a")], [email("brouillon", "email:b")]]);
    expect(fil[0][0].blocks).toHaveLength(1);
    expect(fil[1][0].blocks).toHaveLength(1);
  });

  it("une composition vidée de tous ses blocs disparaît, elle ne laisse pas un cadre vide", () => {
    const fil = elaguerFil([[email("brouillon")], [email("envoye")]]);
    expect(fil[0]).toEqual([]);
  });

  it("l'ordre du fil décide — jamais la version déclarée", () => {
    // Une `version` qui recule serait un bug côté serveur ; on ne s'y fie donc pas. Ce dont on
    // est sûr, c'est l'ordre dans lequel les cartes sont arrivées.
    const v = (n: number): WorkspaceComposition => ({
      source: "mission", blocks: [{
        kind: "mission", title: "M", blockId: "mission:1", version: n,
        etapes: [{ id: "1", label: `Étape v${n}`, etat: "a-faire" }],
      }],
    });
    const fil = elaguerFil([[v(9)], [v(2)]]);
    expect(fil[0]).toHaveLength(0);
    const b = fil[1][0].blocks[0];
    expect(b.kind === "mission" && b.etapes[0].label).toBe("Étape v2");
  });
});
