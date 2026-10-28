"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import {
  Loader2, Check, Plus, HandCoins, AlertTriangle, Lock,
  CalendarClock, ThumbsUp, ThumbsDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { InfoBulle } from "@/components/ui/info-bulle";
import { EntreeMenu, MenuPlus } from "@/app/(app)/medical/menu-plus";
import { partDepensee } from "@/lib/general-means/ecran";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PETTY_CASH_STATUS_LABEL, periodLabel, MAX_RECHARGE_DAY } from "@/lib/petty-cash";
import { cashWarning } from "@/lib/general-means/continuous-cash";
import { ETAT_REMISE_LABEL, remiseEnAttente } from "@/lib/general-means/remise-centre";
import {
  allotPettyCash, confirmPettyCashReceipt, requestPettyCashTopUp, closePettyCash,
  decidePettyCashTopUp, setPettyCashPlan, annulerRallongeCaisse,
} from "@/lib/actions/petty-cash-actions";
import type { GeneralMeansView, GeneralMeansRemittance } from "@/lib/queries/general-means";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { ancreRemise, ancreRallonge } from "@/lib/chemins/moyens-generaux";

/**
 * LA CAISSE D'AVANCE, À L'ÉCRAN — une seule, continue.
 *
 * Une seule question guide la mise en page : **me reste-t-il de quoi payer ?** Le solde est donc
 * en haut, en gros, avant l'historique ; la rallonge se demande depuis le même endroit — c'est
 * au moment où l'on constate qu'il ne reste rien qu'on la demande.
 *
 * ── CE QUI A DISPARU D'ICI, ET POURQUOI ─────────────────────────────────────────────────────
 *
 * Un bloc « Dépenses de la caisse » listait les achats payés en liquide. Ils figuraient DÉJÀ
 * dans « Toutes les dépenses » juste en dessous, avec leur badge « caisse d'avance » : la même
 * dépense s'affichait deux fois, à deux endroits, avec deux compteurs — et l'on ne savait plus
 * laquelle lire ni laquelle corriger. Il n'y a plus qu'une liste, et elle se filtre.
 *
 * Le titre ne porte plus de mois non plus. La caisse ne se ferme pas au 1er : chaque remise
 * garde sa date, et l'historique les montre l'une après l'autre.
 */
export function CashPanel({ view, people }: { view: GeneralMeansView; people: { id: string; name: string }[] }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [pane, setPane] = React.useState<"none" | "topup" | "allot" | "plan" | "solder">("none");
  const [grant, setGrant] = React.useState<Record<string, string>>({});

  // LA PHRASE DE L'ACTION D'ABORD, quand elle en a une : celle de la remise porte la RÉFÉRENCE de
  // l'ordre parti au centre de paiement (§118.176) — c'est ce qu'on suit ensuite là-bas. Le texte
  // local ne sert qu'aux gestes dont l'action ne dit rien de plus qu'un succès.
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => {
    setBusy(key); setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText) : (r.error ?? "L'opération sur la caisse n'a pas été enregistrée.") });
      if (r.ok) { setPane("none"); rafraichir(); }
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(null);
    }
  };

  const cash = view.cash;
  const fund = cash?.fund ?? null;
  const warning = cashWarning(fund, formatCurrency);
  /**
   * La remise qui attend une confirmation de réception, quand c'est à moi de la donner — et
   * seulement une fois VERSÉE (§118.176) : on ne confirme pas avoir reçu ce qui attend le centre.
   */
  const aConfirmer = view.isHolder ? cash?.remittances.filter((r) => r.status === "ALLOTTED" && r.centre === "VERSEE") ?? [] : [];
  /** Les remises demandées au centre, pas encore versées — montrées à part, hors du fond. */
  const enAttente = cash?.remittances.filter((r) => remiseEnAttente(r.centre)) ?? [];

  return (
    <div className="space-y-3">
      {cash && fund ? (
        <>
          {/* UNE BARRE, UN RESTE : dépensé sur remis. Le détail (reçu, à confirmer, remises) est dans l'historique. */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={fund.received > 0 ? "success" : "warning"} dot={false}>
                  {fund.received > 0 ? "Ouverte" : fund.remittanceCount === 0 && enAttente.length > 0 ? "En attente du centre de paiement" : "En attente de réception"}
                </Badge>
                <span className="text-muted-foreground">
                  Dépensé <span className="tabular-nums text-foreground">{formatCurrency(fund.spent)}</span> sur <span className="tabular-nums text-foreground">{formatCurrency(fund.remitted)}</span>
                </span>
              </span>
              <strong className={`tabular-nums ${fund.overspent ? "text-destructive" : fund.lowOnCash ? "text-warning" : "text-success"}`}>
                reste {formatCurrency(fund.remaining)}
              </strong>
            </div>
            <Progress value={partDepensee(fund.spent, fund.remitted)} tone={fund.overspent ? "danger" : fund.lowOnCash ? "warning" : "primary"} className="h-2.5" />
            {cash.holder && <p className="text-xs text-muted-foreground">Détenue par {cash.holder}</p>}
          </div>

          {view.plan?.isActive && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              Rechargement : <strong className="text-foreground">{formatCurrency(view.plan.monthlyAmount)}</strong>
              le {view.plan.rechargeDay} du mois
              {view.plan.nextRechargeAt && <> — prochain le <strong className="text-foreground">{formatDate(view.plan.nextRechargeAt)}</strong></>}
              <InfoBulle label="À propos du rechargement mensuel" align="left">
                Rechargement mensuel réglé par les RH. Ils en sont prévenus 48 h avant chaque échéance.
              </InfoBulle>
            </p>
          )}

          {/* CE QUE LE FOND A À DIRE — dépassement, épuisement, ou réception en attente. Un seul
              message à la fois : trois bandeaux empilés ne se lisent plus. */}
          {warning && (
            <p className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
              fund.overspent ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-warning/40 bg-warning/5 text-muted-foreground"
            }`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{warning}</span>
            </p>
          )}

          {/* LES REMISES DEMANDÉES AU CENTRE DE PAIEMENT (§118.176) — elles ne sont pas encore dans
              le fond : le centre doit les autoriser, puis les Finances les verser. La détentrice
              confirmera leur réception à ce moment-là, et pas avant. */}
          {enAttente.map((r) => (
            <div key={r.id} id={ancreRemise(r.id)} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-sm">
              <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <strong>{formatCurrency(r.amount)}</strong> demandés le {formatDate(r.remittedAt)}
                {r.holder ? ` pour ${r.holder}` : ""} — {ETAT_REMISE_LABEL[r.centre].label.toLowerCase()}.
                Ils s&apos;ajouteront au fond dès que le centre les autorise.
              </span>
              <Badge tone="warning" dot={false}>{ETAT_REMISE_LABEL[r.centre].label}</Badge>
            </div>
          ))}

          {/* CONFIRMER LA RÉCEPTION, REMISE PAR REMISE. Une somme décidée n'est pas une somme
              détenue : tant que la personne n'a pas dit l'avoir reçue, elle n'est pas dépensable. */}
          {aConfirmer.map((r) => (
            <div key={r.id} id={ancreRemise(r.id)} className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                <strong>{formatCurrency(r.amount)}</strong> ont été versés pour votre caisse (remise du {formatDate(r.remittedAt)}) —
                cette somme n&apos;est pas dépensable tant que vous n&apos;avez pas confirmé l&apos;avoir reçue.
              </span>
              <BoutonDecisif size="sm" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy === `recv:${r.id}`} onClick={() => {
                const fd = new FormData(); fd.set("id", r.id);
                void run(`recv:${r.id}`, () => confirmPettyCashReceipt(fd), "Réception confirmée.");
              }}>
                {busy === `recv:${r.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} J&apos;ai reçu la somme
              </BoutonDecisif>
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            {/* UN SEUL BOUTON DE DÉPENSE, et il est plus bas, avec la liste des dépenses. Le
                second bouton vivait ici, sur la caisse — même achat, même facture, même budget
                consommé, mais deux formulaires : on saisissait par le mauvais, et le fond se
                retrouvait faux sans qu'aucun écran ne le dise. Le moyen de paiement est devenu
                une case du formulaire unique. */}
            {view.isHolder && fund.received > 0 && (
              <Button size="sm" variant="outline" onClick={() => setPane(pane === "topup" ? "none" : "topup")}>
                <HandCoins className="h-4 w-4" /> Demander une rallonge
              </Button>
            )}
            {view.canAllot && (
              <Button size="sm" variant="outline" onClick={() => setPane(pane === "allot" ? "none" : "allot")}>
                <Plus className="h-4 w-4" /> Remettre une somme
              </Button>
            )}
            {/* « Réglage mensuel » et « Solder la caisse » : rares, donc derrière ⋯ (Direction, 09/10). */}
            {(view.canAllot || ((view.isHolder || view.canAllot) && cash.currentId)) && (
              <MenuPlus label="Autres gestes de la caisse">
                {view.canAllot && (
                  <EntreeMenu onClick={() => setPane("plan")}><CalendarClock className="h-4 w-4 text-muted-foreground" /> Réglage mensuel</EntreeMenu>
                )}
                {(view.isHolder || view.canAllot) && cash.currentId && (
                  <EntreeMenu onClick={() => setPane("solder")}><Lock className="h-4 w-4 text-muted-foreground" /> Solder la caisse</EntreeMenu>
                )}
              </MenuPlus>
            )}
          </div>

          {/* SOLDER : la confirmation vit ICI, hors du menu — un menu qui se referme au clic démonterait le bouton décisif. */}
          {pane === "solder" && (view.isHolder || view.canAllot) && cash.currentId && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-sm">
              <span className="min-w-0 flex-1">
                Solder arrête {fund.remittanceCount} remise{fund.remittanceCount > 1 ? "s" : ""} ; reliquat <strong className="tabular-nums">{formatCurrency(fund.remaining)}</strong>.
              </span>
              <BoutonDecisif size="sm" variant="outline" disabled={busy === "close"}
                confirmation={`solder la caisse (${fund.remittanceCount} remise(s) arrêtée(s), reliquat ${formatCurrency(fund.remaining)})`}
                onClick={() => {
                const fd = new FormData(); fd.set("id", cash.currentId ?? "");
                void run("close", () => closePettyCash(fd), "Caisse soldée.");
              }}>
                {busy === "close" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Solder la caisse
              </BoutonDecisif>
              <Button size="sm" type="button" variant="outline" onClick={() => setPane("none")}>Annuler</Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          icon="Wallet"
          title="Aucune somme en caisse"
          description={view.canAllot
            ? "Remettez une somme à la personne qui achète au quotidien."
            : "L'administration n'a pas encore remis de somme pour ce département."}
        />
      )}

      {view.canAllot && (pane === "allot" || !cash) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("departmentId", view.department.id);
            void run("allot", () => allotPettyCash(fd), "Remise envoyée au centre de paiement — elle s'ajoutera au fond dès qu'il l'autorise.");
          }}
          className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"
        >
          <p className="flex items-center gap-1 text-sm font-medium">
            Remettre une somme en caisse
            <InfoBulle label="À propos de la remise" align="left">
              La remise part d&apos;abord au centre de paiement : dès qu&apos;il l&apos;autorise, elle s&apos;ajoute au fond en cours
              et garde sa date — rien n&apos;est clos, et il n&apos;y a pas de réception à confirmer.
            </InfoBulle>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs">
              Montant remis (DZD)
              <Input name="amount" inputMode="decimal" placeholder="0" required className="mt-1 h-9 text-right tabular-nums" />
            </label>
            <label className="text-xs">
              Remis à
              <select name="holderId" defaultValue={cash?.holderId ?? ""} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:text-sm">
                <option value="">— Personne actuelle —</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="text-xs">
              Précision
              <Input name="note" placeholder="Facultatif" className="mt-1 h-9" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy === "allot"}>
              {busy === "allot" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Envoyer au centre de paiement
            </Button>
            {cash && <Button size="sm" type="button" variant="outline" onClick={() => setPane("none")}>Annuler</Button>}
          </div>
        </form>
      )}

      {cash && pane === "topup" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("cashId", cash.currentId ?? "");
            void run("topup", () => requestPettyCashTopUp(fd), "Rallonge demandée — l'administration est prévenue.");
          }}
          className="space-y-2 rounded-xl border border-border bg-secondary/30 p-3"
        >
          <p className="text-sm font-medium">Demander une rallonge</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs">
              Montant demandé (DZD)
              <Input name="amount" inputMode="decimal" required placeholder="0" className="mt-1 h-9 text-right tabular-nums" />
            </label>
            <label className="text-xs sm:col-span-2">
              Motif
              <Input name="reason" placeholder="Ex. achats de fin de mois, fournitures épuisées…" className="mt-1 h-9" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy === "topup"}>
              {busy === "topup" ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />} Envoyer la demande
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setPane("none")}>Annuler</Button>
          </div>
        </form>
      )}

      {/* RÉGLAGE MENSUEL — posé par les RH. La caisse ne se ferme plus au changement de mois,
          mais le RECHARGEMENT, lui, reste une échéance d'agenda : sans lui, la remise dépend d'un
          geste dont personne ne se souvient à date fixe, et l'on ne peut prévenir de rien. */}
      {view.canAllot && pane === "plan" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("departmentId", view.department.id);
            void run("plan", () => setPettyCashPlan(fd), "Réglage mensuel enregistré.");
          }}
          className="space-y-2 rounded-xl border border-border bg-secondary/30 p-3"
        >
          <p className="text-sm font-medium">Réglage mensuel de la caisse</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs">
              Somme remise chaque mois (DZD)
              <Input name="monthlyAmount" inputMode="decimal" required defaultValue={view.plan?.monthlyAmount || ""} className="mt-1 h-9 text-right tabular-nums" />
            </label>
            <label className="text-xs">
              Jour du rechargement
              <Input name="rechargeDay" type="number" inputMode="numeric" min={1} max={MAX_RECHARGE_DAY} defaultValue={view.plan?.rechargeDay ?? 1} className="mt-1 h-9 text-right tabular-nums" />
              <span className="text-[0.6875rem] text-muted-foreground">1 à {MAX_RECHARGE_DAY} — le 31 n&apos;existe pas tous les mois.</span>
            </label>
            <label className="text-xs">
              Remis à
              <select name="holderId" defaultValue={view.plan?.holderId ?? cash?.holderId ?? ""} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:text-sm">
                <option value="">— Choisir la personne —</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs">
            {/* LE TÉMOIN CACHÉ, AVANT la case : décochée, c'est lui qui suspend le plan (§118.172). */}
            <input type="hidden" name="isActive" value="0" />
            <input type="checkbox" name="isActive" value="1" defaultChecked={view.plan?.isActive ?? true} className="h-4 w-4 rounded border-input" />
            Rechargement actif (les RH sont prévenues 48 h avant chaque échéance)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy === "plan"}>
              {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />} Enregistrer
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setPane("none")}>Annuler</Button>
          </div>
        </form>
      )}

      {/* LES RALLONGES — accordées AU MONTANT QUE LES RH ÉCRIVENT, refusées, ou en attente. */}
      {view.topUps.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Rallonges demandées ({view.topUps.filter((t) => t.status === "PENDING").length} en attente)
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {view.topUps.map((t) => (
              <li key={t.id} id={ancreRallonge(t.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium tabular-nums">+{formatCurrency(t.amountRequested)} demandés</span>
                  {t.reason && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{t.reason}</span>}
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {t.requester || "—"} · {formatDate(t.createdAt)}
                    {t.decisionNote ? ` · ${t.decisionNote}` : ""}
                  </span>
                </span>
                {t.status === "PENDING" ? (
                  view.canAllot ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Input
                        value={grant[t.id] ?? String(t.amountRequested)}
                        onChange={(e) => setGrant((p) => ({ ...p, [t.id]: e.target.value }))}
                        inputMode="decimal" aria-label="Montant accordé"
                        className="h-10 w-28 text-right tabular-nums sm:h-8"
                      />
                      <BoutonDecisif brut type="button" disabled={busy === `top:${t.id}`} onClick={() => {
                        const fd = new FormData();
                        fd.set("id", t.id); fd.set("decision", "APPROVED");
                        fd.set("amountGranted", grant[t.id] ?? String(t.amountRequested));
                        void run(`top:${t.id}`, () => decidePettyCashTopUp(fd), "Rallonge accordée.");
                      }} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-success/30 px-3 py-1 text-sm font-medium text-success hover:bg-success/10 disabled:opacity-50 sm:min-h-0 sm:px-2 sm:text-xs">
                        {busy === `top:${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsUp className="h-3.5 w-3.5" />} Accorder
                      </BoutonDecisif>
                      <BoutonDecisif brut type="button" disabled={busy === `top:${t.id}`} onClick={() => {
                        const fd = new FormData();
                        fd.set("id", t.id); fd.set("decision", "REJECTED");
                        void run(`top:${t.id}`, () => decidePettyCashTopUp(fd), "Rallonge refusée.");
                      }} className="inline-flex min-h-10 items-center gap-1 rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0 sm:px-2 sm:text-xs">
                        <ThumbsDown className="h-3.5 w-3.5" /> Refuser
                      </BoutonDecisif>
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="warning" dot={false}>En attente des RH</Badge>
                      {/* RETIRER SA DEMANDE (décision du 04/10) — tant qu'elle n'est pas tranchée. */}
                      {t.canCancel && (
                        <BoutonDecisif brut type="button" disabled={busy === `top:${t.id}`} onClick={() => {
                          const fd = new FormData(); fd.set("id", t.id);
                          void run(`top:${t.id}`, () => annulerRallongeCaisse(fd), "Demande de rallonge retirée.");
                        }} className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:min-h-0">
                          Retirer
                        </BoutonDecisif>
                      )}
                    </span>
                  )
                ) : (
                  <Badge tone={t.status === "APPROVED" ? "success" : t.status === "CANCELLED" ? "neutral" : "danger"} dot={false}>
                    {t.status === "APPROVED" ? `Accordée — ${formatCurrency(t.amountGranted ?? 0)}` : t.status === "CANCELLED" ? "Retirée" : "Refusée"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && (
        <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}

      {/* L'HISTORIQUE DES REMISES — ce que la période servait à raconter, en mieux : chaque
          somme avec SA date, sans faire croire qu'un mois solde le précédent. */}
      {((cash && cash.remittances.length > 0) || view.history.length > 0) && (
        <details className="group rounded-xl border border-border">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:min-h-0">
            <span>
              Historique des remises
              <span className="ml-1.5 text-xs">
                ({cash?.remittances.length ?? 0} en cours · {view.history.length} soldée{view.history.length > 1 ? "s" : ""})
              </span>
            </span>
            <span className="text-xs text-primary group-open:hidden">Afficher</span>
            <span className="hidden text-xs text-primary group-open:inline">Masquer</span>
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            {cash && cash.remittances.length > 0 && (
              <RemittanceList title={`Remises en cours (${cash.remittances.length})`} rows={cash.remittances} dejaAncrees={new Set([...enAttente, ...aConfirmer].map((r) => r.id))} />
            )}
            {view.history.length > 0 && (
              <RemittanceList title="Remises soldées" rows={view.history} muted />
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function RemittanceList({ title, rows, muted, dejaAncrees }: {
  title: string; rows: GeneralMeansRemittance[]; muted?: boolean;
  /** Les remises déjà montrées plus haut (en attente, à confirmer) portent leur ancre là-bas : un identifiant ne se pose qu'une fois. */
  dejaAncrees?: ReadonlySet<string>;
}) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {/* Une remise par ligne : au téléphone, une carte par remise plutôt qu'un tableau à tirer. */}
      <div className="sm:rounded-xl sm:border sm:border-border">
        <Table className="min-w-[34rem]">
          <TableHeader className="bg-secondary/40">
            <TableRow>
              <TableHead scope="col" className="h-8">Remise</TableHead>
              <TableHead scope="col" className="h-8">Période</TableHead>
              <TableHead scope="col" className="h-8 text-right">Remis</TableHead>
              <TableHead scope="col" className="h-8 text-right">Dépensé</TableHead>
              <TableHead scope="col" className="h-8">État</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className={muted ? "text-muted-foreground" : ""}>
            {rows.map((r) => (
              <TableRow key={r.id} id={dejaAncrees?.has(r.id) ? undefined : ancreRemise(r.id)}>
                <TableCell className="sm:py-1.5" data-sans-etiquette>
                  <div className="min-w-0">
                    <span className="font-medium sm:font-normal">{formatDate(r.remittedAt)}</span>
                    {r.holder && <span className="block text-[0.6875rem] text-muted-foreground">{r.holder}</span>}
                    {r.note && <span className="block text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{r.note}</span>}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground sm:py-1.5">{periodLabel(r.period)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums sm:py-1.5">{formatCurrency(r.amount)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums sm:py-1.5">{r.spent > 0 ? formatCurrency(r.spent) : "—"}</TableCell>
                <TableCell className="sm:py-1.5">
                  {/* L'ARGENT D'ABORD (§118.176) : une remise pas encore versée — ou refusée — dit ce
                      qu'elle attend ; « soldée » sur une remise refusée ferait croire qu'elle a eu lieu. */}
                  {r.centre !== "VERSEE" ? (
                    <Badge tone={ETAT_REMISE_LABEL[r.centre].tone} dot={false}>
                      {ETAT_REMISE_LABEL[r.centre].label}
                    </Badge>
                  ) : (
                    <Badge tone={PETTY_CASH_STATUS_LABEL[r.status].tone} dot={false}>{PETTY_CASH_STATUS_LABEL[r.status].label}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
