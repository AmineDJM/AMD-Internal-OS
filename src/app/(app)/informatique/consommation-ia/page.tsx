import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";
import { type Agregat, consommationAssistantIa, lireReglagesAssistantIa, tarifPose } from "@/modules/assistant-ia/api";
import { vueCoutIa } from "@/modules/informatique/api";
import { CoutIaBudget } from "@/modules/informatique/ecrans/cout-ia-budget";
import { ReglagesAssistantIaForm } from "./reglages-form";

export const metadata = { title: "Consommation IA — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * CONSOMMATION IA — l'écran du pôle INFORMATIQUE (Super Admin, 24/11/2026 : « le coût de l'IA imputé au budget des
 * départements »). Rattaché ici depuis l'Administration, sans être recréé : le coût de l'IA, mois par mois, rapproché du
 * budget Informatique de chaque société (consommé / budget / reste) et imputé à sa ligne « Intelligence artificielle ».
 *
 * La clé « Consommation IA » ouvre l'écran (Super Admin et responsable du département Informatique par défaut). Ce qui suit
 * reste au SUPER ADMIN seul, comme avant : la consommation par personne et les plafonds de l'Assistant IA (lot V3-D) — le
 * journal (`ModelCallLog`) en est la source ; le coût est ESTIMÉ quand le tarif est posé, « inconnu » sinon, jamais zéro.
 */
const usd = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;
const cout = (a: Agregat) => (a.appels === 0 ? "—" : a.sansTarif === a.appels ? "inconnu" : a.sansTarif > 0 ? `${usd(a.coutUsd)} + ${a.sansTarif} sans tarif` : usd(a.coutUsd));
const jetons = (a: Agregat) => formatNumber(a.entree + a.sortie);

export default async function ConsommationIaPage() {
  const user = await requireModule("INFORMATIQUE_CONSOMMATION_IA", "VIEW");
  const vue = await vueCoutIa(user.id);
  const budget = <CoutIaBudget vue={vue} peutImputer={userCan(user, "INFORMATIQUE_CONSOMMATION_IA", "UPDATE")} />;
  // La consommation par personne et les plafonds de l'Assistant IA restent au Super Admin (lot V3-D) : le responsable
  // Informatique lit le coût par société, par fonction et par département, jamais la ligne d'une personne.
  if (user.role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-5">
        <PageHeader title="Consommation IA" />
        {budget}
      </div>
    );
  }
  const [c, reglages] = await Promise.all([consommationAssistantIa(30), lireReglagesAssistantIa()]);
  const tarifConnu = tarifPose("openai");

  return (
    <div className="space-y-5">
      <PageHeader title="Consommation IA">
        <Link href="/admin/ai#consommation" className="text-sm underline">Détail appel par appel</Link>
      </PageHeader>
      {budget}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><CardContent className="pt-5">
          <p className="text-xs text-muted-foreground">Aujourd&apos;hui (heure d&apos;Alger)</p>
          <p className="text-xl font-semibold">{jetons(c.aujourdHui)} jetons</p>
          <p className="text-xs text-muted-foreground">{formatNumber(c.aujourdHui.appels)} appel(s) · {cout(c.aujourdHui)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <p className="text-xs text-muted-foreground">{c.jours} derniers jours</p>
          <p className="text-xl font-semibold">{jetons(c.total)} jetons</p>
          <p className="text-xs text-muted-foreground">{formatNumber(c.total.appels)} appel(s) · {cout(c.total)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <p className="text-xs text-muted-foreground">Plafond par personne et par jour</p>
          <p className="text-xl font-semibold">{reglages.plafondJetonsJour > 0 ? `${formatNumber(reglages.plafondJetonsJour)} jetons` : "Sans plafond"}</p>
          <p className="text-xs text-muted-foreground">{tarifConnu ? "Coût au tarif posé (ASSISTANT_IA_PRICE_IN / OUT / CACHED)." : "Coût à la grille datée par modèle (décision 0035) — le détail au micro-dollar est dans Administration › IA."}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Plafonds et décisions</CardTitle></CardHeader>
        <CardContent><ReglagesAssistantIaForm initial={reglages} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Par personne — {c.jours} jours</CardTitle></CardHeader>
        <CardContent>
          {c.parPersonne.length === 0 ? <p className="text-sm text-muted-foreground">Aucun appel d&apos;Adam sur la période.</p> : (
            <Table mobileCards>
              <TableHeader><TableRow>
                <TableHead>Personne</TableHead><TableHead>Aujourd&apos;hui</TableHead><TableHead>7 jours</TableHead>
                <TableHead>{c.jours} jours</TableHead><TableHead>Appels</TableHead><TableHead>Coût estimé</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {c.parPersonne.map((p) => (
                  <TableRow key={p.userId}>
                    <TableCell className="font-medium">{p.nom}</TableCell>
                    <TableCell>{formatNumber(p.jetonsAujourdhui)}{reglages.plafondJetonsJour > 0 && <span className="text-xs text-muted-foreground"> ({Math.min(100, Math.round((100 * p.jetonsAujourdhui) / reglages.plafondJetonsJour))} %)</span>}</TableCell>
                    <TableCell>{formatNumber(p.jetons7j)}</TableCell>
                    <TableCell>{jetons(p)}</TableCell>
                    <TableCell>{formatNumber(p.appels)}</TableCell>
                    <TableCell>{cout(p)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Par jour</CardTitle></CardHeader>
          <CardContent>
            {c.parJour.length === 0 ? <p className="text-sm text-muted-foreground">Aucun appel sur la période.</p> : (
              <Table mobileCards>
                <TableHeader><TableRow>
                  <TableHead>Jour</TableHead><TableHead>Personnes</TableHead><TableHead>Appels</TableHead><TableHead>Jetons</TableHead><TableHead>Coût estimé</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {c.parJour.map((j) => (
                    <TableRow key={j.jour}>
                      <TableCell className="font-medium">{j.jour}</TableCell>
                      <TableCell>{formatNumber(j.personnes)}</TableCell>
                      <TableCell>{formatNumber(j.appels)}</TableCell>
                      <TableCell>{jetons(j)}</TableCell>
                      <TableCell>{cout(j)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Par modèle</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {c.parModele.length === 0 ? <p className="text-sm text-muted-foreground">Aucun appel sur la période.</p> : (
              <Table mobileCards>
                <TableHeader><TableRow>
                  <TableHead>Modèle</TableHead><TableHead>Appels</TableHead><TableHead>Entrée</TableHead><TableHead>Sortie</TableHead><TableHead>Coût estimé</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {c.parModele.map((m) => (
                    <TableRow key={`${m.provider}/${m.model}`}>
                      <TableCell className="font-medium">{m.provider}/{m.model}</TableCell>
                      <TableCell>{formatNumber(m.appels)}</TableCell>
                      <TableCell>{formatNumber(m.entree)}</TableCell>
                      <TableCell>{formatNumber(m.sortie)}</TableCell>
                      <TableCell>{cout(m)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {c.plafondsAtteints.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Plafonds du jour atteints</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {c.plafondsAtteints.map((a) => (
                    <li key={`${a.nom}-${a.jour}`}>{a.jour} — {a.nom} : {formatNumber(a.jetons)} jetons (plafond {formatNumber(a.plafond)})</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
