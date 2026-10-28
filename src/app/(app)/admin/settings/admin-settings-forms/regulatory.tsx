"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES — Regulatory : inscriptions, veille par société, superviseurs,
 * colonnes masquées, segments thérapeutiques.
 */
import * as React from "react";
import { Loader2, Check, Plus, X, RotateCcw } from "lucide-react";
import { setRegEnrollmentEnabled, setRegulatorySupervisorRoles, setRegulatoryTherapeuticSegments, setRegulatoryHiddenColumns } from "@/lib/actions/settings-actions";
import { setRegIntelligenceEnabled } from "@/lib/regulatory/intelligence/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { THERAPEUTIC_SEGMENTS } from "@/lib/labels";
import { COLONNES_REGULATORY, COLONNES_INAMOVIBLES } from "@/lib/vues/colonnes-regulatory";
import type { Opt } from "./types";

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
