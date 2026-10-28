import type { MasseMensuelle } from "@/modules/finances/partage";

/**
 * LA MASSE SALARIALE, ENTITÉ PAR ENTITÉ ET MOIS PAR MOIS — « pour chaque entité avoir la masse
 * salariale MENSUELLE et ANNUELLE » (Direction, 04/10/2026).
 *
 * Elle n'a plus sa carte : elle est le PIED de la grille de paie (Direction, 07/10 — maquette « Paie »).
 * Le sélecteur d'entité de la grille la filtre ; ce module ne fait que choisir la ou les colonnes
 * calculées par la page (`masseMensuelleParEntite`) — aucun calcul de paie ici. Module PUR : la
 * grille, composant client, l'importe.
 */
export interface ColonneMasse {
  companyId: string | null;
  label: string;
  masse: MasseMensuelle;
}

/** Valeur du filtre d'entité pour les salariés rattachés à aucune entité. */
export const FILTRE_SANS_ENTITE = "__sans-entite";

const arrondi = (n: number) => Math.round(n * 100) / 100;

/**
 * La masse du filtre : une entité, les « sans entité », ou toutes (`""`) — la somme des colonnes,
 * au centime près.
 */
export function masseDuFiltre(colonnes: readonly ColonneMasse[], filtre: string): MasseMensuelle {
  const retenues = colonnes.filter((c) => (
    filtre === "" ? true : filtre === FILTRE_SANS_ENTITE ? c.companyId === null : c.companyId === filtre
  ));
  const mois = Array.from({ length: 12 }, (_, i) => ({
    cost: arrondi(retenues.reduce((a, c) => a + (c.masse.mois[i]?.cost ?? 0), 0)),
    net: arrondi(retenues.reduce((a, c) => a + (c.masse.mois[i]?.net ?? 0), 0)),
  }));
  return {
    mois,
    total: {
      cost: arrondi(retenues.reduce((a, c) => a + c.masse.total.cost, 0)),
      net: arrondi(retenues.reduce((a, c) => a + c.masse.total.net, 0)),
    },
  };
}
