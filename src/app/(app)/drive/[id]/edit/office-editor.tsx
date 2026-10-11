"use client";

import * as React from "react";
import Script from "next/script";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DELAI_EDITEUR_OFFICE_MS } from "@/lib/office/creation-ui";
import { BackLink } from "@/components/shared/back-link";

// L'API du Document Server est injectée globalement par api.js.
declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (el: string, config: unknown) => { destroyEditor?: () => void } };
  }
}

/** Origine du Document Server (pour préconnecter et accélérer le chargement des assets). */
function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function OfficeEditor({ apiJs, config, name, backHref = "/drive", backLabel = "Retour au Drive" }: { apiJs: string; config: unknown; name: string; backHref?: string; backLabel?: string }) {
  const editorRef = React.useRef<{ destroyEditor?: () => void } | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [echec, setEchec] = React.useState<string | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const origin = originOf(apiJs);

  const init = React.useCallback(() => {
    if (!window.DocsAPI || editorRef.current) return;
    try {
      editorRef.current = new window.DocsAPI.DocEditor("onlyoffice-editor", config);
      setReady(true);
    } catch {
      setEchec("L'éditeur Office n'a pas pu démarrer.");
    }
  }, [config]);

  // LE CHARGEMENT A UNE FIN. Le script de l'éditeur vient du Document Server : s'il est injoignable
  // (serveur arrêté ou en veille, adresse erronée, `http://` que la CSP `upgrade-insecure-requests`
  // force en `https://`), `onLoad` ne vient jamais et « Chargement de l'éditeur… » tournait sans fin.
  React.useEffect(() => {
    if (ready || echec) return;
    const t = window.setTimeout(() => {
      if (!editorRef.current) setEchec("L'éditeur Office ne répond pas : son serveur (OnlyOffice) est injoignable ou trop lent.");
    }, DELAI_EDITEUR_OFFICE_MS);
    return () => window.clearTimeout(t);
  }, [ready, echec]);

  React.useEffect(() => {
    if (typeof window !== "undefined" && window.DocsAPI) init();
    return () => {
      try { editorRef.current?.destroyEditor?.(); } catch { /* ignore */ }
      editorRef.current = null;
    };
  }, [init]);

  // Synchronise l'état du bouton avec le plein écran natif (Échap, F11…).
  React.useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  return (
    // Hors plein écran, l'éditeur occupe la zone de contenu mesurée : sur téléphone, sa barre
    // d'outils basse passait sinon derrière la barre d'onglets.
    <div ref={wrapRef} className={cn("flex flex-col bg-background", fullscreen ? "h-[100dvh]" : "app-viewport")}>
      {/* Préconnexion au Document Server : réduit la latence de chargement des assets. */}
      {origin && (
        <>
          <link rel="preconnect" href={origin} crossOrigin="anonymous" />
          <link rel="dns-prefetch" href={origin} />
        </>
      )}
      {/* Au téléphone, le libellé du retour s'efface derrière sa flèche : la ligne est au nom du fichier. */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4">
        <BackLink href={backHref} className="inline-flex shrink-0 items-center gap-1.5 py-2 text-sm text-muted-foreground hover:text-foreground sm:py-0">
          <ArrowLeft className="h-4 w-4" /> <span className="sr-only sm:not-sr-only">{backLabel}</span>
        </BackLink>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-medium sm:flex-none" title={name}>{name}</span>
        <button
          onClick={toggleFullscreen}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-auto sm:w-auto sm:px-2.5 sm:py-1"
          title={fullscreen ? "Quitter le plein écran" : "Éditer en plein écran"}
          aria-label={fullscreen ? "Quitter le plein écran" : "Éditer en plein écran"}
        >
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{fullscreen ? "Quitter" : "Plein écran"}</span>
        </button>
      </div>
      <div className="relative flex-1">
        {!ready && !echec && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2 text-sm">Chargement de l'éditeur…</span>
          </div>
        )}
        {echec && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="max-w-md space-y-2 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
              <p className="flex items-start gap-2 font-medium">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> {echec}
              </p>
              <p className="text-muted-foreground">
                Le fichier, lui, est bien enregistré : vous pouvez le télécharger depuis sa fiche.
                Réessayez dans un instant ; si cela persiste, signalez-le à l&apos;administrateur.
              </p>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => window.location.reload()} className="text-primary hover:underline">Réessayer</button>
                <Link href={backHref} className="text-muted-foreground hover:text-foreground">{backLabel}</Link>
              </div>
            </div>
          </div>
        )}
        <div id="onlyoffice-editor" className="h-full w-full" />
      </div>
      <Script
        src={apiJs} strategy="afterInteractive" onLoad={init}
        onError={() => setEchec("Le script de l'éditeur Office n'a pas pu être chargé : son serveur (OnlyOffice) est injoignable.")}
      />
    </div>
  );
}
