import Link from "next/link";
import { notFound } from "next/navigation";
import { Scale, Coins, Timer, Layers, ClipboardList, RefreshCw, ShieldCheck, XCircle, Sparkles } from "lucide-react";
import { requireModule } from "@/lib/session";
import { canSeeRegEnrollment } from "@/lib/org-chart-access";
import { getAppSettings } from "@/lib/settings";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table } from "@/components/ui/table";
import {
  REG_LEGAL_REFERENCES, REGISTRATION_FEES, OTHER_FEES, FEE_SPECIAL_CASES, REGISTRATION_PHASES,
  CTD_MODULES, CTD_RULES, MODIFICATION_CATEGORIES, MODIFICATION_RULES,
  DECISION_MENTIONS, DECISION_RULES, REFUSAL_GROUNDS, REGISTRATION_DOSSIER_PIECES,
} from "@/lib/regulatory/anpp-knowledge";
import { montantDzd } from "@/lib/utils";

export const metadata = { title: "Enregistrement (CTD) — Regulatory" };
export const dynamic = "force-dynamic";

/**
 * Onglet Regulatory « Enregistrement » — RÉFÉRENTIEL réglementaire ANPP (Algérie), intégré
 * au logiciel et masqué tant que le Super Admin ne l'a pas débloqué. L'analyseur de dossier
 * CTD (décompression ZIP + lecture/renommage + analyse IA fond/forme + préparation des
 * formulaires) arrive en phase 2 ; le cadre légal ci-dessous en est la source de vérité.
 */
export default async function EnregistrementPage() {
  const user = await requireModule("REGULATORY");
  const settings = await getAppSettings();
  if (!canSeeRegEnrollment(user, settings)) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Enregistrement — Référentiel ANPP"
        description="Cadre légal algérien de l'enregistrement des produits pharmaceutiques, intégré au logiciel. Outil d'aide au pharmacien directeur technique — la validation finale lui revient."
      />
      {/* L'ANALYSE CTD EST UN MODULE À PART, pas un onglet du suivi des dossiers. L'onglet
          « Dossiers » ramenait ici le tableau de suivi et brouillait les deux métiers : suivre
          l'avancement d'un dépôt d'un côté, analyser un CTD de l'autre. Le suivi se rejoint par
          le menu, comme n'importe quel autre module. */}
      <ModuleTabs
        tabs={[
          { label: "Référentiel ANPP", href: "/regulatory/enregistrement" },
          { label: "Analyse CTD", href: "/regulatory/enregistrement/analyse" },
        ]}
      />

      {/* Analyseur CTD — désormais opérationnel (Regulatory Intelligence OS) */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Analyseur de dossier CTD</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>Déposez un dossier CTD en <strong>ZIP</strong> dans l'onglet <Link href="/regulatory/enregistrement/analyse" className="font-medium text-primary hover:underline">Analyse CTD</Link> : le logiciel le <strong>décompresse en sécurité</strong>, <strong>lit et conserve</strong> chaque fichier (chiffré), le <strong>classe</strong> dans le bon module CTD (1 à 5), puis produira une <strong>analyse fond &amp; forme</strong> au regard de la <strong>réglementation algérienne</strong> (et des références CTD/UE), signalera les manques et <strong>préparera les formulaires</strong>.</p>
          <p>Cette page reste la <strong>base de connaissance</strong> qui pilote l'analyseur — l'assistant IA la maîtrise (posez-lui vos questions d'enregistrement). Toute conclusion IA est un <strong>projet soumis à revue humaine</strong>.</p>
        </CardContent>
      </Card>

      {/* Références légales */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Scale className="h-4 w-4 text-primary" /> Textes de référence</CardTitle></CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          {REG_LEGAL_REFERENCES.map((r) => (
            <p key={r.code + r.objet}><span className="font-medium">{r.code}</span> <span className="text-muted-foreground">({r.date})</span> — {r.objet}</p>
          ))}
        </CardContent>
      </Card>

      {/* Tarifs / bordereau de versement */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Coins className="h-4 w-4 text-primary" /> Droits d'enregistrement (bordereau de versement — E-TASDJIL)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {/* Au téléphone, chaque type de produit devient une carte : quatre montants côte à côte ne tiennent pas. */}
          <Table>
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Type de produit</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Pré-soumission (25 %)</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Dépôt (75 %)</th>
                  <th className="py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {REGISTRATION_FEES.map((f) => (
                  <tr key={f.productType} className="border-b border-border/60">
                    <td data-sans-etiquette className="py-1.5 pr-3 font-medium sm:font-normal">{f.productType}</td>
                    <td className="py-1.5 pr-3 text-right text-muted-foreground">{montantDzd(f.presubmission)}</td>
                    <td className="py-1.5 pr-3 text-right text-muted-foreground">{montantDzd(f.deposit)}</td>
                    <td className="py-1.5 text-right font-medium">{montantDzd(f.total)}</td>
                  </tr>
                ))}
              </tbody>
          </Table>
          <div className="flex flex-wrap gap-2">
            {OTHER_FEES.map((o) => (
              <span key={o.operation} className="rounded-lg border border-border bg-secondary/40 px-2.5 py-1 text-xs">{o.operation} : <span className="font-medium">{montantDzd(o.amount)}</span></span>
            ))}
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {FEE_SPECIAL_CASES.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </CardContent>
      </Card>

      {/* Parcours & délais légaux */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Timer className="h-4 w-4 text-primary" /> Parcours & délais légaux</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {REGISTRATION_PHASES.map((p) => (
            <div key={p.key} className="rounded-lg border border-border p-3">
              <p className="text-sm font-semibold">{p.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{p.summary}</p>
              {p.legalDelays.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {p.legalDelays.map((d) => <li key={d}>{d}</li>)}
                </ul>
              )}
              <p className="mt-1.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">{p.legalBasis}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Dossier CTD — 5 modules */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Dossier au format CTD (5 modules, numérotation ICH)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {CTD_MODULES.map((m) => (
            <div key={m.key} className="flex gap-3 rounded-lg border border-border p-3">
              <Badge tone="neutral" dot={false}>{m.key}</Badge>
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-sm text-muted-foreground">{m.description}</p>
              </div>
            </div>
          ))}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {CTD_RULES.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </CardContent>
      </Card>

      {/* Pièces du dossier d'enregistrement complet */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardList className="h-4 w-4 text-primary" /> Pièces du dossier d'enregistrement (arrêté 10 mai 2021, art. 4)</CardTitle></CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-1.5 text-sm md:grid-cols-2">
            {REGISTRATION_DOSSIER_PIECES.map((p) => <li key={p} className="flex gap-2"><span className="text-primary">•</span><span>{p}</span></li>)}
          </ul>
        </CardContent>
      </Card>

      {/* Modifications post-enregistrement */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-primary" /> Modifications post-enregistrement (arrêté 3 oct. 2021)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {MODIFICATION_CATEGORIES.map((m) => (
            <div key={m.key} className="rounded-lg border border-border p-3">
              <p className="text-sm font-semibold">{m.label}</p>
              <p className="text-sm text-muted-foreground">{m.def}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Délai : {m.delay}</p>
            </div>
          ))}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {MODIFICATION_RULES.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </CardContent>
      </Card>

      {/* Décision d'enregistrement */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /> Décision d'enregistrement (art. 40-49)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="mb-1 text-sm font-medium">Mentions obligatoires</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {DECISION_MENTIONS.map((m) => <li key={m}>{m}</li>)}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Règles clés</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {DECISION_RULES.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Motifs de refus */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><XCircle className="h-4 w-4 text-destructive" /> Motifs de refus (art. 38)</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {REFUSAL_GROUNDS.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
