"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Download, FolderOpen, Maximize2, X, Loader2, Film, ImageIcon, BarChart3 } from "lucide-react";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { Card } from "../primitives";
import "./visuel.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN VISUEL GÉNÉRÉ, DANS LA RÉPONSE (lot K2, décision 0032).
 *
 *   • une IMAGE : affichée pleine largeur, PLEIN ÉCRAN au toucher (fond noir, fermeture au bouton, à Échap, au
 *     toucher) ; « Télécharger » et « Ouvrir dans le Drive » en pied ;
 *   • une VIDÉO (modèle ou données) : le LECTEUR NATIF (`playsInline` : elle se lit dans le fil sur iPhone, le plein
 *     écran est celui du système) ;
 *   • EN COURS : la carte relit son état (`etatHref`) toutes les quelques secondes et se transforme en lecteur quand le
 *     fichier est prêt — la conversation, elle, continue ; une notification part à la fin.
 *
 * Les adresses sont des ROUTES de l'ERP (la personne est revérifiée à chaque lecture) : jamais un lien du fournisseur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
type B = Extract<WorkspaceBlock, { kind: "visuel" }>;

interface Etat {
  etat: B["etat"];
  src: string | null;
  telecharger: string | null;
  drive: string | null;
  detail: string | null;
  erreur: string | null;
  progression: number;
}

const FINAL = new Set<B["etat"]>(["pret", "echec"]);
const PAS_MS = 4_000;
const ARRET_APRES_MS = 45 * 60_000;

function useEtatVisuel(b: B): Etat {
  const [e, setE] = React.useState<Etat>({
    etat: b.etat, src: b.src ?? null, telecharger: b.telecharger ?? null, drive: b.drive ?? null,
    detail: b.detail ?? null, erreur: b.erreur ?? null, progression: b.progression ?? 0,
  });
  React.useEffect(() => {
    if (FINAL.has(e.etat)) return;
    let vivant = true;
    const debut = Date.now();
    let minuterie: ReturnType<typeof setTimeout> | null = null;
    const relire = async () => {
      try {
        const r = await fetch(b.etatHref, { cache: "no-store" });
        if (r.ok && vivant) {
          const v = (await r.json()) as Partial<Etat>;
          setE((p) => ({ ...p, ...v, progression: typeof v.progression === "number" ? v.progression : p.progression }));
          if (v.etat && FINAL.has(v.etat)) return;
        }
      } catch {
        // Hors ligne un instant : on relira au pas suivant.
      }
      if (vivant && Date.now() - debut < ARRET_APRES_MS) minuterie = setTimeout(relire, PAS_MS);
    };
    minuterie = setTimeout(relire, PAS_MS);
    return () => { vivant = false; if (minuterie) clearTimeout(minuterie); };
  }, [b.etatHref, e.etat]);
  return e;
}

function PleinEcran({ src, titre, fermer }: { src: string; titre: string; fermer: () => void }) {
  React.useEffect(() => {
    const touche = (ev: KeyboardEvent) => { if (ev.key === "Escape") fermer(); };
    window.addEventListener("keydown", touche);
    const avant = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", touche); document.body.style.overflow = avant; };
  }, [fermer]);
  return createPortal(
    <div className="visuel-plein-ecran" role="dialog" aria-modal="true" aria-label={titre} onClick={fermer}>
      <button type="button" className="visuel-fermer" aria-label="Fermer" onClick={fermer}><X size={22} /></button>
      {/* eslint-disable-next-line @next/next/no-img-element -- route ERP dynamique, pas un asset */}
      <img src={src} alt={titre} onClick={(ev) => ev.stopPropagation()} />
    </div>,
    document.body,
  );
}

const ICONE = { image: ImageIcon, video: Film, "video-donnees": BarChart3 } as const;
const LIBELLE_ATTENTE: Record<B["nature"], string> = {
  image: "Image en cours",
  video: "Vidéo en cours",
  "video-donnees": "Vidéo de données en cours",
};

export function VisuelBlock({ b }: { b: B }) {
  const e = useEtatVisuel(b);
  const [plein, setPlein] = React.useState(false);
  const Icone = ICONE[b.nature] ?? ImageIcon;
  const fermer = React.useCallback(() => setPlein(false), []);

  return (
    <Card title={b.title} meta={<span className="visuel-meta"><Icone size={14} aria-hidden /> {b.nature === "image" ? "Image" : b.nature === "video" ? "Vidéo" : "Vidéo de données"}</span>}>
      {e.etat === "pret" && e.src ? (
        b.nature === "image" ? (
          <button type="button" className="visuel-cadre visuel-image" onClick={() => setPlein(true)} aria-label={`Voir « ${b.title} » en plein écran`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- route ERP dynamique, pas un asset */}
            <img src={e.src} alt={b.title} loading="lazy" />
            <span className="visuel-agrandir" aria-hidden><Maximize2 size={16} /></span>
          </button>
        ) : (
          <div className="visuel-cadre">
            {/* Le lecteur natif : plein écran du système, lecture dans le fil sur iPhone. */}
            <video className="visuel-video" src={`${e.src}#t=0.1`} controls playsInline preload="metadata" aria-label={b.title} />
          </div>
        )
      ) : e.etat === "echec" ? (
        <p className="visuel-erreur" role="alert">{e.erreur ?? "La génération n'a pas abouti."}</p>
      ) : (
        <div className="visuel-attente" role="status" aria-live="polite">
          <Loader2 size={20} className="visuel-tourne" aria-hidden />
          <div className="visuel-attente-texte">
            <strong>{LIBELLE_ATTENTE[b.nature]}{e.progression > 0 ? ` — ${e.progression} %` : ""}</strong>
            <span>
              {b.nature === "image" ? "Quelques secondes." : "Vous pouvez continuer à discuter : la vidéo apparaîtra ici, et une notification vous préviendra."}
            </span>
            {e.progression > 0 ? <span className="visuel-barre" aria-hidden><span style={{ width: `${e.progression}%` }} /></span> : null}
          </div>
        </div>
      )}
      {e.etat === "pret" ? (
        <div className="visuel-pied">
          {e.detail ? <span className="visuel-detail">{e.detail}</span> : null}
          <div className="visuel-gestes">
            {e.telecharger ? <a className="visuel-geste" href={e.telecharger} download><Download size={16} aria-hidden /> Télécharger</a> : null}
            {e.drive ? <a className="visuel-geste" href={e.drive}><FolderOpen size={16} aria-hidden /> Drive</a> : null}
          </div>
        </div>
      ) : null}
      {plein && e.src ? <PleinEcran src={e.src} titre={b.title} fermer={fermer} /> : null}
    </Card>
  );
}
