"use client";

import * as React from "react";
import {
  X, Pin, BellOff, Bell, Hash, Users, UserPlus, LogOut, Archive, Crown, Shield,
  Loader2, Check, Search, Trash2, Pencil,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ROLE_LABELS, CONV_NOTIFY_LEVEL, CONV_MEMBER_ROLE } from "@/lib/labels";
import type { ConversationDetailDTO, DirectoryUserDTO } from "@/lib/queries/messaging";
import {
  togglePinConversation, toggleMute, setNotifyLevel, updateConversation,
  addMembers, removeMember, setMemberRole, leaveConversation, archiveConversation,
} from "@/lib/actions/messaging-actions";
import { PresenceDot } from "./format";

interface Props {
  detail: ConversationDetailDTO;
  directory: DirectoryUserDTO[];
  selfId: string;
  onChanged: () => void;
  onLeft: () => void;
  onClose: () => void;
}

const cid = (id: string) => { const f = new FormData(); f.set("conversationId", id); return f; };

export function InfoPanel({ detail, directory, selfId, onChanged, onLeft, onClose }: Props) {
  const canManage = detail.myRole === "OWNER" || detail.myRole === "ADMIN";
  const isOwner = detail.myRole === "OWNER";
  const isDirect = detail.type === "DIRECT";
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(detail.title);
  const [description, setDescription] = React.useState(detail.description ?? "");
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const confirmer = useConfirmer();
  const retours = useRetours();

  const act = async (fn: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    try { await fn(); } catch { retours.erreur(actionFailureMessage("THROWN")); } finally { setBusy(false); }
    onChanged();
  };

  const saveInfo = async () => {
    const f = cid(detail.id);
    f.set("title", title);
    f.set("description", description);
    if (detail.icon) f.set("icon", detail.icon);
    if (detail.avatarColor) f.set("color", detail.avatarColor);
    setBusy(true); await updateConversation(f); setBusy(false); setEditing(false); onChanged();
  };

  return (
    <div className="flex h-full w-full flex-col bg-card md:w-80 md:border-l md:border-border">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5 sm:py-3">
        <h2 className="text-sm font-semibold">Détails</h2>
        <button onClick={onClose} aria-label="Fermer" className="-mr-1 rounded-lg p-2 text-muted-foreground hover:bg-secondary sm:mr-0 sm:p-1.5"><X className="h-5 w-5" /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Identité */}
        <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
          {isDirect ? (
            <span className="relative">
              <Avatar name={detail.avatarName} color={detail.avatarColor} size="lg" className="h-16 w-16 text-xl" />
              <PresenceDot presence={detail.presence} className="absolute bottom-0 right-0 h-4 w-4" />
            </span>
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl text-white" style={{ backgroundColor: detail.avatarColor ?? (detail.type === "CHANNEL" ? "#0f766e" : "#7c3aed") }}>
              {detail.type === "CHANNEL" ? <Hash className="h-7 w-7" /> : <Users className="h-7 w-7" />}
            </span>
          )}
          {editing ? (
            <div className="w-full space-y-2 text-left">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Sujet…" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={saveInfo}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer</Button>
                <Button size="sm" variant="outline" onClick={() => { setEditing(false); setTitle(detail.title); setDescription(detail.description ?? ""); }}>Annuler</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex max-w-full items-center gap-1.5">
                <h3 className="min-w-0 text-lg font-bold [overflow-wrap:anywhere]">{detail.title}</h3>
                {canManage && !isDirect && (
                  <button onClick={() => setEditing(true)} aria-label="Modifier" className="shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1"><Pencil className="h-3.5 w-3.5" /></button>
                )}
              </div>
              {detail.description && <p className="max-w-full text-sm text-muted-foreground [overflow-wrap:anywhere]">{detail.description}</p>}
              {!isDirect && <p className="text-xs text-muted-foreground">{detail.type === "CHANNEL" ? "Canal" : "Groupe"} · {detail.memberCount} membres{detail.createdByName ? ` · créé par ${detail.createdByName}` : ""}</p>}
            </>
          )}
        </div>

        {/* Préférences */}
        <div className="space-y-1 px-3 py-2">
          <p className="px-1 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Préférences</p>
          <Row icon={Pin} label="Épingler dans ma liste" active={detail.isPinned} onClick={() => act(() => togglePinConversation(cid(detail.id)))} disabled={busy} toggle />
          <Row icon={detail.isMuted ? BellOff : Bell} label={detail.isMuted ? "Réactiver le son" : "Mettre en sourdine"} active={detail.isMuted} onClick={() => act(() => toggleMute(cid(detail.id)))} disabled={busy} toggle />
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-2">
            <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-sm">Notifications</span>
            <Select
              value={detail.notifyLevel}
              onChange={(e) => { const f = cid(detail.id); f.set("level", e.target.value); act(() => setNotifyLevel(f)); }}
              className="h-10 w-44 max-w-[55%] text-xs sm:h-8 sm:w-40"
            >
              {Object.entries(CONV_NOTIFY_LEVEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
        </div>

        {/* Membres */}
        {!isDirect && (
          <div className="px-3 py-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Membres · {detail.members.length}</p>
              {canManage && (
                <button onClick={() => setAdding((v) => !v)} className="-my-1.5 flex items-center gap-1 py-2 text-xs font-medium text-primary hover:underline sm:my-0 sm:py-0">
                  <UserPlus className="h-3.5 w-3.5" /> Ajouter
                </button>
              )}
            </div>

            {adding && (
              <AddMembers
                detail={detail}
                directory={directory}
                onDone={() => { setAdding(false); onChanged(); }}
              />
            )}

            <div className="space-y-0.5">
              {detail.members.map((m) => (
                <div key={m.userId} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/60">
                  <span className="relative shrink-0">
                    <Avatar name={m.name} color={m.avatarColor} size="sm" />
                    <PresenceDot presence={m.presence} className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1 text-sm font-medium">
                      <span className="truncate">{m.name}{m.userId === selfId && " (vous)"}</span>
                      {m.memberRole === "OWNER" && <Crown className="h-3 w-3 shrink-0 text-amber-500" />}
                      {m.memberRole === "ADMIN" && <Shield className="h-3 w-3 shrink-0 text-primary" />}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.title || ROLE_LABELS[m.role]}</p>
                  </div>
                  {isOwner && m.userId !== selfId && m.memberRole !== "OWNER" && (
                    <div className="flex shrink-0 items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                      <button
                        title={m.memberRole === "ADMIN" ? "Rétrograder" : "Promouvoir admin"}
                        aria-label={m.memberRole === "ADMIN" ? "Rétrograder" : "Promouvoir admin"}
                        onClick={() => { const f = cid(detail.id); f.set("userId", m.userId); f.set("role", m.memberRole === "ADMIN" ? "MEMBER" : "ADMIN"); act(() => setMemberRole(f)); }}
                        className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1"
                      >
                        <Shield className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Retirer"
                        aria-label="Retirer"
                        onClick={async () => { if (await confirmer(`Retirer ${m.name} ?`)) { const f = cid(detail.id); f.set("userId", m.userId); act(() => removeMember(f)); } }}
                        className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions de bas de panneau */}
      {!isDirect && (
        <div className="shrink-0 space-y-1 border-t border-border p-3">
          {canManage && (
            <button
              onClick={() => { const f = cid(detail.id); f.set("archived", detail.isArchived ? "false" : "true"); act(() => archiveConversation(f)); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-secondary"
            >
              <Archive className="h-4 w-4" /> {detail.isArchived ? "Désarchiver" : "Archiver"}
            </button>
          )}
          <button
            onClick={async () => {
              if (!(await confirmer("Quitter cette conversation ?"))) return;
              setBusy(true);
              try { await leaveConversation(cid(detail.id)); } catch { retours.erreur(actionFailureMessage("THROWN")); return; } finally { setBusy(false); }
              onLeft();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-destructive hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" /> Quitter la conversation
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ icon: IconC, label, active, onClick, disabled, toggle }: { icon: typeof Pin; label: string; active?: boolean; onClick: () => void; disabled?: boolean; toggle?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-secondary disabled:opacity-50">
      <IconC className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />
      <span className="flex-1">{label}</span>
      {toggle && <span className={cn("h-4 w-7 rounded-full p-0.5 transition-colors", active ? "bg-primary" : "bg-secondary")}><span className={cn("block h-3 w-3 rounded-full bg-white transition-transform", active && "translate-x-3")} /></span>}
    </button>
  );
}

function AddMembers({ detail, directory, onDone }: { detail: ConversationDetailDTO; directory: DirectoryUserDTO[]; onDone: () => void }) {
  const memberIds = new Set(detail.members.map((m) => m.userId));
  const candidates = directory.filter((u) => !memberIds.has(u.id));
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const list = candidates.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));

  const submit = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const f = cid(detail.id);
    f.set("members", [...selected].join(","));
    await addMembers(f);
    setBusy(false);
    onDone();
  };

  return (
    <div className="mb-2 rounded-xl border border-border p-2">
      <div className="mb-1 flex items-center gap-2 border-b border-border px-1 pb-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher…" className="h-9 w-full min-w-0 bg-transparent text-base focus:outline-none sm:h-7 lg:text-sm" />
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto sm:max-h-40">
        {list.map((u) => {
          const on = selected.has(u.id);
          return (
            <button key={u.id} onClick={() => setSelected((s) => { const n = new Set(s); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n; })} className={cn("flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left sm:py-1", on ? "bg-accent" : "hover:bg-secondary")}>
              <Avatar name={u.name} color={u.avatarColor} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{u.name}</span>
              {on && <Check className="h-4 w-4 text-primary" />}
            </button>
          );
        })}
        {list.length === 0 && <p className="py-2 text-center text-xs text-muted-foreground">Personne à ajouter.</p>}
      </div>
      <Button size="sm" className="mt-2 w-full" disabled={busy || selected.size === 0} onClick={submit}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Ajouter {selected.size > 0 ? `(${selected.size})` : ""}
      </Button>
    </div>
  );
}
