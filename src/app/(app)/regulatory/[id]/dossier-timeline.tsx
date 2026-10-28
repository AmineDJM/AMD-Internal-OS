"use client";

import * as React from "react";

import {
  Plus, Loader2, AlertCircle, Pencil, Trash2, Check, X, FileStack, CalendarDays, Paperclip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { formatDate, cn } from "@/lib/utils";
import {
  ADDABLE_KINDS, KIND_LABELS, KIND_TONES, defaultLabel, nextReservesLabel, summarize, type DossierStepKind,
} from "@/lib/regulatory/dossier-timeline";
import {
  addDossierStep, updateDossierStep, deleteDossierStep, startDossierTimeline,
} from "@/lib/actions/regulatory-timeline-actions";
import type { ActionResult } from "@/lib/actions/types";
import { useAction } from "@/components/shared/use-action";
import { useConfirmer } from "@/components/ui/dialogue";

export interface TimelineStepView {
  id: string;
  kind: DossierStepKind;
  label: string;
  version: number | null;
  order: number;
  occurredAt: string | null;
  note: string | null;
  author: string | null;
  createdAt: string;
  docs: DocItem[];
}

/** Les catégories proposées pour une pièce de frise : ce qu'on y dépose réellement. */
const STEP_DOC_CATEGORIES = ["CTD_FULL", "MODULE_1", "MODULE_2", "MODULE_3", "MODULE_4", "MODULE_5", "QUERY_RECEIVED", "QUERY_RESPONSE", "SUPPORTING_DOC", "OTHER"];


/**
 * LA FRISE DU DOSSIER — l'histoire du CTD, de haut en bas.
 *
 * Une pile de PDF montrait DES pièces ; elle ne montrait pas le CHEMIN. Ici, chaque étape est
 * un moment daté du dossier — dépôt initial, réserves de l'agence, réponse, version redéposée —
 * et le « + » sous une étape dit exactement OÙ s'insère la suivante. Les pièces vivent SOUS
 * leur étape : on ne cherche plus à quel cycle appartient un document.
 */
export function DossierTimeline({
  productId, steps, canUpdate, canUpload, canDelete, path,
}: {
  productId: string;
  steps: TimelineStepView[];
  canUpdate: boolean;
  canUpload: boolean;
  canDelete: boolean;
  path: string;
}) {
  const { busy, err, run } = useAction();
  const [addAfter, setAddAfter] = React.useState<string | null | false>(false);

  if (steps.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <FileStack className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">La frise du dossier n&apos;est pas encore ouverte</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Elle s&apos;ouvre sur les premières réserves — <strong>Réserves ANPP 1</strong> — puis
            suit les cycles avec le « + » : réponses, CTD version 2, 3…, décision.
          </p>
          {canUpdate && (
            <Button
              size="sm" className="mt-3 max-w-full" disabled={busy}
              onClick={() => run(() => { const fd = new FormData(); fd.set("productId", productId); return startDossierTimeline(fd); })}
            >
              {/* Le libellé complet dépasse d'un téléphone (mesuré : 267 px dans 343) ; le nom du
                  premier cycle est déjà dit en gras juste au-dessus, on ne le répète qu'à partir de `sm`. */}
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Démarrer la frise<span className="hidden sm:inline"> (Réserves ANPP 1)</span>
            </Button>
          )}
        </div>
        {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{summarize(steps)}</p>

      <ol className="relative space-y-0">
        {steps.map((s, i) => (
          <li key={s.id} className="relative pl-8">
            {/* LE RAIL : il relie les étapes, et s'arrête à la dernière — une ligne qui
                continuerait dans le vide laisserait croire qu'il manque quelque chose. */}
            {i < steps.length - 1 && (
              <span aria-hidden className="absolute left-[0.6875rem] top-6 bottom-0 w-px bg-border" />
            )}
            <span
              aria-hidden
              className={cn(
                "absolute left-1.5 top-4 h-3.5 w-3.5 rounded-full border-2 border-background ring-1",
                s.kind === "ANPP_RESERVES" ? "bg-warning ring-warning/40"
                  : s.kind === "DECISION" ? "bg-success ring-success/40"
                    : s.kind === "CTD_INITIAL" ? "bg-primary ring-primary/40"
                      : "bg-muted-foreground ring-border",
              )}
            />
            <StepCard
              step={s}
              productId={productId}
              canUpdate={canUpdate}
              canUpload={canUpload}
              canDelete={canDelete}
              path={path}
              onAddAfter={() => setAddAfter(s.id)}
            />
          </li>
        ))}
      </ol>

      {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}

      {canUpdate && (
        <div className="pl-8 pt-1">
          <Button variant="outline" size="sm" onClick={() => setAddAfter(null)}>
            <Plus className="h-4 w-4" /> Ajouter une étape à la fin
          </Button>
        </div>
      )}

      <AddStepSheet
        productId={productId}
        afterId={addAfter === false ? null : addAfter}
        open={addAfter !== false}
        onClose={() => setAddAfter(false)}
        reservesLabel={nextReservesLabel(steps)}
      />
    </div>
  );
}

/** Une étape : son en-tête, ses pièces, et le « + » qui ouvre la suivante juste dessous. */
function StepCard({
  step, productId, canUpdate, canUpload, canDelete, path, onAddAfter,
}: {
  step: TimelineStepView;
  productId: string;
  canUpdate: boolean;
  canUpload: boolean;
  canDelete: boolean;
  path: string;
  onAddAfter: () => void;
}) {
  const { busy, err, run } = useAction();
  const confirmer = useConfirmer();
  const [editing, setEditing] = React.useState(false);
  const [label, setLabel] = React.useState(step.label);
  const [when, setWhen] = React.useState(step.occurredAt?.slice(0, 10) ?? "");
  const [note, setNote] = React.useState(step.note ?? "");

  const save = () => run(() => {
    const fd = new FormData();
    fd.set("id", step.id); fd.set("label", label);
    if (when) fd.set("occurredAt", when);
    if (note.trim()) fd.set("note", note);
    return updateDossierStep(fd);
  }, () => setEditing(false));

  return (
    <div className="mb-2 rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-sm" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 text-xs" />
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optionnelle)" className="h-8 text-xs" />
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" disabled={busy || !label.trim()} onClick={save}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Enregistrer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setLabel(step.label); }}>
                  <X className="h-3.5 w-3.5" /> Annuler
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={KIND_TONES[step.kind]} dot={false}>
                  {KIND_LABELS[step.kind]}{step.kind === "CTD_VERSION" && step.version ? ` v${step.version}` : ""}
                </Badge>
                <span className="truncate text-sm font-medium">{step.label}</span>
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-muted-foreground">
                {step.occurredAt && (
                  <span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {formatDate(step.occurredAt)}</span>
                )}
                {step.docs.length > 0 && (
                  <span className="inline-flex items-center gap-1"><Paperclip className="h-3 w-3" /> {step.docs.length} pièce{step.docs.length > 1 ? "s" : ""}</span>
                )}
                <span>· ajoutée par {step.author ?? "—"} le {formatDate(step.createdAt)}</span>
              </p>
              {step.note && <p className="mt-1 text-xs text-muted-foreground">{step.note}</p>}
            </>
          )}
        </div>

        {canUpdate && !editing && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button" onClick={() => setEditing(true)} title="Renommer l'étape"
              className="rounded-md p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {step.kind !== "CTD_INITIAL" && (
              <button
                type="button" disabled={busy} title="Supprimer l'étape"
                onClick={async () => {
                  if (!(await confirmer(`Supprimer l'étape « ${step.label} » ?`))) return;
                  run(() => { const fd = new FormData(); fd.set("id", step.id); return deleteDossierStep(fd); });
                }}
                className="rounded-md p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:p-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* LES PIÈCES DE L'ÉTAPE — plusieurs par étape, c'est la règle : une lettre de réserves
          arrive rarement seule (annexes, tableau de points, accusé). */}
      <div className="space-y-2 border-t border-border px-3 py-2.5">
        {step.docs.length > 0 ? (
          <DocumentList documents={step.docs} canDelete={canDelete || canUpload} canRename={canUpload} path={path} />
        ) : (
          <p className="text-xs text-muted-foreground">Aucune pièce à cette étape.</p>
        )}
        {canUpload && (
          <DocumentUpload
            entityType="REGULATORY_PRODUCT"
            entityId={productId}
            stepKey={step.id}
            categories={STEP_DOC_CATEGORIES}
            compact
          />
        )}
        {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {err}</div>}
      </div>

      {/* LE « + » SOUS L'ÉTAPE : il dit OÙ la suivante s'insère. Un bouton unique en bas de
          page ne le dirait pas, et on ne saurait plus à quel cycle rattacher une réponse. */}
      {canUpdate && (
        <div className="border-t border-dashed border-border px-3 py-1.5">
          <button
            type="button" onClick={onAddAfter}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-2 text-xs font-medium text-primary hover:bg-primary/5 sm:py-1"
          >
            <Plus className="h-3.5 w-3.5" /> Ajouter une étape ici
          </button>
        </div>
      )}
    </div>
  );
}

/** Le formulaire d'ajout : type au menu, nom, numéro de version quand il en faut un, date. */
function AddStepSheet({
  productId, afterId, open, onClose, reservesLabel,
}: {
  productId: string; afterId: string | null; open: boolean; onClose: () => void;
  /** Libellé proposé pour un nouveau cycle de réserves — « Réserves ANPP n+1 ». */
  reservesLabel: string;
}) {
  const { busy: saving, err, setErr, run } = useAction();
  const [kind, setKind] = React.useState<DossierStepKind>("ANPP_RESERVES");
  const [version, setVersion] = React.useState("");
  const [label, setLabel] = React.useState(reservesLabel);
  const [touched, setTouched] = React.useState(false);


  // Le libellé suit le type TANT QUE la personne ne l'a pas écrit elle-même : pré-remplir aide,
  // écraser une saisie serait insupportable. Un cycle de réserves arrive NUMÉROTÉ.
  React.useEffect(() => {
    if (!touched) setLabel(kind === "ANPP_RESERVES" ? reservesLabel : defaultLabel(kind, version ? Number(version) : null));
  }, [kind, version, touched, reservesLabel]);

  const reset = () => { setKind("ANPP_RESERVES"); setVersion(""); setLabel(reservesLabel); setTouched(false); setErr(null); };

  const submit = async (fd: FormData) => {
    fd.set("productId", productId);
    if (afterId) fd.set("afterId", afterId);
    await run(() => addDossierStep(undefined, fd), () => { reset(); onClose(); });
  };

  return (
    <Sheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Ajouter une étape à la frise"
      description={afterId ? "Elle s'insérera juste après l'étape choisie ; les suivantes se décalent." : "Elle sera ajoutée à la fin de la frise."}
      width="md"
    >
      <form action={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Type d&apos;étape <span className="text-destructive">*</span></Label>
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value as DossierStepKind)}>
            {ADDABLE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </Select>
        </div>

        {kind === "CTD_VERSION" && (
          <div className="space-y-1.5">
            <Label>Numéro de version <span className="text-destructive">*</span></Label>
            <Input
              name="version" type="number" min={1} step={1} value={version}
              onChange={(e) => setVersion(e.target.value)} placeholder="2, 3, …"
            />
            <p className="text-xs text-muted-foreground">Le numéro de la version redéposée à l&apos;agence.</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Nom de l&apos;étape <span className="text-destructive">*</span></Label>
          <Input
            name="label" value={label}
            onChange={(e) => { setTouched(true); setLabel(e.target.value); }}
            placeholder="Ex. Réserves du 12/03 — module 3"
          />
          <p className="text-xs text-muted-foreground">C&apos;est ce nom qu&apos;on relira dans un an.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Date de l&apos;événement</Label>
            <Input name="occurredAt" type="date" />
            <p className="text-xs text-muted-foreground">Réception, dépôt… souvent avant la saisie.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Note</Label>
            <Textarea name="note" rows={2} placeholder="Précision utile à la relecture." />
          </div>
        </div>

        {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>Annuler</Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Ajouter l&apos;étape
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
