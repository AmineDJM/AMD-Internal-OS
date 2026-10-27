"use client";

import React, { useRef } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";

/**
 * LES PIÈCES JOINTES DE LA CONVERSATION — plusieurs fichiers, de tout type.
 *
 * Chaque fichier part dans le Drive de la personne par la route de l'écran Drive
 * (`/api/drive/upload` : droits, quotas, formats, chiffrement), et seul son IDENTIFIANT revient.
 * L'assistant reçoit le nom et l'identifiant — jamais le contenu — pour joindre la pièce à une
 * demande ; le serveur revérifie que la personne la voit, à la proposition puis à l'exécution.
 */
export interface PieceJointe {
  cle: string;
  nom: string;
  id?: string;
  etat: "envoi" | "prete" | "erreur";
  erreur?: string;
}

export async function televerser(fichier: File): Promise<{ id: string } | { erreur: string }> {
  const fd = new FormData();
  fd.set("file", fichier);
  try {
    const r = await fetch("/api/drive/upload", { method: "POST", body: fd });
    const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!r.ok || !j.id) return { erreur: j.error ?? "Envoi refusé." };
    return { id: j.id };
  } catch {
    return { erreur: "Connexion interrompue." };
  }
}

export function BoutonJoindre({ onFichiers, desactive }: { onFichiers: (f: File[]) => void; desactive?: boolean }) {
  const champ = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={champ}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onFichiers(f); e.target.value = ""; }}
      />
      <button
        type="button"
        disabled={desactive}
        onClick={() => champ.current?.click()}
        aria-label="Joindre des fichiers"
        title="Joindre des fichiers"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Paperclip className="h-4 w-4" />
      </button>
    </>
  );
}

export function PiecesEnAttente({ pieces, onRetirer }: { pieces: PieceJointe[]; onRetirer: (cle: string) => void }) {
  if (!pieces.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-0.5">
      {pieces.map((p) => (
        <span
          key={p.cle}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
            p.etat === "erreur"
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
              : "border-slate-200 bg-slate-50 text-slate-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          }`}
          title={p.erreur ?? p.nom}
        >
          {p.etat === "envoi" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <FileText className="h-3 w-3 shrink-0" />}
          <span className="truncate">{p.nom}</span>
          {p.etat === "erreur" && <span className="shrink-0">— {p.erreur}</span>}
          <button type="button" onClick={() => onRetirer(p.cle)} aria-label={`Retirer ${p.nom}`} className="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-zinc-800">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Les pièces d'un message envoyé, sous la bulle de la personne. */
export function PiecesDuMessage({ pieces }: { pieces: { id: string; nom: string }[] }) {
  if (!pieces.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {pieces.map((p) => (
        <a key={p.id} href={`/drive/${p.id}`} className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate">{p.nom}</span>
        </a>
      ))}
    </div>
  );
}
