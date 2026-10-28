"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { dureeDuRetour, empiler, roleDuRetour, type AvisRetour, type TonRetour } from "./retour-regle";

/**
 * LE RETOUR D'UN GESTE — bandeau dans l'écran, ou avis flottant (V3-B). Remplace `window.alert()`.
 *
 * ── COMMENT S'EN SERVIR ─────────────────────────────────────────────────────────────────────
 *
 *     // À CÔTÉ DU GESTE (l'erreur d'un formulaire, d'un panneau) — le cas par défaut :
 *     <Retour ton="erreur">{err}</Retour>            // rien n'est rendu si `err` est vide
 *
 *     // QUAND LE GESTE N'A PAS DE PLACE POUR PARLER (une icône dans une ligne, un menu) :
 *     const retours = useRetours();
 *     retours.erreur(r.error ?? "La suppression n'a pas abouti.");
 *     retours.succes("Lien copié.");
 *
 * La règle (rôle ARIA, durée, pile) vit dans `retour-regle.ts`, pure et testée : une ERREUR est
 * annoncée tout de suite (`role="alert"`) et ne s'efface jamais seule ; un succès est annoncé poliment
 * (`role="status"`) et part après le temps de le lire.
 *
 * Écrire le message : dire CE QUI s'est passé et CE QU'ON PEUT FAIRE (« Le document n'a pas été
 * supprimé : il est rattaché à un dossier ouvert. »), jamais « Échec. » — et, pour une panne de
 * connexion, `actionFailureMessage()` (`lib/action-outcome.ts`), qui n'invite pas à réessayer.
 */

const STYLE: Record<TonRetour, { classe: string; Icone: React.ComponentType<{ className?: string }> }> = {
  erreur: { classe: "border-destructive/30 bg-destructive/10 text-destructive", Icone: XCircle },
  alerte: { classe: "border-warning/40 bg-warning/10 text-foreground", Icone: AlertTriangle },
  succes: { classe: "border-success/30 bg-success/10 text-foreground", Icone: CheckCircle2 },
  info: { classe: "border-border bg-secondary text-foreground", Icone: Info },
};

/** Le bandeau, posé dans l'écran à côté du geste qui l'a produit. */
export function Retour({
  ton = "erreur",
  children,
  onFermer,
  className,
}: {
  ton?: TonRetour;
  children?: React.ReactNode;
  /** Affiche une croix « Fermer ». */
  onFermer?: () => void;
  className?: string;
}) {
  if (children === null || children === undefined || children === false || children === "") return null;
  const { classe, Icone } = STYLE[ton];
  return (
    <div role={roleDuRetour(ton)} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", classe, className)}>
      <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 whitespace-pre-line break-words">{children}</div>
      {onFermer && (
        <button type="button" onClick={onFermer} className="-m-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer le message">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export interface Retours {
  signaler: (ton: TonRetour, message: string) => void;
  erreur: (message: string) => void;
  alerte: (message: string) => void;
  succes: (message: string) => void;
  info: (message: string) => void;
}

const ContexteRetours = React.createContext<Retours | null>(null);

/**
 * Le porteur des avis flottants — monté UNE fois, à la racine (`PrimitivesUI`).
 *
 * Les deux régions `aria-live` existent DÈS le premier rendu, vides : un lecteur d'écran n'annonce que
 * ce qui change DANS une région qu'il connaît déjà — une région créée en même temps que son message
 * resterait muette.
 */
export function RetoursProvider({ children }: { children: React.ReactNode }) {
  const [pile, setPile] = React.useState<AvisRetour[]>([]);
  const compteur = React.useRef(0);
  const minuteurs = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const retirer = React.useCallback((id: number) => {
    setPile((p) => p.filter((a) => a.id !== id));
    const t = minuteurs.current.get(id);
    if (t) clearTimeout(t);
    minuteurs.current.delete(id);
  }, []);

  const signaler = React.useCallback((ton: TonRetour, message: string) => {
    const texte = message.trim();
    if (!texte) return;
    const id = ++compteur.current;
    setPile((p) => empiler(p, { id, ton, message: texte }));
    const duree = dureeDuRetour(ton, texte);
    if (duree !== null) minuteurs.current.set(id, setTimeout(() => retirer(id), duree));
  }, [retirer]);

  React.useEffect(() => {
    const m = minuteurs.current;
    return () => { m.forEach(clearTimeout); m.clear(); };
  }, []);

  const valeur = React.useMemo<Retours>(() => ({
    signaler,
    erreur: (m) => signaler("erreur", m),
    alerte: (m) => signaler("alerte", m),
    succes: (m) => signaler("succes", m),
    info: (m) => signaler("info", m),
  }), [signaler]);

  const avis = (role: "alert" | "status") =>
    pile.filter((a) => roleDuRetour(a.ton) === role).map((a) => {
      const { classe, Icone } = STYLE[a.ton];
      return (
        <div key={a.id} className={cn("pointer-events-auto flex items-start gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm shadow-lg animate-slide-up", classe)}>
          <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 whitespace-pre-line break-words">{a.message}</p>
          <button type="button" onClick={() => retirer(a.id)} className="-m-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer le message">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    });

  return (
    <ContexteRetours.Provider value={valeur}>
      {children}
      {/* Au téléphone, au-dessus de la barre d'onglets ; au bureau, en bas à droite. */}
      <div className="pointer-events-none fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[110] flex flex-col items-stretch gap-2 print:hidden sm:inset-x-auto sm:right-4 sm:w-[380px] lg:bottom-4">
        <div role="alert" aria-live="assertive" className="flex flex-col gap-2">{avis("alert")}</div>
        <div role="status" aria-live="polite" className="flex flex-col gap-2">{avis("status")}</div>
      </div>
    </ContexteRetours.Provider>
  );
}

/**
 * Hors porteur (test de rendu, écran hors racine) : l'erreur retombe sur la boîte du navigateur plutôt
 * que d'être perdue — SEUL `window.alert` autorisé du dépôt (cliquet `dialogues-natifs.test.ts`).
 */
const SANS_PORTEUR: Retours = {
  signaler: (ton, m) => (ton === "erreur" || ton === "alerte" ? window.alert(m) : console.info(`[retour] ${m}`)),
  erreur: (m) => window.alert(m),
  alerte: (m) => window.alert(m),
  succes: (m) => console.info(`[retour] ${m}`),
  info: (m) => console.info(`[retour] ${m}`),
};

export function useRetours(): Retours {
  return React.useContext(ContexteRetours) ?? SANS_PORTEUR;
}
