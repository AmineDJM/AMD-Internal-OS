"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input, Select, Label } from "@/components/ui/input";
import {
  calculerRetenue, libelleTaux, natureDepense, naturesParFamille, phraseRangement, rechercherNatures,
  type RegimeRetenueSource, type TauxRetenue,
} from "@/modules/finances/partage";
import { formatCurrency } from "@/lib/utils";

/**
 * LA NATURE DE LA DÉPENSE — obligatoire (Super Admin, 24/11/2026) : une liste courte, groupée par famille, avec sa
 * recherche. Sous le choix, où la dépense se range au budget ; et pour une nature qui porte une RETENUE À LA SOURCE,
 * le brut, la retenue et le net à verser, au taux réglé — dit « à confirmer par le cabinet » tant qu'il ne l'est pas.
 * Le champ s'envoie sous le nom `natureDepense` ; le serveur revérifie (`refusNatureDemande`).
 */
export function NatureDepenseChamp({ value, onChange, montant, taux, id = "pay-nature-depense" }: {
  value: string;
  onChange: (code: string) => void;
  /** Le montant demandé (brut), pour l'aperçu de la retenue. */
  montant: number | null;
  taux: Record<RegimeRetenueSource, TauxRetenue>;
  id?: string;
}) {
  const [q, setQ] = React.useState("");
  const trouvees = rechercherNatures(q);
  const choisie = natureDepense(value);
  // La nature choisie reste dans la liste même quand la recherche l'écarte : un <select> sans sa valeur l'effacerait.
  const liste = choisie && !trouvees.includes(choisie) ? [choisie, ...trouvees] : trouvees;
  const t = choisie?.retenue ? taux[choisie.retenue] : null;
  const retenue = t && montant && montant > 0 ? calculerRetenue(montant, t.taux) : null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Nature de la dépense <span className="text-destructive">*</span></Label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher (loyer, médecin…)" className="pl-8"
            aria-label="Rechercher une nature de dépense"
          />
        </div>
        <Select id={id} name="natureDepense" value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">{liste.length ? "— Choisir la nature —" : "Aucune nature ne correspond"}</option>
          {naturesParFamille(liste).map((g) => (
            <optgroup key={g.famille} label={g.libelle}>
              {g.natures.map((x) => <option key={x.code} value={x.code}>{x.libelle}</option>)}
            </optgroup>
          ))}
        </Select>
      </div>
      {choisie && <p className="text-xs text-muted-foreground">{phraseRangement(choisie)} · pièce attendue : {choisie.piece.toLowerCase()}.</p>}
      {choisie?.retenue && t && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          <p className="font-medium text-foreground">Retenue à la source : {libelleTaux(t)}</p>
          {retenue ? (
            <p className="tabular-nums text-muted-foreground">
              Brut {formatCurrency(retenue.brut)} · retenue {formatCurrency(retenue.retenue)} · <strong className="text-foreground">net à verser {formatCurrency(retenue.net)}</strong>
            </p>
          ) : <p className="text-muted-foreground">Indiquez le montant brut (celui de la note d&apos;honoraires ou de la facture).</p>}
        </div>
      )}
    </div>
  );
}
