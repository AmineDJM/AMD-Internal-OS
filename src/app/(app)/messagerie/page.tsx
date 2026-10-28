import Link from "next/link";
import { Mail, ShieldAlert, PlugZap } from "lucide-react";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { mailAccess, ACCESS_MESSAGE } from "@/lib/mail/access";
import { getConnectionStatus } from "@/lib/mail/connection";
import { MailWorkspace } from "./mail-workspace";
import { DisconnectButton } from "./disconnect-button";

export const dynamic = "force-dynamic";

/**
 * MESSAGERIE MICROSOFT 365.
 *
 * Trois états, et chacun mérite son écran plutôt qu'un message d'erreur générique :
 *   • **fermé** (drapeau, configuration, pilote) — on dit lequel des trois, parce que les gestes
 *     à faire sont totalement différents ;
 *   • **pas encore connecté** — un seul bouton, et l'explication de ce qui va se passer ;
 *   • **connecté** — la messagerie.
 */
export default async function MessageriePage(props: { searchParams: Promise<{ erreur?: string; connecte?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const env = process.env as Record<string, string | undefined>;
  const access = mailAccess(user as never, env);

  if (!access.allowed) {
    return (
      <div className="space-y-4">
        <PageHeader title="Messagerie" />
        <div className="surface space-y-2 p-4 sm:p-6">
          <p className="flex items-start gap-2 font-medium"><ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /> {ACCESS_MESSAGE[access.reason]}</p>
          {access.missingVars.length > 0 && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              Variables manquantes sur le serveur : <code>{access.missingVars.join(", ")}</code>
            </p>
          )}
          {user.role === "SUPER_ADMIN" && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              La marche à suivre complète est dans <code>docs/microsoft-mail-integration-audit.md</code>.
            </p>
          )}
        </div>
      </div>
    );
  }

  const status = await getConnectionStatus(user.id);
  const failed = searchParams.erreur;

  if (!status.connected) {
    return (
      <div className="space-y-4">
        <PageHeader title="Messagerie" description="Votre boîte Microsoft 365, dans AMD Internal OS." />
        <div className="surface mx-auto max-w-xl space-y-4 p-5 text-center sm:p-8">
          <Mail className="mx-auto h-10 w-10 text-primary" />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Connectez votre boîte Microsoft 365</h2>
            <p className="text-sm text-muted-foreground">
              Vous serez redirigé vers Microsoft pour autoriser AMD Internal OS à lire et envoyer
              vos e-mails. <strong className="text-foreground">Aucun mot de passe n&apos;est stocké</strong> : la
              connexion se révoque à tout moment, ici ou depuis votre compte Microsoft.
            </p>
          </div>
          {status.status === "needs-reconnect" && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              Votre autorisation Microsoft a expiré. Reconnectez-vous pour retrouver votre boîte.
            </p>
          )}
          {failed && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {failed === "refus" ? "La connexion a été refusée côté Microsoft."
                : failed === "state" ? "Le lien de retour n'était plus valable. Recommencez depuis cette page."
                : failed === "not-configured" ? "La messagerie n'est pas configurée sur ce serveur."
                : "La connexion n'a pas abouti. Réessayez."}
            </p>
          )}
          <Link
            href="/api/mail/ms/connect"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <PlugZap className="h-4 w-4" /> Connecter ma boîte Microsoft
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PageHeader title="Messagerie" description={status.address ?? undefined}>
        <DisconnectButton />
      </PageHeader>
      <MailWorkspace address={status.address ?? ""} signature={status.signature ?? ""} />
    </div>
  );
}
