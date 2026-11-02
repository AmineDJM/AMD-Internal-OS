import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { DataTable, type Column } from "./data-table";

/**
 * LE TABLEAU PARTAGÉ AU CLAVIER (audit 27/10/2026, FRONTEND-UX-03).
 *
 * `DataTable` sert les listes de sponsoring, de logistique, du grand livre, des budgets… Avant :
 * le tri vivait dans un `<th onClick>` (Tab ne s'y arrête pas, aucun `aria-sort`), la ligne
 * cliquable n'était qu'un `onClick` (impossible à ouvrir sans souris), la recherche n'avait pas de
 * nom accessible et les flèches de pagination étaient deux boutons muets.
 */
type Ligne = { id: string; nom: string; montant: number };
const colonnes: Column<Ligne>[] = [
  { key: "nom", header: "Nom", sortable: true },
  { key: "montant", header: "Montant" },
];
const routeur = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function rendu(rows: Ligne[], href = true) {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: routeur as never },
      React.createElement(DataTable<Ligne>, {
        columns: colonnes, rows, pageSize: 2,
        getRowHref: href ? (r: Ligne) => `/x/${r.id}` : undefined,
      }),
    ),
  );
}

const lignes: Ligne[] = [
  { id: "a", nom: "Alpha", montant: 1 }, { id: "b", nom: "Beta", montant: 2 }, { id: "c", nom: "Gamma", montant: 3 },
];

describe("DataTable — accessibilité clavier", () => {
  const html = rendu(lignes);

  it("une colonne triable est un vrai bouton, et l'en-tête dit l'état du tri", () => {
    expect(html).toMatch(/<th[^>]*aria-sort="none"[^>]*>\s*<button type="button"/);
  });
  it("une colonne non triable n'a ni bouton ni aria-sort", () => {
    expect(html).toMatch(/<th(?![^>]*aria-sort)[^>]*>Montant<\/th>/);
  });
  it("une ligne cliquable est atteignable au clavier", () => {
    expect(html.match(/<tr[^>]*tabindex="0"/g) ?? []).toHaveLength(2);
  });
  it("une ligne sans lien n'entre pas dans l'ordre de tabulation", () => {
    expect(rendu(lignes, false)).not.toMatch(/<tr[^>]*tabindex/);
  });
  it("la recherche et la pagination ont un nom", () => {
    expect(html).toMatch(/<input[^>]*aria-label="Rechercher…"/);
    expect(html).toMatch(/aria-label="Page précédente"/);
    expect(html).toMatch(/aria-label="Page suivante"/);
  });
});
