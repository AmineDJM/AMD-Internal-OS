"use client";

import * as React from "react";
import { Check, X, HelpCircle, Loader2 } from "lucide-react";
import { respondToMeetingInvite } from "@/lib/actions/meeting-actions";
import { useKeyedAction } from "@/components/shared/use-action";

type Resp = "INVITED" | "ACCEPTED" | "DECLINED" | "TENTATIVE";

/**
 * Barre de réponse à une invitation à une réunion — Oui / Peut-être / Non (façon agenda).
 * Chacun répond pour lui-même ; l'organisateur est notifié. Le choix courant est mis en avant.
 */
export function InviteResponse({ meetingId, current }: { meetingId: string; current: Resp }) {
  const [resp, setResp] = React.useState<Resp>(current);
  // Trois boutons, une réponse à la fois ; un refus n'a pas de place où parler : avis flottant.
  const { busy, run } = useKeyedAction({ signalerErreurs: true });

  async function send(value: "ACCEPTED" | "DECLINED" | "TENTATIVE") {
    const fd = new FormData();
    fd.set("id", meetingId);
    fd.set("response", value);
    if (await run(value, () => respondToMeetingInvite(fd))) setResp(value);
  }

  const btn = (value: "ACCEPTED" | "DECLINED" | "TENTATIVE", active: string, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => send(value)}
      disabled={busy !== null}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-sm font-medium sm:px-3 sm:py-2 transition-colors disabled:opacity-60 ${resp === value ? active : "border-border hover:bg-secondary"}`}
    >
      {busy === value ? <Loader2 className="h-4 w-4 animate-spin" /> : icon} {label}
    </button>
  );

  const done = resp === "ACCEPTED" ? "Vous avez accepté." : resp === "DECLINED" ? "Vous avez décliné." : resp === "TENTATIVE" ? "Vous êtes peut-être disponible." : null;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="mb-2 text-sm font-medium">
        Participerez-vous à cette réunion ?{done && <span className="ml-1 font-normal text-muted-foreground">— {done}</span>}
      </p>
      <div className="flex gap-2">
        {btn("ACCEPTED", "border-success bg-success/10 text-success", <Check className="h-4 w-4" />, "Oui")}
        {btn("TENTATIVE", "border-amber-500 bg-amber-500/10 text-amber-700", <HelpCircle className="h-4 w-4" />, "Peut-être")}
        {btn("DECLINED", "border-destructive bg-destructive/10 text-destructive", <X className="h-4 w-4" />, "Non")}
      </div>
    </div>
  );
}
