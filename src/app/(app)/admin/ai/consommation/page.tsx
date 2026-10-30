import Link from "next/link";
import { Gauge } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ADMIN_TABS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";
import { type Agregat, consommationAssistantIa, lireReglagesAssistantIa, tarifPose } from "@/modules/assistant-ia/api";
import { ReglagesAssistantIaForm } from "./reglages-form";

export const metadata = { title: "Consommation IA — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * CONSOMMATION IA — l'Assistant IA (OpenAI) vu par le Super Admin (lot V3-D, audit 27/10 rapport 06) :
 * par personne, par jour, par modèle, avec les plafonds qui le bornent. Les chiffres viennent du
 * journal (`ModelCallLog`, une ligne par appel) ; le coût est ESTIMÉ quand le tarif est posé
 * (`ASSISTANT_IA_PRICE_IN` / `ASSISTANT_IA_PRICE_OUT`), « inconnu » sinon — jamais zéro.
 */
const usd = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;
const cout = (a: Agregat) => (a.appels === 0 ? "—" : a.sansTarif === a.appels ? "inconnu" : a.sansTarif > 0 ? `${usd(a.coutUsd)} + ${a.sansTarif} sans tarif` : usd(a.coutUsd));
const jetons = (a: Agregat) => formatNumber(a.entree + a.sortie);

export default async function ConsommationIaPage() {
  const user = await requireModule("ADMIN", "UPDATE");
  const tabs = <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />;
  if (user.role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-5">
        {tabs}
        <p className="text-sm text-muted-foreground">La consommation de l&apos;IA et ses plafonds sont réservés au Super Admin.</p>
      </div>
    );
  }
  const [c, reglages] = await Promise.all([consommationAssistantIa(30), lireReglagesAssistantIa()]);
  const tarifConnu = tarifPose("openai");

  return (
    <div className="space-y-5">
      {tabs}
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Gauge className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Consommation IA</h1>
          <p className="text-sm text-muted-foreground">
            L&apos;Assistant IA (MiMo) : chaque appel du modèle, par personne, par jour et par modèle — et les plafonds qui le bornent.{" "}
            <Link href="/admin/ai" className="underline">Centre de contrôle IA</Link>
          </p>
        </div>
      </div>

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
          <p className="text-xl font-semibold">{formatNumber(reglages.plafondJetonsJour)} jetons</p>
          <p className="text-xs text-muted-foreground">{tarifConnu ? "Coût estimé au tarif posé (ASSISTANT_IA_PRICE_IN / OUT / CACHED)." : "Coût estimé à la grille publique de gpt-6.1-terra (2 $ / 12 $ par million, 0,20 $ en cache) — posez ASSISTANT_IA_PRICE_IN / OUT / CACHED pour un autre tarif."}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Plafonds et décisions</CardTitle></CardHeader>
        <CardContent><ReglagesAssistantIaForm initial={reglages} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Par personne — {c.jours} jours</CardTitle></CardHeader>
        <CardContent>
          {c.parPersonne.length === 0 ? <p className="text-sm text-muted-foreground">Aucun appel de l&apos;Assistant IA sur la période.</p> : (
            <Table mobileCards>
              <TableHeader><TableRow>
                <TableHead>Personne</TableHead><TableHead>Aujourd&apos;hui</TableHead><TableHead>7 jours</TableHead>
                <TableHead>{c.jours} jours</TableHead><TableHead>Appels</TableHead><TableHead>Coût estimé</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {c.parPersonne.map((p) => (
                  <TableRow key={p.userId}>
                    <TableCell className="font-medium">{p.nom}</TableCell>
                    <TableCell>{formatNumber(p.jetonsAujourdhui)} <span className="text-xs text-muted-foreground">({Math.min(100, Math.round((100 * p.jetonsAujourdhui) / reglages.plafondJetonsJour))} %)</span></TableCell>
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
