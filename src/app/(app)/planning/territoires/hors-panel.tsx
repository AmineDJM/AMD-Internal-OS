"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { affecterAuDelegue } from "@/lib/actions/force-de-vente-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import type { Lettre } from "@/lib/segmentation/regles";
import { sansBloquer } from "@/lib/journal";

/**
 * LES CIBLES HORS PANEL D'UN SECTEUR — le nombre ouvre la liste ; chaque ligne s'affecte en un clic au délégué du
 * secteur (ou toutes d'un coup). L'action refuse de réaffecter un praticien déjà suivi : la liste ne contient que des
 * praticiens sans délégué.
 */
export interface CibleHorsPanel { doctorId: string; nom: string; lieu: string | null; lettre: Lettre; statut: string | null }

export function HorsPanel({ secteur, delegue, cibles, peutAffecter }: {
  secteur: string;
  delegue: { id: string; nom: string } | null;
  cibles: CibleHorsPanel[];
  peutAffecter: boolean;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const { rafraichir, enCours } = useRafraichir();

  if (cibles.length === 0) return <span className="tabular-nums text-muted-foreground">0</span>;

  async function affecter(ids: string[], cle: string) {
    if (!delegue) return;
    setBusy(cle); setMsg(null);
    const fd = new FormData();
    fd.set("repId", delegue.id);
    for (const id of ids) fd.append("doctorId", id);
    const r = await affecterAuDelegue(fd).catch(sansBloquer("hors-panel.affecter.affecterAuDelegue", null));
    setBusy(null);
    if (!r?.ok) { setMsg({ ok: false, texte: r?.error ?? "Affectation impossible." }); return; }
    setMsg({ ok: true, texte: r.message ?? "Affecté." });
    rafraichir();
  }

  const occupe = busy !== null || enCours;
  return (
    <>
      <button type="button" onClick={() => setOuvert(true)} className="rounded-md px-2 py-0.5 font-medium tabular-nums text-warning underline-offset-2 hover:underline">
        {cibles.length}
      </button>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title={`Hors panel · ${secteur}`}
        description={delegue ? `À affecter à ${delegue.nom}` : "Secteur sans délégué : affectez d'abord un délégué au secteur."} width="md">
        <div className="space-y-3 text-sm">
          {msg && <p className={msg.ok ? "text-success" : "text-destructive"}>{msg.texte}</p>}
          <ul className="divide-y divide-border">
            {cibles.map((c) => (
              <li key={c.doctorId} className="flex items-center gap-2.5 py-2">
                <LettreBadge lettre={c.lettre} />
                <span className="min-w-0 flex-1">
                  <Link href={`/praticiens/${c.doctorId}`} className="font-medium [overflow-wrap:anywhere] hover:underline">{c.nom}</Link>
                  <small className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{[c.lieu, c.statut].filter(Boolean).join(" · ")}</small>
                </span>
                {peutAffecter && delegue && (
                  <button type="button" disabled={occupe} onClick={() => void affecter([c.doctorId], c.doctorId)}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius)] border border-border bg-card px-2.5 text-xs font-medium hover:bg-secondary disabled:opacity-60">
                    {busy === c.doctorId && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Affecter
                  </button>
                )}
              </li>
            ))}
          </ul>
          {peutAffecter && delegue && cibles.length > 1 && (
            <button type="button" disabled={occupe} onClick={() => void affecter(cibles.map((c) => c.doctorId), "__tous")}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60">
              {busy === "__tous" && <Loader2 className="h-4 w-4 animate-spin" />} Tout affecter à {delegue.nom}
            </button>
          )}
        </div>
      </Sheet>
    </>
  );
}
