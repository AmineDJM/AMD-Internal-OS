"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Trash2 } from "lucide-react";
import { finaliserFicheCoaching, supprimerFicheCoaching } from "@/lib/actions/coaching-actions";
import { Button } from "@/components/ui/button";
import { useKeyedAction } from "@/components/shared/use-action";

/**
 * LES GESTES D'UNE FICHE CONSULTÉE — finaliser, retirer. L'écran ne propose que ce que la règle
 * permet (`gestesSurLaFiche`) ; l'action la revérifie.
 */
export function FicheActions({
  id, collaborateur, finaliser, supprimer, finalisee, complete, dansUnMenu = false,
}: {
  id: string;
  collaborateur: string;
  finaliser: boolean;
  supprimer: boolean;
  finalisee: boolean;
  complete: boolean;
  /** Rendu comme une entrée du menu « ⋯ » de la fiche (Direction, 07/10) : « Retirer » n'y est plus un bouton nu à l'écran. */
  dansUnMenu?: boolean;
}) {
  const router = useRouter();
  const { busy, error: err, run } = useKeyedAction();

  const agir = async (geste: "finaliser" | "supprimer") => {
    const question = geste === "finaliser"
      ? `Finaliser la fiche et la partager avec ${collaborateur} ?\n\nIl en sera prévenu et pourra la consulter. Une fois finalisée, seule la direction des opérations pourra la modifier.`
      : finalisee
        ? `Retirer cette fiche finalisée ? ${collaborateur} en sera prévenu, et elle disparaîtra de son espace.`
        : "Retirer ce brouillon ?";
    const fd = new FormData();
    fd.set("id", id);
    const ok = await run(geste, () => (geste === "finaliser" ? finaliserFicheCoaching(fd) : supprimerFicheCoaching(fd)), { confirmer: question });
    if (ok && geste === "supprimer") router.push("/medical/coaching");
  };

  if (!finaliser && !supprimer) return null;
  if (dansUnMenu) {
    return (
      <>
        {supprimer && (
          <button
            type="button" role="menuitem" onClick={() => void agir("supprimer")} disabled={busy !== null}
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-destructive hover:bg-secondary disabled:opacity-50 sm:min-h-9 sm:py-1.5"
          >
            {busy === "supprimer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Retirer la fiche
          </button>
        )}
        {err && <span className="px-2.5 py-1 text-xs text-destructive" role="alert">{err}</span>}
      </>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {err && <span className="text-xs text-destructive" role="alert">{err}</span>}
      {/* Ce qui manque pour finaliser se lit sur la carte du total (« Reste à noter ») — pas de phrase sous le bouton. */}
      {finaliser && (
        <Button size="sm" className="h-10 sm:h-8" onClick={() => void agir("finaliser")} disabled={busy !== null || !complete} title={complete ? undefined : "Notez chaque axe pour pouvoir finaliser."}>
          {busy === "finaliser" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Finaliser et partager
        </Button>
      )}
      {supprimer && (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void agir("supprimer")} disabled={busy !== null}>
          {busy === "supprimer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Retirer
        </Button>
      )}
    </span>
  );
}

/** Le bouton d'impression de la page d'impression — et l'impression automatique quand on y arrive par « Imprimer / PDF ». */
export function BoutonImprimer({ auto }: { auto: boolean }) {
  React.useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, [auto]);
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      Imprimer / Enregistrer en PDF
    </Button>
  );
}
