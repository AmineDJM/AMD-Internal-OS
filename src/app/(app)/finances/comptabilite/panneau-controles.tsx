"use client";

import { X } from "lucide-react";
import type { DonneesComptabilite } from "@/modules/finances/api";
import { cn } from "@/lib/utils";
import { BoutonSecondaire } from "./elements";

const BLOCS = [
  { kind: "MISSING_ENTRY", titre: "Paiement réglé sans écriture", ok: "Tous les ordres payés ont leur écriture." },
  { kind: "DOUBLE_ORDER", titre: "Même source payée deux fois", ok: "Rien à signaler." },
  { kind: "DUPLICATE_ENTRY", titre: "Écritures en double", ok: "Rien à signaler." },
] as const;

/**
 * LES CONTRÔLES DU LIVRE — rangés sous « ⋯ » (maquette validée, 24/11/2026), sans rien perdre : les trois questions
 * d'avant (`auditLedger`), sur la société de l'écran. Chaque point ouvre les écritures en cause ; rien ne s'efface ici,
 * un doublon apparent se tranche pièce en main (contre-passation).
 */
export function PanneauControles({ controles, onFermer, onOuvrir, onRelancer }: {
  controles: DonneesComptabilite["controles"]; onFermer: () => void; onOuvrir: (id: string) => void; onRelancer: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2.5">
        <h2 className="text-[19px] font-bold">Contrôles du livre</h2>
        <button type="button" onClick={onFermer} aria-label="Fermer les contrôles" className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg border border-border">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-2.5">
        {BLOCS.map((b) => {
          const points = controles.points.filter((p) => p.kind === b.kind);
          return (
            <div key={b.kind} className={cn("rounded-[10px] border p-3", points.length ? "border-warning/50 bg-warning/5" : "border-border")}>
              <div className="flex justify-between gap-2 text-sm">
                <strong>{b.titre}</strong>
                <span className={cn("font-bold", points.length ? "text-warning" : "text-success")}>{points.length ? points.length : "✓ 0"}</span>
              </div>
              {points.length === 0 ? (
                <p className="mt-1 text-[13px] text-muted-foreground">{b.ok}</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {points.slice(0, 12).map((p, i) => (
                    <li key={i} className="text-[13px]">
                      <p className="font-medium [overflow-wrap:anywhere]">{p.titre}</p>
                      <p className="text-muted-foreground [overflow-wrap:anywhere]">{p.detail}</p>
                      {p.ouvrir.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {p.ouvrir.map((o) => (
                            <button key={o.id} type="button" onClick={() => onOuvrir(o.id)} className="h-8 rounded-lg border border-border bg-card px-2.5 text-[13px] font-semibold">Ouvrir {o.reference}</button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                  {points.length > 12 && <li className="text-xs text-muted-foreground">… et {points.length - 12} autre(s).</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <span className="text-[13px] text-muted-foreground">Dernier passage : {controles.passage}</span>
        <BoutonSecondaire onClick={onRelancer}>Relancer les contrôles</BoutonSecondaire>
      </div>
    </>
  );
}
