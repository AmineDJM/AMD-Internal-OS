"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogIn, AlertCircle } from "lucide-react";
import { supplierLogin } from "@/lib/actions/supplier-portal-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export function SupplierLoginForm() {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <form
      action={async (fd) => {
        setPending(true); setErr(null);
        try {
          const r = await supplierLogin(undefined, fd);
          if (r.ok) { router.replace("/portail"); rafraichir(); }
          else { setErr(r.error ?? "La connexion n'a pas abouti."); setPending(false); }
        } catch {
          setErr(actionFailureMessage("THROWN")); setPending(false);
        }
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="username" placeholder="vous@fournisseur.com" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Mot de passe</Label>
        <Input id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      {err && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {err}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Se connecter
      </Button>
    </form>
  );
}
