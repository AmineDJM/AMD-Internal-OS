"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Receipt, Loader2, Plus, AlertTriangle, Upload, FileText, X, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { formatCurrency } from "@/lib/utils";
import { DEPT_BUDGET_LABEL } from "@/lib/department-budget";
import { addDepartmentExpense, lireFactureDepense } from "@/lib/actions/department-budget-actions";
import { ReceiptLines, type CatalogArticle, type ExistingLine } from "./receipt-lines";
import { BudgetTargetField } from "./budget-target-field";
import { SOURCE_LABEL, SOURCE_HINT, defaultSource, type PaymentSource } from "@/lib/general-means/payment-source";
import { CASE_COMPAREES_DEPENSE, type LectureFactureDepense } from "@/lib/general-means/lecture-facture";
import { cn } from "@/lib/utils";
import type { BudgetTarget } from "@/lib/budget/target";
import { journal } from "@/lib/journal";

type EtatLecture = { etat: "attente" } | { etat: "lecture" } | { etat: "lue"; message: string } | { etat: "echec"; message: string };

/**
 * AJOUTER UN ACHAT — UN SEUL BOUTON, la question du paiement à l'intérieur.
 *
 * Il y en avait deux : « Ajouter une dépense » (sur le budget) et « Enregistrer une dépense »
 * (sur la caisse d'avance). Deux boutons, deux formulaires, deux endroits — pour la MÊME dépense :
 * le même achat, la même facture, le même budget consommé. Seul le moyen de paiement changeait.
 *
 * LA DÉPENSE COMMENCE PAR SA PIÈCE (Direction, 09/11/2026). Le formulaire s'ouvre sur « Déposez la facture ou le
 * ticket » ; la pièce est lue (`lireFactureDepense`) et remplit les articles — nommés et chiffrés comme sur le papier,
 * rattachés au catalogue quand il les connaît, proposés à l'ajout au catalogue sinon —, l'objet et les précisions. La
 * personne corrige ce qu'elle veut, coche « J'ai comparé les articles à la facture », puis enregistre. Une lecture qui
 * échoue ne bloque rien : les articles se saisissent à la main. La pièce reste obligatoire : une dépense sans facture
 * ni bon de paiement n'est qu'une affirmation.
 */
export function ExpensePanel({
  departmentId, year, remaining, articles, budgetTargets = [], cash,
}: {
  departmentId: string;
  year: number;
  remaining: number;
  articles: CatalogArticle[];
  budgetTargets?: BudgetTarget[];
  /** La caisse d'avance, quand elle contient quelque chose ET qu'on peut en sortir de l'argent. */
  cash?: { status: string; remaining: number; canSpend: boolean } | null;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  // Le montant vient du DÉTAIL du ticket : il se calcule, il ne se saisit pas à côté.
  const [total, setTotal] = React.useState(0);

  // LA PIÈCE D'ABORD, et ce que sa lecture propose.
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [lecture, setLecture] = React.useState<LectureFactureDepense | null>(null);
  const [etat, setEtat] = React.useState<EtatLecture>({ etat: "attente" });
  const [objet, setObjet] = React.useState("");
  const [precisions, setPrecisions] = React.useState("");
  const [comparees, setComparees] = React.useState(false);
  const [survol, setSurvol] = React.useState(false);
  const objetTouche = React.useRef(false);
  const precisionsTouchees = React.useRef(false);
  const fichierCourant = React.useRef<File | null>(null);
  const choixRef = React.useRef<HTMLInputElement>(null);

  const cashUsable = Boolean(cash?.canSpend);
  const [source, setSource] = React.useState<PaymentSource>(
    defaultSource(cash ? { status: cash.status } : null, { isHolder: cashUsable }),
  );
  React.useEffect(() => {
    if (open) setSource(defaultSource(cash ? { status: cash.status } : null, { isHolder: cashUsable }));
  }, [open, cash, cashUsable]);

  // Le plafond dépassé n'est pas le même selon le moyen de paiement : le fond en main d'un côté,
  // la caisse de l'exercice de l'autre. Prévenir avec le mauvais chiffre serait pire que se taire.
  const ceiling = source === "CASH" && cash ? cash.remaining : remaining;
  const overBudget = total > 0 && total > ceiling;

  React.useEffect(() => {
    if (!msg?.ok) return;
    const t = window.setTimeout(() => setMsg(null), 8000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const reinitialiser = () => {
    setFichier(null); setLecture(null); setEtat({ etat: "attente" }); setObjet(""); setPrecisions(""); setComparees(false);
    setTotal(0); setSurvol(false);
    objetTouche.current = false; precisionsTouchees.current = false; fichierCourant.current = null;
  };

  /** Une pièce choisie se LIT aussitôt ; le résultat d'une pièce remplacée entre-temps est ignoré. */
  const choisirPiece = (f: File | null | undefined) => {
    if (!f || f.size === 0) return;
    setFichier(f); setLecture(null); setComparees(false); setEtat({ etat: "lecture" });
    fichierCourant.current = f;
    const fd = new FormData();
    fd.set("fichier", f);
    void lireFactureDepense(fd).then((r) => {
      if (fichierCourant.current !== f) return;
      if (!r.ok || !r.lecture) { setEtat({ etat: "echec", message: r.error ?? "Lecture impossible : saisissez les articles à la main." }); return; }
      const l = r.lecture;
      setLecture(l);
      setEtat({ etat: "lue", message: r.message ?? "Facture lue." });
      if (!objetTouche.current && l.objet) setObjet(l.objet);
      if (!precisionsTouchees.current && l.precisions) setPrecisions(l.precisions);
    }).catch((e: unknown) => {
      journal.erreur("expense-panel.lireFactureDepense", {}, e);
      if (fichierCourant.current === f) setEtat({ etat: "echec", message: "Lecture impossible : saisissez les articles à la main." });
    });
  };

  const lignesLues: ExistingLine[] = lecture
    ? lecture.lignes.map((l) => ({
        articleId: l.articleId, label: l.label, quantity: l.quantity, amount: l.amount,
        lue: l.rang, ajouterAuCatalogue: l.ajouterAuCatalogue, notes: l.notes,
      }))
    : [];
  const confirmationExigee = Boolean(lecture && lecture.lignes.some((l) => l.rang !== null));

  return (
    <>
      <Button onClick={() => { reinitialiser(); setOpen(true); setMsg(null); }}>
        <Plus className="h-4 w-4" /> Ajouter une dépense
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Ajouter une dépense" width="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!fichier) return;
            const fd = new FormData(e.currentTarget);
            fd.set("departmentId", departmentId);
            fd.set("year", String(year));
            fd.set("paymentSource", source);
            // La pièce LUE part EN PREMIER : c'est elle que la confirmation reconnaît ; les autres pièces suivent.
            const autres = fd.getAll("files").filter((x): x is File => x instanceof File && x.size > 0);
            fd.delete("files");
            fd.append("files", fichier);
            for (const a of autres) fd.append("files", a);
            if (lecture) fd.set("lectureId", lecture.lectureId);
            setBusy(true); setMsg(null);
            void addDepartmentExpense(fd).then((r) => {
              setBusy(false);
              const base = source === "CASH" ? "Dépense enregistrée et déduite de la caisse d'avance." : "Dépense enregistrée et déduite de la caisse de l'exercice.";
              setMsg({
                ok: r.ok,
                text: r.ok ? `${base}${r.message ? ` ${r.message}` : ""}` : (r.error ?? "La dépense n'a pas été enregistrée."),
              });
              if (r.ok) { setOpen(false); reinitialiser(); rafraichir(); }
            }).catch((e: unknown) => { journal.erreur("expense-panel.addDepartmentExpense", {}, e);
              setBusy(false);
              setMsg({ ok: false, text: actionFailureMessage("THROWN") });
            });
          }}
          className="space-y-3"
        >
          {/* PAYÉ COMMENT ? La question qui séparait deux boutons — elle tient en deux cases. */}
          {cashUsable && (
            <div className="grid grid-cols-2 gap-2">
              {(["CASH", "OFF_CASH"] as PaymentSource[]).map((s) => (
                <button
                  key={s} type="button" onClick={() => setSource(s)} aria-pressed={source === s}
                  className={cn(
                    "rounded-lg border p-2 text-left transition",
                    source === s ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-background hover:bg-secondary",
                  )}
                >
                  <span className="block text-sm font-medium">{SOURCE_LABEL[s]}</span>
                  <span className="block text-[0.6875rem] text-muted-foreground">{SOURCE_HINT[s]}</span>
                </button>
              ))}
            </div>
          )}

          <input ref={choixRef} type="file" className="hidden" onChange={(e) => { choisirPiece(e.target.files?.[0]); e.target.value = ""; }} />
          {!fichier ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
              onDragLeave={() => setSurvol(false)}
              onDrop={(e) => { e.preventDefault(); setSurvol(false); choisirPiece(e.dataTransfer.files?.[0]); }}
              className={cn("space-y-3 rounded-lg border-2 border-dashed px-4 py-6 text-center", survol ? "border-primary bg-primary/5" : "border-border")}
            >
              <Upload className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Déposez la facture ou le ticket <span className="text-destructive">*</span></p>
              <p className="text-xs text-muted-foreground">Les articles, l&apos;objet et les précisions se remplissent depuis la pièce : vous vérifiez, corrigez, puis enregistrez.</p>
              <Button type="button" size="sm" onClick={() => choixRef.current?.click()}><Upload className="h-4 w-4" /> Choisir la pièce</Button>
            </div>
          ) : (
            <div className="space-y-1 rounded-lg border border-border bg-secondary/30 px-3 py-2">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{fichier.name}</span>
                <button type="button" onClick={reinitialiser} aria-label="Changer de pièce" className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {etat.etat === "lecture" && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lecture de la facture…</p>}
              {etat.etat === "lue" && <p className="flex items-center gap-1.5 text-xs text-primary"><Sparkles className="h-3.5 w-3.5" /> {etat.message}</p>}
              {etat.etat === "echec" && <p className="text-xs text-muted-foreground">{etat.message}</p>}
              {lecture?.sansLignes && <p className="text-xs text-muted-foreground">{lecture.sansLignes}</p>}
            </div>
          )}

          {fichier && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="text-xs sm:col-span-2">
                  Objet de l&apos;achat
                  <Input
                    name="label" value={objet} onChange={(e) => { objetTouche.current = true; setObjet(e.target.value); }}
                    placeholder="Facultatif — résumé depuis les articles si vide" className="mt-1 h-9"
                  />
                </label>
                <label className="text-xs">
                  Budget imputé
                  <select name="kind" defaultValue="OPERATING" className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:text-sm">
                    <option value="OPERATING">{DEPT_BUDGET_LABEL.OPERATING}</option>
                    <option value="ACTIVITY">{DEPT_BUDGET_LABEL.ACTIVITY}</option>
                  </select>
                </label>
                <BudgetTargetField targets={budgetTargets} />
                <label className="text-xs sm:col-span-3">
                  Précisions
                  <Input
                    name="notes" value={precisions} onChange={(e) => { precisionsTouchees.current = true; setPrecisions(e.target.value); }}
                    placeholder="Facultatif — fournisseur, n° de facture…" className="mt-1 h-9"
                  />
                </label>
              </div>

              <div className="rounded-lg border border-border bg-background p-2">
                <p className="mb-1.5 text-xs font-medium">
                  Articles de la facture <span className="text-destructive">*</span>
                  <span className="ml-1 font-normal text-muted-foreground">— le total en découle</span>
                </p>
                {etat.etat === "lecture" ? (
                  <p className="flex items-center gap-1.5 px-1 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Les articles arrivent de la facture…</p>
                ) : (
                  <ReceiptLines
                    key={lecture?.lectureId ?? `manuel:${fichier.name}`}
                    articles={articles} onTotalChange={setTotal} budgetTargets={budgetTargets}
                    initial={lignesLues.length > 0 ? lignesLues : undefined}
                  />
                )}
              </div>

              {lecture?.ecart && (
                <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> <span>{lecture.ecart}</span>
                </p>
              )}

              {confirmationExigee && (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-secondary/30 px-3 py-2.5 text-sm">
                  <input
                    type="checkbox" name="lignesComparees" checked={comparees} onChange={(e) => setComparees(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span>
                    <strong>{CASE_COMPAREES_DEPENSE}</strong>
                    <span className="block text-xs text-muted-foreground">Les articles viennent de la lecture : une personne les atteste avant qu&apos;ils n&apos;entrent au budget.</span>
                  </span>
                </label>
              )}

              <label className="block text-xs">
                Autres pièces <span className="text-muted-foreground">— facultatif (bon de livraison, bon de paiement…)</span>
                <input
                  type="file" name="files" multiple
                  className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
                />
              </label>

              {overBudget && (
                <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span>
                    Ce montant dépasse ce qu&apos;il reste{source === "CASH" ? " dans la caisse d'avance" : " sur la caisse de l'exercice"} ({formatCurrency(ceiling)}).
                    {source === "CASH"
                      ? " La dépense sera refusée : on ne sort pas d'un fond ce qu'il ne contient pas."
                      : " La dépense sera enregistrée — mais le budget passera en dépassement, et cela se verra."}
                  </span>
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm" type="submit"
              disabled={busy || !fichier || etat.etat === "lecture" || (confirmationExigee && !comparees)}
              title={!fichier ? "Déposez d'abord la facture ou le ticket." : confirmationExigee && !comparees ? `Cochez « ${CASE_COMPAREES_DEPENSE} ».` : undefined}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />} Enregistrer la dépense
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
          </div>
        </form>
      </Sheet>

      {/* Le résultat de l'enregistrement, sous l'en-tête où se tient le bouton. Il s'efface seul. */}
      {msg && (
        <p role="status" className={`w-full rounded-xl px-3 py-2 text-sm sm:max-w-md ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </>
  );
}
