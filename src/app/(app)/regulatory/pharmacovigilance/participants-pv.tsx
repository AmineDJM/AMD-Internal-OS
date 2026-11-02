"use client";

import * as React from "react";
import { Loader2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ajouterParticipantsPv, retirerParticipantPv } from "@/lib/actions/pharmacovigilance-actions";

/**
 * LES PERSONNES AJOUTÉES À L'ÉCHANGE D'UN CAS (Direction, 06/10) — Regulatory les ajoute (un médecin référent, un
 * responsable qualité, le directeur médical…) : elles lisent le cas et prennent part à la conversation. Chacun peut se
 * retirer. Le même geste que les participants d'une demande de validation.
 */
export function ParticipantsCasPv({ caseId, participants, candidats, peutGerer, moi }: {
  caseId: string;
  participants: { userId: string; nom: string }[];
  candidats: { id: string; name: string }[];
  peutGerer: boolean;
  moi: string;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [choisi, setChoisi] = React.useState("");
  const [filtre, setFiltre] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const q = filtre.trim().toLowerCase();
  const proposes = candidats.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 50);

  const agir = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "La liste des participants n'a pas été modifiée."); else { setChoisi(""); setFiltre(""); rafraichir(); }
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  const fd = (champs: Record<string, string>) => { const f = new FormData(); f.set("caseId", caseId); for (const [k, v] of Object.entries(champs)) f.set(k, v); return f; };

  return (
    <div className="space-y-2">
      {participants.length === 0 ? (
        <p className="text-muted-foreground">Personne d&apos;autre n&apos;a été ajouté : l&apos;échange réunit le déclarant et Regulatory.</p>
      ) : (
        <ul className="space-y-1">
          {participants.map((p) => (
            <li key={p.userId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{p.nom}</span>
              {(peutGerer || p.userId === moi) && (
                <button
                  type="button" disabled={busy || enCours} aria-label={p.userId === moi ? "Me retirer de l'échange" : `Retirer ${p.nom}`}
                  onClick={() => void agir(() => retirerParticipantPv(fd({ userId: p.userId })))}
                  className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-destructive sm:p-1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {peutGerer && (
        <div className="space-y-1.5 border-t border-border pt-2">
          <input
            value={filtre} onChange={(e) => setFiltre(e.target.value)} placeholder="Chercher une personne…" aria-label="Chercher une personne"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <div className="flex gap-1.5">
            <select value={choisi} onChange={(e) => setChoisi(e.target.value)} aria-label="Personne à ajouter" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm">
              <option value="">— Choisir —</option>
              {proposes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Button size="sm" disabled={!choisi || busy || enCours} onClick={() => void agir(() => ajouterParticipantsPv(fd({ userId: choisi })))}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />} Ajouter
            </Button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
