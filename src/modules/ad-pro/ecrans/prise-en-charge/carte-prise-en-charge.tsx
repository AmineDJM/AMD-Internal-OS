import * as React from "react";
import { CarteDetailsDemande, type PiecesJointesDeLaDemande } from "../pieces-jointes-demande";
import { NATIONAL_EVENT_TYPE } from "@/lib/labels";
import { formatCurrency, formatDate } from "@/lib/utils";
import { quoteSummary } from "../../domaine/prise-en-charge/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRISE EN CHARGE, EN UNE CARTE (Direction, 07/10 : « merge en smart ces trois rubriques »).
 *
 * « Professionnels proposés », « Ce que couvre cette prise en charge » et « Informations » étaient trois cartes, chacune
 * avec son propre bandeau de chiffres (8 chiffres, dont plusieurs à « — »). Une seule carte, dans l'ordre où on la lit :
 *   1. l'événement — type, lieu, dates, demandeur, initiative — et ses pièces jointes ;
 *   2. UN bandeau de quatre chiffres : professionnels (et accordés), enveloppe, affecté aux postes, devis acceptés ;
 *   3. les professionnels, puis ce que couvre la prise en charge (les postes), sans leurs bandeaux propres.
 * Commune à l'international et au national : les deux fiches se lisent pareil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const INITIATIVE: Record<string, string> = { DEMANDEUR: "Initiative du demandeur", MEDECIN: "Initiative du médecin" };

export function CartePriseEnCharge({ evenement, pieces, beneficiaires, devis, postes, enveloppe, fiches, professionnels, couverture }: {
  evenement: {
    eventType: string | null; location: string; date: string | null; endDate: string | null; requester: string; initiative: string | null;
    /** VILLE ET PAYS, séparés (Direction, 10/2026) ; au national, le pays est l'Algérie quand rien n'est dit. */
    ville?: string | null; pays?: string | null;
    /** « Initiative du médecin » : le ou les médecins à l'origine de la demande. */
    medecinsOrigine?: string[];
  };
  pieces: PiecesJointesDeLaDemande;
  beneficiaires: { status: string }[];
  devis: Parameters<typeof quoteSummary>[0];
  postes: { amountGranted: number | null; status: string }[];
  /** L'enveloppe accordée par la Direction — `null` tant qu'elle n'a pas tranché. */
  enveloppe: number | null;
  /** Les fiches voyageur : l'estimé (devis retenus + montants saisis + postes de groupe) et les fiches prêtes pour réserver. */
  fiches?: { estime: number; pretes: number; vivantes: number };
  professionnels: React.ReactNode;
  couverture: React.ReactNode;
}) {
  const accordes = beneficiaires.filter((b) => b.status === "APPROVED").length;
  const qs = quoteSummary(devis);
  const vivants = postes.filter((p) => p.status !== "REJECTED");
  const affecte = vivants.reduce((s, p) => s + (p.amountGranted ?? 0), 0);
  const engage = (fiches?.estime ?? 0) + affecte;
  const separes = evenement.ville !== undefined || evenement.pays !== undefined;
  const dates = evenement.date
    ? `${formatDate(evenement.date)}${evenement.endDate && evenement.endDate.slice(0, 10) !== evenement.date.slice(0, 10) ? ` → ${formatDate(evenement.endDate)}` : ""}`
    : null;

  return (
    <CarteDetailsDemande titre="La prise en charge" pieces={pieces} contentClassName="space-y-5" entete={
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {evenement.eventType && <Fait label="Type" valeur={NATIONAL_EVENT_TYPE[evenement.eventType] ?? evenement.eventType} />}
        {separes ? (
          <>
            <Fait label="Ville" valeur={evenement.ville} />
            <Fait label="Pays" valeur={evenement.pays} />
          </>
        ) : <Fait label="Lieu" valeur={evenement.location} />}
        <Fait label="Dates de l'événement" valeur={dates} />
        <Fait label="Demandeur" valeur={evenement.requester} />
        {evenement.initiative && (
          <Fait label="Origine" valeur={[INITIATIVE[evenement.initiative] ?? evenement.initiative, ...(evenement.medecinsOrigine?.length ? [evenement.medecinsOrigine.join(", ")] : [])].join(" — ")} />
        )}
      </dl>
    }>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <Chiffre label="Professionnels" valeur={String(beneficiaires.length)} note={beneficiaires.length ? `${accordes} accordé${accordes > 1 ? "s" : ""}` : undefined} ton={accordes > 0 ? "succes" : undefined} />
        {fiches ? (
          <>
            <Chiffre label="Fiches complètes pour réserver" valeur={`${fiches.pretes} / ${fiches.vivantes}`} />
            <Chiffre label="Estimé (fiches + postes)" valeur={formatCurrency(engage)} note={affecte > 0 ? `dont ${formatCurrency(affecte)} affectés aux postes` : qs.pending > 0 ? `${qs.pending} devis en attente` : undefined} ton={enveloppe != null && engage > enveloppe ? "alerte" : undefined} />
          </>
        ) : (
          <>
            <Chiffre label="Affecté aux postes" valeur={formatCurrency(affecte)} note={`${vivants.length} poste${vivants.length > 1 ? "s" : ""}`} ton={enveloppe != null && affecte > enveloppe ? "alerte" : undefined} />
            <Chiffre label="Devis acceptés" valeur={formatCurrency(qs.acceptedDzd)} note={qs.pending > 0 ? `${qs.pending} en attente` : undefined} ton={qs.pending > 0 ? "attente" : undefined} />
          </>
        )}
        <Chiffre label="Enveloppe accordée" valeur={enveloppe != null ? formatCurrency(enveloppe) : "Non tranchée"} discret={enveloppe == null} />
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Professionnels</h3>
        {professionnels}
      </section>

      <section className="space-y-2 border-t border-border/70 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ce que couvre la prise en charge</h3>
        {couverture}
      </section>
    </CarteDetailsDemande>
  );
}

function Fait({ label, valeur }: { label: string; valeur: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{valeur || "—"}</dd>
    </div>
  );
}

function Chiffre({ label, valeur, note, ton, discret = false }: { label: string; valeur: string; note?: string; ton?: "succes" | "alerte" | "attente"; discret?: boolean }) {
  const couleur = ton === "succes" ? "text-success" : ton === "alerte" ? "text-destructive" : ton === "attente" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/20 px-3 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={`truncate font-semibold tabular-nums ${discret ? "text-sm text-muted-foreground" : "text-base"}`}>{valeur}</p>
      {note && <p className={`truncate text-[0.6875rem] ${couleur}`}>{note}</p>}
    </div>
  );
}
