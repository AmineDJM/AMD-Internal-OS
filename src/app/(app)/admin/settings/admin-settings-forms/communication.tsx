"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES — la communication : diffusion d'une annonce, diagnostic des boîtes mail.
 */
import * as React from "react";
import { Loader2, Megaphone, Search } from "lucide-react";
import { sendBroadcast } from "@/lib/actions/notification-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { Opt, UserLite } from "./types";
import { Retour } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";

export function BroadcastComposer({ roles, users }: { roles: Opt[]; users: UserLite[] }) {
  const [audience, setAudience] = React.useState<"ALL" | "ROLE" | "USERS">("ALL");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);

  const filtered = search.trim()
    ? users.filter((u) => u.name.toLowerCase().includes(search.trim().toLowerCase()))
    : users;
  function toggle(id: string) {
    setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <form
      action={async (fd) => {
        setSending(true); setResult(null);
        fd.set("audience", audience);
        picked.forEach((id) => fd.append("userIds", id));
        try {
          const r = await sendBroadcast(fd);
          setResult({ ok: r.ok, text: r.ok ? (r.message ?? "Envoyée.") : (r.error ?? "L'annonce n'a pas été envoyée.") });
          if (r.ok) { setPicked(new Set()); (document.getElementById("bc-form") as HTMLFormElement | null)?.reset(); }
        } catch {
          setResult({ ok: false, text: actionFailureMessage("THROWN") });
        } finally {
          setSending(false);
        }
      }}
      id="bc-form"
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="title">Titre</Label>
          <Input id="title" name="title" required placeholder="ex. Réunion générale demain 10h" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="link">Lien (optionnel)</Label>
          <Input id="link" name="link" placeholder="/messages ou https://…" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="body">Message</Label>
        <Textarea id="body" name="body" className="min-h-[64px]" placeholder="Détail de la notification…" />
      </div>

      <div className="space-y-2">
        <Label>Destinataires</Label>
        <div className="flex flex-wrap gap-1.5">
          {([["ALL", "Tout le monde"], ["ROLE", "Un rôle"], ["USERS", "Personnes choisies"]] as const).map(([v, l]) => (
            <button key={v} type="button" onClick={() => setAudience(v)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${audience === v ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80"}`}>
              {l}
            </button>
          ))}
        </div>

        {audience === "ROLE" && (
          <Select name="role" defaultValue="">
            <option value="">— Choisir un rôle —</option>
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        )}

        {audience === "USERS" && (
          <div className="space-y-1.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une personne…" className="pl-8" />
            </div>
            <div className="max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
              {filtered.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/50">
                  <input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 rounded border-input" />
                  <span className="truncate">{u.name}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{picked.size} sélectionné·s</p>
          </div>
        )}
      </div>

      <label className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 p-3">
        <input type="checkbox" name="popup" className="mt-0.5 h-4 w-4 rounded border-input" />
        <span className="text-sm">
          <span className="font-medium">Afficher en pop-up plein écran</span>
          <span className="block text-xs text-muted-foreground">Une grande fenêtre s'affiche au milieu de l'écran du destinataire (façon alerte importante), en plus de la cloche. Elle reste jusqu'à ce que la personne clique sur « J'ai compris ».</span>
        </span>
      </label>

      {result && <Retour ton={result.ok ? "succes" : "erreur"}>{result.text}</Retour>}
      <div className="flex justify-end">
        <Button type="submit" disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />} Diffuser
        </Button>
      </div>
    </form>
  );
}

interface Mailbox { userId: string; email: string; name: string }
interface DiagResult { ok: boolean; category: string; label: string; raw: string; host: string; email: string }

const DIAG_TONE: Record<string, string> = {
  OK: "border-success/40 bg-success/10 text-success",
  TOO_MANY_CONNECTIONS: "border-warning/40 bg-warning/10 text-warning",
  COMMAND_FAILED: "border-warning/40 bg-warning/10 text-warning",
  AUTH_FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
  IP_BLOCKED: "border-destructive/40 bg-destructive/10 text-destructive",
  TIMEOUT: "border-border bg-secondary/40 text-foreground",
  OTHER: "border-border bg-secondary/40 text-foreground",
};

/** Teste une connexion IMAP réelle et affiche l'erreur brute + la cause probable. */
export function MailDiagnosticPanel({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [userId, setUserId] = React.useState(mailboxes[0]?.userId ?? "");
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<DiagResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  if (mailboxes.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune boîte mail connectée pour le moment. Demandez à un utilisateur de connecter sa boîte dans « Courrier », puis revenez tester ici.</p>;
  }

  async function run() {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await fetch("/api/admin/mail-diagnostic", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data?.error ?? "Diagnostic impossible."); return; }
      setRes(data as DiagResult);
    } catch { setErr("Diagnostic impossible (réseau)."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-full space-y-1 sm:min-w-[16rem] sm:basis-auto">
          <Label htmlFor="diag-mailbox">Boîte à tester</Label>
          <Select id="diag-mailbox" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {mailboxes.map((m) => <option key={m.userId} value={m.userId}>{m.name} — {m.email}</option>)}
          </Select>
        </div>
        <Button type="button" onClick={run} disabled={busy || !userId}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Tester la connexion
        </Button>
      </div>

      <Retour ton="erreur">{err}</Retour>

      {res && (
        <div className={`space-y-2 rounded-lg border px-3 py-3 text-sm ${DIAG_TONE[res.category] ?? DIAG_TONE.OTHER}`}>
          <p className="font-semibold">{res.ok ? "✓ " : "✗ "}{res.category}</p>
          <p>{res.label}</p>
          <p className="text-xs opacity-80">Serveur : {res.host} · {res.email}</p>
          {res.raw && (
            <div>
              <p className="text-xs font-medium opacity-80">Message brut du serveur :</p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-[0.6875rem] text-foreground">{res.raw}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
