"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Clock, History } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { lienSignalerPv } from "@/lib/chemins/rapports-terrain";
import { jourLocal } from "@/lib/sfe/journee-visite";
import type { StockPourVisite } from "@/lib/queries/promo-remises";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { FormulaireRapport } from "./formulaire-rapport";
import type { ContexteVisite, DerniereVisiteVue, GammeVue, LigneVue, OuvertureVisite } from "./types-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FEUILLE « VISITE » (11/2026) — plein écran au téléphone, panneau à droite sur ordinateur.
 *
 * Elle s'ouvre sur ce qu'un délégué regarde en entrant dans le cabinet : QUI (lettre, spécialité,
 * établissement, « n / m visites ce mois », la fiche complète), et « LA DERNIÈRE FOIS » — ce qui a été
 * présenté, dit, remis, et ce qu'il restait à faire. Puis le rapport : trois champs, le reste replié ; le
 * signalement d'un effet indésirable prérempli ; « La visite n'a pas eu lieu ? » pour une visite prévue.
 *
 * La même feuille pour une visite PLANIFIÉE (« Ma journée », la grille du plan) et une visite HORS PLAN :
 * l'écran hôte dit seulement comment enregistrer (`enregistrer`) — directement, ou par la file hors ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le jour lisible d'une visite — « lun. 24/11 ». */
const jourCourt = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });

export function FeuilleVisite({
  ouverte, contexte, onClose, gamme, stock, precoches, occupe, err, enregistrer, onNonTenue, peutSignalerPv = false,
}: {
  ouverte: OuvertureVisite | null;
  /** Ce que l'écran hôte sait en plus du praticien (lettre, fréquence, dernières visites) ; absent sur la grille du plan. */
  contexte?: ContexteVisite | null;
  onClose: () => void;
  gamme: GammeVue;
  stock: StockPourVisite;
  /** Les produits de la mallette du mois, cochés d'office (hors correction). */
  precoches?: readonly string[];
  occupe: boolean;
  err: string | null;
  /** Enregistre le formulaire ; vrai si la feuille peut se fermer. Le formulaire porte déjà `visitId` ou `doctorId`. */
  enregistrer: (fd: FormData, o: OuvertureVisite) => Promise<boolean>;
  /** « La visite n'a pas eu lieu ? » (§118.193) — offert sur une visite planifiée encore à faire. */
  onNonTenue?: (l: LigneVue) => void;
  peutSignalerPv?: boolean;
}) {
  const ligne = ouverte?.sorte === "PLANIFIEE" ? ouverte.ligne : null;
  const correction = ligne?.etat === "FAITE";
  const nom = ouverte ? (ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.doctorName : ouverte.praticien.name) : "";
  const doctorId = ouverte ? (ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.doctorId ?? null : ouverte.praticien.id) : null;
  const specialite = ouverte ? (ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.specialty : ouverte.praticien.specialty) : null;
  const etablissement = ouverte ? (ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.institution : ouverte.praticien.institution) : null;
  const wilaya = ouverte ? (ouverte.sorte === "PLANIFIEE" ? ouverte.ligne.wilaya : ouverte.praticien.wilaya) : null;
  const lettre = contexte?.lettre ?? (ouverte?.sorte === "HORS_PLAN" ? ouverte.praticien.lettre ?? null : null);
  // « LA DERNIÈRE FOIS » ne se cite pas elle-même : la visite qu'on corrige est écartée.
  const derniere: DerniereVisiteVue | null = (contexte?.dernieres ?? []).find((d) => d.visitId !== ligne?.id) ?? null;
  const aujourdhui = jourLocal(new Date());
  const jourDeLaVisite = ligne ? jourLocal(new Date(ligne.date)) : aujourdhui;
  const lienPv = peutSignalerPv && doctorId
    ? (produitId: string | null) => lienSignalerPv(doctorId, { produitId, date: jourDeLaVisite })
    : null;

  return (
    <Sheet
      open={ouverte !== null}
      onClose={onClose}
      title={nom}
      description={ligne
        ? `${correction ? "Corriger le rapport — " : ""}visite du ${jourCourt(ligne.date)}`
        : ouverte ? "Visite hors plan" : ""}
      width="md"
      pleinEcran
    >
      {ouverte && (
        <div className="space-y-4">
          {/* ── QUI ─────────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {lettre && <LettreBadge lettre={lettre} className="h-6 shrink-0" />}
              <span className="min-w-0 text-muted-foreground">{[specialite, etablissement, wilaya].filter(Boolean).join(" · ") || "—"}</span>
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {contexte?.frequence && contexte.frequence.attendues > 0 && (
                <span><strong className="tabular-nums text-foreground">{contexte.frequence.faites} / {contexte.frequence.attendues}</strong> visites ce mois</span>
              )}
              {ligne && ligne.heuresRestantes > 0 && (
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden /> {ligne.heuresRestantes} h pour rapporter</span>
              )}
              {doctorId && (
                <Link href={`/praticiens/${doctorId}`} className="inline-flex min-h-9 items-center gap-0.5 text-primary hover:underline sm:min-h-0">
                  Fiche complète <ArrowUpRight className="h-3 w-3" aria-hidden />
                </Link>
              )}
            </p>
            {ligne?.origine === "DIRECTION" && (
              <Badge tone="info" dot={false}>Demandée par la Direction{ligne.objectif ? ` — ${ligne.objectif}` : ""}</Badge>
            )}
          </div>

          {/* ── LA DERNIÈRE FOIS ────────────────────────────────────────────── */}
          {contexte?.dernieres && (
            <section aria-label="La dernière fois" className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <History className="h-3.5 w-3.5" aria-hidden /> La dernière fois{derniere ? ` — ${jourCourt(derniere.date)}` : ""}
              </p>
              {derniere ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {derniere.produits.length > 0 && <><dt className="text-muted-foreground">Produits</dt><dd>{derniere.produits.join(" · ")}</dd></>}
                  {derniere.messages.length > 0 && <><dt className="text-muted-foreground">Messages</dt><dd>{derniere.messages.join(" · ")}</dd></>}
                  {derniere.materiel.length > 0 && <><dt className="text-muted-foreground">Remis</dt><dd>{derniere.materiel.join(" · ")}</dd></>}
                  <dt className="text-muted-foreground">À faire</dt><dd className={derniere.suite ? "font-medium" : "text-muted-foreground"}>{derniere.suite ?? "—"}</dd>
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">Aucune visite rapportée chez ce praticien : c&apos;est la première.</p>
              )}
            </section>
          )}

          {ligne && onNonTenue && ligne.etat === "A_FAIRE" && (
            <button
              type="button"
              onClick={() => onNonTenue(ligne)}
              disabled={occupe}
              className="inline-flex min-h-10 items-center text-sm text-primary hover:underline disabled:opacity-50 sm:min-h-8"
            >
              La visite n&apos;a pas eu lieu ?
            </button>
          )}

          <FormulaireRapport
            key={ligne?.id ?? `hors-plan-${doctorId}`}
            action={async (fd) => {
              if (ouverte.sorte === "PLANIFIEE") fd.set("visitId", ouverte.ligne.id);
              else fd.set("doctorId", ouverte.praticien.id);
              if (await enregistrer(fd, ouverte)) onClose();
            }}
            produits={gamme.produits}
            produitsIncomplets={gamme.produitsIncomplets}
            messages={gamme.messages}
            sansBu={gamme.sansBu}
            // UNE CORRECTION N'EXIGE PAS PLUS QUE LA CRÉATION : la règle est au serveur, l'écran la reflète — une visite
            // hors plan, ou une visite rapportée sans message, se corrige sans message (§118.166).
            messageObligatoire={ligne !== null && ligne.origine !== "UNPLANNED" && !(correction && ligne.messageIds.length === 0)}
            produitObligatoire={ligne !== null && ligne.origine !== "UNPLANNED" && !(correction && ligne.produitIds.length === 0)}
            stock={stock}
            precoches={precoches}
            initial={ligne && correction ? {
              texte: ligne.rapport ?? "", suite: ligne.suite ?? "",
              produitIds: ligne.produitIds, messageIds: ligne.messageIds, remises: ligne.remises,
            } : undefined}
            libelleEnvoi={correction ? "Enregistrer la correction" : "Enregistrer la visite"}
            potentiel={ligne?.potentiel ?? null}
            besoin={ligne?.besoin ?? null}
            busy={occupe}
            err={err}
            onCancel={onClose}
            lienPv={lienPv}
            entete={ouverte.sorte === "HORS_PLAN" ? (
              // LE JOUR D'UNE VISITE HORS PLAN : aujourd'hui d'office ; hier se choisit (la même borne de 48 h).
              <div className="flex items-center gap-2">
                <Label htmlFor="visite-jour" className="shrink-0 text-sm">Jour de la visite</Label>
                <Input id="visite-jour" name="date" type="date" defaultValue={aujourdhui} max={aujourdhui} className="w-auto" />
              </div>
            ) : undefined}
          />
        </div>
      )}
    </Sheet>
  );
}
