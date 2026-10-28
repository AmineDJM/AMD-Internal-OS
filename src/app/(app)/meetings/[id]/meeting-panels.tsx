"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, X, Link2, Play, Square, Trash2 } from "lucide-react";
import {
  acceptMeetingProposal, dismissMeetingProposal,
  setMeetingLive, endMeeting, deleteMeeting,
} from "@/lib/actions/meeting-actions";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/** Boutons Accepter / Écarter d'une tâche proposée par l'IA. */
export function ProposalActions({ proposalId }: { proposalId: string }) {
  // Deux icônes sans place où parler : un refus part en avis flottant.
  const { busy, run: lancer } = useKeyedAction({ signalerErreurs: true });

  async function run(kind: "accept" | "dismiss") {
    const fd = new FormData(); fd.set("proposalId", proposalId);
    await lancer(kind, () => (kind === "accept" ? acceptMeetingProposal(fd) : dismissMeetingProposal(fd)));
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button type="button" onClick={() => run("accept")} disabled={busy !== null} title="Créer la tâche"
        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs sm:px-2 sm:py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60">
        {busy === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Créer
      </button>
      <button type="button" onClick={() => run("dismiss")} disabled={busy !== null} title="Écarter" aria-label="Écarter"
        className="inline-flex items-center justify-center rounded-md border border-border p-2 text-muted-foreground sm:p-1 hover:bg-secondary disabled:opacity-60">
        {busy === "dismiss" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/** Copie du lien externe partageable. */
export function ShareLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ignore */ }
  }
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={url} className="min-w-0 flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground sm:py-1.5" />
      <button type="button" onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary sm:py-1.5">
        {copied ? <Check className="h-4 w-4 text-success" /> : <Link2 className="h-4 w-4" />} {copied ? "Copié" : "Copier"}
      </button>
    </div>
  );
}

/** Barre de gestion (organisateur) : démarrer / clôturer / supprimer. */
export function ManageBar({ meetingId, status }: { meetingId: string; status: string }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function act(kind: "live" | "end" | "delete") {
    if (kind === "delete" && !(await confirmer("Supprimer définitivement cette réunion ?"))) return;
    setBusy(kind);
    const fd = new FormData(); fd.set("id", meetingId);
    try {
      const r = kind === "live" ? await setMeetingLive(fd) : kind === "end" ? await endMeeting(fd) : await deleteMeeting(fd);
      if (r.ok) { if (kind === "delete") router.push("/meetings"); else rafraichir(); }
      else retours.erreur(r.error ?? (kind === "delete" ? "La réunion n'a pas été supprimée." : kind === "live" ? "La réunion n'a pas été démarrée." : "La réunion n'a pas été clôturée."));
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "SCHEDULED" && (
        <Button type="button" variant="outline" onClick={() => act("live")} disabled={busy !== null}>
          {busy === "live" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Démarrer
        </Button>
      )}
      {status !== "ENDED" && (
        <Button type="button" variant="outline" onClick={() => act("end")} disabled={busy !== null}>
          {busy === "end" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} Clôturer
        </Button>
      )}
      <button type="button" onClick={() => act("delete")} disabled={busy !== null} title="Supprimer"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-destructive sm:py-1.5 hover:bg-destructive/10 disabled:opacity-60">
        {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer
      </button>
    </div>
  );
}
