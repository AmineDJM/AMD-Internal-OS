import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { groupIntoPoles, itemsOfGroup, poleOfPath, aliasMatches, ongletActif, POLE_OPEN_THRESHOLD, NAV_POLES } from "./navigation";
import { EVENTS_TABS, NAVIGATION, STOCK_PROMO_TABS, type NavItem } from "./labels";
import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "./chemins/stock-promo";
import { MODULES } from "./rbac";
import { CHEMIN_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";

/** Les entrées telles que le layout les livre : DÉJÀ filtrées par le RBAC. */
const accessible = (modules: string[]): NavItem[] =>
  NAVIGATION.filter((n) => (n.tabs ? n.tabs.some((t) => modules.includes(t.module)) : modules.includes(n.module)));

describe("pôles — projection du RBAC, jamais une source de droit", () => {
  it("un pôle n'apparaît QUE s'il a au moins un sous-module accessible", () => {
    // Les Rapports terrain sont un ONGLET de la Promotion médicale (Direction, 07/10) : le seul droit FIELD_REPORTS
    // ouvre l'entrée « Promotion médicale », qui mène à cet onglet — et à rien d'autre (les autres onglets restent fermés).
    const poles = groupIntoPoles(accessible(["FIELD_REPORTS"]));
    expect(poles.map((p) => p.key)).toEqual(["OPERATIONS_SALES"]);
    expect(poles[0].children.map((c) => c.label)).toEqual(["Promotion médicale"]);
  });

  it("un sous-module interdit est ABSENT, pas masqué", () => {
    const poles = groupIntoPoles(accessible(["FIELD_REPORTS"]));
    const labels = poles.flatMap((p) => p.children.map((c) => c.label));
    expect(labels).not.toContain("Ventes");
    expect(labels).not.toContain("Ad & Pro");
    expect(labels).not.toContain("Information médicale");
  });

  it("sans aucun droit, il n'y a aucun pôle — pas un titre vide", () => {
    expect(groupIntoPoles([])).toEqual([]);
  });

  it("≤ 5 sous-modules visibles → ouvert par défaut", () => {
    // « Moyens généraux » relève de GENERAL_MEANS, le MÊME module que sa page. « Demandes de
    // paiement » n'a PLUS d'entrée de menu : la demande se fait depuis les Demandes de
    // validations, et le dossier passe par le centre de paiement avant d'atteindre les
    // Règlements.
    const admin = groupIntoPoles(accessible(["GENERAL_MEANS", "FINANCES", "RH", "BUDGETS"]))
      .find((p) => p.key === "ADMINISTRATION");
    expect(admin?.children.map((c) => c.label)).toEqual([
      "Moyens généraux", "Finances", "Ressources humaines", "Budgets",
    ]);
    expect(admin?.defaultOpen).toBe(true);
  });

  it("> 5 sous-modules visibles → replié, à ouvrir au chevron", () => {
    // LE PÔLE EST CHOISI PARCE QU'IL A CETTE FORME, pas par habitude. Sales & Marketing portait
    // ce cas jusqu'à ce qu'« Information médicale » rejoigne Regulatory : il est retombé à cinq
    // entrées, c'est-à-dire au SEUIL, et l'assertion « > 5 » n'y était plus atteignable.
    // Administration en compte douze — et le cas d'ouverture juste au-dessus porte sur le MÊME
    // pôle, ce qui fait que les deux sens éprouvent le seuil et non une propriété d'un pôle.
    const admin = groupIntoPoles(accessible([
      "FINANCES", "PAYMENT_CENTRE", "VALIDATION_CENTRE", "LEGAL", "MAIL_REGISTER", "BUDGETS",
    ])).find((p) => p.key === "ADMINISTRATION");
    expect(admin!.children.length).toBeGreaterThan(POLE_OPEN_THRESHOLD);
    expect(admin?.defaultOpen).toBe(false);
  });

  /**
   * « INFORMATION MÉDICALE » CHANGE DE PÔLE, ET DE RIEN D'AUTRE (décision Direction 09/2026).
   *
   * Le cas qui ferait tomber ces assertions est exactement celui qu'on veut interdire : que le
   * déplacement d'une entrée de menu ait ouvert ou fermé un écran. `pole` ne sert qu'au
   * regroupement ; la garde est le module, et elle n'a pas bougé.
   */
  it("« Information médicale » est au pôle REGULATORY, et plus dans les pôles commerciaux", () => {
    const poles = groupIntoPoles(accessible(["MEDICAL_INFO"]));
    const reg = poles.find((p) => p.key === "REGULATORY");
    expect(reg?.children.map((c) => c.label)).toContain("Information médicale");
    // Et elle a QUITTÉ l'autre pôle : sans cette moitié, une entrée dupliquée passerait.
    expect(poles.find((p) => p.key === "MARKETING" || p.key === "OPERATIONS_SALES")).toBeUndefined();
  });

  /**
   * MARKETING ET OPERATIONS & SALES (Direction, 08/10 : « sépare Marketing et Sales »). « Sales & Marketing » est coupé
   * en deux pôles, à sa place dans l'ordre ; la Direction a nommé le contenu de chacun — le site web rejoint le Marketing.
   * Les entrées qu'elle n'a pas citées (Ventes, Consommation) restent avec le terrain. Seul le RANGEMENT change.
   */
  it("Marketing puis Operations & Sales, à la place de Sales & Marketing, avec les entrées nommées par la Direction", () => {
    const cles = NAV_POLES.map((p) => p.key);
    expect(cles).not.toContain("SALES_MARKETING");
    expect(cles.indexOf("OPERATIONS_SALES")).toBe(cles.indexOf("MARKETING") + 1);
    expect(cles.indexOf("MARKETING")).toBe(cles.indexOf("ADMINISTRATION") + 1);
    expect(NAV_POLES.find((p) => p.key === "MARKETING")?.label).toBe("Marketing");
    expect(NAV_POLES.find((p) => p.key === "OPERATIONS_SALES")?.label).toBe("Operations & Sales");
    const tout = groupIntoPoles(accessible([...MODULES]));
    const de = (cle: string) => tout.find((p) => p.key === cle)?.children.map((c) => c.label) ?? [];
    expect(de("MARKETING")).toEqual(expect.arrayContaining(["Marketing cockpit", "Segmentation", "Produits 360", "Ad & Pro", "Stock promotionnel", "Site web"]));
    // Le Cockpit Opérations ouvre le pôle (Direction, 08/10), puis le terrain.
    expect(de("OPERATIONS_SALES").slice(0, 5)).toEqual(["Cockpit Opérations", "Promotion médicale", "Force de vente", "Business Units", "Marchés PCH"]);
    // Les ventes restent avec le terrain (leur libellé peut évoluer : « Ventes », « Ventes PCH »).
    expect(de("OPERATIONS_SALES").some((l) => l.startsWith("Ventes"))).toBe(true);
    // « Consommation » n'a plus d'entrée (Direction, 08/10 : « masque-le de ma vue ») — le module reste, l'entrée part.
    expect(de("OPERATIONS_SALES")).not.toContain("Consommation");
    expect(de("BUSINESS_DEV")).not.toContain("Marchés PCH");
    expect(de("ADMINISTRATION")).not.toContain("Site web");
    // Le rangement ne donne AUCUN droit : sans le module, l'entrée n'apparaît dans aucun pôle.
    expect(groupIntoPoles(accessible(["SALES_PLANNING"])).flatMap((p) => p.children.map((c) => c.label))).not.toContain("Business Units");
  });

  /**
   * STOCKS ET LOGISTIQUE REJOIGNENT OPERATIONS & SALES (Direction, 08/10). Le pôle « Supply Chain » disparaît ; l'ordre
   * du pôle suit le fil du produit : terrain, montage, marchés, ventes, puis la chaîne physique, la consommation et les
   * retours. Seul le RANGEMENT change : chaque entrée suit toujours SON module.
   */
  it("Stocks et Logistique sont dans Operations & Sales, après les marchés ; plus de pôle Supply Chain", () => {
    expect(NAV_POLES.map((p) => p.key as string)).not.toContain("SUPPLY_CHAIN");
    const ops = groupIntoPoles(accessible([...MODULES])).find((p) => p.key === "OPERATIONS_SALES")!.children.map((c) => c.label);
    const i = (l: string) => ops.indexOf(l);
    for (const l of ["Stocks", "Logistique"]) expect(ops, l).toContain(l);
    expect(i("Stocks")).toBeGreaterThan(i("Marchés PCH"));
    expect(i("Logistique")).toBe(i("Stocks") + 1);
    // Le rangement n'ouvre rien : sans STOCKS, pas d'entrée Stocks.
    expect(groupIntoPoles(accessible(["PCH"])).flatMap((p) => p.children.map((c) => c.label))).not.toContain("Stocks");
    expect(NAVIGATION.some((n) => n.href === "/retours-reclamations")).toBe(false);
  });

  it("le déplacement ne donne AUCUN droit : sans le module, l'entrée n'apparaît nulle part", () => {
    // Le pôle Regulatory est visible pour qui a REGULATORY ; « Information médicale » ne s'y
    // affiche pas pour autant. Une entrée qui suivrait son PÔLE au lieu de son MODULE serait
    // une porte ouverte par un simple rangement de menu.
    const reg = groupIntoPoles(accessible(["REGULATORY"])).find((p) => p.key === "REGULATORY");
    expect(reg?.children.map((c) => c.label)).not.toContain("Information médicale");
  });

  it("le décompte porte sur CE QUE LA PERSONNE VOIT, pas sur le total du pôle", () => {
    // Deux entrées seulement, alors que le pôle en compte davantage au total : il s'ouvre.
    // Replier pour deux lignes n'aurait aucun sens. (MEDICAL n'a qu'UNE entrée de menu —
    // « Promotion médicale » — qui porte ses deux onglets : Ma journée et l'Annuaire.)
    // (Les Rapports terrain sont un onglet de la Promotion médicale depuis le 07/10 : FIELD_REPORTS n'ajoute pas d'entrée.)
    const sm = groupIntoPoles(accessible(["FIELD_REPORTS", "MEDICAL", "PCH"])).find((p) => p.key === "OPERATIONS_SALES");
    expect(sm?.children.map((c) => c.label)).toEqual(["Promotion médicale", "Marchés PCH"]);
    expect(sm?.defaultOpen).toBe(true);
  });

  it("le PIPELINE est un module du pôle Regulatory — on le trouve en dépliant sa flèche", () => {
    const poles = groupIntoPoles(accessible(["REGULATORY", "REGULATORY_PIPELINE"]));
    const reg = poles.find((p) => p.key === "REGULATORY");
    expect(reg?.children.map((c) => c.label)).toEqual(expect.arrayContaining(["Suivi des dossiers", "Pipeline"]));
    expect(poleOfPath(poles, "/regulatory/pipeline")).toBe("REGULATORY");
  });

  it("Pipeline et Suivi des dossiers se règlent À PART (Direction, 08/10) — chacun suit SON module", () => {
    const entree = NAVIGATION.find((n) => n.href === "/regulatory/pipeline");
    expect(entree?.module).toBe("REGULATORY_PIPELINE");
    // La confidence du pipeline reste une seconde clé : la garde `pipeline` est conservée.
    expect(entree?.gate).toBe("pipeline");
    const seulSuivi = groupIntoPoles(accessible(["REGULATORY"])).find((p) => p.key === "REGULATORY");
    expect(seulSuivi?.children.map((c) => c.label)).toContain("Suivi des dossiers");
    expect(seulSuivi?.children.map((c) => c.label)).not.toContain("Pipeline");
    const seulPipeline = groupIntoPoles(accessible(["REGULATORY_PIPELINE"]));
    const reg = seulPipeline.find((p) => p.key === "REGULATORY");
    expect(reg?.children.map((c) => c.label)).toEqual(["Pipeline"]);
    expect(poleOfPath(seulPipeline, "/regulatory/pipeline")).toBe("REGULATORY");
  });

  it("un SOUS-MODULE (capacité `children`) ouvre le pôle de son parent — Employés, Demandes RH, Recrutement, Formations et Paie sous les RH", () => {
    const rh = NAVIGATION.find((n) => n.href === "/rh")!;
    // LES SOUS-MODULES RH (Direction, 06/10 ; le Recrutement les rejoint le 07/10) : chacun son module, réglable dans la console.
    expect(rh.children?.map((c) => c.href)).toEqual(["/rh/equipe", "/rh/demandes", "/recrutement", "/formations", "/rh/paie"]);
    expect(rh.children?.map((c) => c.module)).toEqual(["EMPLOYEES", "HR_REQUESTS", "RECRUITMENT", "TRAINING", "RH"]);
    // Le recrutement a QUITTÉ « Mon Équipe » : une entrée simple, sans sous-menu ni chemin du recrutement.
    const equipe = NAVIGATION.find((n) => n.href === "/mon-equipe")!;
    expect(equipe.children ?? []).toEqual([]);
    expect(equipe.match ?? []).not.toContain("/recrutement");
    expect(poleOfPath(groupIntoPoles([rh]), "/recrutement/abc")).toBe("ADMINISTRATION");
    expect(rh.groupe).toBe(true);
    // Arriver sur la paie par un lien de notification doit ouvrir Administration, sinon on ne
    // retrouve pas dans le menu l'écran où l'on se trouve.
    expect(poleOfPath(groupIntoPoles([rh]), "/rh/paie")).toBe("ADMINISTRATION");
  });

  it("garde l'ordre des pôles déclaré, quel que soit l'ordre des droits", () => {
    const keys = groupIntoPoles(accessible([...MODULES])).map((p) => p.key);
    expect(keys).toEqual(NAV_POLES.map((p) => p.key).filter((k) => keys.includes(k)));
  });
});

describe("groupes historiques", () => {
  it("Pilotage, Transverse et Système ne contiennent aucune entrée de pôle", () => {
    const all = accessible([...MODULES]);
    for (const g of ["Pilotage", "Transverse", "Système"] as const) {
      expect(itemsOfGroup(all, g).every((i) => !i.pole)).toBe(true);
    }
  });

  it("« Console d'Administration » est dans Système, et l'administration d'entreprise dans les pôles", () => {
    const all = accessible([...MODULES]);
    expect(itemsOfGroup(all, "Système").map((i) => i.label)).toContain("Console d'Administration");
    const admin = groupIntoPoles(all).find((p) => p.key === "ADMINISTRATION");
    expect(admin?.children.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Moyens généraux", "Finances", "Ressources humaines", "Budgets"]),
    );
  });
});

/**
 * L'ENTRÉE DE MENU DIT LA VÉRITÉ SUR LES DROITS.
 *
 * ── LE DÉFAUT RAPPORTÉ ──────────────────────────────────────────────────────────────────────
 *
 * Deux comptes BLOQUÉS sur les Moyens généraux dans la console voyaient toujours l'entrée dans
 * leur menu de gauche. L'entrée était portée par `WORKSPACE` — que tout le monde a — du temps où
 * la page servait aussi à DEMANDER un achat. Les demandes ont déménagé dans « Mon espace », la
 * page refuse désormais l'entrée sans `GENERAL_MEANS`, et le menu promettait donc un écran qui
 * répond « ce n'est pas pour vous ».
 *
 * Le coût réel n'est pas la porte inutile : c'est que la console PARAISSAIT ne pas marcher. On
 * bloque, on regarde, le module est toujours là — et l'on cesse de se servir de l'écran des
 * accès. Une entrée de menu qui ne suit pas son module fait mentir tout le reste.
 */
describe("une entrée de menu porte le MÊME module que sa page", () => {
  it("MOYENS GÉNÉRAUX : bloqué dans la console = absent du menu", () => {
    // Le compte a tout le reste — poste de travail compris : c'est exactement le cas rapporté.
    const labels = accessible(["WORKSPACE", "VALIDATIONS", "NOTIFICATIONS", "DOSSIERS"]).map((n) => n.label);
    expect(labels).not.toContain("Moyens généraux");
  });

  it("…et l'entrée revient dès que le module est accordé", () => {
    expect(accessible(["GENERAL_MEANS"]).map((n) => n.label)).toContain("Moyens généraux");
  });

  it("l'ANNUAIRE d'entreprise est un ONGLET de « Mon espace », dans son périmètre", () => {
    // Il a quitté les Moyens généraux : c'est un carnet d'adresses que tout le monde consulte,
    // pas un outil de caisse. Le laisser hors du `match` ferait se désélectionner le menu en y
    // entrant, sur un écran qu'on vient pourtant d'ouvrir.
    const mg = NAVIGATION.find((n) => n.href === "/moyens-generaux")!;
    expect(mg.module).toBe("GENERAL_MEANS");
    expect(mg.match ?? []).not.toContain("/moyens-generaux/annuaire");
    // EN-TÊTE / HAUT DU MODULE (04/10) : aucun sous-menu ni onglet — le seul geste du haut de la page est
    // le catalogue d'articles (bouton de la page). Les autres onglets/sous-menus ne reviennent pas.
    expect(mg.tabs ?? [], "le module n'a pas d'onglets").toEqual([]);
    expect(mg.children ?? [], "le module n'a pas de sous-menus").toEqual([]);
    const espace = NAVIGATION.find((n) => n.href === "/mon-espace")!;
    // 06/10 : l'annuaire n'est plus un onglet de « Mon espace » ni de la Promotion médicale (il vit dans Annuaires).
    expect((espace.tabs ?? []).map((t) => t.href)).not.toContain("/mon-espace/annuaire");
    const medical = NAVIGATION.find((n) => n.module === "MEDICAL" && (n.tabs ?? []).length > 0)!;
    expect((medical.tabs ?? []).map((t) => t.href)).not.toContain("/medical/annuaire");
  });
});

describe("poleOfPath — le tiroir de la page courante s'ouvre tout seul", () => {
  const poles = groupIntoPoles(accessible([...MODULES]));

  it("retrouve le pôle d'une route, y compris sur une sous-page", () => {
    expect(poleOfPath(poles, "/regulatory")).toBe("REGULATORY");
    expect(poleOfPath(poles, "/pch/abc123")).toBe("OPERATIONS_SALES");
    expect(poleOfPath(poles, "/business-units/secteurs")).toBe("OPERATIONS_SALES");
    expect(poleOfPath(poles, "/site-web")).toBe("MARKETING");
    expect(poleOfPath(poles, "/logistics")).toBe("OPERATIONS_SALES");
    expect(poleOfPath(poles, "/stocks/demandes")).toBe("OPERATIONS_SALES");
    expect(poleOfPath(poles, "/moyens-generaux")).toBe("ADMINISTRATION");
  });

  it("préfère la correspondance la plus PRÉCISE", () => {
    // « /regulatory/enregistrement » appartient au même pôle, mais par une entrée distincte.
    expect(poleOfPath(poles, "/regulatory/enregistrement")).toBe("REGULATORY");
  });

  it("rend null hors des pôles plutôt que d'en ouvrir un au hasard", () => {
    expect(poleOfPath(poles, "/mon-travail")).toBeNull();
    expect(poleOfPath(poles, "/inconnu")).toBeNull();
  });
});

describe("alias de recherche — les anciens noms restent trouvables", () => {
  it("« congrès international » mène toujours à Ad & Pro", () => {
    const hits = aliasMatches("congrès international");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].href).toBe("/sponsoring");
  });

  it("ignore la casse et les accents — personne ne tape les accents dans une recherche", () => {
    expect(aliasMatches("CONGRES").length).toBeGreaterThan(0);
    // « dédouanement » menait à Commandes & logistique, RETIRÉ du service : l'alias est parti
    // avec l'écran. Un raccourci vers une page interdite est pire qu'un raccourci absent — on
    // tape, on est renvoyé, et l'on croit à une panne de droits.
    expect(aliasMatches("dedouanement")).toEqual([]);
    expect(aliasMatches("Événement")[0].href).toBe("/sponsoring");
    expect(aliasMatches("marche")[0].href).toBe("/pch");
  });

  it("« administration » propose la Console d'Administration sans masquer l'ambiguïté", () => {
    expect(aliasMatches("administration").some((h) => h.href === "/admin")).toBe(true);
  });

  it("ne répond pas à une saisie d'un seul caractère", () => {
    expect(aliasMatches("a")).toEqual([]);
  });
});

describe("aucune route n'a changé — les liens historiques restent valides", () => {
  it("les routes des pôles restent atteignables depuis la navigation", () => {
    // Une entrée de menu peut pointer ailleurs qu'avant (Ad & Pro ouvre désormais sur la vue
    // unifiée `/ad-pro`), mais la route historique doit rester JOIGNABLE — sinon un lien envoyé
    // par courriel il y a six mois tombe dans le vide. On accepte donc qu'elle soit portée par
    // l'entrée elle-même, par ses ONGLETS, ou par ses routes de correspondance.
    const reachable = new Set<string>();
    for (const n of NAVIGATION.filter((x) => x.pole)) {
      reachable.add(n.href);
      for (const t of n.tabs ?? []) reachable.add(t.href);
      for (const m of n.match ?? []) reachable.add(m);
    }
    for (const expected of [
      "/regulatory", "/regulatory/enregistrement", "/moyens-generaux", "/finances", "/rh",
      "/budgets", "/sales", "/medical", "/planning", "/field-reports", "/sponsoring",
      "/information-medicale", "/pch", "/logistics", "/stocks",
      // BUSINESS_DEVELOPMENT est retiré du service et sa racine n'a plus d'entrée : c'est
      // « Projets », le sous-module qui lui survit, qui porte désormais le pôle
      // (`modules-retired.ts`, SOUS_MODULES_MAINTENUS).
      "/business-development/projets",
    ]) {
      expect(reachable, expected).toContain(expected);
    }
  });

  it("Ad & Pro ouvre sur la vue unifiée, sans faire disparaître les écrans par nature", () => {
    const adPro = NAVIGATION.find((n) => n.label === "Ad & Pro");
    expect(adPro?.href).toBe("/ad-pro");
    const tabs = (adPro?.tabs ?? []).map((t) => t.href);
    for (const nature of ["/sponsoring", "/congress-international", "/congress-national", "/events", "/promo-material"]) {
      expect(tabs, nature).toContain(nature);
    }
  });
});

describe("Finances — deux écrans, et cliquer le module conduit au travail", () => {
  const finances = NAVIGATION.find((n) => n.label === "Finances");

  it("CLIQUER « FINANCES » MÈNE À « BANQUE & PAIEMENTS »", () => {
    // Le tableau de bord ne portait aucun geste : on y regardait, puis on allait travailler
    // ailleurs. L'entrée parente ne doit donc pas ouvrir une page d'accueil qu'il faut quitter.
    expect(finances?.href).toBe("/finances/paiements-a-faire");
  });

  it("LE « DASHBOARD » N'EST PLUS UN SOUS-MODULE, et ceux qui restent sont nommés", () => {
    const enfants = (finances?.children ?? []).map((c) => c.label);
    expect(enfants).not.toContain("Dashboard");
    // « Bons de commande » a quitté les Finances (§118.176) : un module À PART, et non plus un
    // troisième sous-module — sinon il s'ouvrirait encore à quiconque lit les Finances.
    // « Doublons de factures » (Direction, 14/10/2026) : le recensement unique des doublons, en lecture seule.
    expect(enfants).toEqual(["Banque & paiements", "Comptabilité", "Doublons de factures"]);
  });

  it("LES BONS DE COMMANDE SONT UN MODULE À PART — leur propre entrée, leur propre droit (§118.176)", () => {
    // « Le module bon de commande doit être à part et le super admin donne les accès à qui il
    // veut. » L'entrée suit le module `PURCHASE_ORDERS`, réglé dans Administration › Accès, et pas
    // les Finances : sans cela, la donner à quelqu'un qui n'a pas les Finances serait impossible,
    // et la retirer à quelqu'un qui les a aussi.
    const bc = NAVIGATION.find((n) => n.label === "Bons de commande");
    expect(bc, "une entrée de premier niveau, pas un sous-menu des Finances").toBeDefined();
    expect(bc?.module).toBe("PURCHASE_ORDERS");
    expect(bc?.href).toBe(CHEMIN_BONS_DE_COMMANDE);
    expect(bc?.pole, "le pôle où on la cherchait hier : Administration").toBe("ADMINISTRATION");
    const sousFinances = (finances?.children ?? []).some((c) => c.href === CHEMIN_BONS_DE_COMMANDE || c.label === "Bons de commande");
    expect(sousFinances, "plus aucun chemin vers la file depuis les Finances").toBe(false);
  });

  it("L'ANCIENNE ADRESSE RESTE DANS LE PÉRIMÈTRE — le menu ne se désélectionne pas", () => {
    // `/finances` survit par une redirection : notifications parties, liens copiés, favoris. Si
    // l'adresse sortait du `match`, l'entrée du menu s'éteindrait en y arrivant, et l'on se
    // croirait ailleurs que dans les Finances.
    expect(finances?.match ?? []).toContain("/finances");
  });
});

describe("l'onglet actif — le plus PRÉCIS, et lui seul (§118.164)", () => {
  // Les VRAIES barres (§118.173), et non une liste recopiée ici : celle d'hier rangeait le stock
  // sous /promo-material, et elle aurait continué de passer pendant que le menu montrait autre
  // chose. Deux sous-modules vivent sous l'adresse d'un autre : le catalogue sous le stock, et
  // « Autres demandes » sous « Toutes les demandes ».
  const ONGLETS = EVENTS_TABS.map((t) => t.href);
  const ONGLETS_STOCK = STOCK_PROMO_TABS.map((t) => t.href);

  it("un sous-module rangé sous l'adresse d'un autre n'allume que lui", () => {
    expect(ongletActif(CHEMIN_CATALOGUE_PROMO, ONGLETS_STOCK)).toBe(CHEMIN_CATALOGUE_PROMO);
    expect(ongletActif(CHEMIN_STOCK_PROMO, ONGLETS_STOCK)).toBe(CHEMIN_STOCK_PROMO);
    expect(ongletActif("/ad-pro/autres", ONGLETS)).toBe("/ad-pro/autres");
    expect(ongletActif("/ad-pro", ONGLETS)).toBe("/ad-pro");
  });

  it("une fiche sous un onglet allume cet onglet ; une adresse voisine ne l'allume pas", () => {
    expect(ongletActif("/promo-material/cmabc123", ONGLETS)).toBe("/promo-material");
    expect(ongletActif("/promo-material", ONGLETS)).toBe("/promo-material");
    expect(ongletActif("/promo-materiel", ONGLETS), "un préfixe de MOT n'est pas un préfixe d'adresse").toBeNull();
    expect(ongletActif("/finances", ONGLETS)).toBeNull();
  });

  it("la barre d'onglets lit cette règle — le POINT D'APPEL, pas seulement le corps (§118.49)", () => {
    const src = readFileSync("src/components/shared/module-tabs.tsx", "utf8");
    expect(src).toMatch(/ongletActif\(pathname, visible\.map\(\(t\) => t\.href\)\)/);
    // L'onglet actif se DIT aussi aux lecteurs d'écran (et c'est ce que le banc navigateur lit) :
    // la couleur seule ne se lit pas.
    expect(src).toMatch(/aria-current=\{isActive\(t\.href\) \? "page" : undefined\}/);
    expect(src, "l'ancienne règle allumait deux onglets").not.toMatch(/pathname\.startsWith\(href \+ "\/"\)/);
  });
});
