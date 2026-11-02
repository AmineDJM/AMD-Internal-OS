"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import Link from "next/link";
import { Plus, Trash2, Loader2, Sparkles, Wand2, Package, Upload, TrendingUp, ShoppingCart, BadgeCheck, Download, Factory, Ship } from "lucide-react";
import { addTenderLine, updateTenderLine, deleteTenderLine, analyzeTenderText, analyzeTenderDocument, enrichTenderLine, enrichAllTenderLines, createOrderFromLine } from "@/lib/actions/pch-tender-line-actions";
import type { LectureAoDTO, PchTenderLineDTO } from "@/lib/queries/pch";
import { lineEconomics, awardResult } from "@/lib/pch/box-economics";

type Res = { ok: boolean; error?: string; message?: string };
/**
 * LE CHAMP SANS SA LARGEUR — et le cas ordinaire par-dessus.
 *
 * `inp` portait `w-full`, et deux appels ajoutaient `w-28` / `w-32` par-dessus en croyant les
 * rétrécir. Tailwind n'applique pas « la dernière classe écrite » mais la dernière RÈGLE de sa
 * feuille, où `w-full` est émis APRÈS les largeurs numériques : les deux champs prenaient donc
 * toute la ligne — celui de la quantité vendue poussait à lui seul la référence et le bouton au
 * rang suivant. Rien ne le signalait : ni le typage, ni le lint, ni le build.
 *
 * La largeur est donc SORTIE de la base. `inp` reste le cas ordinaire (le champ occupe sa
 * cellule) ; qui veut une largeur précise part de `inpBase`. Le garde
 * `src/lib/ui/class-collision.test.ts` fait échouer la suite si la collision revient.
 */
// Au téléphone : 40 px de haut et 16 px de texte (pas de zoom automatique d'iOS au focus).
const inpBase = "h-10 rounded-md border border-input bg-background px-2 text-base focus:border-primary focus:outline-none sm:h-8 sm:text-sm";
const inp = `${inpBase} w-full`;
const LINE_STATUS: { value: string; label: string }[] = [
  { value: "PENDING", label: "À étudier" }, { value: "QUOTED", label: "Chiffré" },
  { value: "SUBMITTED", label: "Soumissionné" }, { value: "WON", label: "Gagné" }, { value: "LOST", label: "Perdu" },
  { value: "UNSUCCESSFUL", label: "Infructueux" }, { value: "CANCELLED", label: "Lot annulé" },
];
const fmt = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat("fr-FR").format(n));

export function TenderLines({ tenderId, lines, canEdit, aiConfigured, reserves = {}, lectures }: {
  tenderId: string; lines: PchTenderLineDTO[]; canEdit: boolean; aiConfigured: boolean;
  /**
   * « CE PRODUIT EST DÉJÀ ENGAGÉ AILLEURS » — par `productId`, la phrase à afficher.
   *
   * La Direction énonce qu'un produit est lié à UN SEUL AO. Le savoir au moment où l'on chiffre
   * un lot coûte un clic ; l'apprendre après le dépôt coûte une négociation. La phrase vient du
   * serveur (`queries/pch-engagements.ts`), qui seul peut composer le droit de lire une pièce
   * Legal — la recalculer ici demanderait de charger les contrats dans le navigateur.
   */
  reserves?: Record<string, string>;
  /** Les lectures précédentes du document (lot D1c — F2) : ce que chacune a fait, et le compte des autres. */
  lectures?: { liste: LectureAoDTO[]; total: number };
}) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [busy, setBusy] = React.useState(false);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [text, setText] = React.useState("");
  const [showAnalyze, setShowAnalyze] = React.useState(false);
  // LA LECTURE DIT CE QU'ELLE A FAIT (lot D1c — F2) : ajoutés, remplacés, conservés, ce qui n'a pas été lu,
  // le fichier gardé ou non. La lecture d'avant se refermait sur un « ok » muet.
  const [complementaire, setComplementaire] = React.useState(false);
  const [forcerOcr, setForcerOcr] = React.useState(false);
  const [bilan, setBilan] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<Res>) {
    if (busy) return; setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) { retours.erreur(r.error ?? "La ligne du marché n'a pas été mise à jour."); return; }
      rafraichir();
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }
  async function analyzeText() {
    if (!text.trim()) return;
    setAnalyzing(true); setBilan(null);
    const fd = new FormData(); fd.set("tenderId", tenderId); fd.set("text", text.trim());
    if (complementaire) fd.set("complementaire", "on");
    try {
      const r: Res = await analyzeTenderText(fd);
      if (!r.ok) { setBilan({ ok: false, texte: r.error ?? "Analyse impossible : rien n'a été écrit au tableau du marché." }); return; }
      setBilan({ ok: true, texte: r.message ?? "Lecture terminée." });
      setText(""); setComplementaire(false); setShowAnalyze(false); rafraichir();
    } catch {
      setBilan({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setAnalyzing(false);
    }
  }
  async function analyzeFile() {
    const f = fileRef.current?.files?.[0];
    if (!f) { setBilan({ ok: false, texte: "Choisissez d'abord le document de l'appel d'offres." }); return; }
    setAnalyzing(true); setBilan(null);
    const fd = new FormData(); fd.set("tenderId", tenderId); fd.set("file", f);
    if (complementaire) fd.set("complementaire", "on");
    if (forcerOcr) fd.set("forcerOcr", "on");
    try {
      const r: Res = await analyzeTenderDocument(fd);
      if (!r.ok) { setBilan({ ok: false, texte: r.error ?? "Analyse impossible : rien n'a été écrit au tableau du marché." }); return; }
      setBilan({ ok: true, texte: r.message ?? "Lecture terminée." });
      if (fileRef.current) fileRef.current.value = "";
      setComplementaire(false); setForcerOcr(false); setShowAnalyze(false); rafraichir();
    } catch {
      setBilan({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Package className="h-4 w-4 text-primary" /> Produits du marché ({lines.length})</h3>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowAnalyze((s) => !s)} disabled={!aiConfigured}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm sm:py-1.5 font-medium hover:bg-secondary disabled:opacity-50" title={aiConfigured ? "Lire le document et en extraire les produits (son texte ; l'OCR seulement pour un scan)" : "IA non configurée"}>
              <Wand2 className="h-4 w-4" /> Analyser le document (IA)
            </button>
            <button type="button" disabled={busy || lines.length === 0} onClick={() => { const fd = new FormData(); fd.set("tenderId", tenderId); run(() => enrichAllTenderLines(fd)); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50 sm:py-1.5"
              title="Rejouer l'intelligence marché sur TOUTES les lignes : prix de référence, nomenclature, concurrents, production locale ou importée">
              <Sparkles className="h-4 w-4" /> Enrichir tout
            </button>
            <button type="button" disabled={busy} onClick={() => { const fd = new FormData(); fd.set("tenderId", tenderId); run(() => addTenderLine(fd)); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60 sm:py-1.5"><Plus className="h-4 w-4" /> Ajouter</button>
          </div>
        )}
        {lines.length > 0 && (
          <a href={`/api/pch/export?id=${tenderId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary sm:py-1.5"
            title="Tableau Excel : produits demandés (unité, conditionnement, boîtes, prix de référence) + analyse de marché">
            <Download className="h-4 w-4" /> Tableau Excel
          </a>
        )}
      </div>

      {bilan && (
        <div role={bilan.ok ? "status" : "alert"}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${bilan.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"}`}>
          <p className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{bilan.texte}</p>
          <button type="button" onClick={() => setBilan(null)} className="shrink-0 rounded px-2 py-2 text-xs hover:bg-secondary sm:py-0.5">Fermer</button>
        </div>
      )}

      {showAnalyze && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-3">
          {/* CE QU'UNE LECTURE REMPLACE, dit AVANT qu'on la lance (lot D1c — F2). */}
          <p className="text-xs text-muted-foreground">
            Une nouvelle lecture remplace les lignes des lectures précédentes que personne n&apos;a touchées ; les lignes
            modifiées, chiffrées, soumises, annotées ou rattachées restent, et les lignes saisies à la main ne sont jamais remplacées.
          </p>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={complementaire} onChange={(e) => setComplementaire(e.target.checked)} disabled={analyzing}
              className="mt-0.5 h-4 w-4 rounded border-input" />
            Ce document complète les lectures précédentes (annexe, lot ajouté) : ne rien remplacer
          </label>
          {/* 1) Le document téléversé : son texte est lu tel quel ; l'OCR ne sert qu'aux pages scannées. */}
          <div className="space-y-2">
            <p className="text-xs font-medium">Téléverser le document (PDF ou image) — son texte est lu tel quel ; l&apos;OCR ne sert qu&apos;aux pages scannées</p>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" disabled={analyzing}
                className="max-w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium" />
              <button type="button" onClick={analyzeFile} disabled={analyzing} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Analyser le fichier
              </button>
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={forcerOcr} onChange={(e) => setForcerOcr(e.target.checked)} disabled={analyzing}
                className="mt-0.5 h-4 w-4 rounded border-input" />
              Océriser même si le PDF porte du texte (PDF en partie scanné)
            </label>
          </div>
          <div className="flex items-center gap-2 text-[0.6875rem] uppercase tracking-wide text-muted-foreground"><span className="h-px flex-1 bg-border" /> ou coller le texte <span className="h-px flex-1 bg-border" /></div>
          {/* 2) Le texte de l'appel d'offres, collé (une annexe, une suite au-delà de ce qu'une lecture analyse). */}
          <div className="space-y-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Texte de l'appel d'offres…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus:border-primary focus:outline-none sm:text-sm" />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={analyzeText} disabled={analyzing || !text.trim()} className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-60">
                {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Extraire du texte
              </button>
              <button type="button" onClick={() => setShowAnalyze(false)} disabled={analyzing} className="rounded-lg border border-input px-3 py-2 text-sm hover:bg-secondary">Fermer</button>
            </div>
          </div>
          {lectures && lectures.total > 0 && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-xs font-medium">Lectures précédentes</p>
              <ul className="space-y-0.5 text-[0.6875rem] text-muted-foreground">
                {lectures.liste.map((l) => <li key={l.id}>{l.resume}</li>)}
              </ul>
              {lectures.total > lectures.liste.length && (
                <p className="text-[0.6875rem] text-muted-foreground">
                  {lectures.total - lectures.liste.length} plus ancienne{lectures.total - lectures.liste.length > 1 ? "s" : ""} non affichée{lectures.total - lectures.liste.length > 1 ? "s" : ""}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Aucun produit. {canEdit && "Analysez le document ou ajoutez des lignes manuellement."}</p>
      ) : (
        <div className="space-y-2">
          {lines.map((l) => <LineCard key={l.id} tenderId={tenderId} line={l} canEdit={canEdit} busy={busy} run={run}
            reserve={l.productId ? reserves[l.productId] : undefined} />)}
        </div>
      )}
    </div>
  );
}

function LineCard({ tenderId, line, canEdit, busy, run, reserve }: { tenderId: string; line: PchTenderLineDTO; canEdit: boolean; busy: boolean; run: (fn: () => Promise<Res>) => void; reserve?: string }) {
  const confirmer = useConfirmer();
  const [s, setS] = React.useState({
    designation: line.designation, dci: line.dci ?? "", dosage: line.dosage ?? "", form: line.form ?? "",
    quantityUnits: String(line.quantityUnits || ""), unitsPerBox: line.unitsPerBox != null ? String(line.unitsPerBox) : "",
    unitLabel: line.unitLabel ?? "",
    haveProduct: line.haveProduct, unitPriceDzd: line.unitPriceDzd != null ? String(line.unitPriceDzd) : "",
    // NOTRE PRIX DE PARTICIPATION ET NOTRE COÛT, à la BOÎTE — les deux chiffres qu'on négocie
    // réellement. Le prix de boîte non saisi se RECONSTRUIT depuis l'unité pour les lignes
    // anciennes, sans être réenregistré (voir `lib/pch/box-economics.ts`).
    boxPriceDzd: line.boxPriceDzd != null ? String(line.boxPriceDzd) : "",
    boxCostDzd: line.boxCostDzd != null ? String(line.boxCostDzd) : "",
    status: line.status, awardedUnitPriceDzd: line.awardedUnitPriceDzd != null ? String(line.awardedUnitPriceDzd) : "",
    awardedQuantityUnits: line.awardedQuantityUnits != null ? String(line.awardedQuantityUnits) : "",
    submittedQuantityUnits: line.submittedQuantityUnits != null ? String(line.submittedQuantityUnits) : "",
    suppliersInfo: line.suppliersInfo ?? "", note: line.note ?? "",
  });

  // TOUTE L'ÉCONOMIE DE LA LIGNE, calculée à la frappe : boîtes, prix unitaire déduit, montant,
  // marge. Le même module que le serveur — deux calculs séparés auraient fini par afficher une
  // marge que l'enregistrement n'aurait pas confirmée.
  const eco = lineEconomics({
    quantityUnits: Number(s.quantityUnits) || 0,
    unitsPerBox: Number(s.unitsPerBox) || null,
    boxPriceDzd: s.boxPriceDzd === "" ? null : Number(s.boxPriceDzd),
    boxCostDzd: s.boxCostDzd === "" ? null : Number(s.boxCostDzd),
    unitPriceDzd: s.unitPriceDzd === "" ? null : Number(s.unitPriceDzd),
  });
  const boxes = eco.boxes;
  const award = awardResult({
    quantityUnits: Number(s.quantityUnits) || 0,
    submittedQuantityUnits: s.submittedQuantityUnits === "" ? null : Number(s.submittedQuantityUnits),
    awardedQuantityUnits: s.awardedQuantityUnits === "" ? null : Number(s.awardedQuantityUnits),
    status: s.status,
  });

  function save() {
    const fd = new FormData();
    fd.set("id", line.id); fd.set("tenderId", tenderId);
    fd.set("designation", s.designation); fd.set("dci", s.dci); fd.set("dosage", s.dosage); fd.set("form", s.form);
    fd.set("quantityUnits", s.quantityUnits); fd.set("unitsPerBox", s.unitsPerBox); fd.set("unitLabel", s.unitLabel);
    fd.set("haveProduct", s.haveProduct ? "on" : "off");
    fd.set("unitPriceDzd", s.unitPriceDzd); fd.set("status", s.status); fd.set("awardedUnitPriceDzd", s.awardedUnitPriceDzd);
    fd.set("boxPriceDzd", s.boxPriceDzd); fd.set("boxCostDzd", s.boxCostDzd);
    fd.set("awardedQuantityUnits", s.awardedQuantityUnits); fd.set("submittedQuantityUnits", s.submittedQuantityUnits);
    fd.set("suppliersInfo", s.suppliersInfo); fd.set("note", s.note);
    run(() => updateTenderLine(fd));
  }

  if (!canEdit) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{line.designation}</span>
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs">{LINE_STATUS.find((x) => x.value === line.status)?.label ?? line.status}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{[line.dci, line.dosage, line.form].filter(Boolean).join(" · ") || "—"} · {fmt(line.quantityUnits)} {line.unitLabel ? `${line.unitLabel}(s)` : "unités"}{line.boxesNeeded ? ` = ${fmt(line.boxesNeeded)} boîtes` : ""}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {line.ourProduct && (line.productId
            ? <Link href={`/produits/${line.productId}`} className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[0.6875rem] text-primary hover:underline"><BadgeCheck className="h-3 w-3" /> {line.ourProduct}</Link>
            : <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[0.6875rem] text-primary"><BadgeCheck className="h-3 w-3" /> {line.ourProduct}</span>)}
          {line.refPriceDzd != null && <span className="rounded bg-secondary px-2 py-0.5 text-[0.6875rem]" title={line.refPriceSource ?? undefined}>Prix réf. PCH : {fmt(line.refPriceDzd)} DZD</span>}
          {line.fulfillmentPct != null && <span className="rounded bg-success/15 px-2 py-0.5 text-[0.6875rem] text-success">Vendu : {fmt(line.soldUnits)}/{fmt(line.quantityUnits)} ({line.fulfillmentPct}%)</span>}
        </div>
        {/* LA RÉSERVE EST RENDUE DANS LES DEUX VUES. La poser seulement sur la vue modifiable
            l'aurait cachée à qui lit sans pouvoir écrire — c'est-à-dire souvent à la Direction,
            qui est précisément celle qui arbitre entre deux marchés. */}
        {reserve && <p className="mt-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[0.6875rem]">{reserve}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      {/* AVANT LA SAISIE, pas après : on lit qu'un produit court déjà ailleurs au moment de
          poser son prix, sinon l'information arrive quand l'offre est déjà chiffrée. */}
      {reserve && <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs">{reserve}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <input className={`${inp} sm:col-span-6`} value={s.designation} onChange={(e) => setS({ ...s, designation: e.target.value })} onBlur={save} placeholder="Désignation produit" />
        <input className={`${inp} sm:col-span-3`} value={s.dci} onChange={(e) => setS({ ...s, dci: e.target.value })} onBlur={save} placeholder="DCI" />
        <select className={`${inp} sm:col-span-3`} value={s.status} onChange={(e) => { setS({ ...s, status: e.target.value }); }} onBlur={save}>
          {LINE_STATUS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input className={`${inp} sm:col-span-3`} value={s.dosage} onChange={(e) => setS({ ...s, dosage: e.target.value })} onBlur={save} placeholder="Dosage" />
        <input className={`${inp} sm:col-span-3`} value={s.form} onChange={(e) => setS({ ...s, form: e.target.value })} onBlur={save} placeholder="Forme" />
        <div className="flex items-center gap-1 sm:col-span-3">
          <input className={`${inp} min-w-0`} inputMode="numeric" value={s.quantityUnits} onChange={(e) => setS({ ...s, quantityUnits: e.target.value })} onBlur={save} placeholder="Quantité" />
          {/* Un appel d'offres ne parle pas toujours de comprimés : flacon, seringue, ampoule… */}
          <input className={`${inpBase} w-28 shrink-0`} value={s.unitLabel} onChange={(e) => setS({ ...s, unitLabel: e.target.value })} onBlur={save} placeholder="comprimé…" title="Nature de l'unité demandée" />
        </div>
        <div className="flex items-center gap-1 sm:col-span-3">
          <input className={`${inp} min-w-0`} inputMode="numeric" value={s.unitsPerBox} onChange={(e) => setS({ ...s, unitsPerBox: e.target.value })} onBlur={save} placeholder="Boîte de N" />
          <span className="whitespace-nowrap text-xs font-medium text-primary">{boxes != null ? `= ${fmt(boxes)} bt` : ""}</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs sm:col-span-3"><input type="checkbox" checked={s.haveProduct} onChange={(e) => { setS({ ...s, haveProduct: e.target.checked }); }} onBlur={save} className="h-4 w-4 rounded border-input" /> Nous l'avons</label>
        {/* NOTRE PRIX DE PARTICIPATION ET NOTRE COÛT, À LA BOÎTE — les deux chiffres que
            l'équipe négocie réellement. Le prix unitaire, dont vit la chaîne aval, s'en déduit
            et s'affiche à côté : on ne divise plus de tête avant de saisir. */}
        <input className={`${inp} sm:col-span-3`} inputMode="decimal" value={s.boxPriceDzd} onChange={(e) => setS({ ...s, boxPriceDzd: e.target.value })} onBlur={save} placeholder="Notre prix / boîte" title="Notre prix de participation, à la boîte — c'est lui qui fait foi" />
        <input className={`${inp} sm:col-span-3`} inputMode="decimal" value={s.boxCostDzd} onChange={(e) => setS({ ...s, boxCostDzd: e.target.value })} onBlur={save} placeholder="Notre coût / boîte" title="Ce que la boîte nous coûte — la marge se voit avant le dépôt" />
        <input className={`${inp} sm:col-span-3`} inputMode="decimal" value={s.unitPriceDzd} onChange={(e) => setS({ ...s, unitPriceDzd: e.target.value })} onBlur={save} placeholder="Prix unité (DZD)" title="Déduit du prix à la boîte quand celui-ci est saisi" />
        <input className={`${inp} sm:col-span-3`} inputMode="decimal" value={s.awardedUnitPriceDzd} onChange={(e) => setS({ ...s, awardedUnitPriceDzd: e.target.value })} onBlur={save} placeholder="Prix attribué (DZD)" />
        {/* CE QU'ON A DÉPOSÉ, ET CE QU'ON A OBTENU. Le pourcentage gagné se MESURE sur ces deux
            quantités — un pourcentage saisi à la main dérive de ses quantités dès la première
            correction, et l'on ne sait plus lequel croire. */}
        <input className={`${inp} sm:col-span-3`} inputMode="numeric" value={s.submittedQuantityUnits} onChange={(e) => setS({ ...s, submittedQuantityUnits: e.target.value })} onBlur={save} placeholder="Qté soumise (si partielle)" title="Ce que NOUS avons déposé — vide = toute la quantité demandée" />
        <input className={`${inp} sm:col-span-3`} inputMode="numeric" value={s.awardedQuantityUnits} onChange={(e) => setS({ ...s, awardedQuantityUnits: e.target.value })} onBlur={save} placeholder="Qté attribuée (si partielle)" title="Quantité attribuée — vide = quantité soumise entière" />
        <input className={`${inp} sm:col-span-6`} value={s.suppliersInfo} onChange={(e) => setS({ ...s, suppliersInfo: e.target.value })} onBlur={save} placeholder="Nos fournisseurs + prix / notes marché" />
      </div>

      {/* L'ÉCONOMIE DE LA LIGNE, LUE D'UN COUP D'ŒIL — et l'attribution quand elle est tombée. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {eco.unitPrice != null && <span className="rounded bg-secondary px-2 py-0.5">Prix unité déduit : <strong>{eco.unitPrice}</strong> DZD</span>}
        {eco.amount != null && <span className="rounded bg-secondary px-2 py-0.5">Montant du lot : <strong>{fmt(eco.amount)}</strong> DZD</span>}
        {eco.marginPerBox != null && (
          <span className={`rounded px-2 py-0.5 ${eco.atLoss ? "bg-destructive/10 text-destructive" : "bg-success/15 text-success"}`}
            title={eco.atLoss ? "Le coût dépasse le prix : ce lot se dépose à perte." : undefined}>
            Marge / boîte : <strong>{fmt(eco.marginPerBox)}</strong> DZD{eco.marginPct != null ? ` (${eco.marginPct} %)` : ""}
          </span>
        )}
        {award.won && (
          <span className={`rounded px-2 py-0.5 ${award.partial ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}`}>{award.label}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {line.ourProduct && (line.productId
          ? <Link href={`/produits/${line.productId}`} className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-primary hover:underline" title={line.registeredOurs ? "Produit enregistré chez nous" : undefined}><BadgeCheck className="h-3.5 w-3.5" /> {line.ourProduct}{line.registeredOurs ? " · enregistré" : ""}</Link>
          : <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-primary" title={line.registeredOurs ? "Produit enregistré chez nous" : undefined}><BadgeCheck className="h-3.5 w-3.5" /> {line.ourProduct}{line.registeredOurs ? " · enregistré" : ""}</span>)}
        {line.refPriceDzd != null && <span className="rounded bg-secondary px-2 py-0.5" title={line.refPriceSource ?? undefined}>Prix réf. PCH : <strong>{fmt(line.refPriceDzd)}</strong> DZD</span>}
        {line.competitorCount != null && <span className="rounded bg-secondary px-2 py-0.5">Concurrents : <strong>{line.competitorCount}</strong></span>}
        <span className={`rounded px-2 py-0.5 ${line.registeredNomenclature ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground"}`}>Nomenclature : {line.registeredNomenclature ? `oui (${line.nomLines ?? 0})` : "non"}</span>
        {line.marketEstimateDzd != null && <span className="rounded bg-secondary px-2 py-0.5">Marché ≈ {fmt(line.marketEstimateDzd)} DZD</span>}
        <MarketBadges line={line} />
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" disabled={busy} onClick={() => { const fd = new FormData(); fd.set("id", line.id); fd.set("tenderId", tenderId); run(() => enrichTenderLine(fd)); }}
            className="inline-flex items-center gap-1 rounded px-2 py-2 text-primary hover:bg-primary/10 sm:py-1" title="Verrou prix Réception 2025 + concurrents + nomenclature + notre produit"><Sparkles className="h-3.5 w-3.5" /> Enrichir</button>
          <button type="button" disabled={busy} aria-label={`Supprimer ${line.designation}`} onClick={async () => { if (await confirmer(`Supprimer « ${line.designation} » ?`)) { const fd = new FormData(); fd.set("id", line.id); fd.set("tenderId", tenderId); run(() => deleteTenderLine(fd)); } }}
            className="rounded p-2 text-destructive hover:bg-destructive/10 sm:p-1"><Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" /></button>
        </div>
      </div>

      {line.status === "WON" && <SalesBlock tenderId={tenderId} line={line} canEdit={canEdit} busy={busy} run={run} />}
    </div>
  );
}

/**
 * PAYSAGE CONCURRENTIEL de la ligne, calculé par l'intelligence marché sur le triplet
 * molécule + dosage + forme : où est le marché (ville ou hôpital), qui le tient, et
 * s'il est fourni par des fabricants locaux ou des importateurs. Ne s'affiche que
 * lorsque l'enrichissement a réellement trouvé quelque chose — jamais de case vide.
 */
function MarketBadges({ line }: { line: PchTenderLineDTO }) {
  const hasSplit = line.marketVillePct != null && line.marketHopitalPct != null;
  const origin = line.marketOrigin;
  const concentration = line.marketHhi == null ? null : line.marketHhi >= 2500 ? "concentré" : line.marketHhi >= 1500 ? "modéré" : "fragmenté";
  if (!hasSplit && !origin && !line.competitorsTop && !concentration) return null;
  return (
    <>
      {hasSplit && (
        <span className="rounded bg-secondary px-2 py-0.5" title="Répartition du marché de cette molécule">
          Ville {Math.round(line.marketVillePct as number)} % · Hôpital {Math.round(line.marketHopitalPct as number)} %
        </span>
      )}
      {origin && (
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${origin === "LOCAL" ? "bg-success/15 text-success" : origin === "IMPORT" ? "bg-primary/10 text-primary" : "bg-secondary"}`}
          title="Origine dominante des acteurs qui pèsent sur ce marché (nomenclature)"
        >
          {origin === "IMPORT" ? <Ship className="h-3 w-3" /> : <Factory className="h-3 w-3" />}
          {origin === "LOCAL" ? "Fabriqué local" : origin === "IMPORT" ? "Importé" : "Local + importé"}
        </span>
      )}
      {concentration && <span className="rounded bg-secondary px-2 py-0.5" title={`HHI ${line.marketHhi}`}>Marché {concentration}</span>}
      {line.competitorsTop && (
        <span className="max-w-full rounded bg-secondary px-2 py-0.5 [overflow-wrap:anywhere] sm:max-w-[22rem] sm:truncate" title={line.competitorsTop}>
          {line.competitorsTop}
        </span>
      )}
    </>
  );
}

/** Ventes réelles : bons de commande (fractions) rattachés à une ligne GAGNÉE + taux de réalisation. */
function SalesBlock({ tenderId, line, canEdit, busy, run }: { tenderId: string; line: PchTenderLineDTO; canEdit: boolean; busy: boolean; run: (fn: () => Promise<Res>) => void }) {
  const retours = useRetours();
  const [qty, setQty] = React.useState("");
  const [ref, setRef] = React.useState("");
  const pct = line.fulfillmentPct ?? 0;

  function addOrder() {
    const q = Number(qty) || 0;
    if (q <= 0) { retours.alerte("Indiquez la quantité vendue (fraction)."); return; }
    const fd = new FormData();
    fd.set("lineId", line.id); fd.set("tenderId", tenderId);
    fd.set("quantity", qty); fd.set("reference", ref);
    run(() => createOrderFromLine(fd));
    setQty(""); setRef("");
  }

  return (
    <div className="space-y-2 rounded-md border border-success/30 bg-success/5 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-success"><TrendingUp className="h-3.5 w-3.5" /> Ventes réelles — bons de commande</span>
        <span className="text-muted-foreground">{fmt(line.soldUnits)} / {fmt(line.quantityUnits)} unités · {line.orderCount} bon(s) de commande</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-success transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="text-right text-[0.6875rem] font-medium text-success">{pct}% réalisé</p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input className={`${inpBase} w-32`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Quantité vendue" />
          <input className={`${inp} min-w-[8rem] flex-1`} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="N° bon de commande (optionnel)" />
          <button type="button" disabled={busy} onClick={addOrder} className="inline-flex items-center gap-1 rounded-lg bg-success px-2.5 py-2.5 text-xs font-medium text-white hover:bg-success/90 disabled:opacity-60 sm:py-1.5"><ShoppingCart className="h-3.5 w-3.5" /> Enregistrer la vente</button>
        </div>
      )}
      <p className="text-[0.6875rem] text-muted-foreground">Chaque bon de commande devient une <strong>vente réelle</strong> (fraction de la quantité attribuée) et apparaît dans « Bons de commande » ci-dessous, avec son suivi logistique.</p>
    </div>
  );
}
