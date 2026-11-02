"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, FileText, FileSpreadsheet, Presentation, Loader2, Check } from "lucide-react";
import { createOfficeNode } from "@/lib/actions/drive-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { OfficeKind } from "@/lib/office-templates";
import { executerCreationOffice } from "@/lib/office/creation-ui";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { LetterheadChoice } from "@/components/office/letterhead-choice";
import type { LetterheadOption } from "@/lib/queries/letterheads";

const TYPES: { kind: OfficeKind; label: string; hint: string; icon: React.ElementType }[] = [
  { kind: "word", label: "Word", hint: "Document texte (.docx)", icon: FileText },
  { kind: "cell", label: "Excel", hint: "Classeur (.xlsx)", icon: FileSpreadsheet },
  { kind: "slide", label: "PowerPoint", hint: "Présentation (.pptx)", icon: Presentation },
];

/** Crée un document Office (vierge ou sur papier en-tête) dans le Drive ; ouvre l'éditeur si OnlyOffice est actif. */
export function NewOfficeButton({
  parentId, officeEnabled, spaceId, letterheads = [], companyId = null,
}: {
  parentId: string | null;
  officeEnabled: boolean;
  spaceId?: string | null;
  letterheads?: LetterheadOption[];
  companyId?: string | null;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<OfficeKind>("word");
  const [letterheadId, setLetterheadId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <>
      <Button variant="outline" type="button" onClick={() => { setErr(null); setOpen(true); }}>
        <FilePlus2 className="h-4 w-4" /> Nouveau document
      </Button>
      <Sheet open={open} onClose={() => !saving && setOpen(false)} title="Nouveau document Office" width="md">
        {/* `onSubmit` et non `action={…}` : une action de formulaire tourne dans une transition React,
            qui RETIENT `setSaving(true)` jusqu'à la fin de l'appel (aucun retour visuel, double clic
            possible) et, si l'appel rejette, ne laisse ni message ni bouton utilisable. */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            const fd = new FormData(e.currentTarget);
            setSaving(true); setErr(null);
            fd.set("kind", kind);
            if (letterheadId) fd.set("letterheadId", letterheadId);
            try {
              const r = await executerCreationOffice(() => createOfficeNode(fd));
              if (!r.ok) { setErr(r.error); return; }
              setOpen(false);
              if (officeEnabled) router.push(`/drive/${r.id}`);
              else rafraichir();
            } finally {
              setSaving(false);
            }
          }}
          className="space-y-4"
        >
          {parentId && <input type="hidden" name="parentId" value={parentId} />}
          {spaceId && <input type="hidden" name="spaceId" value={spaceId} />}

          <div className="space-y-1.5">
            <Label>Type de document</Label>
            <div className="grid grid-cols-3 gap-2">
              {TYPES.map((t) => {
                const active = kind === t.kind;
                return (
                  <button
                    key={t.kind} type="button" onClick={() => setKind(t.kind)}
                    className={`flex min-w-0 flex-col items-center gap-1.5 rounded-lg border p-2 text-center transition sm:p-3 ${active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary"}`}
                  >
                    <t.icon className={`h-6 w-6 ${active ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">{t.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="name">Nom du document</Label>
            <Input id="name" name="name" placeholder="Sans titre" defaultValue="Sans titre" required />
          </div>

          <LetterheadChoice
            kind={kind} letterheads={letterheads} companyId={companyId}
            value={letterheadId} onChange={setLetterheadId} disabled={saving}
          />

          {!officeEnabled && (
            <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
              L'éditeur Office en ligne n'est pas encore configuré : le fichier sera créé dans votre Drive,
              vous pourrez le télécharger. L'édition en ligne s'activera une fois OnlyOffice configuré.
            </p>
          )}
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Annuler</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {officeEnabled ? "Créer et éditer" : "Créer"}
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
