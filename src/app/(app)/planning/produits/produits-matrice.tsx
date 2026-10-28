"use client";

import * as React from "react";
import { Loader2, CopyPlus } from "lucide-react";
import { saveAssignment, deleteAssignment, carryForwardAssignments } from "@/lib/actions/sales-planning-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";

/**
 * PRODUITS PAR DÉLÉGUÉ (Direction, 07/10) — une matrice délégué × produit, une case = le rang du produit dans sa
 * mallette (P1, P2, P3 ou rien). Pas d'objectif ni de visites prévues : le requis vient de la segmentation. Choisir un
 * rang l'enregistre ; « — » retire le produit. Les visites prévues d'une affectation existante sont gardées telles quelles.
 */

export interface KamProduits { repId: string; nom: string; secteurNom: string | null; modifiable: boolean }
export interface ProduitColonne { id: string; nom: string }
export interface Affectation { repId: string; productId: string; position: number; plannedVisits: number }

const cle = (repId: string, productId: string) => `${repId}::${productId}`;
const PILLE: Record<number, string> = { 1: "bg-primary/10 text-primary", 2: "bg-violet-500/10 text-violet-600 dark:text-violet-300", 3: "bg-muted text-muted-foreground" };

export function ProduitsMatrice({ cycleId, kams, produits, affectations }: {
  cycleId: string; kams: KamProduits[]; produits: ProduitColonne[]; affectations: Affectation[];
}) {
  const { rafraichir, enCours } = useRafraichir();
  // Une cellule de la matrice n'a pas de place où parler : un refus part en avis flottant.
  const retours = useRetours();
  const [etat, setEtat] = React.useState(() => new Map(affectations.map((a) => [cle(a.repId, a.productId), a])));
  const [ecrit, setEcrit] = React.useState<string | null>(null);
  React.useEffect(() => { setEtat(new Map(affectations.map((a) => [cle(a.repId, a.productId), a]))); }, [affectations]);

  async function changer(repId: string, productId: string, valeur: string) {
    const k = cle(repId, productId);
    const avant = etat.get(k);
    const fd = new FormData();
    fd.set("cycleId", cycleId); fd.set("repId", repId); fd.set("productId", productId);
    setEcrit(k);
    let r: { ok: boolean; error?: string } = { ok: false };
    try {
      if (valeur === "") {
        r = await deleteAssignment(fd);
      } else {
        fd.set("position", valeur);
        fd.set("plannedVisits", String(avant?.plannedVisits ?? 0));
        r = await saveAssignment(fd);
      }
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
      return;
    } finally {
      setEcrit(null);
    }
    if (!r.ok) { retours.erreur(r.error ?? "Enregistrement impossible."); return; }
    setEtat((m) => {
      const n = new Map(m);
      if (valeur === "") n.delete(k); else n.set(k, { repId, productId, position: Number(valeur), plannedVisits: avant?.plannedVisits ?? 0 });
      return n;
    });
    rafraichir();
  }

  return (
    <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
      <table className="w-full border-collapse text-sm" style={{ minWidth: `${220 + produits.length * 120}px` }}>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="sticky left-0 z-[1] whitespace-nowrap bg-card px-3 py-2 font-medium">Délégué</th>
            {produits.map((p) => <th key={p.id} className="px-2 py-2 text-center font-medium">{p.nom}</th>)}
          </tr>
        </thead>
        <tbody>
          {kams.map((k) => (
            <tr key={k.repId} className="border-t border-border">
              <td className="sticky left-0 z-[1] bg-card px-3 py-2">
                <span className="block font-medium [overflow-wrap:anywhere]">{k.nom}</span>
                {k.secteurNom && <small className="block text-xs text-muted-foreground">{k.secteurNom}</small>}
              </td>
              {produits.map((p) => {
                const a = etat.get(cle(k.repId, p.id));
                const k2 = cle(k.repId, p.id);
                return (
                  <td key={p.id} className="px-2 py-2 text-center">
                    {k.modifiable ? (
                      <span className="inline-flex items-center gap-1">
                        <select
                          value={a ? String(a.position) : ""}
                          disabled={ecrit !== null || enCours}
                          onChange={(e) => void changer(k.repId, p.id, e.target.value)}
                          aria-label={`Rang de ${p.nom} pour ${k.nom}`}
                          className={cn("h-8 rounded-md border border-input bg-background px-1.5 text-xs font-medium", a ? PILLE[a.position] : "text-muted-foreground")}
                        >
                          <option value="">—</option>
                          <option value="1">P1</option>
                          <option value="2">P2</option>
                          <option value="3">P3</option>
                        </select>
                        {ecrit === k2 && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                      </span>
                    ) : a ? (
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", PILLE[a.position])}>P{a.position}</span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Reprendre <mois> » — les rangs du cycle précédent recopiés sans écraser ce qui existe (l'action existante). */
export function ReprendreMoisPrecedent({ cycleId, fromYear, fromMonth, libelle }: { cycleId: string; fromYear: number; fromMonth: number; libelle: string }) {
  const { rafraichir, enCours } = useRafraichir();
  // Le bouton n'a pas de place où parler : un refus part en avis flottant.
  const retours = useRetours();
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button" disabled={busy || enCours}
      onClick={async () => {
        setBusy(true);
        const fd = new FormData();
        fd.set("toCycleId", cycleId); fd.set("fromYear", String(fromYear)); fd.set("fromMonth", String(fromMonth));
        try {
          const r = await carryForwardAssignments(fd);
          if (!r.ok) { retours.erreur(r.error ?? "Reprise impossible."); return; }
          rafraichir();
        } catch {
          retours.erreur(actionFailureMessage("THROWN"));
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-2.5 text-xs font-medium hover:bg-secondary disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CopyPlus className="h-3.5 w-3.5" />} Reprendre {libelle}
    </button>
  );
}
