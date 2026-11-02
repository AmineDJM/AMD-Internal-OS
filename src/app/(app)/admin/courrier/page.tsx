import { redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, Mail, AlertTriangle, Globe } from "lucide-react";
import { requireModule } from "@/lib/session";
import { smartMailStatus } from "@/lib/actions/smart-mail-actions";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { MailTester } from "./mail-tester";
import { BackLink } from "@/components/shared/back-link";

export const metadata = { title: "Courrier — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * COURRIER « SMART » — état de la configuration et journal des envois.
 *
 * L'envoi ne passe plus par SMTP (ports 25/465/587, filtrés à peu près partout) mais par une
 * API HTTPS sur le port 443. Cet écran dit, sans jargon, ce qui est prêt et ce qui manque.
 */
export default async function CourrierAdminPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") redirect("/admin");

  const status = await smartMailStatus();

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader
        title="Courrier — envoi sans SMTP"
        description="Les ports SMTP sont filtrés par la plupart des hébergeurs et des réseaux d'entreprise : c'est la cause des blocages. La plateforme envoie désormais par API HTTPS (port 443, celui du web) — s'il passe, le courrier passe."
      />

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">État de la configuration</h2>
            <Badge tone={status.configured ? "success" : "warning"} dot={false}>
              {status.configured ? "Prêt à envoyer" : "Configuration incomplète"}
            </Badge>
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Fournisseur</dt>
              <dd className="text-sm font-medium">{status.provider ?? "— non choisi —"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Adresse d&apos;expédition</dt>
              <dd className="text-sm font-medium [overflow-wrap:anywhere]">{status.from || "— non renseignée —"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Réception (webhook à déclarer chez le fournisseur)</dt>
              <dd className="font-mono text-sm [overflow-wrap:anywhere]">{status.webhookPath}</dd>
            </div>
          </dl>

          {status.missing.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertTriangle className="h-4 w-4" /> Ce qu&apos;il reste à faire (hors application)
              </p>
              <ol className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                <li>
                  <strong className="text-foreground">1. Ouvrir un compte</strong> chez un fournisseur d&apos;envoi
                  (Resend, Postmark ou Brevo) et récupérer sa clé d&apos;API.
                </li>
                <li>
                  <strong className="text-foreground">2. Vérifier le domaine</strong> chez ce fournisseur, en ajoutant
                  les enregistrements <strong>SPF</strong>, <strong>DKIM</strong> et <strong>DMARC</strong> dans le DNS
                  du domaine. Sans eux les messages partent, mais arrivent en indésirables.
                </li>
                <li>
                  <strong className="text-foreground">3. Renseigner les variables</strong> dans Render
                  (Settings → Environment) :
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {status.missing.map((m) => (
                      <li key={m} className="font-mono text-xs">• {m}</li>
                    ))}
                  </ul>
                </li>
                <li>
                  <strong className="text-foreground">4. Pour la réception</strong>, pointer le webhook du fournisseur
                  sur <span className="font-mono [overflow-wrap:anywhere]">{status.webhookPath}</span> avec le même secret que
                  <span className="font-mono"> MAIL_WEBHOOK_SECRET</span> — les messages non signés sont refusés.
                </li>
              </ol>
            </div>
          )}

          {status.configured && (
            <p className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/5 p-3 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              Tout est en place. Vérifiez tout de même que SPF, DKIM et DMARC sont publiés sur le domaine :
              c&apos;est ce qui décide de la boîte de réception plutôt que des indésirables.
            </p>
          )}
        </CardContent>
      </Card>

      <MailTester configured={status.configured} />

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Derniers envois</h2>
          </div>
          {status.recent.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">Aucun envoi pour le moment.</p>
          ) : (
            <ul className="divide-y divide-border">
              {status.recent.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.to}
                      {r.error ? ` · ${r.error}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge tone={r.status === "SENT" ? "success" : r.status === "FAILED" ? "danger" : "neutral"} dot={false}>
                      {r.status === "SENT" ? "Envoyé" : r.status === "FAILED" ? "Échec" : "En file"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
