"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { duree } from "../domaine/lecture/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LECTEUR D'UN VOCAL DANS LA BULLE — le message vocal de la personne, ou la réponse parlée.
 *
 * L'audio est un fichier du Drive, relu par `/api/drive/<id>/raw` (droits revérifiés à chaque
 * lecture). Il est chargé EN ENTIER au premier appui puis joué depuis la mémoire de l'onglet : la
 * route du Drive ne sert pas les plages d'octets, et Safari (iPhone) refuse de jouer un média sans
 * elles. Un vocal pèse quelques centaines de kilo-octets — rien n'est chargé tant qu'on n'écoute pas.
 * Un vocal tout juste enregistré se joue depuis son enregistrement local (`src` direct).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BulleVocaleProps {
  /** Identifiant Drive — ou `null` tant que l'envoi n'est pas fini (`local` est alors joué). */
  id: string | null;
  local?: string | null;
  dureeS: number | null;
  /** Bulle de la personne (sombre) ou de l'assistant (claire). */
  sombre?: boolean;
  libelle: string;
}

const BARRES = 28;

/** Une silhouette d'onde STABLE pour un vocal donné (tirée de son identifiant) : la même à chaque affichage. */
function silhouette(graine: string): number[] {
  let h = 2166136261;
  for (const c of graine) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: BARRES }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 16777619);
    return 0.25 + ((h >>> 0) % 1000) / 1000 * 0.75;
  });
}

export function BulleVocale({ id, local, dureeS, sombre = false, libelle }: BulleVocaleProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(local ?? null);
  const [etat, setEtat] = useState<"pret" | "chargement" | "lecture" | "pause" | "erreur">("pret");
  const [position, setPosition] = useState(0);
  const [total, setTotal] = useState<number | null>(dureeS);
  const barres = useMemo(() => silhouette(id ?? local ?? "vocal"), [id, local]);

  useEffect(() => () => {
    audio.current?.pause();
    if (url.current && url.current !== local && url.current.startsWith("blob:")) URL.revokeObjectURL(url.current);
  }, [local]);

  const basculer = async () => {
    if (etat === "lecture") { audio.current?.pause(); return; }
    try {
      if (!audio.current) {
        if (!url.current) {
          if (!id) return;
          setEtat("chargement");
          const r = await fetch(`/api/drive/${id}/raw`, { cache: "force-cache" });
          if (!r.ok) throw new Error(String(r.status));
          url.current = URL.createObjectURL(await r.blob());
        }
        const a = new Audio(url.current);
        a.onloadedmetadata = () => { if (Number.isFinite(a.duration) && a.duration > 0) setTotal(a.duration); };
        a.ontimeupdate = () => setPosition(a.currentTime);
        a.onplay = () => setEtat("lecture");
        a.onpause = () => setEtat("pause");
        a.onended = () => { setEtat("pret"); setPosition(0); };
        a.onerror = () => setEtat("erreur");
        audio.current = a;
      }
      await audio.current.play();
    } catch {
      setEtat("erreur");
    }
  };

  const part = total ? Math.min(1, position / total) : 0;
  const teinte = sombre ? "bg-white" : "bg-slate-700 dark:bg-zinc-200";
  const fond = sombre ? "bg-white/35" : "bg-slate-300 dark:bg-zinc-600";

  return (
    <div className={`flex w-full min-w-[12.5rem] max-w-[17rem] items-center gap-2.5 ${sombre ? "text-white dark:text-zinc-900" : "text-slate-800 dark:text-zinc-100"}`}>
      <button
        type="button"
        onClick={() => void basculer()}
        aria-label={etat === "lecture" ? `Mettre en pause — ${libelle}` : `Écouter — ${libelle}`}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${sombre ? "bg-white/15 hover:bg-white/25 dark:bg-zinc-900/10" : "bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800"}`}
      >
        {etat === "chargement" ? <Loader2 className="h-4 w-4 animate-spin" /> : etat === "lecture" ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center gap-[2px]" aria-hidden>
          {barres.map((b, i) => (
            <span key={i} className={`w-[3px] shrink-0 rounded-full ${i / BARRES < part ? teinte : fond}`} style={{ height: `${Math.round(b * 100)}%` }} />
          ))}
        </div>
        <span className="font-mono text-[11px] tabular-nums opacity-75">
          {etat === "erreur" ? "Lecture impossible" : etat === "lecture" || etat === "pause" ? `${duree(position)} / ${duree(total)}` : duree(total)}
        </span>
      </div>
    </div>
  );
}
