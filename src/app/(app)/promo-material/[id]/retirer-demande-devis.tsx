"use client";

import * as React from "react";
import { Loader2, Undo2 } from "lucide-react";
import { retirerDemandeDevisPromo } from "@/lib/actions/promo-devis-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * RETIRER LA DEMANDE DE DEVIS DEPUIS LE DOSSIER (audit du 04/10, constat 35). Offert seulement quand le
 * serveur l'a décidé possible (le demandeur ou la Direction, étape « devis demandés ») ; quand l'assistante
 * a déjà retranscrit, le geste n'est pas offert et la carte dit pourquoi — la phrase même de l'action
 * (§118.83). Le motif est exigé : c'est ce que lira l'assistante.
 */
export function RetirerDemandeDevis({ promoMaterialId, references, refus }: { promoMaterialId: string; references: string[]; refus: string | null }) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const [envoi, setEnvoi] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Le geste n'est pas offert : la raison derrière un ⓘ, pas en paragraphe.
  if (refus) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        Retrait impossible <InfoBulle align="left" label="Pourquoi le retrait n'est pas offert">{refus}</InfoBulle>
      </span>
    );
  }
  const occupe = envoi || enCours;
  return (
    <div className={ouvert ? "w-full space-y-2 rounded-lg border border-border p-2.5 text-xs" : "space-y-2 text-xs"}>
      {msg && <p className="text-emerald-700 dark:text-emerald-400">{msg}</p>}
      {err && <p role="alert" className="text-destructive">{err}</p>}
      {!ouvert ? (
        <Button size="sm" variant="outline" className="h-auto min-h-9 w-full whitespace-normal py-1.5 [overflow-wrap:anywhere] sm:h-auto sm:min-h-8 sm:w-auto" disabled={occupe} onClick={() => { setOuvert(true); setErr(null); }}>
          <Undo2 className="h-4 w-4" /> Retirer la demande de devis{references.length ? ` (${references.join(", ")})` : ""}
        </Button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData();
            f.set("promoMaterialId", promoMaterialId);
            f.set("motif", motif);
            setEnvoi(true); setErr(null);
            let r: Awaited<ReturnType<typeof retirerDemandeDevisPromo>>;
            try {
              r = await retirerDemandeDevisPromo(f);
            } catch {
              setErr(actionFailureMessage("THROWN"));
              return;
            } finally {
              setEnvoi(false);
            }
            if (!r.ok) { setErr(r.error ?? "La demande de devis n'a pas été retirée."); return; }
            setMsg(r.message ?? "Demande de devis retirée.");
            setOuvert(false); setMotif("");
            rafraichir();
          }}
        >
          <label className="block font-medium" htmlFor={`motif-retrait-${promoMaterialId}`}>Pourquoi retirer la demande de devis ?</label>
          <Textarea id={`motif-retrait-${promoMaterialId}`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="submit" size="sm" variant="destructive" disabled={occupe || motif.trim() === ""}>
              {occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Retirer la demande
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={occupe} onClick={() => setOuvert(false)}>Annuler</Button>
          </div>
        </form>
      )}
    </div>
  );
}
