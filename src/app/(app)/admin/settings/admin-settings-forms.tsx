"use client";

import * as React from "react";
import { Loader2, Check, Megaphone, Search, Plus, X, RotateCcw, Eye, EyeOff } from "lucide-react";
import { saveAppSettings, setAdProDgThreshold, setRegEnrollmentEnabled, setRegulatorySupervisorRoles, setRegulatoryTherapeuticSegments, setRegulatoryHiddenColumns, setDriveSpaceCreatorRoles, setFieldReportsOverviewRoles, setPromoMessageAuthorRoles, setOrgChartViewers, setHiddenModules, setPipelineAccess, setDirectiveAccess } from "@/lib/actions/settings-actions";
import { describePipelineAudience } from "@/lib/regulatory/pipeline-access";
import { describeDirectiveAccess } from "@/lib/directives/access";
import { setRegIntelligenceEnabled } from "@/lib/regulatory/intelligence/actions";
import { sendBroadcast } from "@/lib/actions/notification-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { THERAPEUTIC_SEGMENTS } from "@/lib/labels";
import { COLONNES_REGULATORY, COLONNES_INAMOVIBLES } from "@/lib/vues/colonnes-regulatory";
import { hiddenSummary } from "@/lib/modules-visibility";
import type { AppSettings } from "@/lib/settings";

interface Opt { value: string; label: string }
interface UserLite { id: string; name: string; role: string }

export function AdminLimitsForm({ settings }: { settings: AppSettings }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setSaving(true); setError(null);
        const r = await saveAppSettings(fd);
        setSaving(false);
        if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(r.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="maxUploadMb">Documents / pièces jointes — taille max (Mo)</Label>
          <Input id="maxUploadMb" name="maxUploadMb" type="number" min="1" max="256" defaultValue={settings.maxUploadMb} />
          <p className="text-xs text-muted-foreground">S'applique à TOUS les documents (Regulatory, Congrès, Sujets, RH, médical…). Jusqu'à 256 Mo ; au-delà, passez par le Drive.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="maxDriveUploadMb">Drive — taille max (Mo)</Label>
          <Input id="maxDriveUploadMb" name="maxDriveUploadMb" type="number" min="1" max="10240" defaultValue={settings.maxDriveUploadMb} />
          <p className="text-xs text-muted-foreground">Fichiers du Drive (gros transferts en flux), jusqu'à 2 048 Mo.</p>
        </div>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer les limites"}
        </Button>
      </div>
    </form>
  );
}


/**
 * LE SEUIL Ad & Pro AU-DELÀ DUQUEL LE DIRECTEUR GÉNÉRAL VALIDE (§118.138).
 *
 * Un seul champ, et c'est l'essentiel : le MÊME chiffre gouverne les quatre circuits
 * configurables et le matériel promotionnel. La phrase le dit en toutes lettres — un réglage
 * dont on ne sait pas ce qu'il touche ne se règle pas, il se laisse tel quel.
 */
export function AdProDgThresholdForm({ settings }: { settings: AppSettings }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setSaving(true); setError(null);
        const r = await setAdProDgThreshold(fd);
        setSaving(false);
        if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(r.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label htmlFor="adProDgThreshold">Seuil de validation du Directeur Général (DZD)</Label>
        <Input
          id="adProDgThreshold" name="adProDgThreshold" type="number" min="0" step="any"
          defaultValue={settings.adProDgThreshold}
        />
        <p className="text-xs text-muted-foreground">
          Au-delà de ce montant, la demande passe par le <strong>Centre de validation Ad &amp; Pro</strong> —
          sur les <strong>sept</strong> natures du pôle, sans exception : sponsoring, prises en charge nationales
          et internationales, événements, matériel promotionnel, consulting et autres demandes. En dessous, la
          porte est franchie automatiquement et tracée. <strong>0</strong> = aucune validation du centre.
          Ce même seuil se règle depuis le centre.
        </p>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer le seuil"}
        </Button>
      </div>
    </form>
  );
}

/** Débloque / masque l'onglet Regulatory « Enregistrement » (analyseur CTD). */
export function RegEnrollmentToggle({ enabled: initial }: { enabled: boolean }) {
  const [enabled, setEnabled] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function toggle(next: boolean) {
    setBusy(true); setError(null);
    const r = await setRegEnrollmentEnabled(next);
    setBusy(false);
    if (r.ok) setEnabled(next);
    else setError(r.error ?? "Échec.");
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Onglet « Enregistrement » (analyseur de dossier CTD)</p>
          <p className="text-xs text-muted-foreground">
            {enabled ? "Visible pour les utilisateurs ayant accès à Regulatory." : "Masqué. Activez pour rendre l'onglet visible dans Regulatory."}
          </p>
        </div>
        <button
          type="button" role="switch" aria-checked={enabled} disabled={busy}
          onClick={() => toggle(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${enabled ? "bg-primary" : "bg-input"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      {busy && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Mise à jour…</p>}
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

interface CompanyFlag { id: string; name: string; enabled: boolean }

/** Déblocage du Regulatory Intelligence OS **par organisation** (un interrupteur par entité). */
export function RegIntelligenceToggles({ companies }: { companies: CompanyFlag[] }) {
  const [state, setState] = React.useState<Record<string, boolean>>(
    Object.fromEntries(companies.map((c) => [c.id, c.enabled])),
  );
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function toggle(companyId: string, next: boolean) {
    setBusyId(companyId); setError(null);
    const r = await setRegIntelligenceEnabled(companyId, next);
    setBusyId(null);
    if (r.ok) setState((s) => ({ ...s, [companyId]: next }));
    else setError(r.error ?? "Échec.");
  }

  if (companies.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune organisation active. Créez une entité dans Administration → Entités.</p>;
  }

  return (
    <div className="space-y-2">
      {companies.map((c) => {
        const enabled = state[c.id];
        return (
          <div key={c.id} className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">
                {enabled ? "Analyse CTD activée — workspace visible pour les rôles réglementaires." : "Verrouillé. Activez pour ouvrir l'analyse intelligente des dossiers CTD."}
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={enabled} disabled={busyId === c.id}
              onClick={() => toggle(c.id, !enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${enabled ? "bg-primary" : "bg-input"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
        );
      })}
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

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
        const r = await sendBroadcast(fd);
        setSending(false);
        setResult({ ok: r.ok, text: r.ok ? (r.message ?? "Envoyée.") : (r.error ?? "Échec.") });
        if (r.ok) { setPicked(new Set()); (document.getElementById("bc-form") as HTMLFormElement | null)?.reset(); }
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

      {result && <p className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>{result.text}</p>}
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

      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

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

/** Sélection des rôles « superviseurs Regulatory » (Super Admin toujours inclus). */
export function RegulatorySupervisorForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setRegulatorySupervisorRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Le Super Admin est toujours superviseur. Ajoutez ici les rôles qui pourront aussi prioriser, fixer les dates cibles et être notifiés.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les superviseurs"}
      </Button>
    </form>
  );
}

/**
 * LES COLONNES DU TABLEAU REGULATORY — celles que la maison retire, pour tout le monde.
 *
 * À ne pas confondre avec le bouton « Colonnes » du tableau, qui reste : celui-là est une
 * préférence de NAVIGATEUR (« pas sur mon écran »). Ici on décide de la maison — sur les DEUX
 * sous-modules, pour tout le monde, et ça survit au vidage du cache.
 *
 * La RÉFÉRENCE ne se propose pas : elle identifie la ligne, et la masquer rendrait le tableau
 * illisible sans qu'on puisse revenir en arrière depuis le tableau lui-même.
 *
 * Adam sait faire le même geste (« supprime la colonne classe thérapeutique ») : c'est le MÊME
 * réglage et le MÊME catalogue — un autre chemin vers le même levier, jamais un levier caché.
 */
export function RegulatoryHiddenColumnsForm({ hidden }: { hidden: string[] }) {
  const [list, setList] = React.useState<string[]>(hidden);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const proposables = COLONNES_REGULATORY.filter((c) => !COLONNES_INAMOVIBLES.includes(c.key));

  const toggle = (key: string) =>
    setList((l) => (l.includes(key) ? l.filter((k) => k !== key) : [...l, key]));

  const save = async () => {
    setSaving(true); setErr(null);
    const fd = new FormData();
    list.forEach((k) => fd.append("columns", k));
    const res = await setRegulatoryHiddenColumns(fd);
    setSaving(false);
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
    else setErr(res.error ?? "Enregistrement impossible.");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {proposables.map((c) => {
          const masquee = list.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              aria-pressed={masquee}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${
                masquee ? "border-destructive/60 bg-destructive/10 text-destructive" : "border-input text-muted-foreground hover:bg-secondary"
              }`}
            >
              {masquee && <X className="h-3 w-3" />} {c.header}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {list.length === 0
          ? "Toutes les colonnes sont affichées."
          : `${list.length} colonne(s) retirée(s) du tableau — les données restent sur les fiches et reviennent dès qu'on les remet.`}
      </p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer
        </Button>
        {saved && <span className="text-xs text-success">Enregistré</span>}
      </div>
    </div>
  );
}

/**
 * Les SEGMENTS THÉRAPEUTIQUES du tableau Regulatory — l'administrateur compose la liste.
 *
 * Le marché d'un groupe n'est pas celui d'un autre : la liste intégrée n'est qu'un point de
 * départ. On ajoute, on retire, on enregistre — et une liste vide rétablit la liste par défaut,
 * pour ne jamais laisser le menu de la colonne « Segments » sans aucune option.
 */
export function RegulatoryTherapeuticSegmentsForm({ segments }: { segments: string[] }) {
  const [list, setList] = React.useState<string[]>(segments);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const usingDefault = list.length === 0;

  const add = () => {
    const v = draft.replace(/\s+/g, " ").trim();
    if (!v) return;
    if (list.some((s) => s.toLowerCase() === v.toLowerCase())) { setDraft(""); return; }
    setList((l) => [...l, v]);
    setDraft("");
  };
  const remove = (seg: string) => setList((l) => l.filter((s) => s !== seg));

  const save = async () => {
    setSaving(true);
    const fd = new FormData();
    list.forEach((s) => fd.append("segments", s));
    const res = await setRegulatoryTherapeuticSegments(fd);
    setSaving(false);
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
  };

  return (
    <div className="space-y-3">
      {usingDefault && (
        <p className="rounded-lg border border-border bg-secondary/30 p-2.5 text-xs text-muted-foreground">
          Aucune liste personnalisée : le tableau Regulatory propose la <strong>liste par défaut</strong>
          {" "}({THERAPEUTIC_SEGMENTS.length} segments). Ajoutez-en pour composer votre propre liste —
          elle remplacera alors entièrement la liste par défaut.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {(usingDefault ? THERAPEUTIC_SEGMENTS : list).map((seg) => (
          <span
            key={seg}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium ${usingDefault ? "border-input text-muted-foreground" : "border-primary bg-primary/10 text-primary"}`}
          >
            {seg}
            {!usingDefault && (
              <button type="button" onClick={() => remove(seg)} className="-my-1 -mr-1.5 rounded-full p-1.5 hover:bg-primary/20 sm:m-0 sm:p-0.5" aria-label={`Retirer ${seg}`}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Ajouter un segment (ex. Cardiologie)…"
          className="w-full sm:w-64"
        />
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-4 w-4" /> Ajouter
        </Button>
        {!usingDefault && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setList([])} title="Vider — rétablit la liste par défaut">
            <RotateCcw className="h-4 w-4" /> Liste par défaut
          </Button>
        )}
        {usingDefault && list.length === 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setList([...THERAPEUTIC_SEGMENTS])} title="Partir de la liste par défaut pour la personnaliser">
            Partir de la liste par défaut
          </Button>
        )}
      </div>

      <Button type="button" size="sm" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les segments"}
      </Button>
    </div>
  );
}

/** Sélection des rôles autorisés à CRÉER des catégories de Drive (Super Admin toujours inclus). */
export function DriveSpaceCreatorForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setDriveSpaceCreatorRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Le Super Admin peut toujours créer des catégories de Drive (espaces partagés type « Promotion Médicale », présentés en onglets). Ajoutez ici les rôles qui pourront aussi en créer et gérer les accès.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les créateurs"}
      </Button>
    </form>
  );
}

/**
 * Rôles autorisés à ÉCRIRE les messages pré-définis de la Direction Marketing.
 *
 * Le référentiel VIDE fait refuser tous les rapports terrain (ils en exigent au moins un) : ce
 * réglage n'est donc pas un confort, c'est ce qui rend le module utilisable.
 */
export function PromoMessageAuthorsForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setPromoMessageAuthorRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Chaque rapport terrain exige au moins un message pré-défini : tant que personne ne peut en publier, tous les
        rapports sont refusés. Une LISTE DE RÔLES plutôt qu&apos;un droit de module — Direction Marketing n&apos;a que
        la lecture sur la promotion médicale, et lui donner l&apos;écriture du module ouvrirait aussi les praticiens et
        les visites.
      </p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les auteurs"}
      </Button>
    </form>
  );
}

/** Sélection des rôles autorisés à voir l'onglet « Overview » des Rapports terrain (Super Admin toujours inclus). */
export function FieldReportsOverviewForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setFieldReportsOverviewRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Le Super Admin voit toujours l'onglet « Overview » (graphes d'analyse des rapports terrain : visites par médecin, hôpital, délégué…). Ajoutez ici les rôles qui pourront aussi le consulter.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer l'accès Overview"}
      </Button>
    </form>
  );
}

/**
 * ORGANIGRAMME — qui peut le CONSULTER : des rôles (les RH au premier chef) et/ou des personnes
 * nommées. Le Super Admin reste seul à le RÉORGANISER. Deux listes plutôt qu'une : « tous les
 * RH » est une règle durable, « cette personne-là » un cas particulier — les confondre obligerait
 * à créer un rôle pour chaque exception.
 */
export function OrgChartViewersForm({ roles, users, selectedRoles, selectedUserIds }: {
  roles: Opt[];
  users: UserLite[];
  selectedRoles: string[];
  selectedUserIds: string[];
}) {
  const [picked, setPicked] = React.useState<string[]>(selectedRoles);
  const [pickedUsers, setPickedUsers] = React.useState<string[]>(selectedUserIds);
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const toggleUser = (id: string) => setPickedUsers((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const q = query.trim().toLowerCase();
  const shown = q ? users.filter((u) => u.name.toLowerCase().includes(q)) : users.filter((u) => pickedUsers.includes(u.id));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        pickedUsers.forEach((id) => fd.append("userIds", id));
        const res = await setOrgChartViewers(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label className="text-xs">Rôles autorisés</Label>
        <div className="flex flex-wrap gap-2">
          {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
            const on = picked.includes(r.value);
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => toggle(r.value)}
                className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Personnes nommément autorisées {pickedUsers.length > 0 ? `(${pickedUsers.length})` : ""}</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une personne…" className="h-10 pl-8 text-xs sm:h-8" />
        </div>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground">{q ? "Aucune personne trouvée." : "Aucune personne ajoutée — cherchez un nom pour en ajouter."}</p>
          ) : shown.map((u) => {
            const on = pickedUsers.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => toggleUser(u.id)}
                className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-1 transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {u.name}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">Les personnes autorisées consultent l'organigramme sur <strong>/organigramme</strong>, filtrable par entité ou sur le groupe entier. Seul le Super Admin modifie les rattachements, les postes et la carte.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès"}
      </Button>
    </form>
  );
}

/**
 * MASQUER / DÉMASQUER DES MODULES.
 *
 * Le geste est RÉVERSIBLE et le formulaire le dit : masquer ne supprime rien — ni les données,
 * ni les droits. C'est ce qui permet de couper un module en refonte sans se demander ce qu'on
 * perd, et de le rallumer d'un clic.
 *
 * Les pastilles montrent l'état RÉEL : une pastille allumée = module masqué. On lit donc l'écran
 * comme on lit un tableau de bord — ce qui est éteint se voit d'un coup d'œil, sans compter.
 */
export function HiddenModulesForm({ modules, selected }: { modules: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((m) => fd.append("modules", m));
        const res = await setHiddenModules(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <p className="text-xs text-muted-foreground">{hiddenSummary(picked)}</p>
      <div className="flex flex-wrap gap-2">
        {modules.map((m) => {
          const off = picked.includes(m.value);
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => toggle(m.value)}
              aria-pressed={off}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${off ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Un module masqué disparaît du menu <strong>et devient injoignable par son adresse</strong> — sinon
        « masqué » ne voudrait dire que « absent du menu ». <strong>Rien n&apos;est supprimé</strong> : les
        données, les droits et les circuits restent en place, et démasquer rend le module tel qu&apos;il était.
        Vous continuez de le voir, vous seul. La Console d&apos;Administration ne peut pas être masquée :
        c&apos;est par elle qu&apos;on rallume.
      </p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les modules en service"}
      </Button>
    </form>
  );
}

/**
 * UN NIVEAU D'ACCÈS — des rôles, et des personnes nommées. Réutilisé pour les deux niveaux du
 * pipeline (consultation / cadenas) : deux blocs écrits deux fois auraient divergé dès la
 * première correction, et l'administrateur aurait eu deux ergonomies pour un même geste.
 */
function RolePeoplePicker({
  title, hint, roles, users, pickedRoles, pickedUsers, onToggleRole, onToggleUser,
}: {
  title: string;
  hint: string;
  roles: Opt[];
  users: UserLite[];
  pickedRoles: string[];
  pickedUsers: string[];
  onToggleRole: (v: string) => void;
  onToggleUser: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  // Sans recherche, on n'affiche QUE les personnes déjà choisies : dérouler cent noms pour en
  // cocher deux transforme un réglage en corvée, et l'on finit par ne plus le régler.
  const shown = q ? users.filter((u) => u.name.toLowerCase().includes(q)) : users.filter((u) => pickedUsers.includes(u.id));

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = pickedRoles.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => onToggleRole(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Personnes nommées {pickedUsers.length > 0 ? `(${pickedUsers.length})` : ""}</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une personne…" className="h-10 pl-8 text-xs sm:h-8" />
        </div>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground">{q ? "Aucune personne trouvée." : "Aucune personne ajoutée — cherchez un nom pour en ajouter."}</p>
          ) : shown.map((u) => {
            const on = pickedUsers.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onToggleUser(u.id)}
                className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-1 transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {u.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * LES ACCÈS AU PIPELINE — deux niveaux, jamais confondus.
 *
 * CONSULTER, c'est lire un portefeuille qu'on n'a pas encore décidé de déposer. TENIR LE CADENAS,
 * c'est le publier à toute l'entreprise — et cela ne se reprend pas : ce qui a été lu a été lu.
 * L'écran affiche donc le second en second, avec sa propre mise en garde, plutôt que de mêler les
 * deux listes dans un seul bloc « accès » où l'on cocherait le mauvais.
 */
export function PipelineAccessForm({ roles, users, settings }: {
  roles: Opt[];
  users: UserLite[];
  settings: Pick<AppSettings, "pipelineViewerRoles" | "pipelineViewerUserIds" | "pipelineManagerRoles" | "pipelineManagerUserIds">;
}) {
  const [viewerRoles, setViewerRoles] = React.useState<string[]>(settings.pipelineViewerRoles);
  const [viewerUsers, setViewerUsers] = React.useState<string[]>(settings.pipelineViewerUserIds);
  const [managerRoles, setManagerRoles] = React.useState<string[]>(settings.pipelineManagerRoles);
  const [managerUsers, setManagerUsers] = React.useState<string[]>(settings.pipelineManagerUserIds);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const flip = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  const audience = describePipelineAudience({
    pipelineViewerRoles: viewerRoles,
    pipelineViewerUserIds: viewerUsers,
    pipelineManagerRoles: managerRoles,
    pipelineManagerUserIds: managerUsers,
  });

  return (
    <form
      action={async () => {
        setSaving(true); setError(null);
        const fd = new FormData();
        viewerRoles.forEach((r) => fd.append("viewerRoles", r));
        viewerUsers.forEach((id) => fd.append("viewerUserIds", id));
        managerRoles.forEach((r) => fd.append("managerRoles", r));
        managerUsers.forEach((id) => fd.append("managerUserIds", id));
        const res = await setPipelineAccess(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(res.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <RolePeoplePicker
        title="Consulter les dossiers verrouillés"
        hint="Voir le portefeuille à l'étude — dans le pipeline, mais aussi partout ailleurs (recherche, sélecteurs de produits, assistant). C'est une confidence, pas un pouvoir."
        roles={roles} users={users}
        pickedRoles={viewerRoles} pickedUsers={viewerUsers}
        onToggleRole={flip(setViewerRoles)} onToggleUser={flip(setViewerUsers)}
      />

      <RolePeoplePicker
        title="Tenir le cadenas (ouvrir un dossier)"
        hint="Ouvrir un dossier le rend visible de TOUTE l'entreprise, et cela ne se reprend pas : ce qui a été lu a été lu. À donner à moins de monde que la consultation. Tenir le cadenas donne aussi la consultation."
        roles={roles} users={users}
        pickedRoles={managerRoles} pickedUsers={managerUsers}
        onToggleRole={flip(setManagerRoles)} onToggleUser={flip(setManagerUsers)}
      />

      <p className="text-xs text-muted-foreground">{audience}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès au pipeline"}
      </Button>
    </form>
  );
}

/**
 * ACCÈS AU MODULE DIRECTIVES — qui lit les notes de service, qui en rédige.
 *
 * Le troisième droit, la PUBLICATION, n'apparaît pas ici : il n'est pas réglable. Une note de
 * service engage l'entreprise devant tous ses salariés ; sa signature appartient à la direction
 * générale, en dur dans le code. L'écran le DIT, pour que personne ne cherche la case.
 */
export function DirectiveAccessForm({ roles, users, settings }: {
  roles: Opt[];
  users: UserLite[];
  settings: Pick<AppSettings, "directiveReaderRoles" | "directiveReaderUserIds" | "directiveIssuerRoles" | "directiveIssuerUserIds">;
}) {
  const [readerRoles, setReaderRoles] = React.useState<string[]>(settings.directiveReaderRoles);
  const [readerUsers, setReaderUsers] = React.useState<string[]>(settings.directiveReaderUserIds);
  const [issuerRoles, setIssuerRoles] = React.useState<string[]>(settings.directiveIssuerRoles);
  const [issuerUsers, setIssuerUsers] = React.useState<string[]>(settings.directiveIssuerUserIds);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const flip = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  const audience = describeDirectiveAccess({
    directiveReaderRoles: readerRoles,
    directiveReaderUserIds: readerUsers,
    directiveIssuerRoles: issuerRoles,
    directiveIssuerUserIds: issuerUsers,
  });

  return (
    <form
      action={async () => {
        setSaving(true); setError(null);
        const fd = new FormData();
        readerRoles.forEach((r) => fd.append("readerRoles", r));
        readerUsers.forEach((id) => fd.append("readerUserIds", id));
        issuerRoles.forEach((r) => fd.append("issuerRoles", r));
        issuerUsers.forEach((id) => fd.append("issuerUserIds", id));
        const res = await setDirectiveAccess(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(res.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <RolePeoplePicker
        title="Lire les directives"
        hint="Recevoir et consulter les notes de service qui vous concernent. C'est le cas ordinaire : presque tout le monde doit lire les notes de la direction."
        roles={roles} users={users}
        pickedRoles={readerRoles} pickedUsers={readerUsers}
        onToggleRole={flip(setReaderRoles)} onToggleUser={flip(setReaderUsers)}
      />

      <RolePeoplePicker
        title="Rédiger une directive"
        hint="Écrire une note et la SOUMETTRE. Ce n'est pas la publier : elle attendra l'accord de la direction générale. Rédiger donne aussi la lecture."
        roles={roles} users={users}
        pickedRoles={issuerRoles} pickedUsers={issuerUsers}
        onToggleRole={flip(setIssuerRoles)} onToggleUser={flip(setIssuerUsers)}
      />

      <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
        <strong className="text-foreground">La publication ne se règle pas.</strong> Une note de service
        engage l&apos;entreprise devant tous ses salariés : seuls le <strong>Directeur Général</strong> et le
        <strong> Super Admin</strong> la prononcent, et cela ne s&apos;ouvre pas depuis cet écran.
      </p>
      <p className="text-xs text-muted-foreground">{audience}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès aux directives"}
      </Button>
    </form>
  );
}
