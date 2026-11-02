"use client";

import * as React from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { sendMail } from "@/lib/actions/smart-mail-actions";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * Envoi de test : la seule façon honnête de savoir si la chaîne fonctionne de bout en bout.
 * Le résultat affiche le motif EXACT retourné par le fournisseur en cas de refus — c'est
 * précisément ce qui manquait avec SMTP, où l'on ne savait jamais pourquoi ça bloquait.
 */
export function MailTester({ configured }: { configured: boolean }) {
  const [to, setTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock.current || !to.trim()) return;
    lock.current = true;
    setBusy(true);
    setResult(null);
    try {
      const r = await sendMail({
        to,
        subject: "Test d'envoi — AMD Internal OS",
        body: "Ce message confirme que l'envoi de courrier fonctionne (API HTTPS, sans SMTP).",
      });
      setResult({ ok: r.ok, text: r.ok ? (r.message ?? "Message envoyé.") : (r.error ?? "Le message de test n'a pas été envoyé.") });
    } catch {
      setResult({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Envoi de test</h2>
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="email" value={to} onChange={(e) => setTo(e.target.value)}
            placeholder="votre.adresse@exemple.dz" required autoComplete="email"
            className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3.5 py-2.5 text-base outline-none sm:text-sm focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <Button type="submit" disabled={busy || !to.trim()}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
            Envoyer un test
          </Button>
        </form>
        {!configured && (
          <p className="text-xs text-muted-foreground">
            La configuration est incomplète : l&apos;essai vous dira précisément ce qui manque.
          </p>
        )}
        {result && (
          <p className={`rounded-xl px-3 py-2 text-sm ${result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {result.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
