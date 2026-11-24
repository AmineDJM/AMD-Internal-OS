"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Badge } from "@/components/ui/badge";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { lienOrdreAPayer } from "@/lib/chemins/finances";
import { cn } from "@/lib/utils";
import { ETATS_ECHEANCE, formatDzd } from "../../domaine/impots";
import { libelleLigneBudget, ventilationBudgetaire } from "../../domaine/budget-impots";
import { corrigerImpotRefuse, joindreQuittanceImpot, retirerImpotDuCentre } from "../../actions-impots";
import { relancerPaiement } from "../../actions-relances";
import { champ, dateCourte, EnTetePanneau, Note, PuceEtape, TitreSection, type Annoncer, type Ligne } from "./commun";

/**
 * LE PANNEAU DE SUIVI — une ligne partie au centre : qui a fait quoi, d'où vient le montant envoyé, le justificatif,
 * puis la quittance. Les gestes : retirer ou relancer tant que le centre n'a pas décidé, reprendre un refus, ouvrir la
 * ligne dans Banque & paiements (c'est là qu'elle se paie), joindre la quittance une fois payée.
 */

const BADGE_ORIGINE: Record<string, string> = {
  PAIE: "bg-primary/10 text-primary",
  FACTURES: "bg-primary/10 text-primary",
  DECLARATION: "bg-warning/10 text-warning",
  JUSTIFICATIF: "bg-warning/10 text-warning",
};

export function PanneauSuivi({ ligne, societe, peutModifier, estDemandeur, onFermer, annoncer }: {
  ligne: Ligne; societe: string; peutModifier: boolean; estDemandeur: boolean; onFermer: () => void; annoncer: Annoncer;
}) {
  const { busy, err, run } = useAction();
  const [quittance, setQuittance] = React.useState<File | null>(null);
  const [numero, setNumero] = React.useState("");
  const o = ligne.ordre;
  const etat = ligne.etat;
  const budget = ventilationBudgetaire(ligne.composition, ligne.decomposition.map((c) => ({ cle: c.cle ?? "", montant: c.montant, label: c.label })), ligne.nature, ligne.organisme);
  const geste = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, champs: Record<string, string | File> = {}) => run(async () => {
    const fd = new FormData();
    fd.set("id", ligne.id);
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    const r = await fn(fd);
    if (r.ok && r.message) annoncer(r.message);
    return r;
  });
  const relancer = () => run(async () => {
    const fd = new FormData();
    fd.set("cibleType", "EXPENSE_ORDER");
    fd.set("cibleId", o?.id ?? "");
    const r = await relancerPaiement(fd);
    if (r.ok && r.message) annoncer(r.message);
    return r;
  });

  const etapes: { titre: string; detail: string; etat: "fait" | "refuse" | "attente" }[] = [
    { titre: "Préparé et envoyé par les Finances", detail: [o?.envoyePar, o?.envoyeLe ? `le ${dateCourte(o.envoyeLe)}` : null, o?.references.join(", "), ligne.justificatif ? `justificatif : ${ligne.justificatif.nom}` : null].filter(Boolean).join(" · "), etat: "fait" },
  ];
  if (etat === "AU_CENTRE") {
    etapes.push({ titre: "Centre de paiement — décision attendue", detail: `en attente depuis le ${dateCourte(o?.envoyeLe)}${o?.relances ? ` · relancé ${o.relances} fois` : ""}`, etat: "attente" });
  } else if (etat === "REFUSE") {
    etapes.push({ titre: "Refusé par le centre de paiement", detail: [o?.decidePar, o?.decideLe ? `le ${dateCourte(o.decideLe)}` : null].filter(Boolean).join(" · "), etat: "refuse" });
  } else {
    etapes.push({ titre: "Autorisé par le centre de paiement", detail: [o?.decidePar, o?.decideLe ? `le ${dateCourte(o.decideLe)}` : null].filter(Boolean).join(" · "), etat: "fait" });
  }
  if (etat === "PAYE") {
    etapes.push({ titre: "Payé dans Banque & paiements", detail: [o?.payeLe ? `le ${dateCourte(o.payeLe)}` : null, o?.payePar, o?.compte].filter(Boolean).join(" · "), etat: "fait" });
    etapes.push({ titre: "Quittance de l'organisme", detail: ligne.quittance ? `${ligne.quittance.numero ? `n° ${ligne.quittance.numero} — ` : ""}jointe à la ligne` : "à joindre dès réception", etat: ligne.quittance ? "fait" : "attente" });
  } else if (etat !== "REFUSE") {
    etapes.push({ titre: "Paiement", detail: etat === "AUTORISE" ? "Pas encore payé : la ligne attend dans Banque & paiements › À payer." : "Après autorisation, la ligne part dans Banque & paiements.", etat: "attente" });
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <EnTetePanneau surtitre={`Suivi · ${ligne.organisme} · ${societe}`} titre={`${ligne.nature} — ${ligne.periodeLibelle}`} onFermer={onFermer}>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge tone={ETATS_ECHEANCE[etat].tone} dot>{ETATS_ECHEANCE[etat].label}</Badge>
              Échéance : {etat === "PAYE" && o?.payeLe ? `payé le ${dateCourte(o.payeLe)}` : ligne.echeanceTexte}
            </p>
            <p className="mt-2 text-xl font-bold">{formatDzd(ligne.montant)} DZD</p>
          </EnTetePanneau>
        </div>
      </div>

      {etat === "REFUSE" && <Note ton="refus"><strong>Refusé — motif du centre de paiement :</strong> {ligne.motifRefus ?? "non précisé"}</Note>}

      <section className="flex flex-col gap-2">
        <TitreSection>Qui a fait quoi</TitreSection>
        <ol className="flex flex-col gap-2">
          {etapes.map((e) => (
            <li key={e.titre} className="flex gap-2.5 text-sm">
              <PuceEtape etat={e.etat} />
              <span><strong>{e.titre}</strong><br /><span className="text-muted-foreground">{e.detail}</span></span>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <TitreSection>D&apos;où vient le montant envoyé</TitreSection>
        <ul className="overflow-hidden rounded-lg border border-border">
          {ligne.decomposition.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-semibold [overflow-wrap:anywhere]">{c.label}</span>
                <span className={cn("self-start rounded-full px-2.5 py-0.5 text-xs font-semibold", BADGE_ORIGINE[c.source] ?? "bg-secondary")}>{c.origine}</span>
              </span>
              <span className="whitespace-nowrap text-sm font-bold">{formatDzd(c.montant)} DZD</span>
            </li>
          ))}
          <li className="flex justify-between gap-2 bg-secondary/60 px-3 py-2.5 text-sm font-bold"><span>Total</span><span>{formatDzd(ligne.montant)} DZD</span></li>
        </ul>
        {budget.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Budget « Impôts &amp; taxes » : {budget.map((b) => `${libelleLigneBudget(b.cle, b.sousNature)} ${formatDzd(b.montant)} DZD`).join(" · ")}
            {budget.length > 1 ? " — un ordre par ligne." : ""}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5 text-sm">
        <span className="[overflow-wrap:anywhere]">Justificatif joint : <strong>{ligne.justificatif?.nom ?? "—"}</strong></span>
        {ligne.justificatif && <a href={`/api/documents/${ligne.justificatif.id}`} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">Voir le justificatif</a>}
      </div>

      {ligne.quittance && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm">
          <span>Quittance{ligne.quittance.numero ? ` n° ${ligne.quittance.numero}` : ""} — {ligne.organisme} · {societe}</span>
          <a href={`/api/documents/${ligne.quittance.id}`} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">Voir la quittance</a>
        </div>
      )}

      {etat === "PAYE" && !ligne.quittance && peutModifier && (
        <div className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3">
          <label htmlFor={`qt-${ligne.id}`} className="text-sm font-semibold">Quittance de {ligne.organisme}</label>
          <div className="flex flex-wrap items-end gap-2">
            <input id={`qt-${ligne.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setQuittance(e.target.files?.[0] ?? null)} className="max-w-full flex-[2_1_14rem] text-sm" />
            <label className="flex flex-[1_1_9rem] flex-col gap-1 text-xs font-semibold text-muted-foreground">
              N° de la quittance
              <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="facultatif" className={champ} />
            </label>
          </div>
        </div>
      )}

      <Retour>{err}</Retour>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3.5">
        {etat === "AU_CENTRE" && peutModifier && (
          <BoutonDecisif type="button" variant="outline" size="lg" disabled={busy} onClick={() => void geste(retirerImpotDuCentre)}>Retirer la demande</BoutonDecisif>
        )}
        {etat === "AU_CENTRE" && estDemandeur && (
          <Button type="button" size="lg" disabled={busy} onClick={() => void relancer()}>{o?.relances ? "Relancer à nouveau" : "Relancer le centre"}</Button>
        )}
        {(etat === "AUTORISE" || etat === "PAYE") && o && (
          <a href={lienOrdreAPayer(o.id)} className={cn("inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold", etat === "AUTORISE" ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border bg-card hover:bg-secondary")}>
            Voir dans Banque &amp; paiements
          </a>
        )}
        {etat === "PAYE" && !ligne.quittance && peutModifier && (
          <Button type="button" size="lg" disabled={busy || !quittance} onClick={() => quittance && void geste(joindreQuittanceImpot, { quittance, numero })}>Joindre la quittance</Button>
        )}
        {etat === "REFUSE" && peutModifier && (
          <Button type="button" size="lg" disabled={busy} onClick={() => void geste(corrigerImpotRefuse)}>Corriger et renvoyer</Button>
        )}
      </div>
    </div>
  );
}
