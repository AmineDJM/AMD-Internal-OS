"use client";

import { DataTable, type Column } from "@/components/shared/data-table";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { adresseRegistre, CLE_NON_RATTACHES, type FiltresAvantages, type LigneRegistreAvantages } from "@/modules/ad-pro/partage";
import { LETTRES, type Lettre } from "@/lib/segmentation/regles";
import { formatDate, formatMontant } from "@/lib/utils";

/**
 * LE TABLEAU DU REGISTRE — recherche, tri et export CSV par le tableau commun (`DataTable` : cellules neutralisées par
 * `celluleCsv`). Une ligne ouvre la fiche du professionnel, filtres conservés.
 */

const pct = (p: number | null) => (p == null ? "—" : `${(p * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`);

export function TableauAvantages({ lignes, filtres, chemin, fichier }: { lignes: LigneRegistreAvantages[]; filtres: FiltresAvantages; chemin: string; fichier: string }) {
  const colonnes: Column<LigneRegistreAvantages>[] = [
    {
      key: "nom", header: "Professionnel", sortable: true, accessor: (l) => l.nom,
      render: (l) => (
        <div className="min-w-[12rem]">
          <p className={l.cle === CLE_NON_RATTACHES ? "font-medium italic" : "font-medium"}>{l.nom}</p>
          {l.cle === CLE_NON_RATTACHES
            ? <p className="max-w-[22rem] truncate text-xs text-muted-foreground" title={l.noms.join(", ")}>{l.noms.join(", ") || "—"}</p>
            : <p className="text-xs text-muted-foreground">{[l.specialite, l.etablissement].filter(Boolean).join(" · ") || "—"}</p>}
        </div>
      ),
    },
    { key: "specialite", header: "Spécialité", sortable: true, className: "hidden", accessor: (l) => l.specialite },
    { key: "etablissement", header: "Établissement", sortable: true, className: "hidden", accessor: (l) => l.etablissement },
    { key: "wilaya", header: "Wilaya", sortable: true, accessor: (l) => l.wilaya },
    {
      key: "lettre", header: "Lettre", sortable: true, align: "center", accessor: (l) => l.lettre,
      render: (l) => (l.lettre && (LETTRES as readonly string[]).includes(l.lettre) ? <LettreBadge lettre={l.lettre as Lettre} /> : <span className="text-muted-foreground">—</span>),
    },
    { key: "nombre", header: "Avantages", sortable: true, align: "right", accessor: (l) => l.nombre, render: (l) => <span className="tabular-nums">{l.nombre}</span> },
    { key: "paye", header: "Payé (DZD)", sortable: true, align: "right", accessor: (l) => l.payeDzd, render: (l) => <span className="font-semibold tabular-nums">{formatMontant(l.payeDzd)}</span> },
    {
      key: "reste", header: "Engagé non payé (DZD)", sortable: true, align: "right", accessor: (l) => l.resteDzd,
      render: (l) => <span className={l.resteDzd > 0 ? "tabular-nums text-warning" : "tabular-nums text-muted-foreground"}>{formatMontant(l.resteDzd)}</span>,
    },
    { key: "part", header: "Part du payé", sortable: true, align: "right", accessor: (l) => (l.part == null ? null : Math.round(l.part * 1000) / 10), render: (l) => <span className="tabular-nums">{pct(l.part)}</span> },
    {
      key: "dernier", header: "Dernier avantage", sortable: true, accessor: (l) => l.dernierLe?.slice(0, 10) ?? null,
      render: (l) => (
        <div className="min-w-[10rem]">
          <p className="tabular-nums">{formatDate(l.dernierLe)}</p>
          <p className="max-w-[16rem] truncate text-xs text-muted-foreground" title={l.dernierObjet ?? undefined}>{l.dernierObjet}</p>
        </div>
      ),
    },
  ];
  return (
    <DataTable
      columns={colonnes}
      rows={lignes}
      searchPlaceholder="Rechercher un professionnel, un établissement…"
      getRowHref={(l) => adresseRegistre(chemin, filtres, l.cle)}
      filename={fichier}
      pageSize={25}
      emptyTitle="Aucun avantage pour ces filtres"
      emptyDescription="Élargissez l'année ou retirez un filtre."
    />
  );
}
