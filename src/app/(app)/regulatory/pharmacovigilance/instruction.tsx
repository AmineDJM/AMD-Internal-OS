"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { changerStatutCasPv, ouvrirEnquetePv } from "@/lib/actions/pharmacovigilance-actions";
import { STATUT_PV, type StatutPv } from "@/lib/pharmacovigilance/regles";

/**
 * L'INSTRUCTION D'UN CAS (Direction, 06/10) — Regulatory change le statut (analyse, clôture avec sa note, réouverture)
 * et ouvre au besoin une ENQUÊTE APPROFONDIE en disant les informations complémentaires attendues du KAM.
 */
export function InstructionCasPv({ caseId, status, suivants }: { caseId: string; status: StatutPv; suivants: StatutPv[] }) {
  const { enCours, rafraichir } = useRafraichir();
  const choix = suivants.filter((s) => s !== "ENQUETE");
  const [vers, setVers] = React.useState<string>(choix[0] ?? "");
  const [note, setNote] = React.useState("");
  const [infos, setInfos] = React.useState("");
  const [busy, setBusy] = React.useState<"statut" | "enquete" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const agir = async (quoi: "statut" | "enquete", fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(quoi); setErr(null);
    try {
      const r = await fn();
      if (!r.ok) { setErr(r.error ?? (quoi === "statut" ? "Le statut n'a pas été changé." : "L'enquête n'a pas été ouverte.")); return; }
      setNote(""); setInfos(""); rafraichir();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  };
  const fd = (champs: Record<string, string>) => { const f = new FormData(); f.set("caseId", caseId); for (const [k, v] of Object.entries(champs)) f.set(k, v); return f; };
  const bloque = busy !== null || enCours;

  return (
    <div className="space-y-4 text-sm">
      {choix.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="pv-statut">Changer le statut</label>
          <Select id="pv-statut" value={vers} onChange={(e) => setVers(e.target.value)}>
            {choix.map((s) => <option key={s} value={s}>{s === "EN_ANALYSE" && status === "CLOS" ? "Rouvrir (en analyse)" : STATUT_PV[s].label}</option>)}
          </Select>
          <Textarea
            value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note"
            placeholder={vers === "CLOS" ? "Note de clôture (obligatoire) : ce qui a été conclu…" : "Note (facultative)…"}
            className="min-h-[60px]"
          />
          <Button size="sm" className="w-full sm:w-auto" disabled={!vers || bloque || (vers === "CLOS" && !note.trim())} onClick={() => void agir("statut", () => changerStatutCasPv(fd({ status: vers, note })))}>
            {busy === "statut" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {vers === "CLOS" ? "Clore le cas" : "Enregistrer"}
          </Button>
        </div>
      )}

      {status !== "CLOS" && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="pv-enquete">
            {status === "ENQUETE" ? "Demander d'autres informations" : "Ouvrir une enquête approfondie"}
          </label>
          <Textarea
            id="pv-enquete" value={infos} onChange={(e) => setInfos(e.target.value)} className="min-h-[80px]"
            placeholder="Informations complémentaires demandées au KAM (lot, posologie, évolution, autres traitements…)"
          />
          <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={!infos.trim() || bloque} onClick={() => void agir("enquete", () => ouvrirEnquetePv(fd({ requestedInfo: infos })))}>
            {busy === "enquete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {status === "ENQUETE" ? "Envoyer la demande" : "Ouvrir l'enquête"}
          </Button>
          <p className="text-xs text-muted-foreground">Le KAM est prévenu ; la demande s&apos;inscrit dans l&apos;échange.</p>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
