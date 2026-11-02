"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { changePassword } from "@/lib/actions/auth-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      Mettre à jour
    </Button>
  );
}

export function ChangePasswordForm({ email }: { email: string }) {
  const [error, formAction] = useActionState(changePassword, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="email" value={email} autoComplete="username" />
      <div className="space-y-1.5">
        <Label htmlFor="current">Mot de passe actuel</Label>
        <Input id="current" name="current" type="password" required autoComplete="current-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="next">Nouveau mot de passe</Label>
        <Input id="next" name="next" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirmer</Label>
        <Input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
      <Submit />
    </form>
  );
}
