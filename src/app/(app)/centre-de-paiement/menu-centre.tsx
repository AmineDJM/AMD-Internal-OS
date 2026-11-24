"use client";

import * as React from "react";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CENTRAL_STATUS_LABEL, type CentralStatus } from "@/modules/finances/partage";
import type { LigneHistoriqueCentre } from "@/modules/finances/api";

const TON: Partial<Record<CentralStatus, "success" | "danger" | "info">> = { APPROVED: "success", REFUSED: "danger", CHANGES_REQUESTED: "info", INFO_REQUESTED: "info" };

/**
 * LE MENU ⋯ DE L'EN-TÊTE (maquette du 24/11/2026) — ce qu'on consulte rarement et qui encombrait la file : les
 * paiements DÉJÀ DÉCIDÉS (ils sortent de « À décider » dès la décision) et l'export de l'entité.
 */
export function MenuCentre({ historique, exportHref }: { historique: LigneHistoriqueCentre[]; exportHref: string }) {
  const [ouvert, setOuvert] = React.useState(false);
  const fermer = React.useCallback(() => setOuvert(false), []);
  return (
    <>
      <MenuDossier label="Autres : déjà décidés, exporter" doigt>
        <button type="button" role="menuitem" onClick={() => setOuvert(true)} className="rounded-md px-2 py-2 text-left text-sm hover:bg-secondary">
          Déjà décidés · {historique.length}
        </button>
        {/* L'EXPORT DE CE QUE L'ÉCRAN MONTRE — l'entité choisie, toutes les lignes (K7, décision 0037). */}
        <a role="menuitem" href={exportHref} className="rounded-md px-2 py-2 text-sm hover:bg-secondary">Exporter</a>
      </MenuDossier>
      {ouvert && (
        <Sheet open onClose={fermer} title="Déjà décidés" width="md">
          {historique.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun paiement décidé pour cette entité.</p>
          ) : (
            <ul className="divide-y divide-border">
              {historique.map((h) => (
                <li key={h.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium [overflow-wrap:anywhere]">{h.objet}</p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {h.reference}{h.beneficiaire ? ` · ${h.beneficiaire}` : ""}
                      {h.decideLe ? ` · ${formatDate(h.decideLe)}` : ""}{h.decideur ? ` par ${h.decideur}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold tabular-nums">{formatCurrency(h.montant)}</p>
                    <Badge tone={TON[h.centralStatus as CentralStatus] ?? "neutral"} dot={false}>
                      {CENTRAL_STATUS_LABEL[h.centralStatus as CentralStatus] ?? h.centralStatus}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </>
  );
}
