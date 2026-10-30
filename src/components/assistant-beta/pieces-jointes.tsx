"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Archive, CheckCircle2, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Loader2,
  Paperclip, Presentation, ShieldAlert, X,
} from "lucide-react";
import { resumeLecture, type LecturePiece } from "@/lib/agent/lecture/regles";
import { familleIcone, phraseLecturePartielle, tailleLisible, type FamilleIcone } from "@/lib/agent/lecture/depot";

/**
 * LES PIÈCES JOINTES DE LA CONVERSATION — plusieurs fichiers, de tout type, et des dossiers entiers.
 *
 * Décision 0015 (glisser-déposer) : un fichier déposé, collé ou choisi devient une PUCE dans la zone
 * de saisie (nom ou chemin relatif, taille, icône, miniature d'une image). RIEN n'est téléversé avant
 * Entrée : une puce retirée ne laisse rien dans le Drive. À l'envoi, chaque fichier part dans le
 * Drive de la personne (`/api/drive/upload` : droits, quotas, formats, chiffrement) avec sa
 * progression, et seul son IDENTIFIANT rejoint le message. Le serveur revérifie que la personne la
 * voit, puis la LIT (`lib/agent/lecture/`) ; sous chaque pièce envoyée, l'écran DIT ce que la lecture
 * a donné. Une pièce s'ouvre d'un clic dans l'aperçu (`apercu-piece.tsx`).
 */
export interface PieceJointe {
  cle: string;
  /** Le nom affiché — le CHEMIN RELATIF pour un fichier venu d'un dossier (« Congrès Oran/devis/imprimeur.pdf »). */
  nom: string;
  taille?: number;
  type?: string;
  /** Le fichier local, pas encore téléversé (absent pour une pièce déjà dans le Drive). */
  fichier?: File;
  /** Miniature locale d'une image (adresse `blob:` de l'onglet). */
  miniature?: string;
  /** Identifiant Drive — après téléversement, ou d'emblée pour une pièce reprise du Drive. */
  id?: string;
  etat: "attente" | "envoi" | "prete" | "erreur";
  /** 0 → 1 pendant le téléversement. */
  progression?: number;
  erreur?: string;
  /** Ce que l'écran dit d'avance (nom de pièce du coffre : jointe, pas lue). */
  avertissement?: string | null;
}

const ICONES: Record<FamilleIcone, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  image: FileImage, pdf: FileText, word: FileText, tableur: FileSpreadsheet, presentation: Presentation,
  audio: FileAudio, video: FileVideo, archive: Archive, texte: FileText, autre: FileText,
};
const TEINTES: Partial<Record<FamilleIcone, string>> = {
  pdf: "text-red-600 dark:text-red-400", word: "text-blue-600 dark:text-blue-400", tableur: "text-emerald-600 dark:text-emerald-400",
  presentation: "text-orange-600 dark:text-orange-400", image: "text-violet-600 dark:text-violet-400",
};

export function IconePiece({ nom, type, className = "h-3.5 w-3.5" }: { nom: string; type?: string; className?: string }) {
  const f = familleIcone(nom, type);
  const Icone = ICONES[f];
  return <Icone className={`${className} shrink-0 ${TEINTES[f] ?? ""}`} aria-hidden />;
}

const tactile = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/**
 * LE TROMBONE — des fichiers, ou un DOSSIER entier (`webkitdirectory`). Sur téléphone (pas de
 * glisser-déposer), il ouvre directement le choix des fichiers : le choix d'un dossier n'y existe pas.
 */
export function BoutonJoindre({ onFichiers, desactive }: { onFichiers: (f: File[]) => void; desactive?: boolean }) {
  const champ = useRef<HTMLInputElement>(null);
  const dossier = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const racine = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // `webkitdirectory` n'est pas un attribut connu de React : posé à la main.
    dossier.current?.setAttribute("webkitdirectory", "");
    dossier.current?.setAttribute("directory", "");
  }, []);
  const recu = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files ?? []);
    if (f.length) onFichiers(f);
    e.target.value = "";
  };
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800";
  return (
    <div
      ref={racine}
      className="relative"
      // Le menu se ferme quand le focus quitte le trombone (clic ailleurs, Tab) ou sur Échap.
      onBlur={(e) => { if (!racine.current?.contains(e.relatedTarget as Node | null)) setMenu(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && menu) { e.stopPropagation(); setMenu(false); } }}
    >
      <input ref={champ} type="file" multiple className="hidden" onChange={recu} data-testid="joindre-fichiers" />
      <input ref={dossier} type="file" multiple className="hidden" onChange={recu} data-testid="joindre-dossier" />
      <button
        type="button"
        disabled={desactive}
        onClick={() => (tactile() ? champ.current?.click() : setMenu((m) => !m))}
        aria-label="Joindre des fichiers ou un dossier"
        aria-haspopup="menu"
        aria-expanded={menu}
        title="Joindre des fichiers ou un dossier (ou glissez-les sur la conversation)"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      {menu && (
        <div role="menu" className="absolute bottom-12 left-0 z-40 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <button type="button" role="menuitem" autoFocus className={item} onClick={() => { setMenu(false); champ.current?.click(); }}>
            <Paperclip className="h-4 w-4" /> Des fichiers…
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); dossier.current?.click(); }}>
            <Folder className="h-4 w-4" /> Un dossier…
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * LES PUCES EN ATTENTE — au-dessus du champ. Un clic (ou Espace) SÉLECTIONNE une puce ; Suppr ou
 * Retour arrière retire la sélection (ou la puce qui a le focus) ; la croix retire une puce ;
 * « Tout retirer » vide tout. Pendant l'envoi, la progression de chaque fichier ; un échec se lit sur
 * la puce, en clair.
 */
export function PiecesEnAttente({ pieces, onRetirer, verrou }: { pieces: PieceJointe[]; onRetirer: (cles: string[]) => void; verrou?: boolean }) {
  const [choisies, setChoisies] = useState<Set<string>>(new Set());
  // Une puce retirée n'est plus sélectionnée.
  useEffect(() => {
    setChoisies((s) => {
      const restantes = new Set([...s].filter((c) => pieces.some((p) => p.cle === c)));
      return restantes.size === s.size ? s : restantes;
    });
  }, [pieces]);
  if (!pieces.length) return null;
  const basculer = (cle: string) => setChoisies((s) => { const n = new Set(s); if (n.has(cle)) n.delete(cle); else n.add(cle); return n; });
  const retirer = (cles: string[]) => { if (!verrou && cles.length) onRetirer(cles); };
  const surTouche = (e: React.KeyboardEvent, cle: string, i: number) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      retirer(choisies.size ? [...choisies] : [cle]);
      // Le focus passe à la puce voisine (ou au champ), pas dans le vide.
      const voisins = (e.currentTarget.closest("[data-puces]")?.querySelectorAll<HTMLElement>("[data-puce]")) ?? [];
      const suivant = voisins[i + 1] ?? voisins[i - 1];
      if (suivant) setTimeout(() => suivant.focus(), 0);
      else setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Votre message']")?.focus(), 0);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const voisins = (e.currentTarget.closest("[data-puces]")?.querySelectorAll<HTMLElement>("[data-puce]")) ?? [];
      voisins[e.key === "ArrowRight" ? i + 1 : i - 1]?.focus();
    }
  };
  const lecture = phraseLecturePartielle(pieces.length);
  return (
    <div className="px-1 pb-1.5 pt-0.5">
      <div role="group" aria-label={`${pieces.length} pièce${pieces.length > 1 ? "s" : ""} jointe${pieces.length > 1 ? "s" : ""} — Suppr retire la sélection`} data-puces className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {pieces.map((p, i) => {
          const choisie = choisies.has(p.cle);
          return (
            <div
              key={p.cle}
              data-testid="puce"
              className={`group relative inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-lg border py-1 pl-1 pr-1 text-xs ${
                p.etat === "erreur"
                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                  : choisie
                    ? "border-violet-400 bg-violet-50 text-violet-900 ring-1 ring-violet-400 dark:border-violet-500 dark:bg-violet-950/40 dark:text-violet-100"
                    : "border-slate-200 bg-slate-50 text-slate-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              }`}
            >
              <button
                type="button"
                data-puce
                aria-pressed={choisie}
                aria-label={`${p.nom}${p.taille ? `, ${tailleLisible(p.taille)}` : ""}${p.etat === "erreur" ? `, erreur : ${p.erreur}` : ""}${p.avertissement ? `, ${p.avertissement}` : ""} — ${choisie ? "sélectionnée" : "appuyer pour sélectionner"}`}
                title={p.erreur ?? p.avertissement ?? p.nom}
                onClick={() => basculer(p.cle)}
                onKeyDown={(e) => surTouche(e, p.cle, i)}
                className="flex min-w-0 items-center gap-1.5 rounded px-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                {p.miniature ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.miniature} alt="" className="h-7 w-7 shrink-0 rounded object-cover" />
                ) : p.etat === "envoi" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                ) : p.etat === "erreur" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <IconePiece nom={p.nom} type={p.type} />
                )}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="max-w-[14rem] truncate sm:max-w-[18rem]">{p.nom}</span>
                  <span className="truncate text-[10px] opacity-75">
                    {p.etat === "erreur" ? p.erreur
                      : p.etat === "envoi" ? `Envoi… ${Math.round((p.progression ?? 0) * 100)} %`
                        : [p.taille ? tailleLisible(p.taille) : null, p.id && !p.fichier ? "dans votre Drive" : null, p.avertissement ? "jointe, non lue" : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {p.avertissement && <ShieldAlert className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
              </button>
              <button
                type="button"
                disabled={verrou}
                onClick={() => retirer([p.cle])}
                aria-label={`Retirer ${p.nom}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-zinc-800"
              >
                <X className="h-3 w-3" />
              </button>
              {p.etat === "envoi" && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-slate-200 dark:bg-zinc-800" aria-hidden>
                  <span className="block h-full bg-violet-600 transition-[width]" style={{ width: `${Math.round((p.progression ?? 0) * 100)}%` }} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      {(pieces.length > 1 || lecture) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
          {lecture && <span className="text-amber-700 dark:text-amber-400">{lecture}</span>}
          {choisies.size > 0 && (
            <button type="button" disabled={verrou} onClick={() => retirer([...choisies])} className="font-medium text-slate-700 underline-offset-2 hover:underline disabled:opacity-40 dark:text-zinc-200">
              Retirer la sélection ({choisies.size})
            </button>
          )}
          {pieces.length > 1 && (
            <button type="button" disabled={verrou} onClick={() => retirer(pieces.map((p) => p.cle))} className="font-medium text-slate-700 underline-offset-2 hover:underline disabled:opacity-40 dark:text-zinc-200">
              Tout retirer
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface PieceOuvrable {
  id: string;
  nom: string;
}

const pastille = "inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";

/** Les pièces d'un message envoyé, sous la bulle de la personne — et ce que leur lecture a donné. Un clic ouvre l'aperçu. */
export function PiecesDuMessage({ pieces, lectures, onOuvrir }: { pieces: PieceOuvrable[]; lectures?: LecturePiece[] | null; onOuvrir?: (p: PieceOuvrable) => void }) {
  if (!pieces.length) return null;
  const parId = new Map((lectures ?? []).map((l) => [l.id, l]));
  return (
    <div className="flex max-w-full flex-col items-end gap-1">
      {pieces.map((p) => {
        const l = parId.get(p.id);
        const Icone = !l ? null : l.statut === "LUE" ? CheckCircle2 : l.statut === "REFUSEE" ? ShieldAlert : AlertTriangle;
        const teinte = !l ? "" : l.statut === "LUE" ? "text-emerald-600 dark:text-emerald-400" : l.statut === "REFUSEE" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400";
        const contenu = (
          <>
            {Icone ? <Icone className={`h-3 w-3 shrink-0 ${teinte}`} aria-hidden /> : <IconePiece nom={p.nom} className="h-3 w-3" />}
            <span className="truncate">{p.nom}</span>
          </>
        );
        return (
          <div key={p.id} className="flex max-w-full flex-col items-end gap-0.5">
            {onOuvrir
              ? <button type="button" onClick={() => onOuvrir(p)} className={pastille} aria-label={`Ouvrir l'aperçu de ${p.nom}`} data-testid="piece-message">{contenu}</button>
              : <a href={`/drive/${p.id}`} className={pastille}>{contenu}</a>}
            {l && (
              <p className={`max-w-[18rem] text-right text-[11px] leading-snug [overflow-wrap:anywhere] ${l.statut === "LUE" ? "text-slate-500 dark:text-zinc-400" : teinte}`}>
                {resumeLecture(l)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Les fichiers que l'ASSISTANT a renvoyés (document créé, traduction…) — ouvrables dans l'aperçu. */
export function PiecesRendues({ pieces, onOuvrir }: { pieces: PieceOuvrable[]; onOuvrir: (p: PieceOuvrable) => void }) {
  if (!pieces.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Fichiers renvoyés par l'assistant">
      {pieces.map((p) => (
        <button key={p.id} type="button" onClick={() => onOuvrir(p)} className={pastille} aria-label={`Ouvrir l'aperçu de ${p.nom}`} data-testid="piece-rendue">
          <IconePiece nom={p.nom} className="h-3 w-3" />
          <span className="truncate">{p.nom}</span>
        </button>
      ))}
    </div>
  );
}
