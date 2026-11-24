"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { relireRapportVisite } from "@/lib/actions/relecture-visite-actions";
import { COMMENTAIRE_RELECTURE_MAX } from "@/lib/sfe/rapport-visite";

/**
 * « RELU » — le geste du superviseur sur un rapport de son équipe (Visite médicale 11/2026). Le mot au délégué est
 * facultatif ; il le lira sur son rapport. Le serveur revérifie l'équipe et l'état du rapport : l'écran ne fait que
 * proposer ce qui sera accepté.
 */
export function RelectureForm({ visitId }: { visitId: string }) {
  const { run, saving, err } = useAction();
  const [commentaire, setCommentaire] = React.useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.set("visitId", visitId);
        if (commentaire.trim()) fd.set("commentaire", commentaire.trim());
        void run(() => relireRapportVisite(fd), () => setCommentaire(""), { succes: "Rapport relu." });
      }}
    >
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Un mot au délégué <span className="font-normal text-muted-foreground">(facultatif)</span></span>
        <Textarea
          value={commentaire} onChange={(e) => setCommentaire(e.target.value)} maxLength={COMMENTAIRE_RELECTURE_MAX}
          placeholder="Bien vu pour la relance ; pensez à reparler du dosage la prochaine fois…" className="min-h-[80px]"
        />
      </label>
      {err && <Retour ton="erreur">{err}</Retour>}
      <Button type="submit" disabled={saving} className="h-11 w-full sm:h-9 sm:w-auto">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Marquer relu
      </Button>
    </form>
  );
}
