"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { LigneRapport } from "@/lib/queries/rapports-terrain-liste";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { SupprimerRapport } from "./supprimer-rapport";

const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });

const TON_TYPE: Record<LigneRapport["type"], "info" | "neutral" | "warning"> = { VISITE: "info", SANS_VISITE: "neutral", PV: "warning" };

/**
 * LA LISTE DES RAPPORTS — un TABLEAU, au téléphone aussi (il défile dans son cadre, la date reste collée à gauche).
 * Toucher une ligne ouvre le rapport dans une feuille latérale : ce qui a été dit, montré, demandé. La fiche d'un
 * compte rendu vocal ou d'un cas de pharmacovigilance s'ouvre depuis la feuille — un geste par ligne.
 */
export function ListeRapports({ lignes, avecDelegue }: { lignes: LigneRapport[]; avecDelegue: boolean }) {
  const [ouverte, setOuverte] = React.useState<LigneRapport | null>(null);
  const colonnes = avecDelegue ? 7 : 6;

  return (
    <>
      <div className="overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="sticky left-0 z-10 border-b border-r border-border bg-card px-3 py-2 font-medium">Date</th>
              {avecDelegue && <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">Délégué</th>}
              <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">Praticien</th>
              <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">Produits</th>
              <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">Messages</th>
              <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">Type</th>
              <th scope="col" className="border-b border-border bg-card px-3 py-2 font-medium">État</th>
            </tr>
          </thead>
          <tbody>
            {lignes.length === 0 && (
              <tr>
                <td colSpan={colonnes} className="px-3 py-10 text-center text-muted-foreground">Aucun rapport sur cette période.</td>
              </tr>
            )}
            {lignes.map((l) => (
              <tr
                key={l.cle}
                tabIndex={0}
                role="button"
                aria-label={`Ouvrir le rapport — ${l.professionnel ?? "praticien non précisé"}, ${jour(l.date)}`}
                onClick={() => setOuverte(l)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOuverte(l); } }}
                className="group cursor-pointer align-top focus-ring"
              >
                <td className="sticky left-0 z-[1] whitespace-nowrap border-b border-r border-border bg-card px-3 py-2.5 tabular-nums group-hover:bg-secondary">{jour(l.date)}</td>
                {avecDelegue && <td className="border-b border-border px-3 py-2.5 group-hover:bg-secondary/60">{l.delegue ?? "—"}</td>}
                <td className="max-w-64 border-b border-border px-3 py-2.5 group-hover:bg-secondary/60">
                  <span className="block truncate font-medium">{l.professionnel ?? "Non précisé"}</span>
                  {l.etablissement && <span className="block truncate text-xs text-muted-foreground">{l.etablissement}</span>}
                </td>
                <td className="max-w-48 border-b border-border px-3 py-2.5 text-xs group-hover:bg-secondary/60">
                  <span className="line-clamp-2">{l.produits.join(" · ") || "—"}</span>
                </td>
                <td className="max-w-56 border-b border-border px-3 py-2.5 text-xs text-muted-foreground group-hover:bg-secondary/60">
                  <span className="line-clamp-2">{l.messages.join(" · ") || "—"}</span>
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2.5 group-hover:bg-secondary/60">
                  <Badge tone={TON_TYPE[l.type]}>{l.typeLibelle}</Badge>
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2.5 group-hover:bg-secondary/60">
                  <Badge tone={l.etat.tone} dot>{l.etat.label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sheet
        open={ouverte !== null}
        onClose={() => setOuverte(null)}
        title={ouverte ? ouverte.professionnel ?? "Praticien non précisé" : ""}
        description={ouverte ? [new Date(ouverte.date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }), ouverte.delegue].filter(Boolean).join(" · ") : ""}
        width="md"
      >
        {ouverte && <FicheRapport ligne={ouverte} />}
      </Sheet>
    </>
  );
}

function Bloc({ titre, children, className }: { titre: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titre}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** LE RAPPORT, EN LECTURE — ce que la ligne résume, en entier. */
function FicheRapport({ ligne }: { ligne: LigneRapport }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TON_TYPE[ligne.type]}>{ligne.typeLibelle}</Badge>
        <Badge tone={ligne.etat.tone} dot>{ligne.etat.label}</Badge>
        {ligne.precision && <span className="text-xs text-muted-foreground">{ligne.precision}</span>}
      </div>
      {(ligne.etablissement || ligne.specialite) && (
        <p className="text-sm text-muted-foreground">{[ligne.specialite, ligne.etablissement].filter(Boolean).join(" · ")}</p>
      )}
      <Bloc titre={ligne.type === "PV" ? "Produit" : "Produits"}>{ligne.produits.join(" · ") || "—"}</Bloc>
      {ligne.type !== "PV" && <Bloc titre="Messages">{ligne.messages.length ? ligne.messages.join(" · ") : "—"}</Bloc>}
      <Bloc titre={ligne.type === "PV" ? "Ce qui s'est passé" : "Compte rendu"}>
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{ligne.texte || "—"}</p>
      </Bloc>
      {ligne.retour && <Bloc titre="Retour du médecin"><p className="whitespace-pre-wrap">{ligne.retour}</p></Bloc>}
      {ligne.suite && <Bloc titre="Ce qu'il reste à faire"><p className="whitespace-pre-wrap">{ligne.suite}</p></Bloc>}
      {ligne.alertePv && (
        <div className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <p className="font-medium">{ligne.alertePv.libelle} <span className="font-normal text-muted-foreground">— relevé par l&apos;IA, à confirmer</span></p>
          {ligne.alertePv.raison && <p className="text-muted-foreground">{ligne.alertePv.raison}</p>}
          {ligne.alertePv.extrait && <p className="italic [overflow-wrap:anywhere]">« {ligne.alertePv.extrait} »</p>}
          {ligne.alertePv.ecarteLe && (
            <p className="text-xs font-medium">Le délégué indique : « ce n&apos;est pas un cas » (le {new Date(ligne.alertePv.ecarteLe).toLocaleDateString("fr-FR")}) — le superviseur tranche à la relecture.</p>
          )}
          {ligne.alertePv.signaler && (
            <Link href={ligne.alertePv.signaler} className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:h-9">
              Signaler <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
      {ligne.casPv && ligne.casPv.length > 0 && (
        <Bloc titre="Pharmacovigilance">
          <ul className="space-y-1">
            {ligne.casPv.map((c) => (
              <li key={c.reference}>{c.lien ? <Link href={c.lien} className="text-primary hover:underline">{c.reference}</Link> : c.reference}</li>
            ))}
          </ul>
        </Bloc>
      )}
      {ligne.relecture && (
        <Bloc titre="Relecture">
          <p>Relu{ligne.relecture.par ? ` par ${ligne.relecture.par}` : ""} le {jour(ligne.relecture.le)}.</p>
          {ligne.relecture.commentaire && <p className="mt-1 whitespace-pre-wrap rounded-lg bg-secondary/50 px-3 py-2 [overflow-wrap:anywhere]">{ligne.relecture.commentaire}</p>}
        </Bloc>
      )}
      {(ligne.lien || ligne.suppression) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {ligne.lien && (
            <Link href={ligne.lien} className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:h-9">
              {ligne.libelleLien ?? "Ouvrir"} <ArrowRight className="h-4 w-4" />
            </Link>
          )}
          {ligne.suppression && (
            <SupprimerRapport id={ligne.suppression.id} name={ligne.suppression.nom} enabled={ligne.suppression !== null} />
          )}
        </div>
      )}
    </div>
  );
}
