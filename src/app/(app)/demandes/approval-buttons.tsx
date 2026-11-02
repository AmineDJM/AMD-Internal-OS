"use client";

import * as React from "react";
import { Loader2, Check, X, Pencil } from "lucide-react";
import { decideApproval } from "@/lib/actions/admin-request-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { exigeMotif, type DecisionApprobation } from "@/lib/secretariat/decision-approbation";
import { cn } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * TRANCHER UNE VALIDATION AU SECRÉTARIAT — valider d'un clic ; refuser et demander une modification avec un
 * MOTIF (lot E5, audit des managers M15).
 *
 * Les trois boutons partaient d'un clic, sans un mot : le demandeur recevait « Validation : refusée » et ne
 * savait ni pourquoi, ni quoi corriger. Le motif est exigé PAR L'ACTION (une requête forgée ignore un écran) ;
 * ici l'envoi reste fermé tant qu'il est vide, et un refus de l'action se LIT au lieu d'un rafraîchissement
 * muet — un « déjà tranchée » se lisait comme un succès. Le rafraîchissement est suivi (§118.172) : sur l'état
 * d'avant, un second clic trancherait une validation déjà tranchée.
 */
type AvecMotif = Exclude<DecisionApprobation, "APPROVED">;

const INVITE: Record<AvecMotif, { bouton: string; aide: string; envoyer: string }> = {
  REJECTED: { bouton: "Refuser…", aide: "Pourquoi vous refusez — c'est ce que lira le demandeur.", envoyer: "Refuser" },
  CHANGES_REQUESTED: { bouton: "Modification…", aide: "Ce qu'il faut modifier — c'est ce que lira le demandeur.", envoyer: "Demander la modification" },
};

const BTN = "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50";

export function ApprovalButtons({ approvalId }: { approvalId: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [ouvert, setOuvert] = React.useState<AvecMotif | null>(null);
  const [motif, setMotif] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const ferme = busy || enCours;

  async function trancher(decision: DecisionApprobation) {
    setBusy(true);
    setErreur(null);
    const fd = new FormData();
    fd.set("approvalId", approvalId);
    fd.set("decision", decision);
    if (exigeMotif(decision)) fd.set("comment", motif.trim());
    try {
      const r = await decideApproval(fd);
      if (!r.ok) {
        setErreur(r.error ?? "La décision n'a pas été enregistrée.");
        return;
      }
      setOuvert(null);
      setMotif("");
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <BoutonDecisif brut
          type="button" disabled={ferme} onClick={() => void trancher("APPROVED")}
          className={cn(BTN, "border-success/30 text-success hover:bg-success/10")}
        >
          {busy && ouvert === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Valider
        </BoutonDecisif>
        {(["CHANGES_REQUESTED", "REJECTED"] as const).map((d) => (
          <button
            key={d} type="button" disabled={ferme} aria-expanded={ouvert === d}
            onClick={() => { setErreur(null); setOuvert(ouvert === d ? null : d); }}
            className={cn(
              BTN,
              d === "REJECTED" ? "border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive" : "border-border text-muted-foreground hover:bg-secondary",
              ouvert === d && "bg-secondary",
            )}
          >
            {d === "REJECTED" ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />} {INVITE[d].bouton}
          </button>
        ))}
      </div>
      {ouvert && (
        <div className="space-y-1.5">
          <textarea
            aria-label={INVITE[ouvert].aide} placeholder={INVITE[ouvert].aide} value={motif} rows={2}
            onChange={(e) => setMotif(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex flex-wrap gap-1.5">
            <BoutonDecisif brut
              type="button" disabled={ferme || motif.trim() === ""} onClick={() => void trancher(ouvert)}
              className={cn(BTN, "border-border text-foreground hover:bg-secondary")}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {INVITE[ouvert].envoyer}
            </BoutonDecisif>
            <button
              type="button" disabled={ferme} onClick={() => { setOuvert(null); setMotif(""); }}
              className={cn(BTN, "border-border text-muted-foreground hover:bg-secondary")}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
      {erreur && <p role="alert" className="text-xs text-destructive">{erreur}</p>}
    </div>
  );
}
