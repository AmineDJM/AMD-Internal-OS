import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { BRAIN_TABS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { PageHeader } from "@/components/shared/page-header";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCircuitsView, getPeopleView, getPlatformView, periodeDe, PERIODES, type Periode } from "@/lib/queries/process-intelligence";
import { Circuits } from "./circuits";
import { Personnes, SelecteurPeriode } from "./personnes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Process Intelligence — AMD Internal OS" };

const VUES = ["circuits", "personnes", "plateforme"] as const;
type Vue = (typeof VUES)[number];

/**
 * PROCESS INTELLIGENCE (refonte 07/10, maquette validée). Le temps RÉELLEMENT passé à chaque étape, lu dans les
 * journaux des circuits (`lib/process/mining.ts`) — et non plus « l'âge depuis la dernière modification ». Trois
 * vues : Circuits, Personnes, Plateforme ; période 30 j / 90 j / 12 mois (`?p=`). Super Admin.
 */
export default async function ProcessIntelligencePage(props: { searchParams?: Promise<{ vue?: string; p?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PROCESS_INTELLIGENCE");
  const vue: Vue = (VUES as readonly string[]).includes(searchParams?.vue ?? "") ? (searchParams!.vue as Vue) : "circuits";
  const periode = periodeDe(searchParams?.p);
  const lien = (v: Vue) => {
    const q = new URLSearchParams();
    if (v !== "circuits") q.set("vue", v);
    if (periode.cle !== "90j") q.set("p", periode.cle);
    const s = q.toString();
    return `/process-intelligence${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <ModuleTabs tabs={BRAIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />
      <PageHeader title="Process Intelligence" description={`${periode.label} · temps réellement passé à chaque étape`}>
        <SelecteurPeriode valeur={periode.cle} options={PERIODES.map((p) => ({ cle: p.cle, label: p.label }))} />
      </PageHeader>

      <nav className="-mx-3 flex gap-1 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0" aria-label="Vues de Process Intelligence">
        {([["circuits", "Circuits"], ["personnes", "Personnes"], ["plateforme", "Plateforme"]] as const).map(([cle, label]) => (
          <Link key={cle} href={lien(cle)} aria-current={vue === cle ? "page" : undefined}
            className={cn("shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors sm:py-2", vue === cle ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {label}
          </Link>
        ))}
      </nav>

      {vue === "circuits" && <VueCircuits periode={periode.cle} />}
      {vue === "personnes" && <Personnes lignes={await getPeopleView(periode.cle)} />}
      {vue === "plateforme" && <VuePlateforme periode={periode.cle} />}
    </div>
  );
}

async function VueCircuits({ periode }: { periode: Periode }) {
  const v = await getCircuitsView(periode);
  return <Circuits circuits={v.circuits} stuckDays={v.stuckDays} />;
}

const nombre = (n: number) => n.toLocaleString("fr-FR");
const duree = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
const usd = (x: number | null) => (x === null ? "—" : `${x.toFixed(2).replace(".", ",")} $`);
const quand = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" }) : "—");

function Carte({ titre, info, children }: { titre: string; info?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="surface overflow-hidden rounded-xl">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{titre}</h2>
        {info && <InfoBulle>{info}</InfoBulle>}
      </header>
      {children}
    </section>
  );
}

async function VuePlateforme({ periode }: { periode: Periode }) {
  const v = await getPlatformView(periode);
  return (
    <div className="space-y-4">
      <Carte titre="Adoption par module" info={<>Pages vues et personnes distinctes sur la période ; la tendance compare la seconde moitié de la période à la première.</>}>
        <Table>
          <TableHeader><TableRow><TableHead className="sticky left-0 z-10 bg-muted/90">Module</TableHead><TableHead className="text-right">Pages vues</TableHead><TableHead className="text-right">Personnes</TableHead><TableHead className="text-right">Tendance</TableHead></TableRow></TableHeader>
          <TableBody>
            {v.adoption.map((a) => (
              <TableRow key={a.module || "—"}>
                <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-card">{a.label}</TableCell>
                <TableCell className="text-right tabular-nums">{nombre(a.vues)}</TableCell>
                <TableCell className="text-right tabular-nums">{a.utilisateurs}</TableCell>
                <TableCell className={cn("text-right tabular-nums", a.tendance !== null && a.tendance < -0.2 ? "text-destructive" : a.tendance !== null && a.tendance > 0.2 ? "text-success" : "text-muted-foreground")}>
                  {a.tendance === null ? "—" : `${a.tendance >= 0 ? "+" : "−"}${Math.abs(Math.round(a.tendance * 100))} %`}
                </TableCell>
              </TableRow>
            ))}
            {v.adoption.length === 0 && <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">Aucune page vue enregistrée.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Carte>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Carte titre="Tâches automatiques" info={<>Les planifications et leurs passages sur la période : échecs, durée médiane, dernière erreur.</>}>
          <Table>
            <TableHeader><TableRow><TableHead className="sticky left-0 z-10 bg-muted/90">Tâche</TableHead><TableHead className="text-right">Passages</TableHead><TableHead className="text-right">Échecs</TableHead><TableHead className="text-right">Durée</TableHead><TableHead>Dernier</TableHead></TableRow></TableHeader>
            <TableBody>
              {v.taches.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="sticky left-0 z-10 bg-card">
                    <span className="block whitespace-nowrap">{t.nom}{t.statut !== "ACTIVE" && <span className="text-muted-foreground"> · en pause</span>}</span>
                    {t.derniereErreur && <span className="block max-w-[18rem] truncate text-xs text-destructive" title={t.derniereErreur}>{t.derniereErreur}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.passages}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", t.echecs > 0 && "font-medium text-destructive")}>{t.echecs}</TableCell>
                  <TableCell className="text-right tabular-nums">{duree(t.dureeMedianeMs)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{quand(t.dernierPassage)}</TableCell>
                </TableRow>
              ))}
              {v.taches.length === 0 && <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Aucune tâche planifiée.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Carte>
        <Carte titre="Luna et IA, par fonction" info={<>Appels, erreurs, latence médiane et coût sur la période (journal des tours, sinon des appels de modèle).</>}>
          <Table>
            <TableHeader><TableRow><TableHead className="sticky left-0 z-10 bg-muted/90">Fonction</TableHead><TableHead className="text-right">Appels</TableHead><TableHead className="text-right">Erreurs</TableHead><TableHead className="text-right">Latence</TableHead><TableHead className="text-right">Coût</TableHead></TableRow></TableHeader>
            <TableBody>
              {v.ia.map((x) => (
                <TableRow key={x.feature}>
                  <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-card">{x.feature}</TableCell>
                  <TableCell className="text-right tabular-nums">{nombre(x.appels)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", x.appels > 0 && x.erreurs / x.appels > 0.1 && "font-medium text-destructive")}>{x.erreurs}</TableCell>
                  <TableCell className="text-right tabular-nums">{duree(x.latenceMedianeMs)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(x.coutUsd)}</TableCell>
                </TableRow>
              ))}
              {v.ia.length === 0 && <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Aucun appel IA sur la période.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </Carte>
      </div>
    </div>
  );
}
