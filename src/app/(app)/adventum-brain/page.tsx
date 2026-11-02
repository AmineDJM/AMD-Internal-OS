import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { BRAIN_TABS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { PageHeader } from "@/components/shared/page-header";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { InfoBulle } from "@/components/ui/info-bulle";
import { getRiskThresholds } from "@/lib/adventum/risk-settings";
import { filtreDuPerimetre } from "@/lib/adventum/perimetre";
import { DETECTOR_COUNT } from "@/lib/adventum/risks";
import {
  derniereAnalyse, lireBriefing, lireDernierBriefing, lireHistorique, lireRisques, personnesActives, type BriefingLu,
} from "@/lib/adventum/brain-read";
import { RiskThresholdsForm } from "./risk-thresholds-form";
import { ADecider, RisquesTable } from "./risques";
import { BoutonRegenerer, Demander, Puce } from "./demander";

export const dynamic = "force-dynamic";
export const metadata = { title: "Adventum Brain — AMD Internal OS" };

const VUES = ["matin", "risques", "demander", "historique"] as const;
type Vue = (typeof VUES)[number];

/**
 * ADVENTUM BRAIN (refonte 07/10, maquette validée). Quatre vues : « Ce matin » (le briefing gardé + ce qui attend
 * une décision), « Risques » (des risques qui ont une vie), « Demander » (la question libre, ancrée et sourcée),
 * « Historique ». La page LIT ce que la passe horaire et le briefing de 7 h ont gardé — aucun calcul au rendu.
 * Le Super Admin voit tout ; une autre personne à qui le module est ouvert (le Directeur des opérations, 08/10) ne voit
 * que « Ce matin » (à décider) et « Risques », bornés à son périmètre (`adventum/perimetre.ts`).
 */
export default async function AdventumBrainPage(props: { searchParams?: Promise<{ vue?: string; jour?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("ADVENTUM_BRAIN");
  // HORS SUPER ADMIN (Direction, 08/10 — le Directeur des opérations) : les risques de SON périmètre seulement, et rien
  // de ce qui parle de toute la maison — ni le briefing, ni la question libre, ni l'historique, ni les seuils.
  const superAdmin = user.role === "SUPER_ADMIN";
  const vuesPermises: readonly Vue[] = superAdmin ? VUES : ["matin", "risques"];
  const vue: Vue = vuesPermises.includes((searchParams?.vue ?? "") as Vue) ? (searchParams!.vue as Vue) : "matin";
  const [risques, analyse, seuils] = await Promise.all([lireRisques(new Date(), filtreDuPerimetre(superAdmin)), derniereAnalyse(), getRiskThresholds()]);
  const ouverts = risques.filter((r) => r.status !== "RESOLU");
  const minutes = analyse ? Math.max(0, Math.round((Date.now() - analyse.getTime()) / 60_000)) : null;
  const sousTitre = `${minutes === null ? "Pas encore analysé" : `Mis à jour il y a ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`} · ${superAdmin ? `${DETECTOR_COUNT} détecteurs` : "périmètre Opérations"}`;

  const onglets: { cle: Vue; label: string; n?: number }[] = ([
    { cle: "matin", label: "Ce matin" },
    { cle: "risques", label: "Risques", n: ouverts.length },
    { cle: "demander", label: "Demander" },
    { cle: "historique", label: "Historique" },
  ] as { cle: Vue; label: string; n?: number }[]).filter((o) => vuesPermises.includes(o.cle));

  return (
    <div className="space-y-4">
      <ModuleTabs tabs={BRAIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />
      <PageHeader title="Adventum Brain" description={sousTitre}>
        <InfoBulle>
          Les risques sont recalculés chaque heure en arrière-plan
          {superAdmin ? " ; le briefing s'écrit à 7 h (heure d'Alger) et reste dans l'historique." : ". Vous voyez ceux de votre périmètre : PCH, stocks, logistique, ventes, force de vente et terrain."}
        </InfoBulle>
        {superAdmin && (
          <MenuDossier>
            <RiskThresholdsForm initial={seuils} />
          </MenuDossier>
        )}
      </PageHeader>

      <nav className="-mx-3 flex gap-1 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0" aria-label="Vues d'Adventum Brain">
        {onglets.map((o) => (
          <Link key={o.cle} href={o.cle === "matin" ? "/adventum-brain" : `/adventum-brain?vue=${o.cle}`} aria-current={vue === o.cle ? "page" : undefined}
            className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors sm:py-2", vue === o.cle ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {o.label}
            {o.n !== undefined && <span className="rounded-full bg-secondary px-1.5 text-xs tabular-nums text-muted-foreground">{o.n}</span>}
          </Link>
        ))}
      </nav>

      {vue === "matin" && <VueMatin aDecider={ouverts.filter((r) => r.status === "NOUVEAU" && (r.level === "critical" || r.level === "high"))} avecBriefing={superAdmin} />}
      {vue === "risques" && <RisquesTable risques={risques} personnes={await personnesActives()} />}
      {vue === "demander" && <Demander />}
      {vue === "historique" && <VueHistorique userId={user.id} jour={searchParams?.jour ?? null} />}
    </div>
  );
}

const jourLong = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
const heure = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

async function VueMatin({ aDecider, avecBriefing }: { aDecider: Awaited<ReturnType<typeof lireRisques>>; avecBriefing: boolean }) {
  // LE BRIEFING parle de toute la maison : hors Super Admin, « Ce matin » se réduit à ce qui attend une décision.
  const [briefing, personnes] = await Promise.all([avecBriefing ? lireDernierBriefing() : Promise.resolve(null), personnesActives()]);
  return (
    <div className={cn("grid grid-cols-1 items-start gap-4", avecBriefing && "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]")}>
      {avecBriefing && <section className="surface overflow-hidden rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{briefing ? `Briefing du ${jourLong(briefing.day)}` : "Briefing du matin"}</h2>
            {briefing && <p className="text-xs text-muted-foreground">généré à {heure(briefing.generatedAt)}{briefing.source === "regles" ? " · à partir des règles" : ""}</p>}
          </div>
          <BoutonRegenerer />
        </header>
        {briefing ? <Briefing b={briefing} /> : <p className="px-4 py-6 text-sm text-muted-foreground">Le premier briefing s&apos;écrira à 7 h — ou maintenant avec « Régénérer ».</p>}
      </section>}
      <section className="surface rounded-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">À décider</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{aDecider.length}</span>
        </header>
        <ADecider risques={aDecider} personnes={personnes} />
      </section>
    </div>
  );
}

function Briefing({ b }: { b: BriefingLu }) {
  const refs = new Map(b.refs.map((r) => [r.key, r]));
  return (
    <div className="space-y-3 px-4 py-4 text-sm leading-relaxed">
      {b.content.paragraphs.map((p, i) => (
        <p key={i}>
          {p.sentences.map((s, j) => (
            <span key={j}>
              {i === 0 && j === 0 ? <b className="font-semibold">{s.text}</b> : s.text}
              {s.refs.map((k) => { const r = refs.get(k); return r ? <Puce key={k} label={r.module} href={r.href} /> : null; })}
              {" "}
            </span>
          ))}
        </p>
      ))}
      <p className="text-muted-foreground">Depuis hier : {b.content.since.resolved} résolu{b.content.since.resolved > 1 ? "s" : ""}, {b.content.since.created} nouveau{b.content.since.created > 1 ? "x" : ""}.</p>
    </div>
  );
}

async function VueHistorique({ userId, jour }: { userId: string; jour: string | null }) {
  const [h, choisi] = await Promise.all([lireHistorique(userId), jour && /^\d{4}-\d{2}-\d{2}$/.test(jour) ? lireBriefing(jour) : Promise.resolve(null)]);
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <section className="surface overflow-hidden rounded-xl">
        <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Briefings</h2></header>
        {choisi && (
          <div className="border-b border-border bg-secondary/30">
            <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">Briefing du {jourLong(choisi.day)}</p>
            <Briefing b={choisi} />
          </div>
        )}
        <ul className="divide-y divide-border">
          {h.briefings.map((b) => (
            <li key={b.day}>
              <Link href={`/adventum-brain?vue=historique&jour=${b.day}`} className={cn("flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-secondary/40", choisi?.day === b.day && "bg-secondary/40")}>
                <span>{jourLong(b.day)}</span>
                <span className="text-xs text-muted-foreground">{b.decisions} décision{b.decisions > 1 ? "s" : ""}{b.source === "regles" ? " · règles" : ""}</span>
              </Link>
            </li>
          ))}
          {h.briefings.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">Aucun briefing gardé.</li>}
        </ul>
      </section>
      <section className="surface overflow-hidden rounded-xl">
        <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Questions</h2></header>
        <ul className="divide-y divide-border">
          {h.questions.map((q) => (
            <li key={q.id} className="space-y-1 px-4 py-3 text-sm">
              <p className="font-medium">{q.question}</p>
              <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{q.answer}</p>
              {q.sources.length > 0 && <p className="-ml-1 flex flex-wrap gap-y-1">{q.sources.map((s, i) => <Puce key={i} label={s.label} href={s.href} />)}</p>}
              {q.proposals.length > 0 && <p className="text-xs text-muted-foreground">Proposé : {q.proposals.map((p) => p.title).join(" · ")}</p>}
              <p className="text-xs text-muted-foreground">{new Date(q.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" })}</p>
            </li>
          ))}
          {h.questions.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">Aucune question posée.</li>}
        </ul>
      </section>
    </div>
  );
}
