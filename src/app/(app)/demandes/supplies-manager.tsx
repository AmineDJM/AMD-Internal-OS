"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useAction } from "@/components/shared/use-action";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Package, Loader2, AlertCircle, Check, Plus, Pencil, X, WandSparkles } from "lucide-react";
import {
  createSupplyArticle, updateSupplyArticle, toggleSupplyArticle,
  previewCatalogNormalization, applyCatalogNormalization, type CatalogRewrite,
} from "@/lib/actions/office-supply-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { TextField, TextAreaField, SelectField, optionsFromMap } from "@/components/shared/form-fields";
import { SUPPLY_CATEGORY, SUPPLY_UNIT } from "@/lib/labels";
import { formatCurrency } from "@/lib/utils";

export interface SupplyArticleRow {
  id: string;
  name: string;
  category: string | null;
  unit: string | null;
  reference: string | null;
  estimatedPrice: number | null;
  supplierHint: string | null;
  active: boolean;
  notes: string | null;
}

/**
 * UNIFORMISER L'EXISTANT — on MONTRE d'abord, on applique ensuite.
 *
 * Réécrire des libellés que des gens reconnaissent est un geste visible : ils doivent le voir
 * venir, ligne par ligne, et pouvoir le refuser. Un bouton qui réécrirait tout le catalogue sans
 * rien montrer serait un bouton qu'on n'ose pas cliquer — donc un bouton mort.
 */
function NormalizePanel() {
  const { rafraichir } = useRafraichir();
  const [rewrites, setRewrites] = React.useState<CatalogRewrite[] | null>(null);
  const [busy, setBusy] = React.useState<"scan" | "apply" | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function scan() {
    setBusy("scan"); setError(null); setDone(null);
    try {
      const r = await previewCatalogNormalization();
      if (!r.ok) { setError(r.error ?? "Lecture impossible."); return; }
      setRewrites(r.rewrites);
      if (r.rewrites.length === 0) setDone(`Le catalogue est déjà uniforme (${r.total} articles).`);
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    setBusy("apply"); setError(null);
    try {
      const r = await applyCatalogNormalization();
      if (!r.ok) { setError(r.error ?? "Application impossible."); return; }
      setRewrites(null);
      setDone(r.message ?? "Catalogue uniformisé.");
      rafraichir();
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-secondary/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Uniformiser l&apos;écriture</p>
          <p className="text-xs text-muted-foreground">
            Casse, espaces, ponctuation, catégories et unités — une seule façon d&apos;écrire.
            Le vocabulaire n&apos;est jamais changé : « Ramette » ne devient pas « Rame ».
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={scan}>
          {busy === "scan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
          Vérifier
        </Button>
      </div>

      {rewrites && rewrites.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{rewrites.length} article(s) à réécrire :</p>
          <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border bg-card p-2 text-xs">
            {rewrites.map((r) => (
              <li key={r.id}>
                {r.changes.map((c, i) => <p key={i} className="text-muted-foreground">{c}</p>)}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={busy !== null} onClick={apply}>
              {busy === "apply" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Appliquer
            </Button>
          </div>
        </div>
      )}

      {done && <p className="flex items-center gap-2 text-xs text-success"><Check className="h-3.5 w-3.5" /> {done}</p>}
      {error && <p className="flex items-center gap-2 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {error}</p>}
    </div>
  );
}

export function SuppliesManager({ articles }: { articles: SupplyArticleRow[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Package className="h-4 w-4" />
        Catalogue fournitures
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Catalogue d'articles de fourniture"
        description="Référentiel des articles de bureau pour passer commande plus vite. Sélectionnables dans les demandes d'achat."
        width="lg"
      >
        {/* Une nouvelle ouverture repart d'un formulaire vierge, comme avant. */}
        <CatalogueArticles key={open ? "ouvert" : "ferme"} articles={articles} />
      </Sheet>
    </>
  );
}

/**
 * LE CATALOGUE D'ARTICLES — le formulaire, l'uniformisation et la liste. Rendu dans le panneau du
 * Bureau du secrétariat (`SuppliesManager`) ET, en pleine page, par les Moyens généraux (décision du
 * 04/10 : « ne laisse que le catalogue d'articles »). Un seul composant : deux copies finiraient par
 * ne plus proposer les mêmes champs (§118.5). Sans le droit de modifier, la liste se LIT seulement —
 * un bouton offert puis refusé n'est pas un geste (§118.83).
 */
export function CatalogueArticles({ articles, peutModifier = true }: { articles: SupplyArticleRow[]; peutModifier?: boolean }) {
  const { rafraichir } = useRafraichir();
  // La pastille Actif / Inactif n'a pas de place pour parler : un refus part en avis flottant.
  const bascule = useAction({ signalerErreurs: true });
  const [editing, setEditing] = React.useState<SupplyArticleRow | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  const reset = () => { setEditing(null); setError(null); formRef.current?.reset(); };

  return (
    <div className="space-y-6">
      {peutModifier && (<>
      <form
        ref={formRef}
        key={editing?.id ?? "new"}
        action={async (fd) => {
          setSubmitting(true); setError(null); setSaved(false);
          try {
            const r = editing ? await updateSupplyArticle(fd) : await createSupplyArticle(fd);
            if (r.ok) { setSaved(true); reset(); rafraichir(); setTimeout(() => setSaved(false), 2000); }
            else setError(r.error ?? "L'article n'a pas été enregistré.");
          } catch {
            setError(actionFailureMessage("THROWN"));
          } finally {
            setSubmitting(false);
          }
        }}
        className="space-y-4 rounded-xl border bg-card p-4"
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{editing ? `Modifier « ${editing.name} »` : "Nouvel article"}</p>
          {editing && (
            <button type="button" onClick={reset} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" /> Annuler
            </button>
          )}
        </div>
        {editing && <input type="hidden" name="id" value={editing.id} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField label="Nom de l'article" name="name" placeholder="Ex. Rame de papier A4 80g" defaultValue={editing?.name} className="sm:col-span-2" />
          <SelectField label="Catégorie" name="category" options={optionsFromMap(SUPPLY_CATEGORY)} placeholder="—" defaultValue={editing?.category ?? ""} />
          <SelectField label="Unité" name="unit" options={optionsFromMap(SUPPLY_UNIT)} placeholder="—" defaultValue={editing?.unit ?? ""} />
          <TextField label="Référence / code" name="reference" placeholder="Ex. PAP-A4-80" defaultValue={editing?.reference ?? undefined} />
          <TextField label="Prix indicatif (DZD)" name="estimatedPrice" type="number" step="any" defaultValue={editing?.estimatedPrice ?? undefined} />
          <TextField label="Fournisseur habituel" name="supplierHint" placeholder="Ex. Papeterie Centrale" defaultValue={editing?.supplierHint ?? undefined} className="sm:col-span-2" />
          <TextAreaField label="Notes" name="notes" placeholder="Précisions éventuelles…" defaultValue={editing?.notes ?? undefined} className="sm:col-span-2" />
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {saved && <span className="inline-flex items-center gap-1 text-sm text-success"><Check className="h-4 w-4" /> Enregistré</span>}
          <Button type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editing ? "Enregistrer" : "Ajouter"}
          </Button>
        </div>
      </form>

      <NormalizePanel />
      </>)}

      <div className="space-y-2">
        <p className="text-sm font-medium">
          Articles <span className="text-muted-foreground">({articles.length})</span>
        </p>
        {articles.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            Aucun article. Ajoutez vos fournitures les plus courantes.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {articles.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {a.name}
                    {!a.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(inactif)</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[a.category ? SUPPLY_CATEGORY[a.category] ?? a.category : null, a.unit ? SUPPLY_UNIT[a.unit] ?? a.unit : null, a.reference, a.estimatedPrice != null ? formatCurrency(a.estimatedPrice) : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                </div>
                {peutModifier && <div className="flex shrink-0 items-center gap-1.5">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(a); setError(null); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <form action={async (fd) => { await bascule.run(() => toggleSupplyArticle(fd)); }}>
                    <input type="hidden" name="id" value={a.id} />
                    <Button type="submit" variant="ghost" size="sm" disabled={bascule.busy}>
                      {a.active ? <Badge tone="success" dot={false}>Actif</Badge> : <Badge tone="neutral" dot={false}>Inactif</Badge>}
                    </Button>
                  </form>
                </div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
