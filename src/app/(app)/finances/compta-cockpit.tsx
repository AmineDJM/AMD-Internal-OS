import Link from "next/link";
import type { getComptaData, ComptaItem } from "@/modules/finances/api";
import { CHOIX_PERIODE, type Periode, type ResultatPeriode } from "@/modules/finances/partage";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FINANCE_CATEGORY } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";

type ComptaData = Awaited<ReturnType<typeof getComptaData>>;

/**
 * CE QUE LE DAF DOIT ENCORE ARBITRER — et rien qui vive déjà ailleurs.
 *
 * Ce bloc listait aussi les ordres « à régler » et les recettes attendues. Depuis que les
 * Finances ont deux sous-modules, la file des ordres EST « Banque & paiements » : la répéter ici
 * donnait deux listes de la même chose, qui divergeaient dès qu'on réglait depuis l'une. Restent
 * les dépenses qu'aucun autre écran ne porte — celles hors ordres, la masse salariale à
 * provisionner — et le résultat mensuel.
 */
export function ComptaCockpit({ d, resultat, periode }: { d: ComptaData; resultat: ResultatPeriode; periode: Periode }) {
  return (
    <div className="space-y-6">
      {/* « À RÉGLER » ET « RECETTES ATTENDUES » ONT ÉTÉ RETIRÉS D'ICI (2026-08).
          La file des ordres à régler EST le sous-module « Banque & paiements » : la répéter sur le
          tableau de bord donnait deux listes de la même chose, qui se désynchronisaient dès qu'on
          réglait depuis l'une. Le bandeau « échéances en retard à traiter » est retiré à son tour
          (Direction, 06/10) : les retards se lisent dans « Banque & paiements ». */}

      {/* Dépenses prévues hors ordres — la MASSE SALARIALE est séparée : elle tombe chaque mois
          et n'a pas à noyer les décaissements qu'on peut encore arbitrer. */}
      {d.depensesAutres.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Autres dépenses prévues ({d.depensesAutres.length}) · {formatCurrency(d.depensesAutresTotal)}
          </h2>
          <ItemTable items={d.depensesAutres} thirdLabel="Fournisseur" href="/finances/comptabilite" />
        </section>
      )}

      {d.depensesSalaires.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Masse salariale à venir ({d.depensesSalaires.length}) · {formatCurrency(d.depensesSalairesTotal)}
          </h2>
          <p className="text-xs text-muted-foreground">Salaires et avances — récurrents, à provisionner ; ils ne se négocient pas comme une dépense fournisseur.</p>
          <ItemTable items={d.depensesSalaires} thirdLabel="Bénéficiaire" href="/rh/paie" />
        </section>
      )}

      <ResultatMensuel resultat={resultat} periode={periode} />
    </div>
  );
}

function ItemTable({ items, thirdLabel, href }: { items: ComptaItem[]; thirdLabel: string; href: string }) {
  return (
    <div className="surface overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Référence</TableHead>
            <TableHead>Libellé</TableHead>
            <TableHead>{thirdLabel}</TableHead>
            <TableHead>Poste</TableHead>
            <TableHead>Échéance</TableHead>
            <TableHead className="text-right">Montant</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={`${it.kind}-${it.id}`}>
              <TableCell className="font-mono text-xs">
                <Link href={href} className="hover:underline">{it.reference}</Link>
              </TableCell>
              <TableCell className="font-medium [overflow-wrap:anywhere]">{it.label}</TableCell>
              <TableCell className="text-muted-foreground [overflow-wrap:anywhere]">{it.counterparty || "—"}</TableCell>
              <TableCell className="text-muted-foreground">{FINANCE_CATEGORY[it.category] ?? it.category}</TableCell>
              <TableCell>
                {it.date ? (
                  it.overdue ? (
                    <Badge tone="danger" dot={false}>{formatDate(it.date)} · en retard</Badge>
                  ) : (
                    <span className="text-muted-foreground">{formatDate(it.date)}</span>
                  )
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">{formatCurrency(it.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * LE RÉSULTAT MENSUEL, SUR LA PÉRIODE CHOISIE — 1 mois, 3 mois, 6 mois (défaut), 1 an, ou du… au…
 * (Direction, 04/10/2026). Le choix est un paramètre d'adresse lu par le serveur : des liens et un
 * formulaire GET, sans état côté navigateur. La paie compte dans son MOIS DE PAIE (voir
 * `finance/resultat-mensuel.ts`), et sa part est montrée à côté des dépenses.
 */
function ResultatMensuel({ resultat, periode }: { resultat: ResultatPeriode; periode: Periode }) {
  const lien = (valeur: string) => `/finances/comptabilite?periode=${valeur}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Résultat mensuel</CardTitle>
        <CardDescription>
          Recettes, dépenses et résultat réalisés — {periode.libelle}. La paie compte dans le mois qu&apos;elle paie, même virée le mois suivant.
        </CardDescription>
        <nav aria-label="Période du résultat" className="flex flex-wrap items-end gap-2 pt-2">
          {CHOIX_PERIODE.filter((c) => c.valeur !== "perso").map((c) => (
            <Link
              key={c.valeur} href={lien(c.valeur)}
              aria-current={periode.choix === c.valeur ? "page" : undefined}
              className={`inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-xs sm:min-h-0 ${periode.choix === c.valeur ? "border-primary bg-primary/10 font-medium text-primary" : "border-border hover:bg-muted"}`}
            >
              {c.libelle}
            </Link>
          ))}
          <form method="get" action="/finances/comptabilite" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="periode" value="perso" />
            <label className="flex flex-col gap-0.5 text-xs">
              <span className="text-muted-foreground">Du</span>
              <input type="month" name="du" defaultValue={periode.choix === "perso" ? periode.debut : ""} required className="h-10 rounded-md border border-border bg-background px-2 text-base sm:h-8 sm:text-xs" />
            </label>
            <label className="flex flex-col gap-0.5 text-xs">
              <span className="text-muted-foreground">Au</span>
              <input type="month" name="au" defaultValue={periode.choix === "perso" ? periode.fin : ""} required className="h-10 rounded-md border border-border bg-background px-2 text-base sm:h-8 sm:text-xs" />
            </label>
            <button
              type="submit"
              aria-current={periode.choix === "perso" ? "page" : undefined}
              className={`h-10 rounded-md border px-3 text-xs sm:h-8 ${periode.choix === "perso" ? "border-primary bg-primary/10 font-medium text-primary" : "border-border hover:bg-muted"}`}
            >
              Période donnée
            </button>
          </form>
        </nav>
        {periode.avertissement && <p role="status" className="text-xs text-warning">{periode.avertissement}</p>}
      </CardHeader>
      <CardContent className="p-0">
        {/* Un tableau croisé mois × mesures : il défile dans son cadre, la colonne des mois reste en place. */}
        <Table className="tabular-nums [&_td]:whitespace-nowrap">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Mois</TableHead>
              <TableHead className="text-right">Recettes</TableHead>
              <TableHead className="text-right">Dépenses</TableHead>
              <TableHead className="text-right">dont paie</TableHead>
              <TableHead className="text-right">Résultat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resultat.lignes.map((m) => (
              <TableRow key={m.mois}>
                <TableCell className="sticky left-0 z-10 bg-card font-medium">{m.libelle}</TableCell>
                <TableCell className="text-right text-success">{formatCurrency(m.recettes)}</TableCell>
                <TableCell className="text-right text-destructive">{formatCurrency(m.depenses)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{formatCurrency(m.dontPaie)}</TableCell>
                <TableCell className={`text-right font-semibold ${m.resultat >= 0 ? "text-foreground" : "text-destructive"}`}>
                  {formatCurrency(m.resultat)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 border-border font-semibold" data-total-periode>
              <TableCell className="sticky left-0 z-10 bg-card">Total — {periode.libelle}</TableCell>
              <TableCell className="text-right text-success">{formatCurrency(resultat.total.recettes)}</TableCell>
              <TableCell className="text-right text-destructive">{formatCurrency(resultat.total.depenses)}</TableCell>
              <TableCell className="text-right text-muted-foreground">{formatCurrency(resultat.total.dontPaie)}</TableCell>
              <TableCell className={`text-right ${resultat.total.resultat >= 0 ? "text-foreground" : "text-destructive"}`}>
                {formatCurrency(resultat.total.resultat)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
