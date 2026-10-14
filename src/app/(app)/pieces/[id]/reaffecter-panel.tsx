"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reaffecterDemandeBC } from "@/lib/actions/document-request-actions";

/**
 * PASSER LE BC D'UN POSTE À UNE AUTRE ASSISTANTE (audit Assistante de direction, 10/2026) — offert par l'écran à qui
 * l'action l'accepte (`refusReaffectation`), avec les seules assistantes de direction actives.
 */
export function ReaffecterPanel({ id, assistantes }: { id: string; assistantes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [cible, setCible] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  if (assistantes.length === 0) return null;
  const envoyer = async () => {
    if (!cible || busy) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("assistantId", cible);
    const r = await reaffecterDemandeBC(fd);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "L'opération a échoué."); return; }
    setCible("");
    router.refresh();
  };
  return (
    <div className="surface space-y-2 p-4">
      <h3 className="text-sm font-semibold">Confier à une autre assistante</h3>
      <p className="text-xs text-muted-foreground">Absente ou débordée : une autre assistante de direction reprend le bon de commande.</p>
      <select value={cible} onChange={(e) => setCible(e.target.value)} className="min-h-9 w-full rounded-lg border border-border bg-background px-2 text-sm">
        <option value="">— Choisir —</option>
        {assistantes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <Button className="w-full" variant="outline" disabled={busy || !cible} onClick={() => void envoyer()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRoundCog className="h-4 w-4" />} Réaffecter
      </Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
