import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ADMIN_TABS } from "@/lib/labels";
import { etatDesConnecteurs } from "@/platform/in-process/chantiers/sondes";
import type { EtatConnecteur } from "@/platform/dev/ports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Développement — connecteurs · Administration" };

/**
 * ADMINISTRATION › DÉVELOPPEMENT (lot C2, décision 0043) — Super Admin SEUL.
 *
 * L'état des connecteurs des chantiers : configuré ? joignable ? quotas restants ? Chaque chargement SONDE, en lecture
 * seule (GitHub `GET /user` + dépôts listés, Render `GET /services`, MiMo `GET /models`) ; les routines n'ont pas de
 * sonde sans effet (un appel lance une session) : configurée ou non. Aucune valeur secrète : des NOMS de variables.
 */

const TITRES: Record<EtatConnecteur["connecteur"], string> = {
  "claude-code": "Claude Code Cloud (Routines API)",
  relais: "Claude Code — relais CLI (machine de la Direction)",
  github: "GitHub",
  render: "Render",
  mimo: "MiMo",
};

function Etat({ e }: { e: EtatConnecteur }) {
  if (!e.configure) return <Badge tone="neutral">non configuré</Badge>;
  if (e.joignable === null) return <Badge tone="info">configuré</Badge>;
  return e.joignable ? <Badge tone="success">joignable</Badge> : <Badge tone="danger">injoignable</Badge>;
}

export default async function DeveloppementPage() {
  const user = await requireModule("ADMIN", "UPDATE");
  const reserve = user.role !== "SUPER_ADMIN";
  const etats = reserve ? [] : await etatDesConnecteurs();
  return (
    <div className="space-y-5">
      <ModuleTabs tabs={ADMIN_TABS.map((onglet) => ({ label: onglet.label, href: onglet.href, show: userCan(user, onglet.module, "VIEW") }))} />
      {reserve ? <p className="text-sm text-muted-foreground">Les connecteurs de développement sont réservés au Super Admin.</p> : <Connecteurs etats={etats} />}
    </div>
  );
}

function Connecteurs({ etats }: { etats: EtatConnecteur[] }) {
  return (
    <>
      <PageHeader
        title="Développement — connecteurs"
        description="Claude Code (Routines et relais CLI), GitHub, Render et MiMo : ce que les chantiers peuvent utiliser. Sondes en lecture seule, à chaque chargement de la page."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {etats.map((e) => (
          <Card key={e.connecteur}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">{TITRES[e.connecteur]}</CardTitle>
              <Etat e={e} />
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {e.erreur && <p className="text-destructive">{e.erreur}</p>}
              {e.details.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {e.details.map((d) => <li key={d}>{d}</li>)}
                </ul>
              )}
              {e.quotas.length > 0 && (
                <div className="space-y-1">
                  {e.quotas.map((q) => (
                    <div key={q.libelle} className="flex justify-between gap-2">
                      <span>{q.libelle}</span>
                      <span className="tabular-nums">{q.restant ?? "?"} / {q.limite ?? "?"}{q.reinitialiseA ? ` (réinit. ${new Date(q.reinitialiseA).toLocaleTimeString("fr-FR")})` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {e.variables.map((v) => <Badge key={v.nom} tone={v.posee ? "success" : "warning"}>{v.nom}</Badge>)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Les variables se posent sur Render (service de l&apos;ERP). Webhooks : GitHub → <code>/api/chantiers/webhooks/github</code> (secret
        GITHUB_WEBHOOK_SECRET, événements push, pull_request, check_suite, check_run, workflow_run, issue_comment) ; Render →
        <code> /api/chantiers/webhooks/render</code> (signing secret dans RENDER_WEBHOOK_SECRET). Décision 0043.
      </p>
    </>
  );
}
