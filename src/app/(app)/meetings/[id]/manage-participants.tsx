"use client";

import * as React from "react";
import { Users, UserPlus, X, Loader2, Search } from "lucide-react";
import { addMeetingParticipants, removeMeetingParticipant } from "@/lib/actions/meeting-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";

interface UserLite { id: string; name: string }

/**
 * Gestion des participants d'une réunion par **l'organisateur** : ajouter (multi-sélection),
 * retirer (croix). Les personnes ajoutées reçoivent une invitation ; retirées perdent l'accès.
 */
export function ManageParticipants({
  meetingId, participants, allUsers,
}: {
  meetingId: string;
  participants: UserLite[];
  allUsers: UserLite[];
}) {
  const [open, setOpen] = React.useState(false);
  const { busy, run } = useAction({ signalerErreurs: true });
  const [pick, setPick] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState("");

  const currentIds = new Set(participants.map((p) => p.id));
  const addable = allUsers.filter((u) => !currentIds.has(u.id) && (!search.trim() || u.name.toLowerCase().includes(search.trim().toLowerCase())));
  const toggle = (id: string) => setPick((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function addSelected() {
    if (pick.size === 0) return;
    const fd = new FormData();
    fd.set("id", meetingId);
    pick.forEach((id) => fd.append("participantIds", id));
    await run(() => addMeetingParticipants(fd), () => { setPick(new Set()); setSearch(""); });
  }

  async function remove(userId: string) {
    const fd = new FormData();
    fd.set("id", meetingId); fd.set("userId", userId);
    await run(() => removeMeetingParticipant(fd));
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Users className="h-4 w-4" /> Gérer</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Participants de la réunion" description="Ajoutez ou retirez des personnes. Les nouvelles reçoivent une invitation." width="md">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Participants actuels ({participants.length})</p>
            {participants.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun participant pour l&apos;instant.</p>
            ) : (
              <ul className="space-y-1">
                {participants.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate">{p.name}</span>
                    <button type="button" onClick={() => remove(p.id)} disabled={busy} title="Retirer" aria-label="Retirer"
                      className="-mr-1.5 shrink-0 rounded-md p-2 text-muted-foreground sm:mr-0 sm:p-1 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5 border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ajouter des participants</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} type="search" placeholder="Rechercher une personne…" className="pl-8" />
            </div>
            <div className="max-h-[40dvh] space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 sm:max-h-64">
              {addable.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">Personne à ajouter.</p>
              ) : addable.map((u) => (
                <label key={u.id} className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-secondary/50 sm:py-1.5">
                  <input type="checkbox" checked={pick.has(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 rounded border-input" />
                  {u.name}
                </label>
              ))}
            </div>
            <Button size="sm" onClick={addSelected} disabled={busy || pick.size === 0} className="w-full sm:w-auto">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Ajouter{pick.size > 0 ? ` (${pick.size})` : ""}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
