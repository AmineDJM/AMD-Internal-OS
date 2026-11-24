import { describe, it, expect } from "vitest";
import {
  EMPTY_FILTERS,
  legalListScope,
  initialLegalListState,
  syncLegalListState,
  visibleLegalRows,
  hasActiveFilter,
  describeActiveFilters,
  type LegalListRow,
  type LegalListState,
} from "./list-view";

/**
 * LE BOGUE DES DOCUMENTS « DISPARUS », REJOUÉ.
 *
 * Ces tests reconstituent la SÉQUENCE exacte qui le produisait — arriver par un rappel
 * d'échéance, puis ouvrir un dossier — et non un état final choisi pour passer. Sans le
 * correctif, le cas nommé « LE BOGUE » ci-dessous échoue : six bons de commande servis par le
 * serveur, zéro affiché.
 *
 * Les données sont celles de la capture du PDG : un dossier « Bons de commande » qui contient
 * six BC, aucun proche de son échéance.
 */

function bc(n: number): LegalListRow {
  return {
    id: `bc-${n}`,
    reference: `BC-2026-${String(n).padStart(3, "0")}`,
    title: `Bon de commande ${n}`,
    kind: "PURCHASE_ORDER",
    counterparty: "Kwality",
    startDate: "2026-01-05T00:00:00.000Z",
    endDate: null, // un BC n'a pas d'échéance : il ne sera JAMAIS « à surveiller »
    status: "ACTIVE",
    expiry: "NONE",
    daysLeft: null,
    amount: 120_000,
    driveNodeId: `node-${n}`,
    driveName: `BC-${n}.pdf`,
    renewedFromTitle: null,
    restricted: false,
    paidDate: null,
    expenseOrderId: null,
  };
}

/** Un bail qui expire bientôt — lui EST « à surveiller ». */
const BAIL_URGENT: LegalListRow = {
  ...bc(99),
  id: "bail-1",
  reference: "BAIL-2026-001",
  title: "Bail Alger-Centre",
  kind: "LEASE",
  endDate: "2026-10-01T00:00:00.000Z",
  expiry: "SOON",
  daysLeft: 36,
};

const SIX_BC = [bc(1), bc(2), bc(3), bc(4), bc(5), bc(6)];

const SCOPE_TOUS = legalListScope({ folderId: null });
const SCOPE_ECHEANCES = legalListScope({ folderId: null, fromExpiryAlert: true });
const SCOPE_DOSSIER_BC = legalListScope({ folderId: "folder-bc" });

describe("Legal — le périmètre d'une liste", () => {
  it("distingue « tous », « un dossier », « non classés » et « arrivée par une échéance »", () => {
    const scopes = [
      SCOPE_TOUS,
      SCOPE_ECHEANCES,
      SCOPE_DOSSIER_BC,
      legalListScope({ folderId: null, unfiledOnly: true }),
      legalListScope({ folderId: "folder-baux" }),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe("Legal — LE BOGUE : des documents servis mais masqués par un filtre d'un autre écran", () => {
  it("LE BOGUE : arriver par un rappel d'échéance puis ouvrir un dossier n'efface plus la liste", () => {
    // 1. Le PDG clique la notification « échéances » : le filtre « à surveiller » se pose.
    let state = initialLegalListState(SCOPE_ECHEANCES, true);
    expect(state.watchOnly).toBe(true);
    // Sur cet écran-là, c'est le comportement voulu : seul le bail urgent s'affiche.
    expect(visibleLegalRows([...SIX_BC, BAIL_URGENT], state)).toHaveLength(1);

    // 2. Il clique le dossier « Bons de commande ». Le composant reste MONTÉ (navigation
    //    <Link>), mais le périmètre servi a changé.
    state = syncLegalListState(state, SCOPE_DOSSIER_BC, false);

    // 3. Les six bons de commande servis par le serveur sont TOUS affichés.
    //    Sans le correctif : 0 sur 6, et « Aucun document ne correspond à ces filtres ».
    expect(state.watchOnly).toBe(false);
    expect(visibleLegalRows(SIX_BC, state)).toHaveLength(6);
  });

  it("DÉMONSTRATION du mécanisme : sans la synchronisation, les six BC restent invisibles", () => {
    // Ce que faisait l'ancien composant : `useState(watchByDefault)` ne se rejoue pas au
    // changement de propriété, donc l'état traversait la navigation tel quel. On le reproduit
    // ici en OMETTANT `syncLegalListState` — c'est exactement la ligne qui manquait.
    const etatQuiSurvit = initialLegalListState(SCOPE_ECHEANCES, true);
    expect(visibleLegalRows(SIX_BC, etatQuiSurvit)).toHaveLength(0);

    // Le correctif est cette seule opération — et elle rend les six documents.
    const etatSynchronise = syncLegalListState(etatQuiSurvit, SCOPE_DOSSIER_BC, false);
    expect(visibleLegalRows(SIX_BC, etatSynchronise)).toHaveLength(6);
  });

  it("un filtre de colonne ne survit pas non plus au changement de dossier", () => {
    let state = initialLegalListState(SCOPE_DOSSIER_BC, false);
    state = { ...state, filters: { ...EMPTY_FILTERS, title: "introuvable-ailleurs" } };
    expect(visibleLegalRows(SIX_BC, state)).toHaveLength(0);

    state = syncLegalListState(state, legalListScope({ folderId: "folder-baux" }), false);
    expect(visibleLegalRows(SIX_BC, state)).toHaveLength(6);
  });

  it("dans le MÊME périmètre, l'état du PDG lui appartient — un rafraîchissement ne l'efface pas", () => {
    // `router.refresh()` après « Renouveler » re-rend avec le MÊME périmètre : perdre le filtre
    // que le PDG venait de poser serait un second bogue, symétrique du premier.
    const posee: LegalListState = {
      scope: SCOPE_DOSSIER_BC,
      filters: { ...EMPTY_FILTERS, counterparty: "Kwality" },
      watchOnly: false,
      unpaidOnly: false,
    };
    const apresRefresh = syncLegalListState(posee, SCOPE_DOSSIER_BC, false);
    expect(apresRefresh).toBe(posee); // même référence : aucun re-rendu inutile
    expect(apresRefresh.filters.counterparty).toBe("Kwality");
  });

  it("la séquence complète de la mission : onglet → retour → autre écran → retour → rechargement", () => {
    const rows = SIX_BC;
    let state = initialLegalListState(SCOPE_DOSSIER_BC, false);
    const visibles = () => visibleLegalRows(rows, state).length;

    expect(visibles()).toBe(6); // ouverture du dossier

    // « Tous les engagements » puis retour au dossier.
    state = syncLegalListState(state, SCOPE_TOUS, false);
    expect(visibles()).toBe(6);
    state = syncLegalListState(state, SCOPE_DOSSIER_BC, false);
    expect(visibles()).toBe(6);

    // Détour par l'écran des échéances, puis retour au dossier.
    state = syncLegalListState(state, SCOPE_ECHEANCES, true);
    expect(visibleLegalRows(rows, state)).toHaveLength(0); // normal : aucun BC n'est urgent
    state = syncLegalListState(state, SCOPE_DOSSIER_BC, false);
    expect(visibles()).toBe(6); // …et le retour les remontre TOUS

    // Rechargement complet du navigateur : le composant est remonté à neuf.
    state = initialLegalListState(SCOPE_DOSSIER_BC, false);
    expect(visibles()).toBe(6);

    // Un aller-retour répété ne dégrade rien (le bogue apparaissait « par intermittence »).
    for (let i = 0; i < 25; i += 1) {
      state = syncLegalListState(state, SCOPE_ECHEANCES, true);
      state = syncLegalListState(state, SCOPE_DOSSIER_BC, false);
      expect(visibles(), `itération ${i}`).toBe(6);
    }
  });
});

describe("Legal — les filtres continuent de filtrer (le correctif ne les a pas neutralisés)", () => {
  const rows = [...SIX_BC, BAIL_URGENT];
  const base = initialLegalListState(SCOPE_TOUS, false);

  it("« à surveiller » isole ce qui expire", () => {
    const s = { ...base, watchOnly: true };
    expect(visibleLegalRows(rows, s).map((r) => r.id)).toEqual(["bail-1"]);
  });

  it("la nature, la partie, la référence et le titre filtrent", () => {
    expect(visibleLegalRows(rows, { ...base, filters: { ...EMPTY_FILTERS, kind: "LEASE" } })).toHaveLength(1);
    expect(visibleLegalRows(rows, { ...base, filters: { ...EMPTY_FILTERS, counterparty: "kwality" } })).toHaveLength(7);
    expect(visibleLegalRows(rows, { ...base, filters: { ...EMPTY_FILTERS, reference: "BC-2026-003" } })).toHaveLength(1);
    expect(visibleLegalRows(rows, { ...base, filters: { ...EMPTY_FILTERS, title: "Bail" } })).toHaveLength(1);
  });

  it("le mois d'échéance filtre, et un document SANS date n'y entre jamais", () => {
    const s = { ...base, filters: { ...EMPTY_FILTERS, endMonth: "2026-10" } };
    expect(visibleLegalRows(rows, s).map((r) => r.id)).toEqual(["bail-1"]);
  });

  it("aucun filtre = tout est affiché", () => {
    expect(visibleLegalRows(rows, base)).toHaveLength(rows.length);
    expect(hasActiveFilter(base)).toBe(false);
  });
});

describe("Legal — l'écran vide DIT pourquoi il est vide", () => {
  it("nomme le filtre qui masque, plutôt que d'accuser les données", () => {
    const s: LegalListState = {
      scope: SCOPE_DOSSIER_BC,
      filters: { ...EMPTY_FILTERS, counterparty: "Sanofi" },
      watchOnly: true,
      unpaidOnly: false,
    };
    const raisons = describeActiveFilters(s);
    expect(raisons.join(" ")).toContain("à surveiller");
    expect(raisons.join(" ")).toContain("Sanofi");
  });

  it("sans filtre, il n'y a rien à nommer — la liste est vraiment vide", () => {
    expect(describeActiveFilters(initialLegalListState(SCOPE_TOUS, false))).toEqual([]);
  });
});

describe("« TVA à compléter » (lot « tva ») — les factures que la G50 ne peut pas compter", () => {
  const facture = (id: string, tva: LegalListRow["tva"], status = "ACTIVE"): LegalListRow => ({ ...bc(1), id, kind: "INVOICE", status, tva });
  it("ne garde que les factures et avoirs non annulés dont la TVA manque ou est à revoir — et se nomme", () => {
    const rows = [
      facture("a-completer", { ht: null, tva: null, aCompleter: "TVA_NON_RENSEIGNEE", phrase: "TVA non renseignée" }),
      facture("complete", { ht: 100, tva: 19, aCompleter: null, phrase: null }),
      facture("annulee", { ht: null, tva: null, aCompleter: "TVA_NON_RENSEIGNEE", phrase: "x" }, "CANCELLED"),
      bc(2),
    ];
    const state: LegalListState = { ...initialLegalListState("all|tous|INVOICE", false), tvaOnly: true };
    expect(visibleLegalRows(rows, state).map((r) => r.id)).toEqual(["a-completer"]);
    expect(hasActiveFilter(state)).toBe(true);
    expect(describeActiveFilters(state)).toContain("TVA à compléter");
  });
});
