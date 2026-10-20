"use client";

import * as React from "react";
import { Loader2, Pencil, Eye } from "lucide-react";

/**
 * L'ÉDITEUR OFFICE EMBARQUÉ — ouvrir un Word, un Excel, un PowerPoint (et leurs anciens formats) dans leur forme
 * exacte, les modifier sur place, sans que le PC décode quoi que ce soit (Direction, 06/10).
 *
 * Le Document Server lit le fichier d'origine SUR LE SERVEUR et gère l'enregistrement automatique, les versions et
 * l'édition à plusieurs ; ce composant ne fait que charger son interface. Les droits sont jugés par
 * `/api/onlyoffice/session` : lecture seule sans droit de modification, édition avec.
 *
 * SOLIDE, parce qu'un éditeur qui ne s'ouvre pas ne doit jamais laisser une page blanche :
 *   • le script de l'éditeur se charge UNE fois pour toute la session, avec un délai maximum ;
 *   • l'éditeur est détruit à la fermeture de la fenêtre (plus de session fantôme côté serveur) ;
 *   • quand il ne peut pas s'ouvrir (non configuré, serveur injoignable, format refusé, erreur de l'éditeur), on
 *     montre le `secours` fourni par l'appelant — la visionneuse du navigateur, ou le téléchargement.
 */

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (el: string, config: unknown) => { destroyEditor?: () => void } };
  }
}

let scriptEnCours: Promise<void> | null = null;
let scriptUrl: string | null = null;

/** Charge `api.js` de l'éditeur une seule fois ; échoue après 20 s plutôt que d'attendre sans fin. */
function chargerScript(url: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("serveur"));
  if (window.DocsAPI && scriptUrl === url) return Promise.resolve();
  if (scriptEnCours && scriptUrl === url) return scriptEnCours;
  scriptUrl = url;
  scriptEnCours = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    const minuteur = window.setTimeout(() => { scriptEnCours = null; reject(new Error("délai dépassé")); }, 20_000);
    s.onload = () => { window.clearTimeout(minuteur); window.DocsAPI ? resolve() : (scriptEnCours = null, reject(new Error("API absente"))); };
    s.onerror = () => { window.clearTimeout(minuteur); scriptEnCours = null; reject(new Error("script injoignable")); };
    document.head.appendChild(s);
  });
  return scriptEnCours;
}

/**
 * PRÉCHAUFFER L'ÉDITEUR — au survol d'un fichier Office, avant le clic.
 *
 * Le script de l'éditeur vient du Document Server : c'est la seule ressource que l'ouverture attend et qui ne
 * dépend pas du fichier. Le charger pendant que la souris hésite sur le nom, c'est autant de moins à attendre
 * après le clic — et `chargerScript` ne le charge qu'une fois pour toute la session. Un échec ici ne dit rien :
 * l'ouverture refera l'essai et, elle, saura le dire.
 */
export function prechargerEditeur(apiJs: string | null | undefined): void {
  if (!apiJs) return;
  chargerScript(apiJs).catch(() => { /* l'ouverture réessaiera et affichera la raison */ });
}

/**
 * La configuration d'ouverture, quand la page l'a déjà préparée côté serveur (pas d'aller-retour en plus) — ou
 * la raison pour laquelle l'éditeur ne s'ouvrira pas (non configuré, refus) : le secours s'affiche aussitôt,
 * sans redemander au serveur ce qu'il vient de dire.
 */
export type SessionPrete = { apiJs: string; config: Record<string, unknown>; mode: "edit" | "view" } | { error: string };

type Etat =
  | { phase: "chargement" }
  | { phase: "ouvert"; mode: "edit" | "view" }
  | { phase: "indisponible"; message: string };

export function EditeurEnLigne({
  type, id, name, secours, hauteur = "78dvh", session, plein = false,
}: {
  type: "drive" | "document";
  id: string;
  name: string;
  /** Ce qu'on montre quand l'éditeur ne peut pas s'ouvrir. */
  secours: (message: string) => React.ReactNode;
  hauteur?: string;
  /** Fournie par la page : l'éditeur démarre sans redemander sa configuration. */
  session?: SessionPrete;
  /** Occupe tout son conteneur, sans cadre ni ligne d'état (le fichier ouvert « plein écran » du Drive). */
  plein?: boolean;
}) {
  const conteneur = `editeur-${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [etat, setEtat] = React.useState<Etat>({ phase: "chargement" });
  // L'ÉDITEUR NE REDÉMARRE QUE SI LE DOCUMENT CHANGE. Un rafraîchissement de la page (commentaire posté,
  // partage modifié, renommage) renvoie une configuration neuve — nouveau jeton, même document : relancer
  // l'éditeur pour cela ferait perdre la position et la saisie en cours. La clé du Document Server
  // (fichier + version) et le mode suffisent à dire si c'est un autre document.
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const cleSession = !session ? "" : "error" in session ? `erreur:${session.error}`
    : `${(session.config.document as { key?: string } | undefined)?.key ?? ""}:${session.mode}`;

  React.useEffect(() => {
    let vivant = true;
    let editeur: { destroyEditor?: () => void } | null = null;
    setEtat({ phase: "chargement" });
    (async () => {
      try {
        let j = sessionRef.current as { apiJs?: string; config?: Record<string, unknown>; mode?: "edit" | "view"; error?: string } | undefined;
        if (!j) {
          const r = await fetch(`/api/onlyoffice/session?type=${type}&id=${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
          j = (await r.json()) as { apiJs?: string; config?: Record<string, unknown>; mode?: "edit" | "view"; error?: string };
          if (!r.ok) throw new Error(j.error ?? "L'éditeur n'est pas disponible.");
        }
        if (!j.apiJs || !j.config) throw new Error(j.error ?? "L'éditeur n'est pas disponible.");
        await chargerScript(j.apiJs);
        if (!vivant || !window.DocsAPI) return;
        const mode = j.mode ?? "view";
        editeur = new window.DocsAPI.DocEditor(conteneur, {
          ...j.config,
          events: {
            onAppReady: () => { if (vivant) setEtat({ phase: "ouvert", mode }); },
            onError: (e: { data?: { errorDescription?: string } }) => {
              if (vivant) setEtat({ phase: "indisponible", message: `L'éditeur a signalé une erreur${e?.data?.errorDescription ? ` : ${e.data.errorDescription}` : ""}.` });
            },
          },
        });
        // Secours si l'éditeur ne signale jamais qu'il est prêt (serveur d'édition qui ne répond pas).
        window.setTimeout(() => {
          if (vivant) setEtat((cur) => (cur.phase === "chargement" ? { phase: "indisponible", message: "L'éditeur ne répond pas." } : cur));
        }, 45_000);
      } catch (e) {
        if (vivant) setEtat({ phase: "indisponible", message: e instanceof Error ? e.message : "L'éditeur n'est pas disponible." });
      }
    })();
    return () => {
      vivant = false;
      try { editeur?.destroyEditor?.(); } catch { /* déjà détruit */ }
    };
  }, [type, id, conteneur, cleSession]);

  if (etat.phase === "indisponible") {
    return plein
      ? <div className="h-full overflow-auto bg-muted/20 p-2 sm:p-3">{secours(etat.message)}</div>
      : <>{secours(etat.message)}</>;
  }

  if (plein) {
    return (
      <div className="relative h-full w-full bg-white">
        {etat.phase === "chargement" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Ouverture dans l&apos;éditeur…
          </div>
        )}
        <div id={conteneur} className="h-full w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {etat.phase === "ouvert" && (etat.mode === "edit"
          ? <><Pencil className="h-3.5 w-3.5 text-primary" /> Modifiable ici — enregistrement automatique</>
          : <><Eye className="h-3.5 w-3.5" /> Lecture seule</>)}
        {etat.phase === "chargement" && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Ouverture de « {name} » dans l&apos;éditeur…</>}
      </div>
      <div className="w-full overflow-hidden rounded-lg border border-border bg-white" style={{ height: hauteur }}>
        <div id={conteneur} className="h-full w-full" />
      </div>
    </div>
  );
}
