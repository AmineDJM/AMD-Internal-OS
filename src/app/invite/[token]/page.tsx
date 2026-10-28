import { AlertTriangle } from "lucide-react";
import { inviteState } from "@/lib/user-invites";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activer mon compte — AMD Internal OS" };

const REASON_TEXT: Record<"unknown" | "used" | "expired", string> = {
  unknown: "Ce lien d'invitation n'existe pas (ou le compte a été désactivé).",
  used: "Ce lien a déjà servi : le mot de passe est déjà défini. Connectez-vous, ou demandez un nouveau lien si ce n'était pas vous.",
  expired: "Ce lien a expiré. Demandez un nouveau lien à votre administrateur.",
};

/**
 * PAGE PUBLIQUE d'activation de compte : la personne invitée définit ELLE-MÊME son mot de
 * passe — il ne transite jamais par une conversation ni par un administrateur. Le token à
 * usage unique est la seule autorisation ; aucune session requise.
 */
export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const state = await inviteState(params.token);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
            A
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Activer mon compte</h1>
          {state.valid ? (
            <p className="text-sm text-muted-foreground">
              Bienvenue {state.name}. Choisissez le mot de passe du compte <span className="font-medium">{state.email}</span>.
            </p>
          ) : null}
        </div>
        {state.valid ? (
          <SetPasswordForm token={params.token} />
        ) : (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {REASON_TEXT[state.reason]}
          </div>
        )}
      </div>
    </div>
  );
}
