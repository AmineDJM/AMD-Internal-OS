"use client";

import { Check, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { etapesDuPoste, faitsDuPoste } from "../../domaine/poste-etapes";
import { etapeAgence, friseAgence, LIBELLE_ETAPE_AGENCE } from "../../domaine/parcours-agence";
import { faitsAgenceDuPoste } from "./resume-poste";
import type { ItemRow } from "../items-panel";
import { DiscussionDuPoste } from "./discussion-poste";

/**
 * LE SUIVI SANS LES DÉTAILS (Direction, 15/11/2026) — ce que le délégué qui a signalé l'événement voit de ses postes : où en
 * est chacun, et l'étape en cours. Ni montants, ni devis, ni agences, ni pièces : il suit, il ne décide de rien. Il ÉCRIT,
 * en revanche, dans la discussion de chaque poste (Direction, 23/11/2026) — c'est là qu'il répond aux questions.
 */
export function SuiviSimple({ items, moiId, chemin }: { items: ItemRow[]; moiId?: string; chemin: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Les postes seront publiés par la Direction Marketing.</p>;
  return (
    <ul className="space-y-2">
      {items.map((it) => {
        const agence = faitsAgenceDuPoste(it);
        const etapes = agence
          ? friseAgence(agence).map((e) => ({ cle: e.cle, libelle: e.libelle, etat: e.etat }))
          : etapesDuPoste(faitsDuPoste(it)).map((e) => ({ cle: e.cle, libelle: e.libelle, etat: e.etat }));
        const enCours = agence ? LIBELLE_ETAPE_AGENCE[etapeAgence(agence)] : etapes.find((e) => e.etat === "EN_COURS")?.libelle ?? (etapes.every((e) => e.etat === "FAIT") ? "Terminé" : "À venir");
        return (
          <li key={it.id} className="space-y-1.5 rounded-xl border border-border bg-card p-3">
            <p className="font-medium">{it.label} <span className="text-xs font-normal text-muted-foreground">· {ITEM_KIND_LABELS[it.kind]}</span></p>
            <ol className="flex flex-wrap gap-1.5" aria-label="Étapes">
              {etapes.map((e) => (
                <li key={e.cle} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                  e.etat === "FAIT" && "bg-success/10 text-success", e.etat === "EN_COURS" && "bg-primary text-primary-foreground",
                  e.etat === "REFUSE" && "bg-destructive/10 text-destructive", e.etat === "A_VENIR" && "bg-secondary text-muted-foreground")}>
                  {e.etat === "FAIT" && <Check className="h-3 w-3" />}{e.libelle}
                </li>
              ))}
            </ol>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" /> En ce moment : {enCours}</p>
            <div className="border-t border-border/70"><DiscussionDuPoste item={it} moiId={moiId} chemin={chemin} /></div>
          </li>
        );
      })}
    </ul>
  );
}
