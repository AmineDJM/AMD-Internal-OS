"use client";

import { useKeyedAction } from "@/components/shared/use-action";
import { Check, Loader2 } from "lucide-react";
import { toggleMissionStop } from "@/lib/actions/admin-request-actions";

export interface StopDTO { id: string; location: string; task: string | null; done: boolean }

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

/** Checklist des points de passage : le chauffeur coche chaque point fait. */
export function MissionStops({ stops }: { stops: StopDTO[] }) {
  // La pastille d'un point n'a pas de place pour parler : un refus part en avis flottant.
  const { busy: busyId, run } = useKeyedAction({ signalerErreurs: true });

  async function toggle(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    await run(id, () => toggleMissionStop(fd));
  }

  if (stops.length === 0) return null;

  return (
    <ol className="space-y-1.5">
      {stops.map((s, i) => (
        <li key={s.id} className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${s.done ? "border-success/30 bg-success/5" : "border-border bg-background"}`}>
          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${s.done ? "bg-success text-white" : "bg-secondary text-foreground"}`}>
            {letter(i)}
          </span>
          <div className={`min-w-0 flex-1 text-sm ${s.done ? "text-muted-foreground" : ""}`}>
            <p className={`font-semibold ${s.done ? "line-through" : ""}`}>{s.location}</p>
            {s.task && <p className={s.done ? "line-through" : "text-muted-foreground"}>{s.task}</p>}
          </div>
          <button
            onClick={() => void toggle(s.id)}
            disabled={busyId !== null}
            title={s.done ? "Marquer à refaire" : "Marquer comme fait"}
            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition ${s.done ? "border-success bg-success text-white" : "border-border text-muted-foreground hover:border-success hover:text-success"}`}
          >
            {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
        </li>
      ))}
    </ol>
  );
}
