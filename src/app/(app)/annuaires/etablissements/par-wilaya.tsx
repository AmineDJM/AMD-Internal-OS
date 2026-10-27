import { MapPin } from "lucide-react";
import type { ParWilaya } from "@/lib/lieux/par-wilaya";

/**
 * LES ÉTABLISSEMENTS ACTIFS PAR WILAYA — lus sur `wilayaCode` (refonte V2-D), pas sur le texte : « Alger »,
 * « ALGER » et « 16 » sont la même ligne sans que personne ait rien nettoyé. La part sans code est dite, pas
 * cachée : c'est ce qui reste à corriger dans les fiches (ou la reprise « lieux-wilaya » pas encore lancée).
 * Composant serveur : il ne reçoit que des comptes.
 */
export function EtablissementsParWilaya({ comptes }: { comptes: ParWilaya }) {
  if (comptes.total === 0) return null;
  return (
    <details className="rounded-lg border bg-card p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <MapPin className="h-4 w-4 text-muted-foreground" />
        Par wilaya — {comptes.rangs.length} wilaya(s), {comptes.total - comptes.sansCode} établissement(s) actif(s) situé(s)
        {comptes.sansCode > 0 && <span className="font-normal text-amber-700">· {comptes.sansCode} sans wilaya reconnue</span>}
      </summary>
      {comptes.rangs.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Aucun établissement n'a encore de code de wilaya : la reprise « lieux-wilaya » (Administration › Refonte des données) ne semble pas avoir été lancée.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {comptes.rangs.map((r) => (
            <li key={r.code} className="rounded-md border px-2 py-0.5 text-xs">
              <span className="text-muted-foreground">{r.code}</span> {r.nom} <span className="font-semibold tabular-nums">{r.n}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
