"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { importerFichierConsommation } from "@/lib/actions/consommation-actions";

/** Importer un fichier : il est lu sur le serveur, puis ouvert en REVUE — rien ne compte avant la validation. */
export function TeleverserConsommation() {
  const router = useRouter();
  const [fichier, setFichier] = React.useState<File | null>(null);
  const { busy: envoi, err: erreur, run } = useAction();
  async function envoyer() {
    if (!fichier) return;
    const fd = new FormData(); fd.set("fichier", fichier);
    // L'identifiant de l'import est capturé pour ouvrir sa revue ; `run` garde l'appel (levée, 45 s).
    let importId: string | undefined;
    const ok = await run(async () => {
      const r = await importerFichierConsommation(fd);
      if (r.ok) importId = r.importId;
      return r;
    });
    if (ok && importId) router.push(`/consommation/${importId}`);
  }
  return (
    <div className="surface flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-end sm:p-4">
      <Input type="file" accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} className="w-full sm:w-80" />
      <Button type="button" disabled={!fichier || envoi} onClick={envoyer}>{envoi ? "Lecture…" : "Importer et analyser"}</Button>
      <Retour ton="erreur" className="w-full">{erreur}</Retour>
    </div>
  );
}
