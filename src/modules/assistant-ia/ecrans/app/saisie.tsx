"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * LA ZONE DE SAISIE D'ADVENTUM IA (décision 0027, point 7) — les trois façons de parler au même endroit :
 * (a) le TEXTE (Entrée envoie sur ordinateur ; sur écran tactile, Entrée va à la ligne et la flèche envoie),
 * (b) la VOIX EN DIRECT (`gpt-live-1`, lot J13 : `BoutonVoixTempsReel`, posé par l'écran), (c) le MESSAGE VOCAL (le micro, posé par l'écran : maintenir,
 * glisser pour annuler, verrouiller, réécouter). Champ en 16 px sur téléphone (iOS zoome en dessous).
 */
export function SaisieAdventum({ onEnvoyer, dessus, joindre, vocal, voix, envoiBloque, peutEnvoyerVide, brouillon, placeholder }: {
  onEnvoyer: (texte: string) => Promise<boolean>;
  dessus?: React.ReactNode;
  joindre?: React.ReactNode;
  vocal?: React.ReactNode;
  voix?: React.ReactNode;
  envoiBloque?: boolean;
  peutEnvoyerVide?: boolean;
  brouillon?: { texte: string; jeton: number } | null;
  placeholder?: string;
}) {
  const [texte, setTexte] = useState("");
  const champ = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (brouillon) { setTexte(brouillon.texte); champ.current?.focus(); } }, [brouillon]);
  useEffect(() => {
    const c = champ.current;
    if (!c) return;
    c.style.height = "auto";
    c.style.height = `${Math.min(c.scrollHeight, 168)}px`;
  }, [texte]);

  const partir = async () => {
    const t = texte.trim();
    if ((!t && !peutEnvoyerVide) || envoiBloque) return;
    setTexte("");
    if (!(await onEnvoyer(t))) setTexte(t);
  };
  const vide = !texte.trim() && !peutEnvoyerVide;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void partir(); }}
      className="relative flex flex-col gap-1.5 rounded-[18px] border border-[var(--aia-filet)] bg-[var(--aia-panneau)] p-2 shadow-sm"
    >
      {dessus}
      <label htmlFor="aia-message" className="sr-only">Votre message</label>
      <textarea
        id="aia-message" ref={champ} rows={1} value={texte} onChange={(e) => setTexte(e.target.value)}
        placeholder={placeholder ?? "Écrivez, glissez des fichiers ou dossiers, ou parlez…"}
        onKeyDown={(e) => {
          const tactile = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
          if (e.key === "Enter" && !e.shiftKey && !tactile && !e.nativeEvent.isComposing) { e.preventDefault(); void partir(); }
        }}
        className="min-h-[44px] resize-none bg-transparent px-2 py-1.5 text-[16px] leading-relaxed text-[var(--aia-texte)] outline-none placeholder:text-[var(--aia-discret)] sm:text-[15px]"
      />
      <div className="relative flex items-center gap-1">
        {joindre}
        <span className="flex-1" />
        {voix}
        {vide && vocal ? vocal : (
          <button type="submit" disabled={vide || envoiBloque} aria-label="Envoyer"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--aia-accent)] text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)] disabled:opacity-40">
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
