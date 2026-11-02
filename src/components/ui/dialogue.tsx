"use client";

import * as React from "react";
import type { DemandeConfirmation } from "./dialogue-regle";
import { useModuleDiffere } from "./differe";

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

type Reponse = { ok: boolean; saisie: string };
type Ouvrir = (demande: string | DemandeConfirmation) => Promise<Reponse>;

const ContexteDialogue = React.createContext<Ouvrir | null>(null);

/**
 * Le porteur des dialogues — monté UNE fois, dans la coque (`app/(app)/layout.tsx` et le portail, via `PrimitivesUI`).
 * Les demandes arrivent en file : une seconde demande pendant qu'une fenêtre est ouverte attend son tour.
 * La fenêtre (`dialogue-fenetre.tsx`) se télécharge au premier moment libre, hors de la coque ; si elle
 * n'a pas pu venir (réseau coupé), la demande passe par la boîte du navigateur — jamais un geste sans
 * confirmation.
 */
export function DialoguesProvider({ children }: { children: React.ReactNode }) {
  const [file, setFile] = React.useState<{ n: number; demande: string | DemandeConfirmation; resoudre: (r: Reponse) => void }[]>([]);
  const compteur = React.useRef(0);
  const { module: fenetre, charger } = useModuleDiffere(() => import("./dialogue-fenetre"));
  const ouvrir = React.useCallback<Ouvrir>(
    (demande) => charger().then(
      () => new Promise<Reponse>((resoudre) => {
        const n = ++compteur.current;
        setFile((f) => [...f, { n, demande, resoudre }]);
      }),
      () => ouvrirSansPorteur(demande),
    ),
    [charger],
  );
  const courant = fenetre ? file[0] : undefined;
  return (
    <ContexteDialogue.Provider value={ouvrir}>
      {children}
      {fenetre && courant && (
        <fenetre.FenetreDemande
          key={courant.n}
          demande={courant.demande}
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
async function ouvrirSansPorteur(demande: string | DemandeConfirmation): Promise<Reponse> {
  const { preparerDialogue, peutConfirmer } = await import("./dialogue-regle");
  const d = preparerDialogue(demande);
  const texte = d.detail ? `${d.titre}\n\n${d.detail}` : d.titre;
  if (d.saisie) {
    const r = window.prompt(`${texte}\n\n${d.saisie.libelle}`, d.saisie.valeur);
    return { ok: r !== null && peutConfirmer(d, r), saisie: (r ?? "").trim() };
  }
  return { ok: window.confirm(texte), saisie: "" };
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
