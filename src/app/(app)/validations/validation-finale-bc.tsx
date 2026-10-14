"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { demanderValidationFinaleBC } from "@/lib/actions/validation-actions";

/**
 * LE CTA DU DEMANDEUR — la pré-validation d'un BC est acquise : demander la validation FINALE. Un geste qui envoie la
 * pièce au centre se confirme une seconde fois, avec ce qui va se passer.
 */
export function ValidationFinaleBC({ demandeId, reference }: { demandeId: string; reference: string }) {
  const router = useRouter();
  const [arme, setArme] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [envoi, start] = React.useTransition();

  const confirmer = () => start(async () => {
    const fd = new FormData();
    fd.set("id", demandeId);
    const r = await demanderValidationFinaleBC(fd);
    setArme(false);
    setMessage(r.ok ? { ok: true, texte: r.message ?? "Validation finale demandée." } : { ok: false, texte: r.error ?? "La validation finale n'a pas pu être demandée." });
    if (r.ok) router.refresh();
  });

  if (message?.ok) return <p className="text-xs text-success">{message.texte}</p>;
  return (
    <div className="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
      <p className="text-xs">Tous les validateurs ont accepté. Le bon de commande {reference} attend votre demande de validation finale.</p>
      {arme ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Il partira au centre de validation, puis à la signature. Confirmer ?</span>
          <Button type="button" size="sm" onClick={confirmer} disabled={envoi}>
            {envoi && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Confirmer
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setArme(false)} disabled={envoi}>Retour</Button>
        </div>
      ) : (
        <Button type="button" size="sm" onClick={() => setArme(true)}>
          <Send className="h-3.5 w-3.5" aria-hidden /> Demander la validation finale
        </Button>
      )}
      {message && !message.ok && <p className="text-xs text-destructive" role="alert">{message.texte}</p>}
    </div>
  );
}
