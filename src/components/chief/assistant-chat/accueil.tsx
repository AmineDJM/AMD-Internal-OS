"use client";

/**
 * LA CONVERSATION — l'accueil d'un fil vide (page Assistant de l'ERP) : la salutation et les amorces.
 */
import { Sparkles, ArrowRight, Wand2 } from "lucide-react";
import { SUGGESTIONS } from "./modele";

export function AccueilVide({ userName, configured, send }: { userName: string; configured: boolean; send: (text: string) => unknown }) {
  return (
    <div className="mx-auto max-w-xl py-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-purple-500 text-primary-foreground shadow-lg">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold">Bonjour {userName.split(" ")[0]} 👋</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Posez une question sur votre travail, ou demandez-moi de préparer une action.
        Je m'appuie sur vos données (selon vos droits) et chaque action vous est soumise pour confirmation.
      </p>
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => send(s)}
            disabled={!configured}
            className="group flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-secondary/50 disabled:opacity-50"
          >
            <Wand2 className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">{s}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  );
}
