"use client";

import * as React from "react";

import { Plus, Loader2, Upload, CheckCircle2, XCircle, MinusCircle, FileText, Trash2, GraduationCap, Save } from "lucide-react";
import type { RegCaseOutcome } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { createCaseStudy, updateCaseStudy, deleteCaseStudy, importCaseFileAction } from "@/lib/regulatory/intelligence/training/actions";
import { OUTCOME_LABELS, OUTCOME_TONES, OUTCOME_ORDER } from "@/lib/regulatory/intelligence/training/labels";
import type { FileIngestStatus } from "@/lib/regulatory/intelligence/corpus/import-formats";

/**
 * ÉTUDES DE CAS — le geste d'entraînement, aussi simple que le corpus :
 * créer le cas (produit + issue réelle + leçon), puis DÉPOSER les pièces — l'envoi démarre
 * tout seul. Chaque pièce ingérée devient un précédent injecté dans les analyses.
 */

interface CaseDocRow { id: string; filename: string; ctdSection: string | null; sections: string[]; createdAt: string }
interface CaseRow { id: string; title: string; productName: string | null; outcome: RegCaseOutcome; lesson: string | null; createdAt: string; documents: CaseDocRow[] }

type UpRow = { id: string; file: File;
  /** Nom affiché quand la ligne représente une pièce EXTRAITE d'une archive. */
  label?: string; state: "pending" | "running" | FileIngestStatus; message?: string; sections?: number };

export function TrainingPanel({ cases }: { cases: CaseRow[] }) {
  const { busy: creating, err: error, run } = useAction();

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating) return;
    const form = e.currentTarget;
    await run(() => createCaseStudy(new FormData(form)), () => form.reset?.());
  }

  return (
    <div className="space-y-4">
      {/* Créer une étude de cas — trois champs qui comptent : le produit, l'ISSUE, la LEÇON. */}
      <section className="surface space-y-3 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4 text-primary" /> Nouvelle étude de cas</h2>
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <Label>Titre *</Label>
            <Input name="title" required placeholder="Ex. Amoxicilline 500 mg gélules — enregistrement 2023" />
          </label>
          <label className="space-y-1">
            <Label>Produit</Label>
            <Input name="productName" placeholder="Nom du produit (optionnel)" />
          </label>
          <label className="space-y-1">
            <Label>Issue réelle à l&apos;ANPP</Label>
            <Select name="outcome" defaultValue="UNKNOWN">
              {OUTCOME_ORDER.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
            </Select>
          </label>
          <label className="space-y-1 sm:col-span-2">
            <Label>Leçon retenue (la phrase qui vaut de l&apos;or pour le prochain dossier)</Label>
            <Textarea name="lesson" rows={2} placeholder="Ex. L'ANPP exige les données de stabilité zone IVb en plus de la zone II pour ce type de forme sèche…" />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Créer l&apos;étude de cas
            </Button>
          </div>
        </form>
        <Retour ton="erreur">{error}</Retour>
      </section>

      {cases.length === 0 ? (
        <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
          Aucune étude de cas pour le moment. Créez-en une par produit passé, puis déposez son dossier
          (les pièces clés suffisent : modules 1 et 3, réponses aux réserves…).
        </p>
      ) : (
        cases.map((c) => <CaseCard key={c.id} c={c} />)
      )}
    </div>
  );
}

function CaseCard({ c }: { c: CaseRow }) {
  const { rafraichir } = useRafraichir();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [rows, setRows] = React.useState<UpRow[]>([]);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [outcome, setOutcome] = React.useState<RegCaseOutcome>(c.outcome);
  const [lesson, setLesson] = React.useState(c.lesson ?? "");
  const [msg, setMsg] = React.useState<string | null>(null);

  // DÉPOSER SUFFIT : la file démarre dès la sélection (2 envois en vol — l'extraction est du calcul).
  const runQueue = async (queue: UpRow[]) => {
    if (running || queue.length === 0) return;
    setRunning(true);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, state: "running" } : r)));
        try {
          const fd = new FormData();
          fd.set("caseId", c.id);
          fd.set("file", row.file);
          const res = await importCaseFileAction(fd);
          if (res.children && res.children.length > 0) {
            // Archive dépliée : la ligne du ZIP devient une ligne PAR PIÈCE — chaque verdict se lit.
            const children = res.children.map((c, i) => ({
              id: `${row.id}-c${i}`, file: row.file, label: c.filename,
              state: c.status, message: c.error, sections: c.sections,
            }));
            setRows((prev) => prev.flatMap((r) => (r.id === row.id ? children : [r])));
          } else {
            setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, state: res.status, message: res.error, sections: res.sections } : r)));
          }
        } catch {
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, state: "FAILED" as const, message: "Envoi interrompu — réessayez." } : r)));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
    setRunning(false);
    rafraichir();
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.size > 0);
    if (list.length === 0) return;
    const next = list.map((f) => ({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, file: f, state: "pending" as const }));
    setRows((prev) => [...prev, ...next]);
    if (!running) void runQueue(next);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true); setMsg(null);
    const fd = new FormData();
    fd.set("caseId", c.id);
    fd.set("outcome", outcome);
    fd.set("lesson", lesson);
    try {
      const r = await updateCaseStudy(fd);
      setMsg(r.ok ? "Issue et leçon enregistrées." : r.error ?? "L'issue et la leçon n'ont pas été enregistrées.");
      if (r.ok) rafraichir();
    } catch {
      setMsg(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const fd = new FormData();
    fd.set("caseId", c.id);
    try {
      const r = await deleteCaseStudy(fd);
      if (r.ok) rafraichir(); else setMsg(r.error ?? "L'étude de cas n'a pas été supprimée.");
    } catch {
      setMsg(actionFailureMessage("THROWN"));
    }
  };

  return (
    <section className="surface space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCap className="h-4 w-4 shrink-0 text-primary" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={c.title}>{c.title}</h3>
        <span className={`rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold ${OUTCOME_TONES[outcome]}`}>{OUTCOME_LABELS[outcome]}</span>
        <span className="text-xs text-muted-foreground">{c.documents.length} pièce·s</span>
        <button type="button" onClick={remove} className="inline-flex items-center gap-1 py-1.5 text-xs text-destructive hover:underline sm:py-0"><Trash2 className="h-3 w-3" /> Supprimer</button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem,1fr,auto]">
        <label className="space-y-1">
          <Label>Issue réelle</Label>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as RegCaseOutcome)}>
            {OUTCOME_ORDER.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
          </Select>
        </label>
        <label className="space-y-1">
          <Label>Leçon retenue</Label>
          <Textarea value={lesson} onChange={(e) => setLesson(e.target.value)} rows={2} placeholder="Ce que ce dossier a appris au service…" />
        </label>
        <div className="flex items-end">
          <Button type="button" size="sm" variant="outline" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer
          </Button>
        </div>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

      <div>
        <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer les pièces du dossier
        </Button>
        <input ref={inputRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.html,.htm,.csv,.xlsx,.xls,.zip"
          onChange={(e) => { addFiles(e.target.files ?? []); e.target.value = ""; }} />
        <p className="mt-1 text-[0.6875rem] text-muted-foreground">
          L&apos;envoi démarre tout seul. Un ZIP est déplié côté serveur (une pièce = un verdict) ; les scans sont océrisés. Chaque pièce est repérée par section CTD et devient un précédent injecté dans TOUTES les analyses.
        </p>
      </div>

      {rows.length > 0 && (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-xl border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm">
              <UpIcon state={r.state} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.label ?? r.file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {r.state === "INGESTED" && `${r.sections ?? 0} section(s) CTD repérée(s) — précédent actif`}
                  {r.state === "UNCHANGED" && "déjà connue de cette étude de cas — rien créé"}
                  {r.message && ` ${r.message}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {c.documents.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border/60">
          {c.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={d.filename}>{d.filename}</span>
              {d.ctdSection && <span className="rounded bg-secondary px-1.5 py-0.5 font-medium">CTD {d.ctdSection}</span>}
              {d.sections.length > 0 && <span className="text-muted-foreground">{d.sections.length} section·s détectée·s</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UpIcon({ state }: { state: UpRow["state"] }) {
  if (state === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (state === "INGESTED") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  if (state === "UNCHANGED") return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
  if (state === "FAILED") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  return <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}
