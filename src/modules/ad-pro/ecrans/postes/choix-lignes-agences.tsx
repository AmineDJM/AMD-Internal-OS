"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { cn, formatCurrency } from "@/lib/utils";
import { nomAgence, phraseDuChoix, totalDesLignes, valeurDeLigne } from "../../domaine/choix-agences";
import type { ItemRow } from "../items-panel";

type Devis = ItemRow["devisLignes"][number];
type Ligne = Devis["lignes"][number];

/** Le total d'un devis ENTIER tel que le comparatif le montre — TTC quand la TVA est imprimée, HT sinon (jamais devinée). */
function totalDuDevis(d: Devis): { montant: number; ttc: boolean } {
  // `announcedTotal` est le total HT IMPRIMÉ (recette du 21/11/2026 : il s'affichait « 1 180 000 DZD TTC » pour un devis de
  // 1 404 200 TTC). C'est la BASE : la TVA et la taxe s'y ajoutent, comme pour le total lu des lignes.
  const ht = d.entete.announcedTotal ?? d.totalDevisHt;
  const taux = (d.entete.tvaRate ?? 0) + (d.entete.extraTaxRate ?? 0);
  return { montant: Math.round(ht * (1 + taux / 100) * 100) / 100, ttc: d.entete.tvaRate != null };
}

/** Une ligne se coche si elle est complète et n'est commandée pour aucun autre poste. */
const cochable = (l: Ligne): boolean => !l.valideeAilleurs && !l.refusValidation;

/** « Toutes les lignes de ce devis » — cochée, décochée, ou entre les deux (quelques lignes). */
function CaseDuDevis({ id, coche, partiel, desactive, onChange, children }: {
  id: string; coche: boolean; partiel: boolean; desactive: boolean; onChange: (oui: boolean) => void; children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = partiel; }, [partiel]);
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium">
      <input ref={ref} id={id} type="checkbox" checked={coche} disabled={desactive} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0" />
      {children}
    </label>
  );
}

/**
 * LE CHOIX DES LIGNES, DEVIS PAR DEVIS (Direction, 23/11/2026) — la Direction Marketing coche ce qu'elle commande dans
 * chaque devis transmis ; les totaux se lisent en direct (par agence et au total, l'arithmétique du BC), et la phrase dit
 * ce qui va se passer : un poste accordé, ou un poste scindé en autant de postes que d'agences retenues.
 */
export function ChoixLignesAgences({ itemId, devis, budgetCategoryId, budgetOptions, enCours, onRetenir, onAnnuler }: {
  itemId: string;
  devis: Devis[];
  budgetCategoryId: string | null;
  budgetOptions: { id: string; label: string }[];
  enCours: boolean;
  onRetenir: (f: FormData) => void;
  onAnnuler: () => void;
}) {
  const [coches, setCoches] = React.useState<Record<string, string[]>>({});
  const basculer = (pieceId: string, ligneId: string, oui: boolean) => setCoches((c) => {
    const s = new Set(c[pieceId] ?? []);
    if (oui) s.add(ligneId); else s.delete(ligneId);
    return { ...c, [pieceId]: [...s] };
  });
  const toutes = (d: Devis, oui: boolean) => setCoches((c) => ({ ...c, [d.pieceId]: oui ? d.lignes.filter(cochable).map((l) => l.id) : [] }));

  const parDevis = devis.map((d) => {
    const choisies = new Set(coches[d.pieceId] ?? []);
    return { d, choisies, total: totalDesLignes(d, choisies) };
  });
  const retenus = parDevis.filter((x) => x.choisies.size > 0);
  const total = Math.round(retenus.reduce((s, x) => s + x.total.montant, 0) * 100) / 100;
  const ttc = retenus.filter((x) => x.total.ttc).length;
  const mention = retenus.length === 0 ? "" : ttc === retenus.length ? "TTC" : ttc === 0 ? "HT, sans TVA" : "TTC (HT pour les devis sans TVA)";
  const titre = `agc-titre-${itemId}`;

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-card p-3" aria-labelledby={titre}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        f.set("id", itemId);
        onRetenir(f);
      }}
    >
      <div className="space-y-0.5">
        <p id={titre} className="text-sm font-semibold">Choisir les lignes à commander</p>
        <p className="text-xs text-muted-foreground">Cochez, dans chaque devis, les lignes retenues : un bon de commande par agence, rien que les lignes cochées.</p>
      </div>

      {parDevis.map(({ d, choisies, total: t }) => {
        const entier = totalDuDevis(d);
        const possibles = d.lignes.filter(cochable);
        const toutCoche = possibles.length > 0 && possibles.every((l) => choisies.has(l.id));
        const agence = nomAgence(d);
        return (
          <fieldset key={d.pieceId} className={cn("min-w-0 space-y-2 rounded-lg border p-2.5", choisies.size > 0 ? "border-primary bg-primary/5" : "border-border")}>
            <legend className="sr-only">Devis de {agence}</legend>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{agence}</p>
                <p className="text-xs text-muted-foreground">
                  {d.reference ?? d.titre} · {d.lignes.length} ligne{d.lignes.length > 1 ? "s" : ""} · devis entier <span className="tabular-nums">{formatCurrency(entier.montant)}</span> {entier.ttc ? "TTC" : "HT, sans TVA"}
                </p>
              </div>
              {d.fichierId && (
                <a href={`/api/documents/${d.fichierId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
                  <ExternalLink className="h-3.5 w-3.5" /> Ouvrir le devis
                </a>
              )}
            </div>
            <CaseDuDevis
              id={`agc-${itemId}-${d.pieceId}-tout`} coche={toutCoche} partiel={choisies.size > 0 && !toutCoche}
              desactive={possibles.length === 0 || enCours} onChange={(oui) => toutes(d, oui)}
            >
              Toutes les lignes de ce devis
            </CaseDuDevis>
            <ul className="divide-y divide-border rounded-md border border-border bg-background">
              {d.lignes.map((l) => {
                const ok = cochable(l);
                const idCase = `agc-${itemId}-${l.id}`;
                return (
                  <li key={l.id} className="flex items-start gap-2 p-2 text-sm">
                    <input
                      id={idCase} type="checkbox" name="ligne" value={valeurDeLigne(d.pieceId, l.id)} checked={choisies.has(l.id)}
                      disabled={!ok || enCours} onChange={(e) => basculer(d.pieceId, l.id, e.target.checked)}
                      aria-describedby={ok ? undefined : `${idCase}-motif`} className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <label htmlFor={idCase} className={cn("min-w-0 flex-1", !ok && "text-muted-foreground")}>
                      <span className="block break-words">{l.reference || "Ligne sans désignation"}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {l.quantity ?? "?"}{l.unit ? ` ${l.unit}` : ""} × {l.unitPrice != null ? formatCurrency(l.unitPrice) : "?"}
                      </span>
                      {!ok && (
                        <span id={`${idCase}-motif`} className="block text-xs text-warning">
                          {l.valideeAilleurs ? `Déjà commandée pour le poste « ${l.valideeAilleurs} ».` : l.refusValidation}
                        </span>
                      )}
                    </label>
                    <span className="shrink-0 text-right text-sm tabular-nums">
                      {l.totalHt != null ? formatCurrency(l.totalHt) : "—"}
                      <span className="block text-[10px] text-muted-foreground">HT</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs" aria-live="polite">
              <span className="text-muted-foreground">{choisies.size} ligne{choisies.size > 1 ? "s" : ""} cochée{choisies.size > 1 ? "s" : ""}</span>
              <span className="font-semibold tabular-nums">{formatCurrency(t.montant)} {t.ttc ? "TTC" : "HT, sans TVA"}</span>
            </p>
          </fieldset>
        );
      })}

      <p className="flex flex-wrap items-baseline justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-2 text-sm" aria-live="polite">
        <span>Total retenu{retenus.length > 0 ? ` — ${retenus.length} agence${retenus.length > 1 ? "s" : ""}` : ""}</span>
        <span className="font-semibold tabular-nums">{formatCurrency(total)}{mention ? ` ${mention}` : ""}</span>
      </p>

      <div className="space-y-1">
        <Label htmlFor={`agc-bud-${itemId}`}>Budget qui porte {retenus.length > 1 ? "ces postes" : "ce poste"}</Label>
        <select id={`agc-bud-${itemId}`} name="budgetCategoryId" required defaultValue={budgetCategoryId ?? ""} className="w-full rounded-lg border border-border bg-background px-2 py-2 text-sm">
          <option value="">Choisir le budget (enveloppe › catégorie)…</option>
          {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      <p className="text-xs text-muted-foreground" role="status">
        {phraseDuChoix(retenus.map((x) => ({ agence: nomAgence(x.d), nombre: x.choisies.size })))}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={retenus.length === 0 || enCours} className="w-full sm:w-auto">
          {retenus.length > 1 ? `Retenir ${retenus.length} agences` : "Retenir ces lignes"}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onAnnuler}>Annuler</Button>
      </div>
    </form>
  );
}
