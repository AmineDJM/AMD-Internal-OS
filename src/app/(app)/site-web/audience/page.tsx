import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { KpiCard } from "@/components/shared/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Donut } from "@/components/charts/donut";
import { seriesColor } from "@/components/charts/palette";
import { BarresPart, CourbeAudience } from "@/components/site-web/audience-graphiques";
import { visibleTabs } from "@/lib/nav-tabs";
import { SITE_WEB_TABS } from "@/lib/labels";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import { peutGererLaLiaison } from "@/lib/site-web/acces";
import { ECRAN_LIAISON } from "@/lib/site-web/ecran";
import { tableauAudience } from "@/lib/site-web/audience";
import {
  ecartPoints, formatDuree, formatTaux, libelleClic, libelleDeSeau, lirePeriode, nomDuPays, PERIODES, taux, variation,
  type Variation,
} from "@/lib/site-web/audience-calc";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audience du site — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AUDIENCE DU SITE PUBLIC (Direction, 07/10) — combien de visiteurs, d'où ils viennent, ce
 * qu'ils lisent, ce qu'ils cliquent, et combien finissent par postuler. Même droit de VUE que le
 * module ; les chiffres viennent du script que le site inclut (`/api/site-web/v1/audience.js`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function AudiencePage(props: { searchParams: Promise<{ p?: string | string[] }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("SITE_WEB");
  const periode = lirePeriode(searchParams.p);
  const [t, onglets] = await Promise.all([tableauAudience(periode), visibleTabs(user, SITE_WEB_TABS)]);
  const gere = peutGererLaLiaison(user);
  const f = (v: number) => formatNumber(v);
  const def = PERIODES.find((p) => p.cle === periode)!;
  const comparaison = periode === "12m" ? "aux 12 mois précédents" : `aux ${def.jours} jours précédents`;

  const entete = (
    <>
      <PageHeader title="Audience du site">
        {t.dernierEvenement && (
          <span className="text-xs text-muted-foreground">Dernier événement reçu le {formatDateTime(t.dernierEvenement)}</span>
        )}
      </PageHeader>
      <ModuleTabs tabs={onglets} />
    </>
  );

  if (!t.dernierEvenement) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {entete}
        <p className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          Le site n&apos;envoie pas encore son audience.{" "}
          {gere
            ? <Link href={`${ECRAN_LIAISON.href}#audience`} className="font-medium text-primary underline">Installer la mesure</Link>
            : <span className="text-muted-foreground">Un Super Admin l&apos;installe depuis {ECRAN_LIAISON.nom}.</span>}
        </p>
      </div>
    );
  }

  const c = t.courant;
  const p = t.precedent;
  const totalVisiteurs = (lignes: { visiteurs: number }[]) => lignes.reduce((s, l) => s + l.visiteurs, 0);
  const totalClics = t.clics.parType.reduce((s, l) => s + l.clics, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {entete}

      {/* ── LA PÉRIODE ─────────────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Période" className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {PERIODES.map((x) => (
            <Link
              key={x.cle}
              href={`/site-web/audience?p=${x.cle}`}
              aria-current={x.cle === periode ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                x.cle === periode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {x.libelle}
            </Link>
          ))}
        </nav>
        <span className="text-xs text-muted-foreground">Variations comparées {comparaison}</span>
        <InfoBulle label="Comment ces chiffres sont mesurés" align="left">
          Mesure sans cookie. Un visiteur = une empreinte du jour (adresse et navigateur condensés, jamais gardés) : revenu trois jours,
          il compte trois fois. Une visite = un onglet ouvert sur le site. Rebond = visite d&apos;une seule page. Conversion = candidatures
          reçues ÷ visiteurs. Les navigateurs qui demandent à ne pas être suivis ne sont pas comptés.
        </InfoBulle>
      </div>

      {/* ── LES CHIFFRES CLÉS ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Visiteurs uniques" value={f(c.visiteurs)} icon="Users" trend={tendance(variation(c.visiteurs, p.visiteurs))} />
        <KpiCard label="Pages vues" value={f(c.vues)} icon="Eye" trend={tendance(variation(c.vues, p.vues))} />
        <KpiCard label="Visites" value={f(c.visites)} icon="MousePointer2" trend={tendance(variation(c.visites, p.visites))} />
        <KpiCard
          label="Durée moyenne d'une visite" value={formatDuree(c.dureeMoyenneMs)} icon="Clock"
          trend={tendance(variation(Math.round(c.dureeMoyenneMs ?? 0), Math.round(p.dureeMoyenneMs ?? 0)))}
        />
        <KpiCard label="Taux de rebond" value={formatTaux(c.rebond)} icon="LogOut" trend={tendance(ecartPoints(c.rebond, p.rebond, false))} />
        <KpiCard label="Clics" value={f(c.clics)} icon="MousePointerClick" trend={tendance(variation(c.clics, p.clics))} />
        <KpiCard label="Candidatures reçues" value={f(c.candidatures)} icon="FileText" tone="success" trend={tendance(variation(c.candidatures, p.candidatures))} />
        <KpiCard label="Conversion visiteurs → candidatures" value={formatTaux(c.conversion)} icon="Target" trend={tendance(ecartPoints(c.conversion, p.conversion))} />
      </div>

      <Card>
        <CardHeader><CardTitle>Visiteurs et pages vues {periode === "12m" ? "par mois" : "par jour"}</CardTitle></CardHeader>
        <CardContent>
          <CourbeAudience points={t.serie.map((s) => ({ label: libelleDeSeau(s.seau), visiteurs: s.visiteurs, vues: s.vues }))} format={f} />
        </CardContent>
      </Card>

      {/* ── LES PAGES ET LES SOURCES ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader><CardTitle>Pages les plus vues</CardTitle></CardHeader>
          <CardContent className="px-0 sm:px-0">
            {t.pages.length === 0 ? <Vide /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead className="text-right">Vues</TableHead>
                    <TableHead className="text-right">Visiteurs</TableHead>
                    <TableHead className="text-right">Durée moy.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.pages.map((l) => (
                    <TableRow key={l.path}>
                      <TableCell className="max-w-[13rem] sm:max-w-[16rem]">
                        <span className="block truncate font-mono text-xs" title={l.path}>{l.path}</span>
                        {l.titre && <span className="block truncate text-xs text-muted-foreground" title={l.titre}>{l.titre}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{f(l.vues)}</TableCell>
                      <TableCell className="text-right tabular-nums">{f(l.visiteurs)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{formatDuree(l.dureeMoyenneMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader><CardTitle>Sources de trafic</CardTitle></CardHeader>
          <CardContent className="px-0 sm:px-0">
            {t.sources.length === 0 ? <Vide /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Visiteurs</TableHead>
                    <TableHead className="text-right">Vues</TableHead>
                    <TableHead className="text-right">Part</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const total = totalVisiteurs(t.sources);
                    const max = Math.max(1, ...t.sources.map((s) => s.visiteurs));
                    return t.sources.map((s) => (
                      <TableRow key={s.cle}>
                        <TableCell className="min-w-[8rem]">
                          <span className="block font-medium">{s.cle}</span>
                          <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
                            <span className="block h-full rounded-full" style={{ width: `${(s.visiteurs / max) * 100}%`, backgroundColor: seriesColor(0) }} />
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{f(s.visiteurs)}</TableCell>
                        <TableCell className="text-right tabular-nums">{f(s.vues)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatTaux(taux(s.visiteurs, total))}</TableCell>
                      </TableRow>
                    ));
                  })()}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── QUI : APPAREILS, NAVIGATEURS, SYSTÈMES, PAYS ───────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="min-w-0">
          <CardHeader><CardTitle>Appareils</CardTitle></CardHeader>
          <CardContent>
            <Donut
              slices={t.appareils.map((a, i) => ({ label: a.cle, value: a.visiteurs, color: seriesColor(i) }))}
              total={totalVisiteurs(t.appareils)}
              centerLabel="visiteurs"
              centerValue={f(totalVisiteurs(t.appareils))}
              format={f}
              size={148}
            />
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Navigateurs</CardTitle></CardHeader>
          <CardContent>
            <BarresPart lignes={t.navigateurs.map((l) => ({ label: l.cle, valeur: l.visiteurs }))} total={totalVisiteurs(t.navigateurs)} format={f} />
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Systèmes</CardTitle></CardHeader>
          <CardContent>
            <BarresPart lignes={t.systemes.map((l) => ({ label: l.cle, valeur: l.visiteurs }))} total={totalVisiteurs(t.systemes)} format={f} />
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Pays</CardTitle></CardHeader>
          <CardContent>
            <BarresPart lignes={t.pays.map((l) => ({ label: nomDuPays(l.cle), valeur: l.visiteurs }))} total={totalVisiteurs(t.pays)} format={f} />
          </CardContent>
        </Card>
      </div>

      {/* ── CE QU'ILS CLIQUENT ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader><CardTitle>Clics par type</CardTitle></CardHeader>
          <CardContent>
            <BarresPart
              lignes={t.clics.parType.map((l) => ({ label: libelleClic(l.label), valeur: l.clics, detail: `${f(l.visiteurs)} visiteur(s)` }))}
              total={totalClics} format={f} vide="Aucun clic mesuré sur la période."
            />
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Éléments les plus cliqués</CardTitle></CardHeader>
          <CardContent className="px-0 sm:px-0">
            {t.clics.elements.length === 0 ? <Vide texte="Aucun clic mesuré sur la période." /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Élément</TableHead>
                    <TableHead className="text-right">Clics</TableHead>
                    <TableHead className="text-right">Visiteurs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.clics.elements.map((l) => (
                    <TableRow key={`${l.label}|${l.cible ?? ""}`}>
                      <TableCell className="max-w-[14rem] sm:max-w-[20rem]">
                        <span className="block text-xs font-medium text-muted-foreground">{libelleClic(l.label)}</span>
                        <span className="block truncate" title={l.cible ?? undefined}>{l.cible ?? "—"}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{f(l.clics)}</TableCell>
                      <TableCell className="text-right tabular-nums">{f(l.visiteurs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── LES OFFRES D'EMPLOI : de la vue à la candidature ──────────────────────────── */}
      <Card className="min-w-0">
        <CardHeader><CardTitle>Offres d&apos;emploi</CardTitle></CardHeader>
        <CardContent className="px-0 sm:px-0">
          {t.offres.length === 0 ? <Vide texte="Aucune offre vue sur la période." /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Offre</TableHead>
                  <TableHead className="text-right">Vues</TableHead>
                  <TableHead className="text-right">Visiteurs</TableHead>
                  <TableHead className="text-right">« Postuler »</TableHead>
                  <TableHead className="text-right">Candidatures</TableHead>
                  <TableHead className="text-right">Conversion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.offres.map((o) => (
                  <TableRow key={o.cle}>
                    <TableCell className="max-w-[14rem] sm:max-w-[22rem]">
                      {o.lien
                        ? <Link href={o.lien} className="block truncate font-medium hover:underline" title={o.titre}>{o.titre}</Link>
                        : <span className="block truncate font-medium" title={o.titre}>{o.titre}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{f(o.vues)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f(o.visiteurs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f(o.postuler)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{f(o.candidatures)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTaux(o.conversion)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── LE BLOG ET LES CAMPAGNES ───────────────────────────────────────────────────── */}
      <div className={cn("grid grid-cols-1 gap-4", t.campagnes.length > 0 && "lg:grid-cols-2")}>
        <Card className="min-w-0">
          <CardHeader><CardTitle>Articles du blog</CardTitle></CardHeader>
          <CardContent className="px-0 sm:px-0">
            {t.articles.length === 0 ? <Vide texte="Aucun article lu sur la période." /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Article</TableHead>
                    <TableHead className="text-right">Vues</TableHead>
                    <TableHead className="text-right">Visiteurs</TableHead>
                    <TableHead className="text-right">Lecture moy.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.articles.map((a) => (
                    <TableRow key={a.cle}>
                      <TableCell className="max-w-[14rem] sm:max-w-[22rem]">
                        {a.lien
                          ? <Link href={a.lien} className="block truncate font-medium hover:underline" title={a.titre}>{a.titre}</Link>
                          : <span className="block truncate font-medium" title={a.titre}>{a.titre}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{f(a.vues)}</TableCell>
                      <TableCell className="text-right tabular-nums">{f(a.visiteurs)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{formatDuree(a.dureeMoyenneMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {t.campagnes.length > 0 && (
          <Card className="min-w-0">
            <CardHeader><CardTitle>Campagnes</CardTitle></CardHeader>
            <CardContent className="px-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campagne</TableHead>
                    <TableHead className="text-right">Visiteurs</TableHead>
                    <TableHead className="text-right">Vues</TableHead>
                    <TableHead className="text-right">« Postuler »</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.campagnes.map((x) => (
                    <TableRow key={x.cle}>
                      <TableCell className="max-w-[14rem] sm:max-w-[18rem]">
                        <span className="block truncate font-medium" title={x.cle}>{x.cle}</span>
                        {x.source && <span className="block truncate text-xs text-muted-foreground">{x.source}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{f(x.visiteurs)}</TableCell>
                      <TableCell className="text-right tabular-nums">{f(x.vues)}</TableCell>
                      <TableCell className="text-right tabular-nums">{f(x.postuler)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {gere && (
        <p className="text-xs text-muted-foreground">
          <Link href={`${ECRAN_LIAISON.href}#audience`} className="inline-flex items-center gap-1 hover:underline">
            Balise de mesure du site <ExternalLink className="h-3 w-3" />
          </Link>
        </p>
      )}
    </div>
  );
}

/** La variation telle que la carte l'affiche : verte si elle va dans le bon sens, rouge sinon, rien si inconnue. */
function tendance(v: Variation): { value: string; positive: boolean } | undefined {
  if (!v.texte || v.favorable === null) return undefined;
  return { value: v.texte, positive: v.favorable };
}

function Vide({ texte = "Rien sur la période." }: { texte?: string }) {
  return <p className="px-5 py-4 text-center text-sm text-muted-foreground">{texte}</p>;
}
