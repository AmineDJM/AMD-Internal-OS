"use client";

import { useKeyedAction } from "@/components/shared/use-action";
import { Loader2, Users } from "lucide-react";
import { setTenderLineBusinessUnits } from "@/lib/actions/pch-tender-line-actions";
import { needsAllocation, allocationNotice } from "@/lib/pch/bu-allocation";

export interface AllocLine {
  id: string;
  designation: string;
  status: string;
  businessUnitIds: string[];
}

export interface AllocBu {
  id: string;
  name: string;
  color: string | null;
}

/**
 * AFFECTATIONS — qui PORTE chaque produit du marché.
 *
 * ── LE MAILLON QUI MANQUAIT ─────────────────────────────────────────────────────────────────
 *
 * On gagne un lot ; quelqu'un doit le vendre. La force de vente sait attribuer un produit à un
 * délégué — elle a son écran et ses cycles. Ce qui manquait était le maillon d'AVANT : rien ne
 * disait quelle gamme portait quel lot, et les produits gagnés n'apparaissaient dans aucun
 * portefeuille. On les répartissait de vive voix, et trois mois plus tard personne ne savait qui
 * suivait quoi.
 *
 * ── POURQUOI PAR PRODUIT, ET PLUSIEURS ──────────────────────────────────────────────────────
 *
 * Le marché portait UNE Business Unit pour ses vingt lots — l'oncologie et l'anti-infectieux dans
 * le même bordereau, rattachés à la même équipe. L'affectation se fait donc produit par produit,
 * et un produit peut être porté par DEUX gammes (une ville, une hôpital sur la même molécule).
 *
 * ── L'ALERTE NE CRIE QUE SUR CE QUI COMPTE ──────────────────────────────────────────────────
 *
 * Un lot perdu, annulé ou encore à l'étude n'a personne à qui être confié : seuls les lots GAGNÉS
 * sans Business Unit sont signalés. Signaler les autres ferait crier l'écran sur dix-neuf lignes
 * qui vont très bien, et l'on cesserait de lire l'alerte le jour où elle compte.
 */
export function AllocationsPanel({
  tenderId, lines, businessUnits, canEdit,
}: {
  tenderId: string;
  lines: AllocLine[];
  businessUnits: AllocBu[];
  canEdit: boolean;
}) {
  const { busy, error: err, run } = useKeyedAction();

  const gagnes = lines.filter((l) => l.status === "WON").length;
  const orphelins = lines.filter((l) => needsAllocation(l.status, l.businessUnitIds.length)).length;
  const notice = allocationNotice(gagnes, orphelins);

  async function toggle(line: AllocLine, buId: string, checked: boolean) {
    if (busy) return;
    const voulu = checked
      ? [...new Set([...line.businessUnitIds, buId])]
      : line.businessUnitIds.filter((v) => v !== buId);
    const fd = new FormData();
    fd.set("id", line.id); fd.set("tenderId", tenderId);
    for (const v of voulu) fd.append("businessUnitId", v);
    await run(line.id, async () => {
      const r = await setTenderLineBusinessUnits(fd);
      return r.ok ? r : { ...r, error: r.error ?? "Affectation impossible." };
    });
  }

  if (businessUnits.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Users className="h-4 w-4 text-primary" /> Affectations</h3>
        {/* AUCUNE BU N'EXISTE : on le DIT et l'on nomme l'écran qui en crée. Une liste vide sans
            explication se lit comme une panne, et l'on cherche le défaut ailleurs. */}
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Aucune Business Unit active. Créez-en dans Business Units : c&apos;est là
          que se décide qui porte quelle gamme.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Users className="h-4 w-4 text-primary" /> Affectations ({lines.length} produit·s)</h3>
        {notice && <p className={`text-xs ${orphelins > 0 ? "text-warning" : "text-muted-foreground"}`}>{notice}</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        Un produit confié à une Business Unit entre dans son portefeuille. La force de vente
        l&apos;attribue ensuite à ses KAM depuis <strong>Force de vente → Affectations</strong> —
        c&apos;est le même circuit que pour les autres produits, pas un second.
      </p>

      {err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Aucun produit sur ce marché — ajoutez-les d&apos;abord dans « Produits du marché ».
        </p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((l) => {
            const manque = needsAllocation(l.status, l.businessUnitIds.length);
            return (
              <li
                key={l.id}
                className={`rounded-lg border px-3 py-2 ${manque ? "border-warning/50 bg-warning/5" : "border-border bg-card"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere] sm:truncate">{l.designation}</span>
                  {busy === l.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  {manque && <span className="rounded bg-warning/20 px-2 py-0.5 text-[0.6875rem] text-warning">gagné, sans BU</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {businessUnits.map((b) => {
                    const on = l.businessUnitIds.includes(b.id);
                    return (
                      <label
                        key={b.id}
                        className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors sm:min-h-0 sm:px-2 ${
                          on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"
                        } ${canEdit ? "" : "pointer-events-none opacity-70"}`}
                      >
                        <input
                          type="checkbox" checked={on} disabled={!canEdit || busy !== null}
                          onChange={(e) => void toggle(l, b.id, e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-input"
                        />
                        {b.color && <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: b.color }} />}
                        {b.name}
                      </label>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
