"use client";

import * as React from "react";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { SELECTEUR_FOCUSABLE, sautDeFocus } from "./sheet-focus-regle";
import { focusInitial, peutConfirmer, preparerDialogue, type DemandeConfirmation, type DialoguePret } from "./dialogue-regle";

/**
 * LA FENÊTRE DU DIALOGUE DE CONFIRMATION — chargée après la page par le porteur (`dialogue.tsx`),
 * pour que la coque ne paie pas son poids (bouton, verrou de défilement, règles). Ce qu'elle garantit
 * (rôle, focus, Échap) est décrit dans `dialogue.tsx`.
 */

/** La fenêtre seule, contrôlée — pour un écran qui veut la poser lui-même. */
export function DialogueConfirmation({
  dialogue,
  onRepondre,
}: {
  dialogue: DialoguePret;
  /** `ok` faux : la personne a renoncé (Retour, Échap, voile). `saisie` : le champ, tel que tapé. */
  onRepondre: (reponse: { ok: boolean; saisie: string }) => void;
}) {
  useScrollLock(true);
  const id = React.useId();
  const fenetre = React.useRef<HTMLDivElement>(null);
  const champ = React.useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const boutonAnnuler = React.useRef<HTMLButtonElement>(null);
  const boutonConfirmer = React.useRef<HTMLButtonElement>(null);
  const [saisie, setSaisie] = React.useState(dialogue.saisie?.valeur ?? "");
  const repondre = React.useRef(onRepondre);
  repondre.current = onRepondre;

  // Entrer, rester, revenir — et Échap, capturé AVANT les écouteurs de la page (une `Sheet` dessous
  // écoute Échap en phase de bouillonnement : `preventDefault` lui dit que le geste est consommé).
  React.useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    const cible = focusInitial(dialogue);
    (cible === "saisie" ? champ.current : cible === "annuler" ? boutonAnnuler.current : boutonConfirmer.current)?.focus({ preventScroll: true });
    const auClavier = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        repondre.current({ ok: false, saisie: "" });
        return;
      }
      if (e.key !== "Tab" || !fenetre.current) return;
      const cibles = Array.from(fenetre.current.querySelectorAll<HTMLElement>(SELECTEUR_FOCUSABLE));
      const saut = sautDeFocus(cibles.length, cibles.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (saut === null) return;
      e.preventDefault();
      e.stopPropagation();
      cibles[saut].focus();
    };
    document.addEventListener("keydown", auClavier, true);
    return () => {
      document.removeEventListener("keydown", auClavier, true);
      if (avant && avant.isConnected && typeof avant.focus === "function") avant.focus({ preventScroll: true });
    };
    // La fenêtre est montée pour UNE demande : son focus se pose une fois.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valide = peutConfirmer(dialogue, saisie);
  const Champ = dialogue.saisie?.multiligne ? "textarea" : "input";

  return (
    <div className="fixed inset-0 z-[100] print:hidden">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => onRepondre({ ok: false, saisie: "" })} aria-hidden />
      <div className="pointer-events-none absolute inset-0 grid place-items-end p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:place-items-center sm:p-4">
        <div
          ref={fenetre}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${id}-titre`}
          aria-describedby={dialogue.detail ? `${id}-detail` : undefined}
          className="pointer-events-auto w-full max-w-[460px] rounded-2xl border border-border bg-card p-5 shadow-2xl animate-slide-up sm:animate-fade-in"
        >
          <form
            className="grid gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (valide) onRepondre({ ok: true, saisie: saisie.trim() });
            }}
          >
            <h2 id={`${id}-titre`} className="text-base font-semibold leading-snug">{dialogue.titre}</h2>
            {dialogue.detail && (
              <p id={`${id}-detail`} className="whitespace-pre-line text-sm text-muted-foreground">{dialogue.detail}</p>
            )}
            {dialogue.saisie && (
              <div className="grid gap-1.5">
                <label htmlFor={`${id}-saisie`} className="text-xs font-semibold">
                  {dialogue.saisie.libelle}
                  {!dialogue.saisie.obligatoire && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
                </label>
                <Champ
                  ref={champ}
                  id={`${id}-saisie`}
                  value={saisie}
                  required={dialogue.saisie.obligatoire}
                  placeholder={dialogue.saisie.placeholder}
                  maxLength={1000}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setSaisie(e.target.value)}
                  className={cn(
                    "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm focus-ring",
                    dialogue.saisie.multiligne && "min-h-[76px] resize-y",
                  )}
                />
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button ref={boutonAnnuler} type="button" variant="ghost" onClick={() => onRepondre({ ok: false, saisie: "" })}>
                {dialogue.annuler}
              </Button>
              <Button ref={boutonConfirmer} type="submit" variant={dialogue.ton === "danger" ? "destructive" : "primary"} disabled={!valide}>
                {dialogue.confirmer}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/** La fenêtre pour une demande brute — ce que monte le porteur. */
export function FenetreDemande({
  demande,
  onRepondre,
}: {
  demande: string | DemandeConfirmation;
  onRepondre: (reponse: { ok: boolean; saisie: string }) => void;
}) {
  const dialogue = React.useMemo(() => preparerDialogue(demande), [demande]);
  return <DialogueConfirmation dialogue={dialogue} onRepondre={onRepondre} />;
}
