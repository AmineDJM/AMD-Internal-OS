"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { useAction } from "@/components/shared/use-action";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { libelleMois, type DetailImputation } from "../partage";
import { imputerCoutIa } from "../actions-cout-ia";
import type { RapprochementSociete, VueCoutIa } from "../infra/requetes";

/**
 * LE COÛT DE L'IA × LE BUDGET INFORMATIQUE — le mois en cours (coût mesuré, imputé ou à imputer), le geste d'imputation
 * (mois + taux USD → DZD), et, société par société, le rapprochement mois par mois : consommé, cumul, reste de la ligne
 * « Intelligence artificielle (consommation) ». Le détail du dernier mois imputé dit QUI consomme (fonction, département).
 */

const usd = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

function FormulaireImputation({ moisCourant, dernierTaux }: { moisCourant: string; dernierTaux: number | null }) {
  const { saving, err, run } = useAction();
  const [ok, setOk] = React.useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setOk(null);
        void run(async () => {
          const r = await imputerCoutIa(fd);
          if (r.ok) setOk(r.message ?? "Imputé.");
          return r;
        });
      }}
    >
      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">Mois</span>
        <Input type="month" name="mois" defaultValue={moisCourant} max={moisCourant} required className="w-40" />
      </label>
      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">Taux USD → DZD</span>
        <Input name="taux" inputMode="decimal" defaultValue={dernierTaux ?? ""} placeholder="ex. 135,5" required className="w-32" />
      </label>
      <BoutonDecisif disabled={saving} confirmation="Imputer le coût de l'IA de ce mois au budget Informatique">Imputer au budget</BoutonDecisif>
      <div className="basis-full">
        <Retour>{err}</Retour>
        <Retour ton="succes">{ok}</Retour>
      </div>
    </form>
  );
}

function DetailQuiConsomme({ detail }: { detail: DetailImputation }) {
  const bloc = (titre: string, lignes: DetailImputation["parFonction"]) => (
    <div className="min-w-0">
      <p className="mb-1 text-sm font-medium">{titre}</p>
      {lignes.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
        <ul className="space-y-0.5 text-sm">
          {lignes.map((l) => (
            <li key={l.cle || l.libelle} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{l.libelle}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{usd(l.coutUsd)} · {formatNumber(l.appels)} appel(s)</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {bloc("Par fonction IA", detail.parFonction)}
      {bloc("Par département demandeur", detail.parDepartement)}
    </div>
  );
}

function CarteSociete({ s, annee }: { s: RapprochementSociete; annee: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2">
          <span>{s.societe}{s.enveloppe ? ` — ${s.enveloppe.nom}` : ""}</span>
          <span className="text-sm font-normal text-muted-foreground">
            Budget IA {annee} : {s.budgetIa > 0 ? formatCurrency(s.budgetIa) : <Link href="/budgets" className="underline">à fixer dans Budgets</Link>}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!s.enveloppe ? (
          <EmptyState icon="PiggyBank" title="Budget Informatique pas encore ouvert" description="Il s'ouvre à la première imputation, montants à zéro." />
        ) : (
          <Table mobileCards>
            <TableHeader><TableRow>
              <TableHead>Mois</TableHead><TableHead className="text-right">Consommé</TableHead><TableHead className="text-right">Cumul</TableHead><TableHead className="text-right">Reste</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {s.mois.map((m) => (
                <TableRow key={m.mois}>
                  <TableCell className="font-medium">{libelleMois(m.mois)}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.consomme ? formatCurrency(m.consomme) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(m.cumul)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${m.depassement ? "text-destructive" : ""}`}>{m.reste === null ? "—" : formatCurrency(m.reste)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {s.detail && s.moisDuDetail && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">Qui consomme — {libelleMois(s.moisDuDetail)}</p>
            <DetailQuiConsomme detail={s.detail} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CoutIaBudget({ vue, peutImputer }: { vue: VueCoutIa; peutImputer: boolean }) {
  const { apercu } = vue;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>{`Budget Informatique — ${libelleMois(apercu.mois)}`}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {apercu.parSociete.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun appel d&apos;IA rattaché à vos sociétés ce mois-ci.</p>
          ) : (
            <Table mobileCards>
              <TableHeader><TableRow>
                <TableHead>Société</TableHead><TableHead className="text-right">Coût mesuré</TableHead><TableHead className="text-right">Appels</TableHead><TableHead className="text-right">Imputé</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {apercu.parSociete.map((p) => (
                  <TableRow key={p.companyId}>
                    <TableCell className="font-medium">{p.societe}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(p.coutUsd)}{p.sansTarif > 0 ? ` + ${p.sansTarif} sans tarif` : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(p.appels)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.imputeDzd === null ? "à imputer" : formatCurrency(p.imputeDzd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {apercu.nonRattache.appels > 0 && (
            <Retour ton="alerte">
              {`${usd(apercu.nonRattache.coutUsd)} (${formatNumber(apercu.nonRattache.appels)} appel(s)) ne sont rattachés à aucune société : `}
              {apercu.nonRattache.personnes > 0 ? `rattachez ${apercu.nonRattache.personnes} personne(s) à une société dans leur fiche RH` : "tâches de fond sans demandeur"}
              {apercu.nonRattache.personnes > 0 && apercu.nonRattache.sansPersonne > 0 ? " ; le reste vient de tâches de fond sans demandeur" : ""}.
            </Retour>
          )}
          {peutImputer && <FormulaireImputation moisCourant={vue.moisCourant} dernierTaux={vue.dernierTaux} />}
        </CardContent>
      </Card>
      {vue.societes.length === 0 ? (
        <EmptyState icon="Building2" title="Aucune société ne vous est ouverte" description="Demandez l'accès à votre société au Super Admin." />
      ) : vue.societes.map((s) => <CarteSociete key={s.companyId} s={s} annee={vue.annee} />)}
    </div>
  );
}
