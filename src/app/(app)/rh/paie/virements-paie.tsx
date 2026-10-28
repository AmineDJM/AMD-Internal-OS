"use client";

import * as React from "react";
import { Loader2, Send, ChevronLeft, ChevronRight, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { envoyerPaieAuCentre } from "@/lib/actions/payroll-hr-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { ETAT_VIREMENT_LABEL, moisDeLaPaie, type MoisDeLEntite, type VirementDuMois } from "@/lib/hr/virement-paie";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOIS EN COURS — la paie à envoyer, une ligne par entité (§118.176 ; maquette « Paie », 07/10).
 *
 * « Pour la paie, c'est un bouton pour toute la paie avec mention obligatoire de la somme des
 * salaires à virer. (un bouton par entité) » — la Direction, 01/10/2026.
 *
 * Une carte en tête de la paie : le mois (navigable), combien de salaires sont saisis sur l'effectif,
 * un statut, puis une ligne par entité — sa progression, la somme à virer, « Envoyer la paie ». Le
 * bouton déplie le formulaire d'envoi sous la ligne : la SOMME À VIRER se tape — elle n'est jamais
 * pré-remplie (attestation des RH) ; la somme des nets saisis est montrée à côté, avec l'écart.
 * Les règles sont celles de `moisDeLEntite` : la carte n'offre jamais un envoi que l'action refuserait.
 *
 * Le rafraîchissement passe par `useRafraichir` (§118.172) : tant que la carte n'est pas à jour,
 * l'envoi reste fermé — sinon un second clic partirait sur l'état d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MoisCarte extends MoisDeLEntite {
  virements: VirementDuMois[];
  /** Salariés actifs de l'entité — le dénominateur de « N saisis sur M ». */
  effectif: number;
  /** Parmi eux, ceux dont le salaire du mois est saisi (saisi, envoyé ou viré). */
  saisis: number;
}

export interface CarteEntite {
  companyId: string;
  label: string;
  /** Index 0 = janvier. */
  mois: MoisCarte[];
}

const TON: Record<VirementDuMois["etat"], "warning" | "info" | "success" | "danger" | "neutral"> = {
  EN_ATTENTE: "warning", A_VIRER: "info", VIRE: "success", REFUSE: "danger", ANNULE: "neutral",
};
const COURT: Record<VirementDuMois["etat"], string> = {
  EN_ATTENTE: "Au centre de paiement", A_VIRER: "Autorisée — à virer", VIRE: "Virée", REFUSE: "Refusée", ANNULE: "Annulée",
};

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

export function VirementsPaie({
  year, cartes, sansEntite, budgetOptions, moisInitial,
}: {
  year: number;
  cartes: CarteEntite[];
  /** Salaires saisis de salariés sans entité, par mois (index 0 = janvier). */
  sansEntite: number[];
  budgetOptions: { id: string; label: string }[];
  moisInitial: number;
}) {
  const [mois, setMois] = React.useState<number>(moisInitial);
  const libelleMois = moisDeLaPaie(year, mois);
  const etats = cartes.map((c) => c.mois[mois - 1]!);

  const effectif = etats.reduce((a, e) => a + e.effectif, 0);
  const saisis = etats.reduce((a, e) => a + e.saisis, 0);
  const aSaisir = Math.max(0, effectif - saisis);
  const statut: { tone: "warning" | "info" | "success" | "neutral"; texte: string } =
    etats.some((e) => e.aEnvoyer > 0 && !e.enCours) ? { tone: "warning", texte: "À envoyer au centre de paiement" }
    : etats.some((e) => e.enCours) ? { tone: "info", texte: "Envoyée au centre de paiement" }
    : etats.length > 0 && etats.some((e) => e.vires > 0) && aSaisir === 0 ? { tone: "success", texte: "Virée" }
    : saisis === 0 ? { tone: "neutral", texte: "Rien de saisi" }
    : { tone: "neutral", texte: "Saisie en cours" };
  // « Envoyer la paie » en bouton primaire sur la PREMIÈRE entité prête : c'est le geste suivant.
  const premierePrete = etats.findIndex((e) => !e.refus);
  const sansEntiteDuMois = sansEntite[mois - 1] ?? 0;

  return (
    <section className="surface" aria-labelledby="mois-paie-titre">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <Button
              type="button" variant="ghost" size="sm" className="w-9 px-0 sm:w-8" aria-label="Mois précédent"
              disabled={mois <= 1} onClick={() => setMois((m) => Math.max(1, m - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h2 id="mois-paie-titre" className="min-w-[8.5rem] text-center text-base font-semibold first-letter:uppercase" aria-live="polite">
              {libelleMois}
            </h2>
            <Button
              type="button" variant="ghost" size="sm" className="w-9 px-0 sm:w-8" aria-label="Mois suivant"
              disabled={mois >= 12} onClick={() => setMois((m) => Math.min(12, m + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <InfoBulle label="Comment part la paie" align="left">
              Un envoi par entité, avec la somme des salaires à virer, tapée par les RH. Le centre de paiement
              l&apos;autorise, les Finances la virent ; chaque salarié est prévenu au virement.
            </InfoBulle>
          </div>
          <p className="pl-1 text-xs text-muted-foreground">
            {pluriel(saisis, "salaire")} saisi{saisis > 1 ? "s" : ""} sur {effectif}
            {effectif > 0 && (aSaisir > 0 ? <> · <span className="font-medium text-foreground">{aSaisir} à saisir</span></> : <> · tout est saisi</>)}
          </p>
        </div>
        <Badge tone={statut.tone} dot={false}>{statut.texte}</Badge>
      </div>

      {cartes.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">Aucune entité ne vous est ouverte : la paie s&apos;envoie entité par entité.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {cartes.map((c, i) => (
            <LigneEntite
              key={`${c.companyId}:${mois}`}
              year={year} month={mois} libelleMois={libelleMois}
              carte={c} etat={etats[i]!} primaire={i === premierePrete} budgetOptions={budgetOptions}
            />
          ))}
        </ul>
      )}

      {sansEntiteDuMois > 0 && (
        <p className="flex items-center gap-2 rounded-b-[var(--radius)] border-t border-border bg-warning/5 px-4 py-2 text-xs">
          <UserX className="h-3.5 w-3.5 shrink-0 text-warning" />
          {pluriel(sansEntiteDuMois, "salaire")} saisi{sansEntiteDuMois > 1 ? "s" : ""} sans entité : {sansEntiteDuMois > 1 ? "ils ne peuvent" : "il ne peut"} pas partir au centre.
        </p>
      )}
    </section>
  );
}

function LigneEntite({
  year, month, libelleMois, carte, etat, primaire, budgetOptions,
}: {
  year: number;
  month: number;
  libelleMois: string;
  carte: CarteEntite;
  etat: MoisCarte;
  primaire: boolean;
  budgetOptions: { id: string; label: string }[];
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(false);
  const [somme, setSomme] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const saisie = Number(somme.replace(/[\s  ]/g, "").replace(",", "."));
  const ecart = somme.trim() && Number.isFinite(saisie) ? Math.round((saisie - etat.netsAEnvoyer) * 100) / 100 : null;
  const vire = [...etat.virements].reverse().find((v) => v.etat === "VIRE") ?? null;
  const pct = etat.effectif > 0 ? Math.min(100, Math.round((etat.saisis / etat.effectif) * 100)) : 0;

  const envoyer = async (fd: FormData) => {
    setBusy(true); setMsg(null);
    fd.set("companyId", carte.companyId);
    fd.set("year", String(year));
    fd.set("month", String(month));
    const r = await envoyerPaieAuCentre(fd).catch(sansBloquer("virements-paie.envoyer.envoyerPaieAuCentre", { ok: false as const, error: "L'envoi n'a pas abouti — réessayez." }));
    setBusy(false);
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Paie envoyée au centre de paiement.") : (r.error ?? "Envoi refusé.") });
    if (r.ok) { setSomme(""); setOuvert(false); rafraichir(); }
  };

  // La somme de la ligne : ce qui part (à envoyer), sinon ce qui est parti (en cours), sinon ce qui est viré.
  const montant = etat.aEnvoyer > 0
    ? { valeur: etat.netsAEnvoyer, note: etat.complement ? "complément à virer" : "à virer" }
    : etat.enCours ? { valeur: etat.enCours.montant, note: `envoyée le ${formatDate(etat.enCours.envoyeLe)}` }
    : vire ? { valeur: vire.montant, note: vire.vireLe ? `virée le ${formatDate(vire.vireLe)}` : "virée" }
    : null;
  const detail = etat.virements.length > 0 || (etat.refus && (etat.aEnvoyer > 0 || etat.enCours));

  return (
    <li data-entite={carte.label}>
      <div className="grid grid-cols-1 items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:gap-4 sm:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <p className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{carte.label}</p>
          {detail && (
            <InfoBulle label={`Envois de ${carte.label} — ${libelleMois}`} align="left">
              {etat.refus && (etat.aEnvoyer > 0 || etat.enCours) && <span className="mb-1.5 block">{etat.refus}</span>}
              {etat.virements.map((v) => (
                <span key={v.id} className="block [overflow-wrap:anywhere]">
                  <span className="font-medium">{COURT[v.etat]}</span> · {formatCurrency(v.montant)}
                  {v.reference ? ` · ${v.reference}` : ""} · envoyée le {formatDate(v.envoyeLe)}{v.vireLe ? ` · virée le ${formatDate(v.vireLe)}` : ""}
                </span>
              ))}
            </InfoBulle>
          )}
        </div>

        <div className="min-w-0">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={etat.effectif} aria-valuenow={etat.saisis} aria-label={`Salaires saisis — ${carte.label}`}>
            <span className={cn("block h-full rounded-full", pct >= 100 ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{etat.saisis} / {etat.effectif} saisis</p>
        </div>

        <p className="tabular-nums sm:text-right">
          {montant ? (
            <>
              <span className="block text-sm font-semibold">{formatCurrency(montant.valeur)}</span>
              <span className="block text-xs text-muted-foreground">{montant.note}</span>
            </>
          ) : <span className="text-sm text-muted-foreground">—</span>}
        </p>

        <div className="flex sm:justify-end">
          {!etat.refus ? (
            <Button
              type="button" size="sm" variant={primaire ? "primary" : "outline"} className="w-full sm:w-auto"
              aria-expanded={ouvert} disabled={enCours} onClick={() => { setMsg(null); setOuvert((o) => !o); }}
            >
              <Send className="h-3.5 w-3.5" /> {etat.complement ? "Envoyer un complément" : "Envoyer la paie"}
            </Button>
          ) : etat.enCours ? (
            <Badge tone={TON[etat.enCours.etat]} dot={false} title={ETAT_VIREMENT_LABEL[etat.enCours.etat]}>{COURT[etat.enCours.etat]}</Badge>
          ) : vire || etat.vires > 0 ? (
            <Badge tone="success" dot={false}>Virée</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">Rien à envoyer</span>
          )}
        </div>
      </div>

      {ouvert && !etat.refus && (
        <form action={envoyer} className="mx-3 mb-3 grid grid-cols-1 gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:mx-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`somme-${carte.companyId}-${month}`}>
              Somme des salaires à virer (DZD) <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`somme-${carte.companyId}-${month}`} name="amount" inputMode="decimal" required autoFocus
              value={somme} onChange={(e) => setSomme(e.target.value)} placeholder="Ex. 1 250 000"
              className="h-9 text-right tabular-nums"
            />
            <p className="text-[0.6875rem] text-muted-foreground">
              Nets saisis : {formatCurrency(etat.netsAEnvoyer)} ({etat.aEnvoyer})
              {ecart !== null && ecart !== 0 && <> · écart {ecart > 0 ? "+" : "−"}{formatCurrency(Math.abs(ecart))}</>}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`cat-${carte.companyId}-${month}`}>Catégorie budgétaire <span className="text-xs font-normal text-muted-foreground">(facultatif)</span></Label>
            <Select id={`cat-${carte.companyId}-${month}`} name="budgetCategoryId" defaultValue="" className="h-9 text-sm">
              <option value="">— Laisser aux Finances —</option>
              {budgetOptions.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </Select>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOuvert(false)} disabled={busy}>Fermer</Button>
            <BoutonDecisif type="submit" size="sm" disabled={busy || enCours} className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left [&_svg]:shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {etat.complement ? `Envoyer un complément — ${carte.label}` : `Envoyer la paie au centre — ${carte.label}`}
            </BoutonDecisif>
          </div>
        </form>
      )}

      {msg && (
        <p role="status" className={cn("mx-3 mb-3 rounded-lg px-3 py-2 text-xs sm:mx-4", msg.ok ? "bg-success/10" : "bg-destructive/10 text-destructive")}>
          {msg.texte}
        </p>
      )}
    </li>
  );
}
