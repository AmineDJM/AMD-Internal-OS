"use client";

import * as React from "react";
import { Search, Hash, Users, MessageSquare, Check, Loader2, Compass } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ROLE_LABELS } from "@/lib/labels";
import type { DirectoryUserDTO, ChannelDTO } from "@/lib/queries/messaging";
import { createDirect, createGroup, createChannel, joinChannel } from "@/lib/actions/messaging-actions";
import { PresenceDot } from "./format";

type Mode = "dm" | "group" | "channel" | "browse";

interface Props {
  open: boolean;
  onClose: () => void;
  directory: DirectoryUserDTO[];
  channels: ChannelDTO[];
  onCreated: (conversationId: string) => void;
}

export function NewConversation({ open, onClose, directory, channels, onCreated }: Props) {
  const [mode, setMode] = React.useState<Mode>("dm");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const reset = () => { setMode("dm"); setErr(null); setBusy(false); };

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; id?: string }>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      setBusy(false);
      if (r.ok && r.id) { onCreated(r.id); reset(); }
      else setErr(r.error ?? "La conversation n'a pas été ouverte.");
    } catch {
      setBusy(false);
      setErr(actionFailureMessage("THROWN"));
    }
  };

  return (
    <Sheet open={open} onClose={() => { reset(); onClose(); }} title="Nouvelle conversation" description="Démarrez un échange privé, créez un groupe ou un canal d'équipe." width="lg">
      <div className="mb-4 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {([
          ["dm", "Message", MessageSquare],
          ["group", "Groupe", Users],
          ["channel", "Canal", Hash],
          ["browse", "Parcourir", Compass],
        ] as [Mode, string, typeof Hash][]).map(([m, label, IconC]) => (
          <button
            key={m}
            onClick={() => { setMode(m); setErr(null); }}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium transition-colors",
              mode === m ? "border-primary bg-accent text-accent-foreground" : "border-border hover:bg-secondary",
            )}
          >
            <IconC className="h-5 w-5" />
            {label}
          </button>
        ))}
      </div>

      {err && <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      {mode === "dm" && <DirectPicker directory={directory} busy={busy} onPick={(userId) => run(() => createDirect(fd({ userId })))} />}
      {mode === "group" && <GroupForm kind="group" directory={directory} busy={busy} onSubmit={(data) => run(() => createGroup(fd(data)))} />}
      {mode === "channel" && <GroupForm kind="channel" directory={directory} busy={busy} onSubmit={(data) => run(() => createChannel(fd(data)))} />}
      {mode === "browse" && <BrowseChannels channels={channels} busy={busy} onJoin={(conversationId) => run(() => joinChannel(fd({ conversationId })))} />}
    </Sheet>
  );
}

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

function DirectPicker({ directory, busy, onPick }: { directory: DirectoryUserDTO[]; busy: boolean; onPick: (userId: string) => void }) {
  const [q, setQ] = React.useState("");
  const list = directory.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) || (u.title ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <SearchBox value={q} onChange={setQ} placeholder="Rechercher un collègue…" />
      <div className="mt-2 max-h-[55dvh] space-y-0.5 overflow-y-auto">
        {list.map((u) => (
          <button key={u.id} disabled={busy} onClick={() => onPick(u.id)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-secondary disabled:opacity-50">
            <span className="relative shrink-0">
              <Avatar name={u.name} color={u.avatarColor} />
              <PresenceDot presence={u.presence} className="absolute -bottom-0.5 -right-0.5 h-3 w-3" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{u.name}</p>
              <p className="truncate text-xs text-muted-foreground">{u.title || ROLE_LABELS[u.role] || ""}{u.departmentName ? ` · ${u.departmentName}` : ""}</p>
            </div>
          </button>
        ))}
        {list.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Aucun collègue trouvé.</p>}
      </div>
    </div>
  );
}

function GroupForm({
  kind, directory, busy, onSubmit,
}: {
  kind: "group" | "channel";
  directory: DirectoryUserDTO[];
  busy: boolean;
  onSubmit: (data: Record<string, string>) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{kind === "channel" ? "Nom du canal" : "Nom du groupe"}</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "channel" ? "ex. Annonces, Réglementaire…" : "ex. Équipe Ventes"} />
      </div>
      {kind === "channel" && (
        <div className="space-y-1.5">
          <Label>Sujet (optionnel)</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi sert ce canal ?" rows={2} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>Membres {selected.size > 0 && <span className="text-muted-foreground">· {selected.size} sélectionné(s)</span>}</Label>
        <MemberMultiSelect directory={directory} selected={selected} onToggle={toggle} />
      </div>
      <Button
        disabled={busy || !title.trim()}
        onClick={() => onSubmit({ title: title.trim(), description, members: [...selected].join(",") })}
        className="w-full"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : kind === "channel" ? <Hash className="h-4 w-4" /> : <Users className="h-4 w-4" />}
        Créer {kind === "channel" ? "le canal" : "le groupe"}
      </Button>
    </div>
  );
}

function MemberMultiSelect({ directory, selected, onToggle }: { directory: DirectoryUserDTO[]; selected: Set<string>; onToggle: (id: string) => void }) {
  const [q, setQ] = React.useState("");
  const list = directory.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="rounded-xl border border-border">
      <SearchBox value={q} onChange={setQ} placeholder="Ajouter des membres…" bare />
      <div className="max-h-52 space-y-0.5 overflow-y-auto p-1">
        {list.map((u) => {
          const on = selected.has(u.id);
          return (
            <button key={u.id} onClick={() => onToggle(u.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left sm:py-1.5", on ? "bg-accent" : "hover:bg-secondary")}>
              <Avatar name={u.name} color={u.avatarColor} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{u.name}</p>
                <p className="truncate text-xs text-muted-foreground">{u.title || ROLE_LABELS[u.role]}</p>
              </div>
              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                {on && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          );
        })}
        {list.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">Aucun résultat.</p>}
      </div>
    </div>
  );
}

function BrowseChannels({ channels, busy, onJoin }: { channels: ChannelDTO[]; busy: boolean; onJoin: (id: string) => void }) {
  if (channels.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Aucun canal à rejoindre pour l'instant.</p>;
  return (
    <div className="max-h-[60dvh] space-y-2 overflow-y-auto">
      {channels.map((c) => (
        <div key={c.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: c.color ?? "#0f766e" }}>
            <Hash className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{c.title}</p>
            <p className="truncate text-xs text-muted-foreground">{c.description || `${c.memberCount} membre(s)`}</p>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onJoin(c.id)}>Rejoindre</Button>
        </div>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder, bare }: { value: string; onChange: (v: string) => void; placeholder: string; bare?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 px-3", bare ? "border-b border-border" : "rounded-lg border border-input bg-background")}>
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-10 w-full min-w-0 bg-transparent text-base focus:outline-none sm:h-9 lg:text-sm" />
    </div>
  );
}
