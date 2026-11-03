"use client";

import Link from "next/link";
import { useState } from "react";
import { Search, Mic, Settings2, PanelLeft, ArrowLeft } from "lucide-react";

/**
 * L'EN-TÊTE D'ADAM — identité à gauche, état à droite, rien au milieu.
 *
 * CE QU'ON A RETIRÉ. L'ancienne version portait une phrase de présentation :
 * « — cherchez tout, lisez tout, agissez (sous confirmation) — au clavier ou à la voix. »
 * Elle décrivait le produit à quelqu'un qui l'utilise tous les jours. Une notice affichée en
 * permanence n'informe personne : elle occupe la ligne la plus visible de l'écran pour dire ce
 * que la première réponse aura déjà démontré.
 *
 * CE QUI RESTE SE JUSTIFIE UN PAR UN :
 *   • l'identité — pour savoir à qui l'on parle ;
 *   • l'état de fraîcheur — un point et deux mots : Adam voit-il des données à jour ?
 *   • la recherche, la voix, l'historique, les réglages — quatre commandes, pas neuf.
 *
 * L'HISTORIQUE N'EST PAS UNE COLONNE PERMANENTE. Une liste de conversations affichée en
 * continu consomme un cinquième de la largeur pour une chose qu'on ouvre trois fois par jour.
 * Elle vit derrière une icône, sur ordinateur comme sur téléphone.
 */

export interface ChiefHeaderProps {
  /** L'état des données : « À jour », « Synchronisation… », « Hors ligne ». */
  freshness?: { label: string; tone: "ok" | "warn" | "off" };
  /** La voix est-elle réellement disponible pour ce compte ? Sinon, pas de bouton mort. */
  voiceAvailable?: boolean;
  /** Les réglages d'Adam ne s'ouvrent qu'à la vue globale. */
  settingsHref?: string | null;
  /** Ouvre l'historique des conversations (feuille sur téléphone, tiroir sur ordinateur). */
  onOpenHistory?: () => void;
  onOpenSearch?: () => void;
  onStartVoice?: () => void;
  /** Sur une page secondaire (réglages), l'en-tête devient un retour. */
  backHref?: string;
  backLabel?: string;
  /**
   * LES MODULES OÙ CETTE PERSONNE PEUT ALLER — la porte de sortie du bureau.
   *
   * Sans elle, `(chief)` était un cul-de-sac : il retire toute la navigation de l'ERP, et rien
   * ne la remplaçait. Vide ⇒ aucun bouton, ce qui est le comportement juste pour un compte qui
   * n'aurait accès à rien d'autre.
   */
}

export function ChiefHeader({
  freshness,
  voiceAvailable = false,
  settingsHref,
  onOpenHistory,
  onOpenSearch,
  onStartVoice,
  backHref,
  backLabel,
}: ChiefHeaderProps) {
  const [pressed, setPressed] = useState<string | null>(null);

  if (backHref) {
    return (
      <header className="chief-header">
        <Link
          href={backHref}
          className="chief-icon-btn -ml-2"
          aria-label="Revenir au bureau d'Adam"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <span className="chief-title text-[17px] md:text-[19px]">{backLabel ?? "Réglages"}</span>
      </header>
    );
  }

  return (
    <header className="chief-header">
      {onOpenHistory && (
        <button
          type="button"
          onClick={onOpenHistory}
          className="chief-icon-btn -ml-2"
          aria-label="Ouvrir l'historique des conversations"
        >
          <PanelLeft className="h-[18px] w-[18px]" aria-hidden />
        </button>
      )}

      <Link href="/adam/bureau" className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ outlineColor: "hsl(var(--chief-accent))" }}>
        <AdamMark />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.01em]" style={{ color: "hsl(var(--chief-text))" }}>
            Adam
          </span>
          {/* Le sous-titre disparaît sous 380 px : sur un petit téléphone, la place va à
              l'identité, pas à sa qualification. */}
          <span className="hidden truncate text-[12.5px] xs:inline" style={{ color: "hsl(var(--chief-text-tertiary))" }}>
            Chief of Staff
          </span>
        </span>
      </Link>

      <div className="ml-auto flex items-center gap-0.5">
        {/* LE LIBELLÉ NE S'AFFICHE QU'À PARTIR DE `sm`. On ne peut PAS l'obtenir avec le `hidden`
            de Tailwind : `.chief-freshness` déclare `display: inline-flex` et l'emporte, ce qui
            affichait le point DEUX FOIS sur téléphone. Le masquage passe donc par un conteneur
            neutre, qui n'a pas de display imposé. */}
        {freshness && (
          <span className="mr-1 hidden sm:block">
            <span className="chief-freshness" title={`Données : ${freshness.label}`}>
              <span
                className={`chief-dot ${freshness.tone === "warn" ? "chief-dot-warn" : freshness.tone === "off" ? "chief-dot-off" : ""}`}
                aria-hidden
              />
              {freshness.label}
            </span>
          </span>
        )}
        {/* Sur téléphone, le point seul suffit : le mot tiendrait au prix d'une commande. */}
        {freshness && (
          <span className="mr-1.5 block sm:hidden" title={`Données : ${freshness.label}`} aria-label={`Données : ${freshness.label}`}>
            <span
              className={`chief-dot ${freshness.tone === "warn" ? "chief-dot-warn" : freshness.tone === "off" ? "chief-dot-off" : ""}`}
            />
          </span>
        )}

        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            onPointerDown={() => setPressed("search")}
            onPointerUp={() => setPressed(null)}
            className="chief-icon-btn"
            style={{ transform: pressed === "search" ? "scale(0.94)" : undefined }}
            aria-label="Rechercher (Ctrl+K)"
            title="Rechercher — Ctrl+K"
          >
            <Search className="h-[18px] w-[18px]" aria-hidden />
          </button>
        )}

        {/* Un bouton qui n'agit pas est pire qu'un bouton absent : la voix n'apparaît que si
            elle est réellement configurée ET ouverte à ce compte. */}
        {voiceAvailable && onStartVoice && (
          <button
            type="button"
            onClick={onStartVoice}
            className="chief-icon-btn hidden sm:inline-flex"
            aria-label="Parler à Adam"
            title="Parler à Adam"
          >
            <Mic className="h-[18px] w-[18px]" aria-hidden />
          </button>
        )}

        {settingsHref && (
          <Link href={settingsHref} className="chief-icon-btn" aria-label="Réglages d'Adam" title="Réglages d'Adam">
            <Settings2 className="h-[18px] w-[18px]" aria-hidden />
          </Link>
        )}

        {/* LA SORTIE, EN DERNIER. À l'extrémité de la barre parce que c'est le geste qu'on fait
            en QUITTANT : le mettre près de l'identité l'aurait rendu plus visible que la
            conversation elle-même, ce que ce bureau refuse depuis le premier jour. */}
      </div>
    </header>
  );
}

/**
 * La marque d'Adam. Un carré à l'accent, sans dégradé : le dégradé est le réflexe des
 * interfaces qui veulent avoir l'air « IA ». Une forme franche vieillit mieux.
 */
function AdamMark() {
  return (
    <span
      aria-hidden
      className="grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-[9px] text-[13px] font-semibold"
      style={{ backgroundColor: "hsl(var(--chief-accent))", color: "hsl(var(--chief-accent-fg))" }}
    >
      A
    </span>
  );
}
