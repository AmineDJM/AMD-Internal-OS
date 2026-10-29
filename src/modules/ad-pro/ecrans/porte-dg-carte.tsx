"use client";

import * as React from "react";
import { ShieldCheck, ShieldAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { statuerTotalDg } from "@/lib/actions/porte-dg-actions";
import type { EtatPorteDg } from "@/lib/seuils/porte-dg-total";
import type { AdProParent } from "../domaine/postes";

/**
 * LA PORTE DU DG SUR LE TOTAL DE LA DEMANDE (Direction, 27/10/2026), en tête des postes.
 *
 * Elle ne s'affiche que lorsqu'elle est requise (total au-dessus du seuil). Tout le monde y lit le
 * total, le seuil et où en est la validation ; le DG (ou le Super Admin) y statue : « Valider le
 * total », ou « Renvoyer en révision » avec un motif transmis aux parties prenantes.
 */
export function CartePorteDg({ parent, parentId, porte }: {
  parent: AdProParent;
  parentId: string;
  porte: { etat: EtatPorteDg; phrase: string | null; total: number; seuil: number | null; note: string | null; peutStatuer: boolean };
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [revoir, setRevoir] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  if (porte.etat === "NON_REQUISE") return null;

  const statuer = async (decision: "VALIDEE" | "A_REVOIR") => {
    if (busy || enCours) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("parent", parent);
    fd.set("parentId", parentId);
    fd.set("decision", decision);
    fd.set("totalVu", String(porte.total));
    if (note.trim()) fd.set("note", note.trim());
    try {
      const r = await statuerTotalDg(fd);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Décision enregistrée.") : (r.error ?? "La décision n'a pas été enregistrée.") });
      if (r.ok) { setRevoir(false); setNote(""); rafraichir(); }
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };

  const ouverte = porte.etat === "VALIDEE";
  return (
    <div
      className={`rounded-xl border p-3 text-sm ${ouverte ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/30 dark:bg-emerald-500/5" : "border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5"}`}
      data-testid="porte-dg"
    >
      <div className="flex flex-wrap items-center gap-2">
        {ouverte ? <ShieldCheck className="h-4 w-4 text-emerald-600" /> : <ShieldAlert className="h-4 w-4 text-amber-600" />}
        <span className="font-semibold">Validation du Directeur Général — total de la demande</span>
        <Badge tone={ouverte ? "success" : porte.etat === "A_REVOIR" ? "danger" : "warning"}>
          {ouverte ? "Validé" : porte.etat === "A_REVOIR" ? "À revoir" : "En attente"}
        </Badge>
        <span className="ml-auto font-semibold tabular-nums">{formatCurrency(porte.total)}</span>
      </div>
      {porte.phrase && <p className="mt-1 text-xs text-muted-foreground">{porte.phrase}</p>}
      {porte.etat === "A_REVOIR" && porte.note && <p className="mt-1 text-xs">Motif : {porte.note}</p>}
      {porte.peutStatuer && !ouverte && (
        <div className="mt-2 space-y-2">
          {revoir ? (
            <div className="space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Ce qu'il faut revoir (transmis au demandeur, à la Direction Marketing et au Directeur des opérations)"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => void statuer("A_REVOIR")}>
                  <Undo2 className="h-4 w-4" /> Renvoyer en révision
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevoir(false)}>Annuler</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || enCours} onClick={() => void statuer("VALIDEE")}>
                <ShieldCheck className="h-4 w-4" /> Valider le total ({formatCurrency(porte.total)})
              </Button>
              <Button size="sm" variant="outline" disabled={busy || enCours} onClick={() => setRevoir(true)}>
                <Undo2 className="h-4 w-4" /> Renvoyer en révision
              </Button>
            </div>
          )}
        </div>
      )}
      {msg && <p role="status" className={`mt-2 text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}
