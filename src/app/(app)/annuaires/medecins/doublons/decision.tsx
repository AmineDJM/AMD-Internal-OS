"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { ecarterFusionMedecin, fusionnerMedecinsEnDouble } from "@/lib/actions/medical-directory-crud-actions";

/** ✓ / ✗ d'une proposition de fusion — un clic, la réponse dite à côté (lot T2, décision 0061). */
export function DecisionDoublon({ gardeId, absorbeId }: { gardeId: string; absorbeId: string }) {
  const [enCours, demarrer] = useTransition();
  const [retour, setRetour] = useState<{ ton: "succes" | "erreur"; texte: string } | null>(null);
  const router = useRouter();
  const agir = (fusionner: boolean) => demarrer(async () => {
    const fd = new FormData();
    if (fusionner) { fd.set("gardeId", gardeId); fd.set("absorbeId", absorbeId); } else { fd.set("medecinAId", gardeId); fd.set("medecinBId", absorbeId); }
    const r = fusionner ? await fusionnerMedecinsEnDouble(fd) : await ecarterFusionMedecin(fd);
    setRetour(r.ok ? { ton: "succes", texte: r.message ?? "Fait." } : { ton: "erreur", texte: r.error ?? "Le geste n'a pas abouti." });
    if (r.ok) router.refresh();
  });
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button size="sm" variant="success" disabled={enCours} onClick={() => agir(true)} aria-label="Fusionner ces deux fiches">✓ Fusionner</Button>
        <Button size="sm" variant="outline" disabled={enCours} onClick={() => agir(false)} aria-label="Écarter cette proposition">✗ Écarter</Button>
      </div>
      {retour ? <Retour ton={retour.ton}>{retour.texte}</Retour> : null}
    </div>
  );
}
