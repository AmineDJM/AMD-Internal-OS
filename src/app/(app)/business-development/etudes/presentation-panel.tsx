"use client";

import { phraseIaNonConfiguree, courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import * as React from "react";

import { Presentation, Sparkles, Loader2, Download, Trash2, RefreshCw, ChevronDown, ChevronRight, Info } from "lucide-react";
import { generatePresentation, regeneratePresentation, deletePresentation } from "@/lib/actions/market-presentation-actions";
import type { PresentationDTO } from "@/lib/queries/market-research";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

type Res = { ok: boolean; error?: string; id?: string };

export function PresentationPanel({
  researchId, presentations, canEdit, aiConfigured, cleIa = null, rowCount,
}: {
  researchId: string; presentations: PresentationDTO[]; canEdit: boolean; aiConfigured: boolean; rowCount: number;
  /** Le nom de la clé manquante, lu côté serveur (§118.128). */
  cleIa?: string | null;
}) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [busy, setBusy] = React.useState<string | null>(null); // message d'activité
  const [creating, setCreating] = React.useState(false);
  const [angle, setAngle] = React.useState("");
  const [title, setTitle] = React.useState("");

  async function generate() {
    if (busy) return;
    setBusy("L'IA analyse l'étude et rédige la présentation…");
    const fd = new FormData();
    fd.set("researchId", researchId);
    if (title.trim()) fd.set("title", title.trim());
    if (angle.trim()) fd.set("instruction", angle.trim());
    try {
      const r: Res = await generatePresentation(undefined, fd);
      if (!r.ok) { retours.erreur(r.error ?? "Génération impossible."); return; }
      setCreating(false); setAngle(""); setTitle("");
      rafraichir();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  const disabled = !aiConfigured || rowCount === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><Presentation className="h-4 w-4 text-primary" /> Présentations stratégiques (IA)</h3>
          <p className="text-sm text-muted-foreground">Générez une présentation PowerPoint (.pptx) analysée par l'IA à partir de l'étude — téléchargeable et modifiable, ré-analysable en ajoutant des commentaires.</p>
        </div>
        {canEdit && !creating && (
          <button type="button" onClick={() => setCreating(true)} disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            <Sparkles className="h-4 w-4" /> Générer une présentation
          </button>
        )}
      </div>

      {disabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{rowCount === 0 ? "Ajoutez au moins une molécule à l'étude avant de générer une présentation." : phraseIaNonConfiguree(cleIa, "la génération de présentation")}</span>
        </div>
      )}

      {creating && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre de la présentation (optionnel)"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-base focus:border-primary focus:outline-none sm:h-9 sm:text-sm" />
          <textarea value={angle} onChange={(e) => setAngle(e.target.value)} rows={2}
            placeholder="Angle / consignes pour l'analyse (optionnel) — ex. « focus sur les opportunités de fabrication locale », « prioriser les molécules à fort volume »…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus:border-primary focus:outline-none sm:text-sm" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={generate} disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Lancer l'analyse
            </button>
            <button type="button" onClick={() => { setCreating(false); setAngle(""); setTitle(""); }} disabled={!!busy}
              className="rounded-lg border border-input px-3 py-2 text-sm hover:bg-secondary disabled:opacity-60">Annuler</button>
          </div>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
          <Loader2 className="h-4 w-4 animate-spin" /> {busy}
        </div>
      )}

      {presentations.length === 0 && !creating && (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Aucune présentation. {canEdit && !disabled && "Cliquez sur « Générer une présentation »."}</p>
      )}

      <div className="space-y-3">
        {presentations.map((p) => (
          <PresentationCard key={p.id} presentation={p} canEdit={canEdit} busy={!!busy} setBusy={setBusy} onDone={rafraichir} />
        ))}
      </div>
    </div>
  );
}

function PresentationCard({
  presentation, canEdit, busy, setBusy, onDone,
}: {
  presentation: PresentationDTO; canEdit: boolean; busy: boolean; setBusy: (m: string | null) => void; onDone: () => void;
}) {
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const latest = presentation.versions[0];

  async function relaunch() {
    if (busy) return;
    setBusy("L'IA relance l'analyse avec vos commentaires…");
    const fd = new FormData();
    fd.set("presentationId", presentation.id);
    if (comment.trim()) fd.set("instruction", comment.trim());
    try {
      const r: Res = await regeneratePresentation(undefined, fd);
      if (!r.ok) { retours.erreur(r.error ?? "Relance impossible."); return; }
      setComment(""); onDone();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    if (!(await confirmer(`Supprimer la présentation « ${presentation.title} » et toutes ses versions ?`))) return;
    setBusy("Suppression…");
    const fd = new FormData(); fd.set("id", presentation.id);
    try {
      const r: Res = await deletePresentation(fd);
      if (!r.ok) { retours.erreur(r.error ?? "Suppression impossible."); return; }
      onDone();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <Presentation className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block font-medium [overflow-wrap:anywhere] sm:truncate">{presentation.title}</span>
            <span className="block text-xs text-muted-foreground">{presentation.versions.length} version(s) · dernière : v{latest?.version ?? "—"}</span>
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {latest && (
            <a href={`/api/market-research/presentation/${latest.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:py-1.5">
              <Download className="h-4 w-4" /> Télécharger .pptx
            </a>
          )}
          {canEdit && (
            <button type="button" onClick={remove} disabled={busy} title="Supprimer la présentation"
              className="rounded-lg border border-input p-2 text-destructive hover:bg-destructive/10 disabled:opacity-60"><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historique des analyses</p>
            {presentation.versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-1.5 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-muted-foreground"> · {new Date(v.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                  {v.instruction && <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={v.instruction}>« {v.instruction} »</span>}
                </div>
                <a href={`/api/market-research/presentation/${v.id}`} className="inline-flex items-center gap-1 rounded px-2 py-2 text-xs text-primary hover:bg-primary/10 sm:py-1"><Download className="h-3.5 w-3.5" /> .pptx</a>
              </div>
            ))}
          </div>

          {canEdit && (
            <div className="space-y-2 rounded-md border border-border bg-background p-2.5">
              <p className="text-xs font-medium text-muted-foreground">Ré-analyser en ajoutant des commentaires (crée une nouvelle version) :</p>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                placeholder="Ex. « insiste davantage sur les risques d'importation », « ajoute une reco go/no-go par produit »…"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus:border-primary focus:outline-none sm:text-sm" />
              <button type="button" onClick={relaunch} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Relancer l'analyse
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
