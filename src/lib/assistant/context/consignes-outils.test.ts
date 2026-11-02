import { describe, expect, it } from "vitest";
import { routeQuery, consigneCalcul, consignePeriode, consigneProchainGeste, consigneRepresentation, consigneSignaux } from "./router";
import { outilsNommes, shortlistTools, fitToolBudget, TOOL_DOMAINS_ALL } from "./tool-shortlist";
import { resolveTools } from "./tool-resolver";

/**
 * CE QUE LA CONSIGNE NOMME, LE TOUR L'EXPOSE (§118.122).
 *
 * Le défaut mesuré : `consigneSignaux` dit « l'état des dossiers se lit dans
 * regulatory_intelligence / legal_intelligence / finance_intelligence » et la liste courte de
 * « quels dossiers sont en retard ? » en expose UN sur trois. Le modèle part alors en découverte
 * — six appels, 54 schémas → 241, 13 700 → 55 286 jetons d'entrée avec 0 % de cache, et
 * `what_changed` (nommé par la consigne) écarté au plafond du fournisseur. 63 s et 0,2534 $ pour
 * la question qu'un dirigeant pose chaque lundi.
 *
 * Ce banc part des VRAIES consignes et du VRAI résolveur : vérifier `outilsNommes` seul ne
 * prouverait rien sur le tour (§118.49).
 */

/** Les consignes de tour, telles que `assistant.ts` les compose dans `planCtx`. */
const CONSIGNES: Array<readonly [string, (s: string) => string | null]> = [
  ["calcul", consigneCalcul],
  ["periode", consignePeriode],
  ["representation", consigneRepresentation],
  ["signaux", consigneSignaux],
  ["prochainGeste", consigneProchainGeste],
];

/**
 * Les phrases doivent DÉCLENCHER au moins une consigne, sinon le banc mesurerait le vide. Une
 * assertion le vérifie plus bas — c'est la prémisse, et sans elle le cas serait vrai par défaut.
 */
/**
 * LES FORMES GLOBALES — mesuré : sur les huit tours de la sonde de conversation, UN SEUL
 * déclenchait une consigne. Le mot d'état était là, la CIBLE manquait, parce que la cible est
 * l'entreprise. Ces phrases-là sont désormais servies ; les cas négatifs juste après tiennent
 * l'autre moitié de la règle — une consigne qui arrive partout cesse d'être lue (§118.32).
 */
const GLOBALES = [
  "Où on en est ?",
  "Qu'est-ce qui bloque ?",
  "Y'a quoi d'urgent ?",
  "Qu'est-ce qui cloche ?",
  "Quels sont les risques ?",
  "Qu'est-ce que je dois savoir aujourd'hui ?",
  "Fais-moi un point sur la trésorerie",
];

/** Ce qui NE doit PAS déclencher : un mot d'état sans question sur l'état de l'entreprise. */
const HORS_SUJET = [
  "Il manque une virgule dans ce paragraphe",
  "Relance-moi demain à 9h",
  "Quelles sont mes obligations de congés ?",
  "Résume-moi ce document",
  "Mon accès est bloqué",
  "Bonjour Adam",
  "Merci beaucoup",
];

const PHRASES = [
  "Résume-moi la semaine",
  "Qu'est-ce qui a bougé ces derniers jours ?",
  "Remets-moi à niveau, j'étais en déplacement",
  "Récapitule-moi la quinzaine écoulée",
  "Quels dossiers réglementaires sont en retard ?",
  "Quelles factures sont sans bon de commande ?",
  "Quels contrats arrivent à échéance ce mois-ci ?",
  "Quels budgets sont en dépassement ?",
  "Quels dossiers sont bloqués et pourquoi ?",
  "Montre-moi un tableau de bord des dossiers",
  "Fais-moi un Gantt des échéances réglementaires",
  "Quelle est la probabilité de dépasser le budget ?",
];

const consignesDe = (p: string) =>
  CONSIGNES.map(([nom, fn]) => [nom, fn(p)] as const).filter((x): x is readonly [string, string] => x[1] !== null);

/** Une liste d'outils de la forme que le résolveur reçoit — le parc complet du registre. */
const PARC = Object.keys(TOOL_DOMAINS_ALL).map((name) => ({ name }));

describe("la question d'état SANS cible est la plus fréquente", () => {
  it("une forme globale reçoit la consigne d'état ET celle du prochain geste", () => {
    for (const q of GLOBALES) {
      expect(consigneSignaux(q), `« ${q} » : aucune consigne d'état — c'est la question la plus naturelle d'un dirigeant`).not.toBeNull();
      expect(consigneProchainGeste(q), `« ${q} » : un constat sans geste proposé est un tableau de bord`).not.toBeNull();
    }
  });

  it("un mot d'état hors sujet ne la déclenche pas", () => {
    for (const q of HORS_SUJET) {
      expect(consigneSignaux(q), `« ${q} » ne demande rien sur l'état de l'entreprise`).toBeNull();
      expect(consigneProchainGeste(q), `« ${q} » ne produit aucun constat`).toBeNull();
    }
  });

  it("le prochain geste distingue un LIEN d'un GESTE, et borne le nombre de cartes", () => {
    const c = consigneProchainGeste("Qu'est-ce qui bloque ?")!;
    // Mesuré : sans cette distinction, le modèle mettait un lien sur chacun des six blocages et
    // ne proposait RIEN — la branche « lien » était l'échappatoire de toutes les autres.
    expect(c).toContain("N'EST PAS UN GESTE");
    expect(c).toMatch(/pas plus de deux cartes/);
    expect(c).toContain("proposer n'est pas agir");
  });
});

describe("les outils qu'une consigne nomme", () => {
  it("chaque phrase du banc déclenche bien une consigne (la prémisse)", () => {
    for (const p of PHRASES) {
      expect(consignesDe(p).length, `« ${p} » ne déclenche AUCUNE consigne : ce cas ne mesurerait rien`).toBeGreaterThan(0);
    }
  });

  it("un nom d'outil se lit qu'il porte des backticks ou non", () => {
    // La moitié qui compte : `consigneSignaux`, la plus appelée du produit, écrit ses trois noms
    // SANS backticks. Un détecteur qui exigerait les backticks serait désarmé en ayant l'air armé.
    expect(outilsNommes("se lit dans regulatory_intelligence / legal_intelligence")).toEqual([
      "legal_intelligence", "regulatory_intelligence",
    ]);
    expect(outilsNommes("appelle `what_changed` SANS référence")).toEqual(["what_changed"]);
    // Ce qui n'est pas un outil du registre n'ouvre rien.
    expect(outilsNommes("un mot_inconnu et du texte ordinaire")).toEqual([]);
    expect(outilsNommes(null)).toEqual([]);
  });

  it("est EXPOSÉ par la liste courte de sa propre question", () => {
    const manques: string[] = [];
    for (const p of PHRASES) {
      const route = routeQuery(p);
      const cites = consignesDe(p).flatMap(([nom, texte]) => outilsNommes(texte).map((o) => [nom, o] as const));
      if (!cites.length) continue;
      const epingles = outilsNommes(consignesDe(p).map(([, t]) => t).join("\n"));
      const exposes = new Set(shortlistTools(PARC, route, epingles).map((t) => t.name));
      for (const [consigne, outil] of cites) {
        if (!exposes.has(outil)) manques.push(`« ${p} » : la consigne ${consigne} nomme ${outil}, absent de la liste`);
      }
    }
    expect(manques, manques.join("\n")).toEqual([]);
  });

  it("survit au PLAFOND DU NIVEAU du résolveur, qui est ce qui coupait vraiment", () => {
    // Le résolveur borne par niveau (A/B/C) et c'est LUI qui n'exposait que 15 outils au premier
    // appel de découverte mesuré. Sans l'épingle à ce rang, la réparation serait défaite à
    // l'étage du dessous et la liste courte n'y changerait rien.
    const manques: string[] = [];
    for (const p of PHRASES) {
      const route = routeQuery(p);
      const epingles = outilsNommes(consignesDe(p).map(([, t]) => t).join("\n"));
      if (!epingles.length) continue;
      const resolus = new Set(resolveTools(PARC, p, route, { epingles }).tools.map((t) => t.name));
      for (const o of epingles) {
        if (!resolus.has(o)) manques.push(`« ${p} » : ${o} est nommé par une consigne et coupé par le plafond du niveau`);
      }
    }
    expect(manques, manques.join("\n")).toEqual([]);
  });

  it("n'est PAS coupé par le plafond du fournisseur", () => {
    // Mesuré avant la réparation : `what_changed` figurait parmi les 113 outils écartés à 128,
    // c'est-à-dire exactement celui que la consigne venait de nommer.
    const route = routeQuery("Résume-moi la semaine");
    const epingles = outilsNommes(consignePeriode("Résume-moi la semaine"));
    expect(epingles).toContain("what_changed");
    // Un parc volontairement plus grand que le plafond, l'outil nommé placé en DERNIER — la
    // position où une coupe par ordre de liste l'emporte à coup sûr.
    const gonfle = [
      ...Array.from({ length: 200 }, (_, i) => ({ name: `bourrage_${i}` })),
      ...PARC.filter((t) => t.name !== "what_changed"),
      { name: "what_changed" },
    ];
    const tenus = new Set(fitToolBudget(gonfle, route, 128, epingles).map((t) => t.name));
    expect(tenus.size).toBeLessThanOrEqual(128);
    for (const o of epingles) {
      expect(tenus.has(o), `${o} est nommé par la consigne et coupé au plafond du fournisseur`).toBe(true);
    }
  });

  it("épingler n'ouvre RIEN qui ne soit déjà dans la liste reçue", () => {
    // La question qu'un lecteur se posera : est-ce que nommer un outil dans une phrase peut
    // l'accorder ? Non — on n'épingle que parmi `tools`, déjà filtré par les droits.
    const route = routeQuery("Résume-moi la semaine");
    const restreint = [{ name: "search_everything" }, { name: "inspect_record" }];
    const noms = shortlistTools(restreint, route, ["what_changed", "send_email"]).map((t) => t.name);
    expect(noms).not.toContain("what_changed");
    expect(noms).not.toContain("send_email");
  });
});
