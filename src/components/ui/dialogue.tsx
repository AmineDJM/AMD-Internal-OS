"use client";

import * as React from "react";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { SELECTEUR_FOCUSABLE, sautDeFocus } from "./sheet-focus-regle";
import { focusInitial, peutConfirmer, preparerDialogue, type DemandeConfirmation, type DialoguePret } from "./dialogue-regle";

/**
 * LE DIALOGUE DE CONFIRMATION — remplace `window.confirm()` et `window.prompt()` (V3-B).
 *
 * ── COMMENT S'EN SERVIR ─────────────────────────────────────────────────────────────────────
 *
 *     const confirmer = useConfirmer();
 *     async function supprimer() {
 *       if (!(await confirmer("Supprimer ce document ?"))) return;
 *       …
 *     }
 *
 *     const saisir = useSaisir();
 *     const motif = await saisir({ titre: "Annuler la formation ?", saisie: { libelle: "Motif", obligatoire: true } });
 *     if (motif === null) return;            // la personne a renoncé
 *
 * La chaîne suffit : son premier paragraphe devient le titre, la suite le détail, et le bouton porte le
 * verbe (« Supprimer »), règle pure dans `dialogue-regle.ts`. Pour décider soi-même : `{ titre, message,
 * confirmer, ton }`.
 *
 * ── CE QUE LA FENÊTRE GARANTIT (et que `window.confirm` ne garantissait pas au même titre) ───
 *
 * - `role="alertdialog"` + `aria-modal`, titre et détail reliés (`aria-labelledby`/`describedby`) ;
 * - le focus ENTRE (sur « Retour » pour un geste à risque : Entrée par réflexe ne supprime rien),
 *   RESTE (Tab boucle, règle `sautDeFocus` partagée avec `Sheet`) et REVIENT à l'élément d'avant ;
 * - Échap renonce — et ne ferme QUE la fenêtre : capturé avant la feuille qui est dessous ;
 * - un appui sur le voile renonce ; le défilement de la page est figé (`useScrollLock`, compté).
 *
 * Ce n'est PAS la double confirmation des gestes décisifs (approuver, payer, signer) : ceux-là
 * passent par `BoutonDecisif` (second clic sur le bouton même). Ce dialogue sert le reste —
 * supprimer une ligne, quitter sans enregistrer, réinitialiser un réglage, saisir un motif.
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

type Reponse = { ok: boolean; saisie: string };
type Ouvrir = (demande: string | DemandeConfirmation) => Promise<Reponse>;

const ContexteDialogue = React.createContext<Ouvrir | null>(null);

/**
 * Le porteur des dialogues — monté UNE fois, à la racine (`app/layout.tsx`, via `PrimitivesUI`).
 * Les demandes arrivent en file : une seconde demande pendant qu'une fenêtre est ouverte attend son tour.
 */
export function DialoguesProvider({ children }: { children: React.ReactNode }) {
  const [file, setFile] = React.useState<{ n: number; dialogue: DialoguePret; resoudre: (r: Reponse) => void }[]>([]);
  const compteur = React.useRef(0);
  const ouvrir = React.useCallback<Ouvrir>(
    (demande) => new Promise<Reponse>((resoudre) => {
      const n = ++compteur.current;
      setFile((f) => [...f, { n, dialogue: preparerDialogue(demande), resoudre }]);
    }),
    [],
  );
  const courant = file[0];
  return (
    <ContexteDialogue.Provider value={ouvrir}>
      {children}
      {courant && (
        <DialogueConfirmation
          key={courant.n}
          dialogue={courant.dialogue}
          onRepondre={(r) => {
            courant.resoudre(r);
            setFile((f) => f.slice(1));
          }}
        />
      )}
    </ContexteDialogue.Provider>
  );
}

/**
 * Hors porteur (un test de rendu, un écran monté hors de la racine), on retombe sur la boîte du
 * navigateur plutôt que de laisser passer un geste sans confirmation. C'est le SEUL `window.confirm`
 * autorisé du dépôt (cliquet `dialogues-natifs.test.ts`).
 */
function ouvrirSansPorteur(demande: string | DemandeConfirmation): Promise<Reponse> {
  const d = preparerDialogue(demande);
  const texte = d.detail ? `${d.titre}\n\n${d.detail}` : d.titre;
  if (d.saisie) {
    const r = window.prompt(`${texte}\n\n${d.saisie.libelle}`, d.saisie.valeur);
    return Promise.resolve({ ok: r !== null && peutConfirmer(d, r), saisie: (r ?? "").trim() });
  }
  return Promise.resolve({ ok: window.confirm(texte), saisie: "" });
}

/** `await confirmer("Supprimer ?")` → `true` si la personne confirme. */
export function useConfirmer(): (demande: string | DemandeConfirmation) => Promise<boolean> {
  const ouvrir = React.useContext(ContexteDialogue) ?? ouvrirSansPorteur;
  return React.useCallback(async (demande) => (await ouvrir(demande)).ok, [ouvrir]);
}

/** `await saisir({ titre, saisie: { libelle } })` → le texte saisi, ou `null` si la personne renonce. */
export function useSaisir(): (demande: DemandeConfirmation & { saisie: NonNullable<DemandeConfirmation["saisie"]> }) => Promise<string | null> {
  const ouvrir = React.useContext(ContexteDialogue) ?? ouvrirSansPorteur;
  return React.useCallback(async (demande) => {
    const r = await ouvrir(demande);
    return r.ok ? r.saisie : null;
  }, [ouvrir]);
}
