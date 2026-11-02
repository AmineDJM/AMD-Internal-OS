import { describe, expect, it } from "vitest";
import { caduquesParMessage, messageRendCaduque, propositionsPerimees, remplace, sujetDe, MOTS_COMMUNS_MIN, type PropositionComparable } from "./proposition-perimee";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « NON, FINALEMENT AMEL » NE DOIT PAS LAISSER LA CARTE DE RAIHANA CLIQUABLE.
 *
 * ── LE DÉFAUT MESURÉ, DANS LE VRAI CHAT ─────────────────────────────────────────────────
 *
 * Banc live, scène « CHANGEMENT DE SCOPE ». Tour 1 propose une tâche pour Raihana, échéance
 * vendredi. Tour 2 : « Non, finalement pas Raihana : c\'est Amel Haddad, et l\'échéance c\'est
 * lundi. » Deux cartes à l\'écran, deux cartes exécutables. Le clic sur la première a créé :
 *
 *     « Nivolex — vérifier l\'étiquetage bilingue (scope) » · Raihana Cherif · 2026-09-11
 *
 * c\'est-à-dire EXACTEMENT ce que le PDG venait d\'annuler, avec un reçu qui dit « fait ».
 *
 * ── LES DEUX MOITIÉS, ET LA SECONDE COMPTE AUTANT ───────────────────────────────────────
 *
 *   1. la proposition dépassée est retirée ;
 *   2. DEUX DEMANDES DISTINCTES SURVIVENT. Une règle qui retirerait toute carte de même nature
 *      ferait perdre le travail de « et une autre pour Amel sur le CPP » — le défaut inverse,
 *      aussi coûteux, et celui qu\'on remarquerait plus tard.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const p = (id: string, kind: string, title: string, summary?: string): PropositionComparable =>
  ({ id, kind, title, summary: summary ?? null });

describe("la proposition que la personne a dépassée est retirée", () => {
  it("LE CAS MESURÉ : Raihana vendredi → Amel lundi ne laisse qu\'une carte", () => {
    const ancienne = p("i1", "create_task", "Nivolex — vérifier l\'étiquetage bilingue (scope)", "Assignée à : Raihana Cherif · Échéance : vendredi");
    const nouvelle = p("i2", "create_task", "Nivolex — vérifier l\'étiquetage bilingue (scope)", "Assignée à : Amel Haddad · Échéance : lundi");
    expect(remplace(nouvelle, ancienne)).toBe(true);
    expect(propositionsPerimees([nouvelle], [ancienne])).toEqual(["i1"]);
  });

  it("le sujet peut être reformulé — ce sont les mots qui identifient qui comptent", () => {
    const ancienne = p("i1", "create_task", "Relancer Hetero Labs pour le certificat GMP Trastuzex");
    const nouvelle = p("i2", "create_task", "Relance Hetero Labs — certificat GMP Trastuzex, urgence haute");
    expect(remplace(nouvelle, ancienne), "la reformulation du même travail n\'a pas été reconnue").toBe(true);
  });

  it("deux propositions VAGUES de même nature se remplacent — c\'est là que le risque est le plus grand", () => {
    // « Modifier le devis » n\'a qu\'un mot distinctif : exiger deux mots communs rendrait la
    // règle inapplicable exactement où deux cartes se ressemblent au point d\'être confondues.
    expect(remplace(p("i2", "update_legal_document", "Modifier le devis"), p("i1", "update_legal_document", "Modifier le devis"))).toBe(true);
  });
});

describe("LE TEST QUI COMPTE : deux demandes distinctes survivent toutes les deux", () => {
  it.each([
    ["natures différentes", p("i2", "send_email", "Écrire à Amel Haddad — étiquetage Nivolex"), p("i1", "create_task", "Nivolex — vérifier l\'étiquetage bilingue")],
    ["sujets distincts, même nature", p("i2", "create_task", "Obtenir le CPP légalisé de Julphar — Pembrolix"), p("i1", "create_task", "Relancer Hetero Labs — certificat GMP Trastuzex")],
    ["un seul mot commun ne suffit pas", p("i2", "create_task", "Relancer l\'ANPP sur les réserves Nivolex"), p("i1", "create_task", "Préparer le rapport de stabilité Nivolex")],
    ["modules voisins mais objets différents", p("i2", "create_legal_document", "Devis CHU de Tizi Ouzou — Lenvatix"), p("i1", "create_legal_document", "Bon de commande Imprimerie El Djazair — etiquettes")],
  ])("%s", (_nom, nouvelle, ancienne) => {
    expect(remplace(nouvelle, ancienne), "une demande légitime a été retirée").toBe(false);
    expect(propositionsPerimees([nouvelle], [ancienne])).toEqual([]);
  });

  it("une proposition ne se remplace jamais elle-même", () => {
    const x = p("i1", "create_task", "Relancer Hetero Labs — GMP");
    expect(remplace(x, x)).toBe(false);
    expect(propositionsPerimees([x], [x])).toEqual([]);
  });

  it("un lot de plusieurs propositions ne retire que celles qu\'il recouvre", () => {
    const enAttente = [
      p("v1", "create_task", "Relancer Hetero Labs — certificat GMP Trastuzex"),
      p("v2", "create_task", "Obtenir le CPP légalisé de Julphar — Pembrolix"),
      p("v3", "send_email", "Écrire à Deepak — module 3 du CTD"),
    ];
    const lot = [
      p("n1", "create_task", "Relancer Hetero Labs pour le certificat GMP Trastuzex — priorité haute"),
      p("n2", "create_task", "Préparer la réunion budget avec Sofiane Kaci"),
    ];
    expect(propositionsPerimees(lot, enAttente)).toEqual(["v1"]);
  });

  it("les briques nues font ce qu\'elles disent", () => {
    expect(sujetDe(p("x", "k", "Devis n° DEV-2026-0455 — Imprimerie El Djazair"))).toContain("imprimerie");
    expect(sujetDe(p("x", "k", "Devis n° DEV-2026-0455 — Imprimerie El Djazair")), "« devis » est une catégorie, pas un sujet").not.toContain("devis");
    expect(MOTS_COMMUNS_MIN).toBe(2);
  });

  it("mesure consignée — cartes dépassées retirées, demandes distinctes préservées", () => {
    /**
     * Deux jeux OPPOSÉS : une règle qui retire tout serait parfaite sur le premier et nulle sur
     * le second, et une règle qui ne retire rien ferait l\'inverse. Seul le total a un sens.
     */
    const aRetirer: [PropositionComparable, PropositionComparable][] = [
      [p("n", "create_task", "Nivolex — étiquetage bilingue", "Raihana"), p("v", "create_task", "Nivolex — étiquetage bilingue", "Amel")],
      [p("n", "create_task", "Relance Hetero Labs — GMP Trastuzex"), p("v", "create_task", "Relancer Hetero Labs pour le GMP Trastuzex")],
      [p("n", "update_regulatory", "Passer Pembrolix en attente ANPP"), p("v", "update_regulatory", "Passer Pembrolix en preparation")],
      [p("n", "send_email", "Message a Deepak — CTD module 3"), p("v", "send_email", "Ecrire a Deepak sur le CTD module 3")],
    ];
    const aGarder: [PropositionComparable, PropositionComparable][] = [
      [p("n", "send_email", "Message a Amel — etiquetage"), p("v", "create_task", "Nivolex — etiquetage bilingue")],
      [p("n", "create_task", "CPP legalise Julphar — Pembrolix"), p("v", "create_task", "Certificat GMP Hetero — Trastuzex")],
      [p("n", "create_task", "Preparer la reunion budget Sofiane"), p("v", "create_task", "Relancer ANPP reserves Nivolex")],
      [p("n", "create_legal_document", "Devis CHU Tizi Ouzou — Lenvatix"), p("v", "create_legal_document", "Facture Imprimerie El Djazair")],
      [p("n", "create_task", "Relancer ANPP sur les reserves Nivolex"), p("v", "create_task", "Preparer le rapport de stabilite Nivolex")],
    ];
    const retires = aRetirer.filter(([n, v]) => remplace(n, v)).length;
    const gardes = aGarder.filter(([n, v]) => !remplace(n, v)).length;

    consignerMesure("proposition_depassee_retiree", { n: aRetirer.length + aGarder.length, ok: retires + gardes },
      "lib/assistant/proposition-perimee.test.ts",
      "cartes d\'ecriture jugees correctement sur leur PEREMPTION — retrait quand la personne vient de remplacer la demande, conservation quand ce sont deux travaux differents");

    expect(aRetirer.filter(([n, v]) => !remplace(n, v)).map(([, v]) => v.title), "ces cartes depassees restaient cliquables").toEqual([]);
    expect(aGarder.filter(([n, v]) => remplace(n, v)).map(([, v]) => v.title), "ces demandes legitimes ont ete retirees").toEqual([]);
  });
});

describe("LE CAS RÉEL DU BANC : le tour ne propose RIEN, et la carte doit quand même partir", () => {
  /**
   * Le journal des intentions du tour fautif ne porte qu\'UNE ligne : au tour 2, Adam a répondu
   * en texte sans rien proposer. `remplace` ne pouvait donc rien voir — il compare DEUX
   * propositions. C\'est le message qui doit trancher.
   */
  const carte = p("i1", "create_task", "Nivolex — vérifier l\'étiquetage bilingue (scope)", "Demandée à : Raihana Cherif · Échéance : vendredi");

  it("le message qui reprend le sujet rend la carte caduque", () => {
    expect(messageRendCaduque(carte, "Non, finalement pas Raihana : c\'est Amel Haddad qui doit s\'occuper de l\'étiquetage Nivolex, et l\'échéance c\'est lundi.")).toBe(true);
    expect(caduquesParMessage([carte], "Non, finalement pas Raihana : l\'étiquetage Nivolex, c\'est Amel.")).toEqual(["i1"]);
  });

  it.each([
    ["une question sans rapport", "Au fait, où en est le budget marketing du trimestre ?"],
    ["un autre dossier", "Donne-moi le statut du dossier Pembrolix et son responsable."],
    ["un simple accord", "Ok, parfait."],
    ["une salutation", "Bonjour Adam"],
  ])("%s laisse la carte intacte", (_nom, message) => {
    expect(messageRendCaduque(carte, message), `« ${message} » a tué une carte légitime`).toBe(false);
    expect(caduquesParMessage([carte], message)).toEqual([]);
  });

  it("une carte déjà remplacée n\'est pas comptée deux fois", () => {
    expect(caduquesParMessage([carte], "l\'étiquetage Nivolex pour Amel", ["i1"])).toEqual([]);
  });
});
