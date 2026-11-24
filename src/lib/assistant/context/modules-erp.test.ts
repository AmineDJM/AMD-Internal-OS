import { describe, expect, it } from "vitest";

import { MODULE_LABELS } from "@/lib/labels";
import { RESOLVER_WRITE_NAMES } from "@/lib/assistant";
import { SERVICE_DU_MODULE, outilsDesModulesNommes, signauxDesModules } from "@/lib/assistant/context/modules-domaines";
import { detectDomains, routeQuery } from "@/lib/assistant/context/router";
import { resolveTools } from "@/lib/assistant/context/tool-resolver";
import { fitToolBudget, TOOL_DOMAINS_ALL, ALWAYS_ON, EXECUTIVE, CAPABILITIES } from "@/lib/assistant/context/tool-shortlist";
import { normalizeUtterance } from "@/lib/assistant/voice/fast-path";

const PARC = Object.keys(TOOL_DOMAINS_ALL).map((name) => ({ name }));

/** La liste servie au modèle, par le VRAI chemin : routeur → résolveur → plafond du fournisseur. */
function outilsDuTour(question: string): string[] {
  const route = routeQuery(question, {});
  const resolved = resolveTools(PARC, question, route, { ecritures: RESOLVER_WRITE_NAMES });
  return fitToolBudget(resolved.tools, route, undefined, []).map((t) => t.name);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « IL A PAS ACCÈS À TOUT L'ERP » — ce que la plainte du dirigeant était, mesurée.
 *
 * L'ERP déclare 43 modules ; 29 ne faisaient reconnaître AUCUN domaine, et le résolveur servait
 * alors les MÊMES NEUF outils quelle que soit la question — dont la boîte mail, parce que `MAIL`
 * est le premier d'une liste figée et que le rang se calcule sur la POSITION du domaine.
 * « Combien de visites terrain ce mois-ci ? » recevait `gmail_search`, avec 213 outils sur 227
 * écartés. Le manque était de ROUTAGE : les outils existaient tous.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les modules de l'ERP sont atteignables", () => {
  /**
   * L'EXHAUSTIVITÉ EST TENUE PAR LE TYPE (`Record<CleModule, …>`) : un module ajouté demain ne
   * COMPILE PAS tant que personne n'a dit qui le sert. Ce que le test ajoute, c'est que
   * `domaines: []` reste l'EXCEPTION et qu'elle se compte — une liste vide dit « aucun outil
   * dédié », ce qui n'est pas la même dette qu'un outil mal routé (§118.31).
   *
   * Le sabotage : vider les `domaines` d'un module servi — le compte monte et le test tombe.
   */
  it("tous les modules déclarent leur service, et les sans-outil se comptent", () => {
    const modules = Object.keys(MODULE_LABELS);
    expect(Object.keys(SERVICE_DU_MODULE).sort()).toEqual(modules.sort());
    const sansOutil = Object.entries(SERVICE_DU_MODULE).filter(([, s]) => s.domaines.length === 0).map(([c]) => c);
    // MESURÉ : les moyens généraux et le retour d'expérience n'ont aucune capacité Adam ; le site
    // public non plus, par décision — publier sur le site est un geste d'écran (§118.158). Le
    // STOCK et le CATALOGUE promotionnels non plus (§118.164) : chaque geste de stock atteste un
    // fait PHYSIQUE (« je l'ai reçu », « je l'ai compté ») qu'un modèle ne voit pas, les anciennes
    // ops de stock d'Adam ont été retirées avec l'ancien registre, et Adam est en pause.
    // Les KPI & bilans non plus (Direction, 08/10) : noter, valider, signer sont des attestations d'un manager (§118.15).
    // La CORBEILLE non plus (24/11/2026) : restaurer une pièce supprimée est un geste d'écran, jamais confié à un modèle.
    expect(sansOutil.sort()).toEqual(["CORBEILLE", "FEEDBACK", "GENERAL_MEANS", "KPI", "PROMO_CATALOG", "PROMO_STOCK", "SITE_WEB"]);
  });

  /**
   * LE CLIQUET QUI REND LA LISTE ÉCRITE À LA MAIN SÛRE. Un nom d'outil recopié est faux au
   * premier renommage, EN SILENCE — ici le banc tombe en nommant le module fautif.
   * Le sabotage : renommer un outil déclaré.
   */
  it("chaque outil déclaré par un module existe dans le parc", () => {
    const inconnus: string[] = [];
    for (const [cle, service] of Object.entries(SERVICE_DU_MODULE)) {
      for (const o of service.outils ?? []) if (!(o in TOOL_DOMAINS_ALL)) inconnus.push(`${cle} → ${o}`);
    }
    expect(inconnus).toEqual([]);
  });

  /**
   * LA COUCHE NE PARLE QUE SI RIEN D'AUTRE N'A PARLÉ — les deux sens, et c'est la moitié qui
   * compte : sans la seconde assertion, la couche pourrait arbitrer CONTRE le vocabulaire écrit
   * à la main et faire changer de verdict un corpus de routage existant.
   *
   * Le sabotage : verser les signaux des modules inconditionnellement dans `signauxDeLaPhrase`.
   */
  it("elle complète le vocabulaire existant, elle ne l'arbitre pas", () => {
    // Rien reconnu avant → la couche répond.
    expect(signauxDesModules(normalizeUtterance("combien de visites terrain ce mois-ci ?")).length).toBeGreaterThan(0);
    expect(detectDomains(normalizeUtterance("combien de visites terrain ce mois-ci ?"))).toContain("DIRECTORY");
    // UN DOMAINE DÉJÀ RECONNU GARDE LE SIEN, et le cas doit DISCRIMINER : il faut un mot de
    // module qui PRÉCÈDE le mot reconnu, sinon le tri par position rend l'assertion vraie que la
    // couche soit conditionnelle ou non. Mesuré : « visites » est à la position 4 (module
    // FIELD_REPORTS → DIRECTORY), « budget » à la position 16 (FINANCE). Versée sans condition,
    // la couche mettrait DIRECTORY en tête et détournerait une question de budget.
    //
    // Ma première version asserait « des mails aujourd'hui ? » → MAIL : vrai dans les deux cas,
    // parce que la phrase ne contient AUCUN mot de module. Le sabotage est passé au vert et a
    // nommé le défaut — l'assertion visait l'autre moitié du mécanisme (§118.111).
    const melange = detectDomains(normalizeUtterance("les visites et le budget du trimestre"));
    expect(melange[0]).toBe("FINANCE");
    expect(melange).not.toContain("DIRECTORY");
    expect(detectDomains(normalizeUtterance("des mails aujourd'hui ?"))[0]).toBe("MAIL");
  });

  /**
   * LA PHRASE ENTIÈRE DU LIBELLÉ, PAS SES MOTS PRIS UN PAR UN.
   *
   * « Rapports terrain » découpé en mots ferait de « le rapport d'analyse CTD » une question de
   * force de vente. Le sabotage : accepter UN mot du libellé — le cas négatif tombe.
   */
  it("« le rapport d'analyse CTD » ne nomme aucun module ; « les rapports terrain », si", () => {
    expect(outilsDesModulesNommes(normalizeUtterance("retrouve le rapport d'analyse CTD"))).toEqual([]);
    expect(outilsDesModulesNommes(normalizeUtterance("résume-moi la note fournisseur Kwality"))).toEqual([]);
    expect(outilsDesModulesNommes(normalizeUtterance("montre-moi les rapports terrain"))).toContain("field_report_operation");
  });

  /**
   * LE LIBELLÉ ENTRE AUTOMATIQUEMENT. Un module qui ne déclare AUCUN mot supplémentaire reste
   * reconnu par son propre nom, donc un renommage suit sans que personne y pense (§118.73).
   * Le sabotage : retirer `MODULE_LABELS[cle]` des expressions.
   */
  it("un module sans mots déclarés est reconnu par son nom", () => {
    expect(SERVICE_DU_MODULE.LEGAL.mots ?? []).toEqual([]);
    expect(outilsDesModulesNommes(normalizeUtterance("une demande de consulting"))).toContain("consulting_operation");
  });

  /**
   * L'OUTIL DU MODULE EST SERVI — et c'est la mesure qui a nommé le défaut restant après
   * l'ouverture du domaine : REGULATORY porte 46 outils pour 15 places, et `read_stock` tombait
   * au profit d'outils simplement plus tôt dans le registre.
   *
   * Le sabotage : retirer `outilsDuModule` de `garde` ou son rang 0.6 — les trois cas tombent.
   */
  it("un module nommé fait passer SES lectures devant les autres de son domaine", () => {
    const stocks = outilsDuTour("quel est l'état des stocks à l'hôpital Mustapha ?");
    expect(stocks).toContain("read_stock");
    expect(stocks).toContain("search_hospitals");

    const espace = outilsDuTour("montre-moi mon espace de travail");
    expect(espace).toContain("my_overview");

    // LE CORPUS DE CONNAISSANCE était déclaré `["GENERAL"]` — le domaine que le résolveur
    // EXCLUT — donc JAMAIS dans une liste de premier tour, quelle que soit la question.
    const corpus = outilsDuTour("que dit le corpus Adventum Brain sur l'étiquetage ?");
    expect(corpus).toContain("search_knowledge_corpus");
    expect(corpus).toContain("read_corpus_document");
  });

  /**
   * NOMMER UN MODULE N'OUVRE PAS SES GESTES À UNE QUESTION QUI NE FAIT QUE LIRE.
   *
   * Les deux moitiés sont nécessaires : sans la première, une question d'état exposerait les
   * écritures du module (« décrire les écritures à quelqu'un qui pose une question, c'est offrir
   * l'occasion de se tromper de geste ») ; sans la seconde, l'épinglage ne servirait à rien là
   * où il compte. Le sabotage : retirer le filtre `estEcriture` de la boucle des modules.
   *
   * Et c'est la mesure qui a corrigé MA mesure : la première sonde passait un ensemble
   * d'écritures `undefined` (mauvais chemin d'import) et montrait `stock_operation` servi sur une
   * question de lecture — elle ne prouvait rien (§118.92).
   */
  it("le filtre des écritures reste appliqué aux outils du module", () => {
    expect(RESOLVER_WRITE_NAMES.has("stock_operation")).toBe(true);
    expect(outilsDuTour("quel est l'état des stocks à l'hôpital Mustapha ?")).not.toContain("stock_operation");
    expect(outilsDuTour("crée une demande d'état de stock pour l'hôpital Mustapha")).toContain("stock_operation");
  });

  /**
   * CE QUI RESTE, ET SON COMPTE — un manque non classé est un manque invisible (§118.31).
   *
   * `GENERAL` porte deux sens : sur une QUESTION il veut dire « rien reconnu », sur un OUTIL
   * « utile partout ». Le résolveur filtrait `GENERAL` de la question puis le confrontait aux
   * outils : 31 outils déclarés `["GENERAL"]` et rien d'autre, dont 17 hors des listes
   * inconditionnelles, ne pouvaient donc JAMAIS être servis au premier tour. Cinq sont désormais
   * déclarés par un module ; les autres restent atteignables par la découverte, et leur nombre
   * ne doit pas MONTER.
   */
  it("le compte des transverses sans siège ne monte pas", () => {
    const inconditionnels = new Set<string>([
      ...(ALWAYS_ON as readonly string[]), ...(EXECUTIVE as readonly string[]), ...(CAPABILITIES as readonly string[]),
    ]);
    const declares = new Set(Object.values(SERVICE_DU_MODULE).flatMap((s) => s.outils ?? []));
    const orphelins = Object.entries(TOOL_DOMAINS_ALL)
      .filter(([n, ds]) => ds.every((d) => d === "GENERAL") && !inconditionnels.has(n) && !declares.has(n))
      .map(([n]) => n);
    // MESURÉ le 11/09/2026 : 17 avant le lot, 12 après. Le plafond est le chiffre mesuré —
    // au-dessus, il ne pourrait plus se déclencher (§118.79c).
    expect(orphelins.length).toBeLessThanOrEqual(12);
  });
});
