"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { X, UserPlus, Users, Loader2, Trash2, Database } from "lucide-react";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { updateMarketResearch, deleteMarketResearch, setMarketResearchParticipants } from "@/lib/actions/market-research-actions";

/**
 * Métadonnées d'une étude de marché : titre (modifiable), sources de données
 * (modifiables, valeurs par défaut fournies), participants, et suppression.
 */
export function ResearchMeta({
  research, allUsers, canEdit,
}: {
  research: { id: string; title: string; notes: string | null; sources: string | null; participants: { id: string; name: string }[] };
  allUsers: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  // Enregistrement au fil de la saisie : pas de bouton où parler, un refus part en avis flottant.
  const retours = useRetours();
  const [title, setTitle] = React.useState(research.title);
  const [sources, setSources] = React.useState(research.sources ?? "");
  const [notes, setNotes] = React.useState(research.notes ?? "");
  const [pIds, setPIds] = React.useState<string[]>(research.participants.map((p) => p.id));
  const [saving, setSaving] = React.useState(false);
  const nameById = React.useMemo(() => new Map([...research.participants, ...allUsers].map((u) => [u.id, u.name])), [research.participants, allUsers]);
  const available = allUsers.filter((u) => !pIds.includes(u.id));

  async function saveMeta() {
    if (!canEdit) return;
    setSaving(true);
    const fd = new FormData();
    fd.set("id", research.id); fd.set("title", title || research.title); fd.set("sources", sources); fd.set("notes", notes);
    try {
      const r = await updateMarketResearch(fd);
      if (!r.ok) retours.erreur(r.error ?? "L'étude n'a pas été enregistrée.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false); rafraichir();
    }
  }

  async function saveParticipants(next: string[]) {
    setPIds(next);
    const fd = new FormData(); fd.set("id", research.id);
    next.forEach((i) => fd.append("participantIds", i));
    try {
      const r = await setMarketResearchParticipants(fd);
      if (!r.ok) retours.erreur(r.error ?? "Les participants n'ont pas été enregistrés.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      rafraichir();
    }
  }

  async function remove() {
    if (!(await confirmer(`Supprimer définitivement l'étude « ${research.title} » (lignes, acteurs et présentations) ?`))) return;
    const fd = new FormData(); fd.set("id", research.id);
    try {
      const r = await deleteMarketResearch(fd);
      if (r.ok) router.push("/business-development/etudes"); else retours.erreur(r.error ?? "Suppression impossible.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    }
  }

  if (!canEdit) {
    return (
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0"><p className="text-xs text-muted-foreground">Sources de données</p><p className="[overflow-wrap:anywhere]">{research.sources || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Participants</p><p>{research.participants.map((p) => p.name).join(", ") || "—"}</p></div>
        {research.notes && <div className="sm:col-span-2"><p className="text-xs text-muted-foreground">Notes</p><p className="whitespace-pre-wrap">{research.notes}</p></div>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Nom de l&apos;étude</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveMeta} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" /> Sources de données (modifiables)</Label>
          <Input value={sources} onChange={(e) => setSources(e.target.value)} onBlur={saveMeta} placeholder="IQVIA 2025-2026 · Nomenclature DZ · Réceptions PCH 2025" />
          <p className="text-xs text-muted-foreground">Jeux réels branchés à l&apos;app (IQVIA, nomenclature, réceptions PCH) — servent au pré-remplissage et à la présentation IA.</p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveMeta} rows={2} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Participants</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {pIds.length === 0 && <span className="text-xs text-muted-foreground">Aucun participant.</span>}
          {pIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {nameById.get(id) ?? id}
              <button type="button" aria-label={`Retirer ${nameById.get(id) ?? id}`} onClick={() => saveParticipants(pIds.filter((x) => x !== id))} className="-my-1 -mr-1.5 rounded-full p-2 hover:bg-primary/20 sm:m-0 sm:p-0"><X className="h-3.5 w-3.5 sm:h-3 sm:w-3" /></button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Select value="" onChange={(e) => { if (e.target.value) saveParticipants([...pIds, e.target.value]); }} disabled={available.length === 0}>
            <option value="">{available.length ? "+ Ajouter un collaborateur…" : "Tout le monde est déjà participant"}</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">{saving && <Loader2 className="inline h-3.5 w-3.5 animate-spin" />}</span>
        <Button variant="outline" size="sm" onClick={remove} className="text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /> Supprimer l&apos;étude</Button>
      </div>
    </div>
  );
}
