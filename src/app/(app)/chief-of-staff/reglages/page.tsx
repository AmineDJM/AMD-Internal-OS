import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Settings2, Mail, Inbox, Radio } from "lucide-react";
import { requireModule } from "@/lib/session";
import { hasGlobalView, peutPiloterMissionsAdam } from "@/lib/rbac";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { adamHealth, type HealthLevel } from "@/lib/google/health";
import { SCOPE_PURPOSE } from "@/lib/google/config";
import { ReglagesForm } from "./reglages-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Réglages d'Adam — AMD Internal OS" };

/**
 * LES RÉGLAGES D'ADAM — la page de MISE EN SERVICE, réservée au PDG / Super Admin.
 *
 * Objectif : qu'aucune manipulation de base de données ne soit jamais nécessaire. On connecte
 * un compte Google en un clic, on voit si Adam entend vraiment (veille, dernier événement,
 * réconciliation), et on règle la seule chose qui engage l'entreprise vis-à-vis de l'extérieur :
 * ce qui a le droit de PARTIR.
 *
 * Ce qu'on n'affiche JAMAIS : un jeton, même tronqué. L'état d'une connexion se décrit par sa
 * santé, pas par son secret.
 */

const ERREURS: Record<string, string> = {
  droit: "Cette connexion est réservée au PDG et au Super Admin.",
  refus: "La connexion a été refusée — aucun accès n'a été accordé.",
  state: "Le lien de retour n'était plus valide. Relancez la connexion depuis cette page.",
  "non-configure": "La configuration Google est incomplète côté serveur (voir ci-dessous).",
  profil: "Google n'a pas renvoyé d'adresse exploitable pour ce compte.",
  "mauvais-compte": "Ce n'est pas le compte d'Adam. Le consentement a été révoqué immédiatement.",
  echec: "L'échange avec Google a échoué. Le détail est dans le journal serveur.",
};

const LEVEL_UI: Record<HealthLevel, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  OPERATIONAL: { tone: "success", label: "Opérationnel" },
  DEGRADED: { tone: "warning", label: "Dégradé" },
  DISCONNECTED: { tone: "neutral", label: "Non connecté" },
  MISCONFIGURED: { tone: "danger", label: "Mal configuré" },
};

function dt(d: Date | null): string {
  if (!d) return "jamais";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" }).format(d);
}

export default async function AdamReglagesPage(
  props: {
    searchParams?: Promise<{ connecte?: string; erreur?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("CHIEF_OF_STAFF");
  // Le module suffit à ouvrir « My Chief of Staff », pas à brancher l'identité de communication
  // de la direction : cette page-là exige la vue globale.
  if (!hasGlobalView(user)) redirect("/chief-of-staff");

  const health = await adamHealth();
  const lvl = LEVEL_UI[health.level];
  // L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — lu par la santé d'Adam (côté ERP, comme la
  // connexion Google), posé et levé par le formulaire. L'écran ne lit ni la base ni `lib/missions`.
  const suspension = health.missions.suspension;
  // Les missions d'Adam sont réservées au Super Admin (§118.136) : leur interrupteur et leurs
  // compteurs ne sont pas montrés à qui ne peut pas en avoir — un bouton qu'une action refuse
  // n'est pas un bouton.
  const missionsPilotables = peutPiloterMissionsAdam(user);
  const missionsPausedInfo = suspension.active
    ? `depuis le ${dt(suspension.depuis)}${suspension.par ? ` par ${suspension.par}` : ""}`
    : null;
  const erreur = searchParams?.erreur ? (ERREURS[searchParams.erreur] ?? "La connexion a échoué.") : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/chief-of-staff" className="-m-2 rounded-lg p-2 text-muted-foreground hover:text-foreground" aria-label="Retour au Chief of Staff">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Settings2 className="h-5 w-5" aria-hidden />
          Réglages d&apos;Adam
        </h1>
        <Badge tone={lvl.tone} dot>{lvl.label}</Badge>
      </div>

      {searchParams?.connecte === "1" && (
        <p role="status" className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
          Compte Google connecté. La veille Gmail a été armée.
        </p>
      )}
      {erreur && (
        <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {erreur}
        </p>
      )}

      {health.issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
              À regarder
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {health.issues.map((i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compte Google</CardTitle>
          <CardDescription>
            L&apos;identité de communication d&apos;Adam : sa boîte, son agenda, son Drive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!health.config.configured ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Configuration serveur incomplète.</p>
              <p className="mt-1 text-muted-foreground">
                Variables manquantes : <code>{health.config.missingVars.join(", ")}</code>. Elles se
                règlent sur l&apos;hébergeur, pas ici — puis ce bouton devient actif.
              </p>
            </div>
          ) : health.connection.connected || health.connection.status === "paused" ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Compte</dt>
                <dd className="font-medium [overflow-wrap:anywhere]">{health.connection.address}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">État</dt>
                <dd className="font-medium">
                  {health.connection.paused ? "En pause" : "Connecté"}
                  {health.connection.hasRefreshToken ? "" : " — sans jeton de reprise"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Veille Gmail</dt>
                <dd className="font-medium">
                  {health.watch.armed ? `armée jusqu'au ${dt(health.watch.expiresAt)}` : "non armée"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Dernier événement reçu</dt>
                <dd className="font-medium">{dt(health.ingestion.lastNotifiedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Dernière réconciliation</dt>
                <dd className="font-medium">{dt(health.ingestion.lastReconciledAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Messages ingérés (24 h)</dt>
                <dd className="font-medium">{health.ingestion.last24h}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              Aucun compte connecté. Adam fonctionne sur l&apos;ERP, mais sans boîte, sans agenda
              et sans Drive Google.
            </p>
          )}

          {health.config.configured && (
            <div className="flex flex-wrap gap-2">
              {/* Une vraie navigation, pas un bouton : le flux OAuth est une redirection
                  serveur. On garde l'apparence d'un bouton sans imbriquer <a> dans <button>. */}
              <a
                href="/api/google/connect"
                className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition ${
                  health.connection.connected
                    ? "border border-border bg-card text-foreground hover:bg-secondary"
                    : "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                }`}
              >
                {health.connection.connected ? "Reconnecter / compléter les droits" : "Connecter le compte Google"}
              </a>
            </div>
          )}

          {health.connection.missingScopes.length > 0 && health.connection.connected && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-sm">
              <p className="font-medium">Droits manquants</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {health.connection.missingScopes.map((s) => (
                  <li key={s}>• {SCOPE_PURPOSE[s] ?? s}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ce qui a le droit de partir</CardTitle>
          <CardDescription>
            Adam lit, comprend, classe et prépare EN AUTONOMIE. Ce réglage ne concerne que la
            sortie — le moment où un message quitte l&apos;entreprise.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReglagesForm
            policy={health.outbound.policy as "REQUIRE_APPROVAL" | "AUTO_SEND" | "DRAFT_ONLY"}
            outboundPaused={health.outbound.outboundPaused}
            inboundPaused={health.outbound.inboundPaused}
            connectionPaused={health.connection.paused}
            connected={health.connection.connected || health.connection.status === "paused"}
            missionsPaused={suspension.active}
            missionsPausedInfo={missionsPausedInfo}
            missionsPilotables={missionsPilotables}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activité</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat icon={<Mail className="h-4 w-4" aria-hidden />} label="En attente d'accord" value={health.outbound.awaitingApproval} />
            <Stat icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} label="Envoyés (24 h)" value={health.outbound.sent24h} />
            <Stat icon={<XCircle className="h-4 w-4" aria-hidden />} label="Échecs (24 h)" value={health.outbound.failed24h} />
            <Stat icon={<Inbox className="h-4 w-4" aria-hidden />} label="Reçus (24 h)" value={health.ingestion.last24h} />
            {missionsPilotables ? (
              <>
                <Stat icon={<Radio className="h-4 w-4" aria-hidden />} label="Missions actives" value={health.missions.active} />
                <Stat icon={<Radio className="h-4 w-4" aria-hidden />} label="En attente de réponse" value={health.missions.waiting} />
                <Stat icon={<AlertTriangle className="h-4 w-4" aria-hidden />} label="Attendent une décision" value={health.missions.needsCeo} />
                <Stat icon={<Mail className="h-4 w-4" aria-hidden />} label="Prêtes à envoyer" value={health.missions.readyToSend} />
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
