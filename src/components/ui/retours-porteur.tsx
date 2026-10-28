"use client";

import * as React from "react";
import { dureeDuRetour, empiler, roleDuRetour, type AvisRetour, type TonRetour } from "./retour-regle";
import { useModuleDiffere } from "./differe";

/**
 * LE PORTEUR DES AVIS FLOTTANTS ET `useRetours()` — la part de `retour.tsx` que paie la coque.
 *
 * Le bandeau (`<Retour>`) et le dessin des avis (icônes, `retours-pile.tsx`) n'y sont pas : la pile se
 * télécharge au premier moment libre ; d'ici là, ou sans réseau, un avis s'affiche en texte seul — dans
 * la même région `aria-live`, donc annoncé de même. Mode d'emploi : `retour.tsx`.
 */

export interface Retours {
  signaler: (ton: TonRetour, message: string) => void;
  erreur: (message: string) => void;
  alerte: (message: string) => void;
  succes: (message: string) => void;
  info: (message: string) => void;
}

const ContexteRetours = React.createContext<Retours | null>(null);

/**
 * Le porteur des avis flottants — monté UNE fois, dans la coque (`PrimitivesUI`).
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

  const { module: dessin } = useModuleDiffere(() => import("./retours-pile"));
  const avis = (role: "alert" | "status") => {
    const lot = pile.filter((a) => roleDuRetour(a.ton) === role);
    if (dessin) return <dessin.Avis lot={lot} retirer={retirer} />;
    // Repli sans téléchargement (la pile n'est pas encore là, ou le réseau est coupé) : le message,
    // annoncé de même, et de quoi le fermer.
    return lot.map((a) => (
      <div key={a.id} className="pointer-events-auto flex items-start gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm shadow-lg">
        <p className="min-w-0 flex-1 whitespace-pre-line break-words">{a.message}</p>
        <button type="button" onClick={() => retirer(a.id)} className="-m-1 shrink-0 rounded px-1 text-xs opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer le message">
          ✕
        </button>
      </div>
    ));
  };

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
