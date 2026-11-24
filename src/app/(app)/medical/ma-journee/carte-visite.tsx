"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ETAT_VISITE_LABELS } from "@/lib/sfe/tournee";
import { alertePvOuverte } from "@/lib/sfe/compte-rendu-envoye";
import { lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import type { CarteVisite } from "@/lib/sfe/journee-visite";
import type { Lettre } from "@/lib/segmentation/regles";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { EntreeMenu, MenuPlus } from "../menu-plus";
import { tonEtatVisite } from "./emploi-du-temps";
import type { LigneVue } from "./types-visite";

/** L'heure d'une visite, quand le plan en a posé une (minuit = « dans la journée », on ne l'affiche pas). */
export function heureDe(iso: string): string | null {
  const d = new Date(iso);
  if (d.getHours() === 0 && d.getMinutes() === 0) return null;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** L'itinéraire : l'établissement et la wilaya, ouverts dans l'application de cartes du téléphone. */
export function lienItineraire(etablissement: string | null, wilaya: string | null): string | null {
  const q = [etablissement, wilaya].filter(Boolean).join(", ");
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${q}, Algérie`)}` : null;
}

const jourCourt = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

/**
 * UNE VISITE DU JOUR (maquette du délégué, 24/11/2026) — l'heure et son rang dans la tournée, la lettre, le médecin (sa
 * fiche), d'où vient la visite, son état, « spécialité · établissement · dernier passage », l'objectif, les produits
 * prévus ; UN geste visible (« Commencer », « Voir » le compte rendu envoyé), le reste dans ⋯.
 */
export function CarteVisiteDuJour({
  l, rang, lettre, dernierPassage, estProchaine, occupe, peutSignalerPv, onCommencer, onVoir, onNonTenue,
}: {
  l: CarteVisite<LigneVue>;
  rang: number;
  lettre: Lettre | null;
  /** ISO de la dernière visite rapportée chez ce médecin (hors celle-ci). */
  dernierPassage: string | null;
  estProchaine: boolean;
  occupe: boolean;
  peutSignalerPv: boolean;
  onCommencer: () => void;
  onVoir: () => void;
  onNonTenue: () => void;
}) {
  const heure = heureDe(l.date);
  const alertePv = l.etat === "FAITE" && l.lecture ? alertePvOuverte(l.lecture) : false;
  const horsPlan = l.origine === "UNPLANNED";
  const itineraire = lienItineraire(l.institution, l.wilaya);
  const fini = l.etat === "FAITE" || l.etat === "ANNULEE" || l.etat === "REPORTEE";
  return (
    <li className={cn(
      "rounded-xl border bg-card px-3 py-3 sm:px-4",
      estProchaine ? "border-primary/60 shadow-[inset_3px_0_0_hsl(var(--primary))]" : "border-border",
    )}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="w-12 shrink-0">
          <p className="text-sm font-semibold tabular-nums">{heure ?? "—"}</p>
          <p className="text-xs text-muted-foreground">{horsPlan ? "hors plan" : `n° ${rang}`}</p>
        </div>
        <div className={cn("min-w-0 flex-1 basis-56 space-y-1", fini && "opacity-80")}>
          <p className="flex min-w-0 flex-wrap items-center gap-1.5">
            {lettre && <LettreBadge lettre={lettre} className="h-5 min-w-[22px] shrink-0" />}
            {l.doctorId ? (
              <Link href={`/praticiens/${l.doctorId}`} className="min-w-0 truncate font-semibold hover:underline">{l.doctorName}</Link>
            ) : <span className="min-w-0 truncate font-semibold">{l.doctorName}</span>}
            {l.origine === "DIRECTION" && <Badge tone="warning" dot={false}>Demandée par la Direction</Badge>}
            {horsPlan && <Badge tone="neutral" dot={false}>Hors plan</Badge>}
            {alertePv
              ? <Badge tone="danger">Possible PV — à déclarer</Badge>
              : <Badge tone={tonEtatVisite(l.etat)}>{l.etat === "FAITE" ? "Compte rendu envoyé" : ETAT_VISITE_LABELS[l.etat]}</Badge>}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[l.specialty, l.institution].filter(Boolean).join(" · ") || "—"}
            {dernierPassage ? ` · dernier passage ${jourCourt(dernierPassage)}` : " · première visite"}
          </p>
          {l.objectif && <p className="text-sm [overflow-wrap:anywhere]"><span className="font-medium">Objectif :</span> <span className="text-muted-foreground">{l.objectif}</span></p>}
          {l.produits.length > 0 && (
            <p className="flex flex-wrap gap-1.5">
              {l.produits.map((p) => <Badge key={p} tone="info" dot={false}>{p}</Badge>)}
            </p>
          )}
          {l.motifNonTenue && <p className="text-xs text-warning [overflow-wrap:anywhere]">{l.motifNonTenue}</p>}
          {l.geste === "COMMENCER" && l.heuresRestantes <= 12 && (
            <p className="inline-flex items-center gap-1 text-xs text-warning"><Clock className="h-3 w-3" aria-hidden /> {l.heuresRestantes} h pour rapporter</p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {l.geste === "COMMENCER" && (
            <Button variant={estProchaine ? "primary" : "outline"} className="h-10" onClick={onCommencer} disabled={occupe}>Commencer</Button>
          )}
          {l.etat === "FAITE" && (
            <Button variant={alertePv ? "primary" : "outline"} className="h-10" onClick={onVoir} disabled={occupe}>Voir</Button>
          )}
          {l.etat === "FAITE" && !alertePv && l.geste === "AUCUN" && <Check className="h-4 w-4 text-success" aria-label="Compte rendu envoyé" />}
          <MenuPlus label="Autres actions sur la visite">
            {l.doctorId && <EntreeMenu href={`/praticiens/${l.doctorId}`}>Fiche du médecin</EntreeMenu>}
            {itineraire && <EntreeMenu href={itineraire} brut nouvelOnglet>Itinéraire</EntreeMenu>}
            {l.etat === "A_FAIRE" && !horsPlan && <EntreeMenu onClick={onNonTenue}>Reporter ou annuler (visite non tenue)</EntreeMenu>}
            {peutSignalerPv && l.doctorId && (
              <EntreeMenu href={l.etat === "FAITE" ? lienSignalerPv(l.doctorId, l.id) : lienSignalerPv(l.doctorId)}>Signaler un cas de pharmacovigilance</EntreeMenu>
            )}
          </MenuPlus>
        </div>
      </div>
    </li>
  );
}
