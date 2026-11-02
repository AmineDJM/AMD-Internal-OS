"use client";

import * as React from "react";
import { Archive, Link2, Loader2, RotateCcw, Trash2 } from "lucide-react";
import {
  classerCandidatureSite, effacerCandidatureSite, rattacherCandidatureSite, remettreCandidatureATrier,
} from "@/lib/actions/candidatures-site-actions";
import type { ActionResult } from "@/lib/actions/types";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Button } from "@/components/ui/button";

/**
 * LES GESTES DU TRI (§118.159) — rattacher à un recrutement ouvert, classer, remettre à trier,
 * effacer. Chaque phrase de retour vient de l'action serveur : l'écran ne dit jamais « fait » à la
 * place du code. Les règles vivent dans `lib/site-web/candidatures.ts` ; l'action les revérifie.
 */
export function GestesCandidature({
  id, etat, postesOuverts, nom, orpheline,
}: {
  id: string;
  etat: "NOUVELLE" | "RATTACHEE" | "CLASSEE";
  postesOuverts: { value: string; label: string }[];
  nom: string;
  /** Rattachée à un candidat qui n'existe plus : il ne reste qu'à pouvoir l'effacer. */
  orpheline: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [enCours, setEnCours] = React.useState<string | null>(null);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [poste, setPoste] = React.useState("");
  const [motif, setMotif] = React.useState("");

  const agir = async (geste: string, fn: (fd: FormData) => Promise<ActionResult>, champs: Record<string, string> = {}) => {
    setEnCours(geste); setRetour(null);
    const fd = new FormData();
    fd.set("id", id);
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    let r: ActionResult;
    try {
      r = await fn(fd);
    } catch {
      r = { ok: false, error: "Le serveur n'a pas répondu. Rechargez la page avant de recommencer : le geste a peut-être eu lieu." };
    }
    setEnCours(null);
    setRetour(r.ok ? { ok: true, texte: r.message ?? "Fait." } : { ok: false, texte: r.error ?? "Le geste n'a pas abouti." });
    rafraichir();
  };

  const effacer = async () => {
    if (!(await confirmer(`Effacer la candidature de ${nom} ET son CV ?\n\nC'est définitif : on ne pourra plus la retrouver (droit à l'oubli).`))) return;
    void agir("effacer", effacerCandidatureSite);
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      {etat === "NOUVELLE" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor={`poste-${id}`}>Recrutement auquel la rattacher</label>
          <select
            id={`poste-${id}`}
            value={poste}
            onChange={(e) => setPoste(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:text-sm"
          >
            <option value="">{postesOuverts.length ? "Choisir un poste ouvert…" : "Aucun poste ouvert en ce moment"}</option>
            {postesOuverts.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <Button
            size="sm"
            disabled={!poste || enCours !== null}
            onClick={() => void agir("rattacher", rattacherCandidatureSite, { requestId: poste })}
          >
            {enCours === "rattacher" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Rattacher
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {etat === "NOUVELLE" && (
          <>
            <label className="sr-only" htmlFor={`motif-${id}`}>Motif (facultatif)</label>
            <input
              id={`motif-${id}`}
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Motif (facultatif)"
              className="h-10 min-w-0 flex-1 basis-full rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:max-w-xs sm:basis-0 sm:text-sm"
            />
            <Button size="sm" variant="outline" disabled={enCours !== null} onClick={() => void agir("classer", classerCandidatureSite, { motif })}>
              {enCours === "classer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              Classer sans suite
            </Button>
          </>
        )}
        {etat === "CLASSEE" && (
          <Button size="sm" variant="outline" disabled={enCours !== null} onClick={() => void agir("remettre", remettreCandidatureATrier)}>
            {enCours === "remettre" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Remettre à trier
          </Button>
        )}
        {(etat !== "RATTACHEE" || orpheline) && (
          <Button size="sm" variant="ghost" disabled={enCours !== null} onClick={effacer}>
            {enCours === "effacer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Effacer
          </Button>
        )}
      </div>
      {retour && (
        <p role={retour.ok ? "status" : "alert"} className={retour.ok ? "text-sm text-success" : "text-sm text-destructive"}>{retour.texte}</p>
      )}
    </div>
  );
}
