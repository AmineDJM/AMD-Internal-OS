"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { importerFichierConsommation } from "@/lib/actions/consommation-actions";

/** Importer un fichier : il est lu sur le serveur, puis ouvert en REVUE — rien ne compte avant la validation. */
export function TeleverserConsommation() {
  const router = useRouter();
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  async function envoyer() {
    if (!fichier) return;
    setEnvoi(true); setErreur(null);
    const fd = new FormData(); fd.set("fichier", fichier);
    const r = await importerFichierConsommation(fd);
    setEnvoi(false);
    if (!r.ok) setErreur(r.error); else router.push(`/consommation/${r.importId}`);
  }
  return (
    <div className="surface flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-end sm:p-4">
      <Input type="file" accept=".xlsx,.xls,.xlsm,.csv" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} className="w-full sm:w-80" />
      <Button type="button" disabled={!fichier || envoi} onClick={envoyer}>{envoi ? "Lecture…" : "Importer et analyser"}</Button>
      {erreur && <p className="w-full text-sm text-destructive">{erreur}</p>}
    </div>
  );
}
