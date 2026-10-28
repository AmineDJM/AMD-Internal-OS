"use client";

import * as React from "react";
import Script from "next/script";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Download, FileText, Loader2, Maximize2, Minimize2, RotateCw, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { DELAI_EDITEUR_OFFICE_MS } from "@/lib/office/creation-ui";
import { natureApercu } from "@/lib/formats/apercu";
import { BackLink } from "@/components/shared/back-link";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { DocxView, XlsxView, PptxView } from "@/components/documents/office-viewers";
import { ApercuUniversel, SansApercu } from "@/components/documents/apercu-universel";
import { sansBloquer } from "@/lib/journal";

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

/** Les octets du fichier pour l'aperçu de secours, et s'il est encore le modèle vierge. */
export interface ApercuSecours { src: string; telechargement: string; vierge?: boolean }

/**
 * L'APERÇU QUAND L'ÉDITEUR NE VIENT PAS — les visionneuses du navigateur (Word, Excel, PowerPoint
 * modernes, PDF, texte), sans aucun appel au Document Server. Surtout PAS `ApercuUniversel` avec
 * une cible : il retenterait l'éditeur qu'on sait injoignable.
 */
function ApercuHorsEditeur({ src, telechargement, vierge, name }: ApercuSecours & { name: string }) {
  if (vierge) {
    return (
      <div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background p-6 text-center">
        <FileText className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">Document vierge</p>
        <p className="text-xs text-muted-foreground">L&apos;édition reviendra dès que l&apos;éditeur est joignable.</p>
      </div>
    );
  }
  const nature = natureApercu(name);
  if (nature === "docx") return <DocxView src={src} name={name} />;
  if (nature === "xlsx") return <XlsxView src={src} name={name} />;
  if (nature === "pptx") return <PptxView src={src} name={name} />;
  if (nature === "converti") {
    return <SansApercu nom={name} telechargement={telechargement} raison="Ce format ne s'affiche que dans l'éditeur Office : téléchargez-le pour l'ouvrir." />;
  }
  return <ApercuUniversel src={src} name={name} telechargement={telechargement} />;
}

export function OfficeEditor({
  apiJs, config, name, backHref = "/drive", backLabel = "Retour au Drive", apercu, diagnostic = false,
}: {
  apiJs: string; config: unknown; name: string; backHref?: string; backLabel?: string;
  /** Ce qu'on montre si l'éditeur ne se charge pas. */
  apercu: ApercuSecours;
  /** Lien « Diagnostiquer » vers le test d'Administration (Super Admin). */
  diagnostic?: boolean;
}) {
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
      document.exitFullscreen?.().catch(sansBloquer("office-editor.OfficeEditor.exitFullscreen"));
    } else {
      el.requestFullscreen?.().catch(sansBloquer("office-editor.OfficeEditor.requestFullscreen"));
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
          // L'ÉDITEUR NE VIENT PAS : on montre quand même le document (aperçu du navigateur, sans
          // dépendance externe), avec une ligne d'état — pas une carte d'erreur à la place du fichier.
          <div className="absolute inset-0 flex flex-col">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-secondary/40 px-3 py-1.5 text-sm sm:px-4">
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
              <span className="font-medium">Éditeur indisponible — aperçu en lecture seule</span>
              <InfoBulle label="Pourquoi" align="left">
                {echec} Le fichier, lui, est bien enregistré. Réessayez dans un instant ; si cela persiste, signalez-le à
                l&apos;administrateur.
              </InfoBulle>
              <div className="ml-auto flex items-center gap-3 text-xs">
                <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1 py-1.5 text-primary hover:underline">
                  <RotateCw className="h-3.5 w-3.5" /> Réessayer
                </button>
                <BoutonTelecharger href={apercu.telechargement} nom={name} sansChoix className="inline-flex items-center gap-1 py-1.5 text-primary hover:underline">
                  <Download className="h-3.5 w-3.5" /> Télécharger
                </BoutonTelecharger>
                {diagnostic && (
                  <Link href="/admin#editeur-office" className="inline-flex items-center gap-1 py-1.5 text-muted-foreground hover:text-foreground">
                    <Stethoscope className="h-3.5 w-3.5" /> Diagnostiquer
                  </Link>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-muted/20 p-2 sm:p-3">
              <ApercuHorsEditeur {...apercu} name={name} />
            </div>
          </div>
        )}
        <div id="onlyoffice-editor" className={cn("h-full w-full", echec && "invisible")} />
      </div>
      <Script
        src={apiJs} strategy="afterInteractive" onLoad={init}
        onError={() => setEchec("Le script de l'éditeur Office n'a pas pu être chargé : son serveur (OnlyOffice) est injoignable.")}
      />
    </div>
  );
}
