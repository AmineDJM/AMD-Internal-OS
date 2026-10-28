"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Check, Loader2, Lock, AlertCircle, ShieldCheck, Plus, ThumbsUp, ThumbsDown, Receipt } from "lucide-react";
import {
  setDepartmentBudget, requestDepartmentBudget, decideDepartmentBudgetRequest, annulerDemandeBudgetDepartement, addDepartmentExpense,
} from "@/lib/actions/department-budget-actions";
import {
  DEPT_BUDGET_LABEL, DEPT_BUDGET_HINT, DEPT_BUDGET_KINDS, budgetHealth, consumedPercent,
  allocatedOf, consumedOf, EMPTY_GRANT,
  type DeptBudgetKind, type DeptBudgetViewRow, type DeptBudgetGrant, type DeptBudgetTotals,
} from "@/lib/department-budget";
import type { DeptBudgetRequestRow } from "@/lib/queries/department-budget";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { DepartmentAccessSheet } from "./access-sheet";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { ancreDemandeBudget } from "@/lib/chemins/budgets";

/**
 * Le tableau des budgets départementaux.
 *
 * Une case non modifiable n'est pas cachée : elle est **affichée en lecture**, avec un cadenas.
 * Masquer le budget des employés à l'administrateur (et réciproquement) l'empêcherait de voir
 * ce que coûte réellement un département — or c'est justement l'intérêt de mettre les deux
 * colonnes côte à côte. Ce qui est réservé, c'est l'ÉCRITURE, pas la lecture.
 *
 * La saisie s'enregistre à la sortie du champ (et à Entrée), sans bouton : un tableau de
 * budgets se remplit en tabulant d'une case à l'autre.
 */
export function DepartmentBudgetTable({
  rows, year, totals, requests, canDecide, canManageAccess, generalGrant, users, demandeAOuvrir,
}: {
  rows: DeptBudgetViewRow[];
  year: number;
  totals: DeptBudgetTotals;
  requests: DeptBudgetRequestRow[];
  canDecide: boolean;
  canManageAccess: boolean;
  generalGrant: DeptBudgetGrant | null;
  users: { id: string; name: string }[];
  /** La demande dont parle la notification (`?demande=`) : sa ligne vient sous les yeux et s'entoure. */
  demandeAOuvrir?: string | null;
}) {
  const router = useRouter();
  const [err, setErr] = React.useState<string | null>(null);
  /** Ligne pour laquelle on ouvre le formulaire de demande de dotation / rallonge. */
  const [askFor, setAskFor] = React.useState<{ id: string; path: string } | null>(null);
  /** Ligne pour laquelle on saisit une dépense (avec justificatif). */
  const [spendFor, setSpendFor] = React.useState<{ id: string; path: string } | null>(null);
  const pending = requests.filter((r) => r.status === "PENDING");
  /** Ligne dont on règle les accès — `"__GENERAL__"` pour la règle générale. */
  const [accessFor, setAccessFor] = React.useState<string | null>(null);

  // Les bandeaux d'explication décrivent le SOCLE par rôle : ce que la personne peut régler
  // partout, indépendamment des autorisations posées département par département.
  const canEditAnywhere = (k: DeptBudgetKind) => rows.some((r) => r.editable.includes(k));

  const years = [year - 1, year, year + 1];

  return (
    <div className="space-y-4">
      <SurlignerCible ids={[demandeAOuvrir ? ancreDemandeBudget(demandeAOuvrir) : null]} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Exercice</span>
        {years.map((y) => (
          <button
            key={y}
            type="button"
            onClick={() => router.push(`/budgets/departements?year=${y}`)}
            className={`min-h-9 rounded-lg px-3 py-1 text-sm tabular-nums transition sm:min-h-0 ${y === year ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
          >
            {y}
          </button>
        ))}
      </div>

      {/* Qui règle quoi — dit à l'écran, pas seulement appliqué en silence. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {DEPT_BUDGET_KINDS.map((k) => (
          <p key={k} className="flex items-start gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
            {!canEditAnywhere(k) && <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>
              <strong className="text-foreground">{DEPT_BUDGET_LABEL[k]}</strong> — {DEPT_BUDGET_HINT[k]}
              {!canEditAnywhere(k) && " Vous le consultez sans pouvoir le modifier."}
            </span>
          </p>
        ))}
      </div>

      {err && (
        <p className="flex items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {err}
        </p>
      )}

      {askFor && (
        <RequestForm
          departmentId={askFor.id} path={askFor.path} year={year}
          onDone={() => setAskFor(null)} onError={setErr}
        />
      )}
      {spendFor && (
        <ExpenseForm
          departmentId={spendFor.id} path={spendFor.path} year={year}
          onDone={() => setSpendFor(null)} onError={setErr}
        />
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-secondary/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-10 bg-secondary px-3 py-2 text-left font-medium">Département</th>
              <th className="px-3 py-2 text-right font-medium">Effectif</th>
              {DEPT_BUDGET_KINDS.map((k) => (
                <th key={k} className="px-3 py-2 text-right font-medium">
                  {DEPT_BUDGET_LABEL[k]}
                  <span className="block text-[0.6875rem] normal-case text-muted-foreground">alloué · consommé</span>
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Actions</th>
              {canManageAccess && <th className="px-3 py-2 text-right font-medium">Accès</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.departmentId} className="hover:bg-secondary/20">
                <td className="sticky left-0 z-10 max-w-[11rem] bg-card px-3 py-2 sm:max-w-none">
                  <span className="font-medium [overflow-wrap:anywhere]">{r.path}</span>
                  {r.companyName && <span className="ml-2 text-xs text-muted-foreground">{r.companyName}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.members}</td>
                {DEPT_BUDGET_KINDS.map((k) => (
                  <td key={k} className="px-3 py-2 text-right">
                    <AmountCell
                      departmentId={r.departmentId} year={year} kind={k}
                      value={allocatedOf(r, k)} readOnly={!r.editable.includes(k)} onError={setErr}
                    />
                    <div className="mt-0.5">
                      <Consumption allocated={allocatedOf(r, k)} consumed={consumedOf(r, k)} />
                    </div>
                  </td>
                ))}
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setAskFor({ id: r.departmentId, path: r.path })}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-input px-2 py-1 text-xs hover:bg-secondary sm:min-h-0"
                      title="Demander une dotation ou une rallonge — l'administration tranche"
                    >
                      <Plus className="h-3.5 w-3.5" /> Dotation
                    </button>
                    {r.editable.some((k) => k !== "HR") && (
                      <button
                        type="button"
                        onClick={() => setSpendFor({ id: r.departmentId, path: r.path })}
                        className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-input px-2 py-1 text-xs hover:bg-secondary sm:min-h-0"
                        title="Imputer une dépense (facture ou bon de paiement obligatoire)"
                      >
                        <Receipt className="h-3.5 w-3.5" /> Dépense
                      </button>
                    )}
                  </div>
                </td>
                {canManageAccess && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setAccessFor(r.departmentId)}
                      title={`Régler les accès — ${r.path}`}
                      className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-2 py-1 text-xs transition hover:bg-secondary sm:min-h-0 ${r.hasOwnRule ? "text-primary" : "text-muted-foreground"}`}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {r.hasOwnRule ? "Réglés" : "Régler"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border bg-secondary/30 font-medium">
            <tr>
              <td className="sticky left-0 z-10 bg-secondary px-3 py-2">Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{totals.members}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(totals.operating)}
                <span className="block text-[0.6875rem] font-normal text-muted-foreground">{formatCurrency(totals.operatingConsumed)}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(totals.hr)}
                <span className="block text-[0.6875rem] font-normal text-muted-foreground">{formatCurrency(totals.hrConsumed)}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(totals.activity)}
                <span className="block text-[0.6875rem] font-normal text-muted-foreground">{formatCurrency(totals.activityConsumed)}</span>
              </td>
              <td />
              {canManageAccess && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      {requests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            Dotations et rallonges ({pending.length} en attente)
          </h2>
          <p className="text-xs text-muted-foreground">
            Personne ne s&apos;accorde son propre budget : celui qui le tient le demande,
            l&apos;administration tranche. Un montant accordé <strong>s&apos;ajoute</strong> au budget en cours.
          </p>
          <RequestList requests={requests} canDecide={canDecide} onError={setErr} />
        </section>
      )}

      {canManageAccess && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAccessFor("__GENERAL__")}>
            <ShieldCheck className="h-4 w-4" /> Règle générale — tous les départements
          </Button>
          <span className="text-xs text-muted-foreground">
            Ouvre l&apos;accès partout d&apos;un coup ; chaque département peut ensuite ouvrir davantage.
          </span>
        </div>
      )}

      {canManageAccess && accessFor !== null && (
        <DepartmentAccessSheet
          open
          onClose={() => setAccessFor(null)}
          departmentId={accessFor === "__GENERAL__" ? null : accessFor}
          departmentLabel={rows.find((r) => r.departmentId === accessFor)?.path ?? "tous les départements"}
          grant={
            accessFor === "__GENERAL__"
              ? generalGrant ?? EMPTY_GRANT
              : rows.find((r) => r.departmentId === accessFor)?.grant ?? EMPTY_GRANT
          }
          users={users}
        />
      )}

      <p className="text-xs text-muted-foreground">
        La <strong>masse salariale consommée</strong> est calculée depuis la paie de l&apos;exercice — elle n&apos;est jamais
        saisie : un montant ressaisi dirait ce qu&apos;on espère, pas ce qui se passe. Les moyens généraux et le budget
        métier se consomment, eux, <strong>dépense par dépense</strong>, chacune accompagnée de sa facture ou de son
        bon de paiement.
      </p>
    </div>
  );
}

function AmountCell({
  departmentId, year, kind, value, readOnly, onError,
}: {
  departmentId: string; year: number; kind: DeptBudgetKind;
  value: number; readOnly: boolean; onError: (e: string | null) => void;
}) {
  const { rafraichir } = useRafraichir();
  const [text, setText] = React.useState(value ? String(value) : "");
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const initial = React.useRef(value ? String(value) : "");

  if (readOnly) {
    return (
      <span className="inline-flex items-center gap-1.5 tabular-nums text-muted-foreground">
        <Lock className="h-3 w-3" /> {value ? formatCurrency(value) : "—"}
      </span>
    );
  }

  const save = () => {
    if (busy || text.trim() === initial.current.trim()) return;
    setBusy(true);
    onError(null);
    const fd = new FormData();
    fd.set("departmentId", departmentId);
    fd.set("kind", kind);
    fd.set("year", String(year));
    fd.set("amount", text);
    void (async () => {
      try {
        const r = await setDepartmentBudget(fd);
        if (!r.ok) {
          onError(r.error ?? "Enregistrement impossible.");
          setText(initial.current); // on ne laisse pas à l'écran un montant qui n'a pas été retenu
          return;
        }
        initial.current = text;
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        rafraichir();
      } catch {
        onError(actionFailureMessage("THROWN"));
        setText(initial.current); // rien n'est sûr d'avoir été retenu : on rend la valeur connue
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
        inputMode="decimal"
        placeholder="0"
        className="h-8 w-32 text-right tabular-nums"
        aria-label={`${DEPT_BUDGET_LABEL[kind]} ${year}`}
      />
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : saved ? <Check className="h-3.5 w-3.5 text-success" /> : <span className="w-3.5" />}
    </span>
  );
}

/**
 * Le CONSOMMÉ sous l'alloué. Sans budget réglé, on affiche la dépense seule plutôt qu'un
 * pourcentage : « 0 % » sur un budget inexistant ferait passer une absence de décision pour
 * une bonne nouvelle.
 */
function Consumption({ allocated, consumed }: { allocated: number; consumed: number }) {
  const health = budgetHealth(allocated, consumed);
  if (health === "UNSET") {
    return <span className="text-[0.6875rem] tabular-nums text-muted-foreground">{consumed ? formatCurrency(consumed) : "—"}</span>;
  }
  const tone = health === "OVER_BUDGET" ? "danger" : health === "AT_RISK" ? "warning" : "success";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[0.6875rem] tabular-nums text-muted-foreground">{formatCurrency(consumed)}</span>
      <Badge tone={tone} dot={false}>{consumedPercent(allocated, consumed)} %</Badge>
    </span>
  );
}

/**
 * DEMANDER UNE DOTATION OU UNE RALLONGE — le geste par lequel un budget augmente.
 * Une dotation initiale est une rallonge partant de zéro : un seul formulaire, un seul circuit.
 */
function RequestForm({ departmentId, path, year, onDone, onError }: {
  departmentId: string; path: string; year: number; onDone: () => void; onError: (e: string | null) => void;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("departmentId", departmentId);
        fd.set("year", String(year));
        setBusy(true); onError(null);
        void requestDepartmentBudget(fd).then((r) => {
          setBusy(false);
          if (r.ok) { onDone(); rafraichir(); } else onError(r.error ?? "La demande de dotation n'a pas été envoyée.");
        }).catch(() => { setBusy(false); onError(actionFailureMessage("THROWN")); });
      }}
      className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
    >
      <p className="text-sm font-medium">Demander une dotation — {path}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs">
          Budget concerné
          <select name="kind" defaultValue="OPERATING" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base sm:text-sm">
            {DEPT_BUDGET_KINDS.map((k) => <option key={k} value={k}>{DEPT_BUDGET_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">
          Montant demandé (DZD)
          <Input name="amount" inputMode="decimal" placeholder="0" className="mt-1 h-9 text-right tabular-nums" required />
        </label>
        <label className="text-xs sm:col-span-1">
          Exercice
          <Input value={year} readOnly className="mt-1 h-9 text-right tabular-nums" />
        </label>
      </div>
      <label className="block text-xs">
        Motif
        <Input name="reason" placeholder="Ex. renouvellement du parc de fournitures, prestation imprévue…" className="mt-1 h-9" />
      </label>
      <p className="text-[0.6875rem] text-muted-foreground">
        Le montant s&apos;<strong>ajoute</strong> au budget en cours une fois accordé. L&apos;administration est prévenue.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Envoyer la demande
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onDone}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * IMPUTER UNE DÉPENSE — la pièce justificative est OBLIGATOIRE. Une ligne de dépense sans
 * facture ni bon de paiement n'est qu'une affirmation ; c'est exactement ce qu'un budget doit
 * cesser d'accepter.
 */
function ExpenseForm({ departmentId, path, year, onDone, onError }: {
  departmentId: string; path: string; year: number; onDone: () => void; onError: (e: string | null) => void;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("departmentId", departmentId);
        fd.set("year", String(year));
        setBusy(true); onError(null);
        void addDepartmentExpense(fd).then((r) => {
          setBusy(false);
          if (r.ok) { onDone(); rafraichir(); } else onError(r.error ?? "La dépense n'a pas été imputée.");
        }).catch(() => { setBusy(false); onError(actionFailureMessage("THROWN")); });
      }}
      className="space-y-2 rounded-xl border border-border bg-secondary/30 p-3"
    >
      <p className="text-sm font-medium">Imputer une dépense — {path}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs">
          Budget imputé
          <select name="kind" defaultValue="OPERATING" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base sm:text-sm">
            {DEPT_BUDGET_KINDS.filter((k) => k !== "HR").map((k) => <option key={k} value={k}>{DEPT_BUDGET_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          Objet de la dépense
          <Input name="label" placeholder="Ex. ramettes A4 et toner — fournisseur Papeterie Centrale" className="mt-1 h-9" required />
        </label>
        <label className="text-xs">
          Montant (DZD)
          <Input name="amount" inputMode="decimal" placeholder="0" className="mt-1 h-9 text-right tabular-nums" required />
        </label>
        <label className="text-xs sm:col-span-2">
          Précisions
          <Input name="notes" placeholder="Facultatif" className="mt-1 h-9" />
        </label>
      </div>
      <label className="block text-xs">
        Facture / bon de paiement <span className="text-destructive">*</span>
        <input type="file" name="files" multiple required className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />} Imputer la dépense
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onDone}>Annuler</Button>
      </div>
    </form>
  );
}

/** La file des dotations à trancher — visible de l'administration, et d'elle seule. */
function RequestList({ requests, canDecide, onError }: {
  requests: DeptBudgetRequestRow[]; canDecide: boolean; onError: (e: string | null) => void;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [busy, setBusy] = React.useState<string | null>(null);

  const decide = (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusy(id); onError(null);
    const fd = new FormData();
    fd.set("id", id); fd.set("decision", decision);
    void decideDepartmentBudgetRequest(fd).then((r) => {
      setBusy(null);
      if (r.ok) rafraichir(); else onError(r.error ?? "La décision n'a pas été enregistrée.");
    }).catch(() => { setBusy(null); onError(actionFailureMessage("THROWN")); });
  };

  // RETIRER SA DEMANDE (décision du 04/10) — tant que l'administration ne l'a pas tranchée.
  const retirer = async (id: string) => {
    if (!(await confirmer("Retirer cette demande de dotation ? L'administration en sera prévenue."))) return;
    setBusy(id); onError(null);
    const fd = new FormData();
    fd.set("id", id);
    void annulerDemandeBudgetDepartement(fd).then((r) => {
      setBusy(null);
      if (r.ok) rafraichir(); else onError(r.error ?? "La demande n'a pas été retirée.");
    }).catch(() => { setBusy(null); onError(actionFailureMessage("THROWN")); });
  };

  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {requests.map((q) => (
        <li key={q.id} id={ancreDemandeBudget(q.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 basis-[12rem]">
            <span className="font-medium">{q.departmentName}</span>
            <span className="ml-2 text-xs text-muted-foreground">{DEPT_BUDGET_LABEL[q.kind]} · {q.year}</span>
            {q.reason && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{q.reason}</span>}
          </span>
          <span className="whitespace-nowrap tabular-nums font-semibold">+{formatCurrency(q.amount)}</span>
          <span className="text-xs text-muted-foreground">{q.requester || "—"}</span>
          {q.status === "PENDING" ? (
            canDecide ? (
              <span className="flex items-center gap-1.5">
                <button type="button" disabled={busy === q.id} onClick={() => decide(q.id, "APPROVED")}
                  className="inline-flex min-h-10 items-center gap-1 rounded-md border border-success/30 px-3 py-1 text-sm font-medium text-success hover:bg-success/10 disabled:opacity-50 sm:min-h-0 sm:px-2 sm:text-xs">
                  {busy === q.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsUp className="h-3.5 w-3.5" />} Accorder
                </button>
                <button type="button" disabled={busy === q.id} onClick={() => decide(q.id, "REJECTED")}
                  className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2 sm:text-xs">
                  <ThumbsDown className="h-3.5 w-3.5" /> Refuser
                </button>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone="warning" dot={false}>En attente de l&apos;administration</Badge>
                {q.canCancel && (
                  <button type="button" disabled={busy === q.id} onClick={() => void retirer(q.id)}
                    className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0">
                    Retirer
                  </button>
                )}
              </span>
            )
          ) : (
            <Badge tone={q.status === "APPROVED" ? "success" : q.status === "CANCELLED" ? "neutral" : "danger"} dot={false}>
              {q.status === "APPROVED" ? "Accordée" : q.status === "CANCELLED" ? "Retirée" : "Refusée"}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
