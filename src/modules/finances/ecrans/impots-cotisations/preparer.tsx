"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import {
  decomposer, formatDzd, justificatifAttendu, lireMontantFiscal, origineDuMontant,
  type LigneDecomposee, type SaisiesFiscales,
} from "../../domaine/impots";
import { libelleLigneBudget, ventilationBudgetaire } from "../../domaine/budget-impots";
import type { PaieDuMois } from "../../infra/impots";
import { enregistrerBrouillonImpot, envoyerImpotAuCentre } from "../../actions-impots";
import { champ, EnTetePanneau, Note, type Annoncer, type Ligne } from "./commun";

/**
 * LE PANNEAU « PRÉPARER » — la décomposition du montant, ligne par ligne (maquette validée, 24/11/2026). L'IRG et la
 * CNAS sont PROPOSÉS par les fiches salariés et restent modifiables (l'écart se voit, et part au journal à l'envoi) ;
 * la TVA (collectée sur les ventes − déductible sur les achats) et les autres lignes se recopient de la déclaration. Le justificatif est obligatoire.
 */

const BADGE: Record<string, string> = {
  PAIE: "bg-primary/10 text-primary",
  FACTURES: "bg-primary/10 text-primary",
  RETENUES: "bg-primary/10 text-primary",
  DECLARATION: "bg-warning/10 text-warning",
  JUSTIFICATIF: "bg-warning/10 text-warning",
};

export function PanneauPreparer({
  ligne, societe, paie, saisies, setSaisies, fichier, setFichier, peutModifier, onFermer, annoncer,
}: {
  ligne: Ligne; societe: string; paie: PaieDuMois | null; saisies: SaisiesFiscales; setSaisies: (s: SaisiesFiscales) => void;
  fichier: File | null; setFichier: (f: File | null) => void; peutModifier: boolean; onFermer: () => void; annoncer: Annoncer;
}) {
  const { busy, err, setErr, run } = useAction();
  const [detail, setDetail] = React.useState<string | null>(null);
  const propositions = paie?.propositions ?? { irg: null, sal: null, pat: null, tva: null, fiches: 0 };
  const d = decomposer(ligne.composition, saisies, propositions);
  const mois = ligne.periodeLibelle.split(" ")[0];
  const pose = (k: keyof SaisiesFiscales, v: string | undefined) => {
    const n = { ...saisies };
    if (v === undefined) delete n[k]; else (n as Record<string, unknown>)[k] = v;
    setSaisies(n);
    setErr(null);
  };
  const autres = saisies.autres ?? [];

  // Parti avec l'ordre : le fichier choisi ne doit pas resservir à un second envoi.
  const oublierLeFichier = () => setFichier(null);
  const formulaire = () => {
    const fd = new FormData();
    fd.set("id", ligne.id);
    fd.set("saisies", JSON.stringify(saisies));
    if (fichier) fd.set("justificatif", fichier);
    return fd;
  };
  const brouillon = () => run(async () => {
    const r = await enregistrerBrouillonImpot(formulaire());
    if (r.ok && r.message) annoncer(r.message);
    return r;
  });
  const envoyer = () => run(async () => {
    const r = await envoyerImpotAuCentre(formulaire());
    if (r.ok) { oublierLeFichier(); if (r.message) annoncer(r.message); }
    return r;
  });

  const parts: string[] = [];
  if (d.dePaie > 0) parts.push(`${formatDzd(d.dePaie)} proposé par la paie`);
  if (d.deFactures > 0) parts.push(`${formatDzd(d.deFactures)} proposé par les factures`);
  if (d.deRetenues > 0) parts.push(`${formatDzd(d.deRetenues)} de retenues à la source`);
  if (d.deDeclaration > 0) parts.push(`${formatDzd(d.deDeclaration)} saisi depuis ${ligne.composition === "MONTANT" ? "le justificatif" : "la déclaration"}`);
  const justificatifDeja = ligne.justificatif;
  const budget = ventilationBudgetaire(ligne.composition, d.lignes, ligne.nature, ligne.organisme);
  const aPaie = d.lignes.some((l) => l.source === "PAIE");

  return (
    <div className="flex flex-col gap-3.5">
      <EnTetePanneau surtitre={`Préparer · ${ligne.organisme} · ${societe}`} titre={`${ligne.nature} — ${ligne.periodeLibelle}`} onFermer={onFermer}>
        <p className="mt-1 text-sm text-muted-foreground">
          Échéance : <strong className="text-foreground">{ligne.echeanceTexte.replace(" · à confirmer", "")}</strong>
          {ligne.jourAConfirmer && <span className="font-semibold text-warning"> · jour à confirmer (calendrier)</span>}
        </p>
      </EnTetePanneau>

      {ligne.motifRefusPrecedent && <Note ton="refus"><strong>Refusé la première fois :</strong> {ligne.motifRefusPrecedent}</Note>}
      {aPaie && paie?.base !== "HORS_MOIS" && propositions.fiches > 0 && (
        <Note>
          <strong>Valeurs des fiches salariés, à vérifier avec la déclaration.</strong> La paie ne calcule ni l&apos;IRG ni la CNAS du mois :
          elle additionne les retenues fixes saisies par les RH sur chaque fiche. Une fiche non mise à jour donne un montant faux :
          corrigez-le ici, l&apos;écart est tracé.
        </Note>
      )}
      {aPaie && (paie?.base === "HORS_MOIS" || propositions.fiches === 0) && (
        <Note ton="neutre">
          {paie?.base === "HORS_MOIS" ? "Période non mensuelle : aucune proposition de la paie." : "Aucune fiche salarié pour cette société."} Recopiez les montants de la déclaration.
        </Note>
      )}

      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Décomposition du montant — ligne par ligne</p>

      {d.lignes.map((l) => {
        const autreIndex = l.cle.startsWith("autre") ? Number(l.cle.slice(5)) : -1;
        return (
          <div key={l.cle} className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">{l.cle === "tva" ? "TVA du mois" : l.label}</span>
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", BADGE[l.source])}>
                {l.source === "PAIE" ? (l.propose === null ? "À saisir (aucune retenue sur les fiches)" : `Proposé par la paie de ${mois}`)
                  : l.source === "FACTURES" ? `Proposé par les factures de ${mois}`
                  : l.source === "RETENUES" ? `Proposé par les paiements de ${mois}`
                  : l.source === "DECLARATION" ? `À saisir depuis la déclaration${ligne.composition === "G50" ? " G50" : ""}` : "À saisir depuis le justificatif"}
              </span>
            </div>
            <ExplicationLigne ligne={ligne} l={l} fiches={propositions.fiches} />

            {l.cle === "tva" && l.source === "DECLARATION" ? (
              <>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <ChampMontant id={`tvac-${ligne.id}`} label="TVA collectée sur les ventes (ligne de la G50)" valeur={saisies.tvaC ?? ""} placeholder="à recopier" onChange={(v) => pose("tvaC", v)} disabled={!peutModifier} />
                  <ChampMontant id={`tvad-${ligne.id}`} label="TVA déductible sur les achats (ligne de la G50)" valeur={saisies.tvaD ?? ""} placeholder="à recopier" onChange={(v) => pose("tvaD", v)} disabled={!peutModifier} />
                </div>
                <ResultatTva c={saisies.tvaC} d={saisies.tvaD} />
              </>
            ) : autreIndex >= 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[12rem] flex-[2_1_12rem] flex-col gap-1 text-xs font-semibold text-muted-foreground">
                  Libellé (comme sur la déclaration)
                  <input type="text" value={autres[autreIndex]?.libelle ?? ""} disabled={!peutModifier} placeholder="ex. droit de timbre"
                    onChange={(e) => setSaisies({ ...saisies, autres: autres.map((a, j) => (j === autreIndex ? { ...a, libelle: e.target.value } : a)) })} className={champ} />
                </label>
                <div className="flex-[1_1_8rem]">
                  <ChampMontant id={`autre-${ligne.id}-${autreIndex}`} label="Montant (DZD)" valeur={autres[autreIndex]?.montant ?? ""}
                    onChange={(v) => setSaisies({ ...saisies, autres: autres.map((a, j) => (j === autreIndex ? { ...a, montant: v } : a)) })} disabled={!peutModifier} />
                </div>
                {peutModifier && (
                  <Button type="button" variant="outline" className="text-destructive" onClick={() => setSaisies({ ...saisies, autres: autres.filter((_, j) => j !== autreIndex) })}>Retirer</Button>
                )}
              </div>
            ) : (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <ChampMontant
                    id={`in-${ligne.id}-${l.cle}`} disabled={!peutModifier}
                    label={l.source === "FACTURES" ? "TVA à payer (modifiable)"
                      : l.source === "RETENUES" ? "Retenues à reverser (modifiable)"
                      : l.source === "PAIE" ? `${l.cle === "irg" ? "IRG à reverser" : l.cle === "sal" ? "Part salariale à reverser" : "Part patronale"}${l.propose !== null ? " (modifiable)" : ""}`
                      : "Montant porté sur le justificatif"}
                    valeur={saisies[l.cle as "irg" | "tva" | "ras"] ?? (l.propose !== null ? formatDzd(l.propose) : "")}
                    onChange={(v) => pose(l.cle as keyof SaisiesFiscales, v)}
                  />
                </div>
                <span className="pb-2.5 text-sm text-muted-foreground">DZD</span>
              </div>
            )}

            {l.modifie && l.propose !== null && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success/10 px-2.5 py-2 text-xs text-success">
                <span>Modifié par vous : proposé {formatDzd(l.propose)} → envoyé {formatDzd(l.montant)} DZD. L&apos;écart, votre nom et la date seront visibles du centre de paiement.</span>
                {peutModifier && <button type="button" className="font-semibold text-primary" onClick={() => pose(l.cle as keyof SaisiesFiscales, undefined)}>Revenir au montant proposé</button>}
              </div>
            )}

            {l.source === "PAIE" && paie && paie.fiches.length > 0 && (
              <>
                <button type="button" aria-expanded={detail === l.cle} onClick={() => setDetail(detail === l.cle ? null : l.cle)}
                  className="self-start text-sm font-semibold text-primary underline">
                  {detail === l.cle ? "Masquer le détail par salarié" : `Voir le détail par salarié (${paie.fiches.length} fiches)`}
                </button>
                {detail === l.cle && <DetailFiches cle={l.cle as "irg" | "sal" | "pat"} paie={paie} total={l.propose} />}
              </>
            )}
          </div>
        );
      })}

      {ligne.composition === "G50" && peutModifier && (
        <button type="button" onClick={() => setSaisies({ ...saisies, autres: [...autres, { libelle: "", montant: "" }] })}
          className="h-9 self-start rounded-lg border border-dashed border-border bg-card px-3 text-sm font-semibold text-primary">
          + Ajouter une autre ligne de la déclaration
        </button>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-secondary/60 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Total à demander au centre de paiement</p>
          <p className="mt-0.5 text-xs text-foreground/80">{parts.length ? parts.join(" + ") : "rien de saisi pour l'instant"}</p>
          {d.manque.length > 0 && <p className="mt-0.5 text-xs font-semibold text-warning">Encore à saisir : {d.manque.join(", ")}</p>}
          {budget.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">Budget : {budget.map((b) => `${libelleLigneBudget(b.cle)} ${formatDzd(b.montant)}`).join(" · ")}</p>
          )}
        </div>
        <p className="text-2xl font-bold">{formatDzd(d.total)} DZD</p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3.5 py-3">
        <label htmlFor={`pj-${ligne.id}`} className="text-sm font-semibold">
          Justificatif — {justificatifAttendu(ligne.composition, ligne.periodeLibelle, ligne.organisme)} <span className="text-destructive">* obligatoire</span>
        </label>
        {fichier || justificatifDeja ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success/10 px-2.5 py-2 text-sm text-success">
            <span className="[overflow-wrap:anywhere]">✓ {fichier?.name ?? justificatifDeja?.nom} — joint</span>
            {fichier && peutModifier && <button type="button" className="font-semibold text-destructive" onClick={() => setFichier(null)}>Retirer</button>}
          </div>
        ) : (
          <input id={`pj-${ligne.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={!peutModifier}
            onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setErr(null); }} className="max-w-full text-sm" />
        )}
      </div>

      <Retour>{err}</Retour>

      {peutModifier && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3.5">
          <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => void brouillon()}>Enregistrer le brouillon</Button>
          <BoutonDecisif type="button" size="lg" disabled={busy} onClick={() => void envoyer()} confirmation={`Envoyer ${formatDzd(d.total)} DZD au centre de paiement`}>
            Envoyer au centre de paiement
          </BoutonDecisif>
        </div>
      )}
    </div>
  );
}

function ChampMontant({ id, label, valeur, onChange, placeholder = "0", disabled }: {
  id: string; label: string; valeur: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">{label}</label>
      <input id={id} type="text" inputMode="decimal" value={valeur} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} className={cn(champ, "text-right text-base font-semibold")} />
    </div>
  );
}

function ResultatTva({ c, d }: { c?: string; d?: string }) {
  const lc = c?.trim() ? lireMontantFiscal(c) : null;
  const ld = d?.trim() ? lireMontantFiscal(d) : null;
  if (lc === null || ld === null) return <p className="text-sm text-muted-foreground">TVA à payer = collectée − déductible : saisissez les deux montants.</p>;
  if (lc - ld < 0) return <p className="text-sm font-semibold text-warning">Résultat négatif ({formatDzd(lc - ld)}) : rien n&apos;est ajouté au total. Vérifiez la déclaration.</p>;
  return <p className="rounded-md bg-secondary/60 px-2.5 py-2 text-sm font-bold">TVA à payer = {formatDzd(lc)} − {formatDzd(ld)} = {formatDzd(lc - ld)} DZD</p>;
}

function ExplicationLigne({ ligne, l, fiches }: { ligne: Ligne; l: LigneDecomposee; fiches: number }) {
  const t = l.source === "FACTURES"
    ? "TVA collectée sur les ventes − TVA déductible sur les achats, tirée des factures du mois. Vérifiez-la avec la G50 : corrigée ici, l'écart est tracé."
    : l.source === "RETENUES"
    ? "Retenues à la source calculées au paiement des honoraires de médecins et des prestataires étrangers ce mois-là. Déjà imputées au budget des dépenses : cette part se règle sans budget. Corrigée ici, l'écart est tracé."
    : l.cle === "irg"
    ? `Somme des retenues IRG inscrites sur les ${fiches} fiches salariés par les RH. La paie ne calcule pas l'IRG du mois ; retenu sur les salaires, il ne part aujourd'hui par aucun ordre de paiement.`
    : l.cle === "sal" ? `Somme des retenues « SS 9 % » des ${fiches} fiches. Le virement de paie ne paie que les nets : cette part n'est versée nulle part aujourd'hui.`
      : l.cle === "pat" ? "Somme, fiche par fiche, de la retenue « SS 35 % » moins la retenue « SS 9 % » inscrites par les RH. À confirmer par les Finances."
        : l.cle === "tva" ? "TVA nette = collectée sur les ventes − déductible sur les achats. Tant que les factures ne portent pas leur TVA, recopiez les deux montants de la G50."
            : l.cle === "montant" ? `La plateforme ne calcule pas ce montant : recopiez celui du ${justificatifAttendu(ligne.composition, ligne.periodeLibelle, ligne.organisme)}.`
              : "Ligne ajoutée par vous (droit de timbre, IRG sur autres revenus…) : libellé et montant tels que sur la déclaration.";
  return <p className="text-sm leading-relaxed text-muted-foreground">{l.propose === null && l.source === "PAIE" ? "Aucune fiche ne porte cette retenue : recopiez le montant de la déclaration." : t}{(l.source === "PAIE" || l.source === "FACTURES" || l.source === "RETENUES") && l.propose !== null ? ` (${origineDuMontant(l).toLowerCase()})` : ""}</p>;
}

function DetailFiches({ cle, paie, total }: { cle: "irg" | "sal" | "pat"; paie: PaieDuMois; total: number | null }) {
  const valeur = (f: PaieDuMois["fiches"][number]) => (cle === "irg" ? f.retIrg : cle === "sal" ? f.retSS9 : f.partPatronale);
  const colonne = cle === "irg" ? "Ret. IRG (fiche)" : cle === "sal" ? "Ret. SS 9 % (fiche)" : "Part patronale";
  const sans = paie.fiches.filter((f) => valeur(f) === null).length;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 bg-secondary/60 px-2.5 py-2 text-xs font-semibold text-muted-foreground">
        <span>Salarié · poste</span>
        <span className="text-right">{cle === "pat" ? "Ret. SS 35 % (fiche)" : ""}</span>
        <span className="text-right">{colonne}</span>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {paie.fiches.map((f, i) => (
          <div key={i} className={cn("border-t border-border px-2.5 py-2", valeur(f) === null && "bg-warning/10")}>
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-2 text-sm">
              <span className="[overflow-wrap:anywhere]"><strong>{f.nom}</strong>{f.poste ? <span className="text-muted-foreground"> · {f.poste}</span> : null}</span>
              <span className="text-right text-muted-foreground">{cle === "pat" && f.retSS35 !== null ? formatDzd(f.retSS35) : ""}</span>
              <span className="text-right font-bold">{valeur(f) === null ? "—" : formatDzd(valeur(f))}</span>
            </div>
            {valeur(f) === null && <p className="mt-1 text-xs font-semibold text-warning">Retenue non inscrite sur la fiche — à vérifier par les RH.</p>}
          </div>
        ))}
      </div>
      <p className="border-t border-border bg-secondary/60 px-2.5 py-2 text-xs text-muted-foreground">
        Total des {paie.fiches.length} fiches = {formatDzd(total)} DZD : c&apos;est le montant proposé ci-dessus.{sans ? ` ${sans} fiche(s) sans cette retenue.` : ""}
        {paie.base === "FICHES_ACTIVES" ? " Paie du mois non saisie : fiches actives de la société." : ""}
      </p>
    </div>
  );
}
