import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { calendrierLisible, lireCandidat, tableauQualite, VALIDITE_BANC_JOURS, type Regression } from "@/modules/assistant-ia/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { ADMIN_TABS } from "@/lib/labels";
import { formatNumber } from "@/lib/utils";
import { BancAbForm, CalendrierBancForm, GesteModele } from "./qualite-form";

export const metadata = { title: "Qualité IA — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * QUALITÉ IA (J5 + J14, décision 0022) — le banc programmé de l'Assistant IA (calendrier, historique, détail par scénario,
 * régressions), le protocole A/B des modèles par rôle (changement permis seulement sur un banc vert), et les traces
 * rejouables. Super Admin seul.
 */
const ms = (v: number | null) => (v == null ? "—" : `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`);
const usd = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} $`;
const date = (d: Date | null) => (d ? d.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "short", timeStyle: "short" }) : "—");
const STATUT: Record<string, string> = { DEMANDE: "demandé", EN_COURS: "en cours", TERMINE: "terminé", ECHEC: "échoué", REFUSE: "refusé" };
const DECLENCHEUR: Record<string, string> = { PROGRAMME: "calendrier", MANUEL: "manuel", AB: "A/B" };
const COULEUR_VERDICT: Record<string, string> = { OK: "text-emerald-600", "ÉCHEC": "text-destructive", ERREUR: "text-destructive", "SANS OUTIL": "text-amber-600", "NON JOUÉ": "text-muted-foreground" };

export default async function QualiteIaPage() {
  const user = await requireModule("ADMIN", "UPDATE");
  const onglets = ADMIN_TABS.map((o) => ({ label: o.label, href: o.href, show: userCan(user, o.module, "VIEW") }));
  if (user.role !== "SUPER_ADMIN") {
    return <div className="space-y-5"><ModuleTabs tabs={onglets} /><p className="text-sm text-muted-foreground">Réservé au Super Admin : banc programmé et modèles par rôle.</p></div>;
  }
  const t = await tableauQualite();
  const abVerts = t.passages.filter((p) => p.declencheur === "AB" && p.statut === "TERMINE" && p.vert && p.finLe && Date.now() - p.finLe.getTime() < VALIDITE_BANC_JOURS * 86_400_000);

  return (
    <div className="space-y-5">
      <ModuleTabs tabs={onglets} />
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Qualité IA</h1>
          <p className="text-sm text-muted-foreground">
            Le banc de l&apos;Assistant IA rejoué sur le worker contre une base d&apos;essai — réussite, latence, jetons, coût — et les modèles par rôle.{" "}
            <Link href="/admin/ai" className="underline">Centre de contrôle IA</Link>
          </p>
        </div>
      </div>

      {!t.base.configuree && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Le banc ne tourne pas.</strong> {t.base.raison}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Banc programmé</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            En service : {calendrierLisible(t.reglage)}{t.prochain ? ` — prochain passage le ${date(t.prochain)}` : ""}. Le banc tourne sur le worker (jamais dans une page),
            contre la base d&apos;essai déclarée : les 26 scénarios Jarvis, l&apos;Atelier, les Travaux, la Bibliothèque. Une régression (réussite en baisse, latence ou coût +30 %) vous est notifiée.
          </p>
          <CalendrierBancForm initial={t.reglage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Historique des passages</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {t.passages.length === 0 ? <p className="text-sm text-muted-foreground">Aucun passage encore.</p> : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Demandé</TableHead><TableHead>Déclencheur</TableHead><TableHead>Statut</TableHead><TableHead>Réussite</TableHead>
                <TableHead>1er mot P50 / P95</TableHead><TableHead>Total P50 / P95</TableHead><TableHead>Jetons (cache)</TableHead><TableHead>Coût</TableHead><TableHead>Verdict</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {t.passages.map((p) => {
                  const c = lireCandidat(p.candidat);
                  const rs = (Array.isArray(p.regressions) ? p.regressions : []) as unknown as Regression[];
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{date(p.demandeLe)}</TableCell>
                      <TableCell>{DECLENCHEUR[p.declencheur] ?? p.declencheur}{c ? ` — ${c.role} : ${c.modelId} (${c.effort})` : ""}</TableCell>
                      <TableCell>{STATUT[p.statut] ?? p.statut}{p.raison ? <span className="block max-w-xs text-xs text-muted-foreground">{p.raison}</span> : null}</TableCell>
                      <TableCell>{p.total ? `${p.reussis}/${p.total}` : "—"}{p.budgetAtteint ? <span className="block text-xs text-amber-600">plafond atteint</span> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">{ms(p.premierMotP50Ms)} / {ms(p.premierMotP95Ms)}</TableCell>
                      <TableCell className="whitespace-nowrap">{ms(p.latenceP50Ms)} / {ms(p.latenceP95Ms)}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatNumber(p.jetonsEntree + p.jetonsSortie)} ({formatNumber(p.jetonsCache)})</TableCell>
                      <TableCell>{p.statut === "TERMINE" ? usd(p.coutUsd) : "—"}</TableCell>
                      <TableCell>
                        {p.vert === true && <span className="text-emerald-600">vert</span>}
                        {p.vert === false && <span className="text-destructive">{rs.length ? "régression" : "non vert"}</span>}
                        {rs.map((r, i) => <span key={i} className="block text-xs text-muted-foreground">{r.mesure} : {r.avant} → {r.apres}{r.detail ? ` (${r.detail})` : ""}</span>)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {t.dernier && (
        <Card>
          <CardHeader><CardTitle className="text-base">Dernier passage terminé — {date(t.dernier.finLe)}, par scénario</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Scénario</TableHead><TableHead>Famille</TableHead><TableHead>Verdict</TableHead><TableHead>1er mot</TableHead><TableHead>Total</TableHead>
                <TableHead>Appels</TableHead><TableHead>Jetons entrée (cache) / sortie</TableHead><TableHead>Coût</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {t.scenarios.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.scenario}{s.motifs.length ? <span className="block max-w-md font-sans text-muted-foreground">{s.motifs.join(" ; ")}</span> : null}</TableCell>
                    <TableCell>{s.famille}</TableCell>
                    <TableCell className={COULEUR_VERDICT[s.verdict] ?? ""}>{s.verdict}</TableCell>
                    <TableCell>{ms(s.premierMotMs)}</TableCell>
                    <TableCell>{ms(s.ms)}</TableCell>
                    <TableCell>{s.appels}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatNumber(s.jetonsEntree)} ({formatNumber(s.jetonsCache)}) / {formatNumber(s.jetonsSortie)}</TableCell>
                    <TableCell>{usd(s.coutUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Modèles par rôle — protocole A/B</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Le modèle d&apos;un rôle ne change qu&apos;avec un banc A/B <strong>vert</strong> enregistré pour ce candidat exact (moins de {VALIDITE_BANC_JOURS} jours) :
            rien n&apos;a reculé face à la référence, aucune écriture sans carte. Le retour au modèle de l&apos;environnement est toujours permis.
          </p>
          <Table>
            <TableHeader><TableRow><TableHead>Rôle</TableHead><TableHead>En service</TableHead><TableHead>Source</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {(["rapide", "standard", "raisonnement"] as const).map((r) => {
                const m = t.modeles[r];
                const choix = t.choix.find((c) => c.role === r);
                return (
                  <TableRow key={r}>
                    <TableCell>{r}</TableCell>
                    <TableCell className="font-mono text-xs">{m.modelId} · effort {m.effort}</TableCell>
                    <TableCell>{m.source === "écran" ? `écran, le ${date(choix?.decideLe ?? null)} (banc ${choix?.passageId.slice(-6)})` : "environnement"}</TableCell>
                    <TableCell>{m.source === "écran" && <GesteModele geste="revenir" role={r} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {abVerts.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Candidats éprouvés (banc vert) :</p>
              {abVerts.map((p) => {
                const c = lireCandidat(p.candidat);
                return c ? (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span>{c.role} → <span className="font-mono">{c.modelId}</span> (effort {c.effort}) — {p.reussis}/{p.total} OK, {usd(p.coutUsd)}, le {date(p.finLe)}</span>
                    <GesteModele geste="appliquer" role={c.role} modelId={c.modelId} effort={c.effort} />
                  </div>
                ) : null;
              })}
            </div>
          )}
          <BancAbForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Traces rejouables et contenus piégés</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Traces {t.traces.actives ? "actives" : "COUPÉES (ASSISTANT_IA_TRACES=off)"} : {formatNumber(t.traces.nombre)} tour(s), {formatNumber(Math.round(t.traces.octets / 1024))} Ko,
            gardées {t.traces.jours} jours. Chaque tour se rejoue à l&apos;identique, sans rappeler le modèle :{" "}
            <code className="rounded bg-muted px-1">npm run assistant:rejouer -- &lt;id de la réponse&gt; --exporter trace.json</code>, puis{" "}
            <code className="rounded bg-muted px-1">--fichier trace.json</code> en local.
          </p>
          <p>
            Contenus piégés : 240 devis, mails, PDF, pages et pièces jointes (instructions cachées, RIB et destinataires substitués, français et arabe) éprouvés à chaque
            vérification du code — toute valeur d&apos;origine tierce est signalée sur la carte (« ce RIB provient du document X, à vérifier ») et aucune action ne part sans confirmation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
