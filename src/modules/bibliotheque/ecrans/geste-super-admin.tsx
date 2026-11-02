"use client";

import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { lancerPassageBibliotheque } from "../actions";

/** Le Super Admin lance un passage (rattrapage + lecture) sans attendre la tâche de fond. */
export function LireMaintenant() {
  const { busy, err, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(lancerPassageBibliotheque, undefined, { succes: "Passage fait : l'état de la file est à jour." })}>
        {busy ? "Lecture…" : "Lire maintenant"}
      </Button>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
