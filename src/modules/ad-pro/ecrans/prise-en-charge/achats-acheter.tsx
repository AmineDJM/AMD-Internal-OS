"use client";

import * as React from "react";
import { Loader2, Upload, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { formatCurrency } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/types";
import type { PageAchatVue } from "../../infra/requetes/achats-pec";
import { acheterLignePec, demanderPaiementBcPec } from "../../actions-prise-en-charge-achats";
import { modifierMontantPec, repondreRemboursementPec } from "../../actions-prise-en-charge-chiffrage";

/**
 * « ACHETER — BC n°k » (maquette Chiffrage, partie « Plus tard ») : l'assistante n'achète QUE les lignes de ce BC signé par
 * les Finances — billet ou confirmation déposés, pièce pour un autre poste ; un prix changé se corrige (jusqu'à la marge de
 * 10 % on continue, au-delà le complément part dans un BC complémentaire) ; un professionnel retiré après achat attend
 * « Remboursé ? » ; enfin « Demander le paiement », facture OBLIGATOIRE.
 */
export function AcheterBc({ vue }: { vue: PageAchatVue }) {
  const { busy, error, setError, run } = useKeyedAction();
  const [info, setInfo] = React.useState<string | null>(null);
  const [facture, setFacture] = React.useState<File | null>(null);
  const geste = (cle: string, fn: () => Promise<ActionResult>) => run(cle, async () => {
    setInfo(null);
    const r = await fn();
    if (r.ok && r.message) setInfo(r.message);
    return r;
  });
  const demanderPaiement = () => geste("paiement", () => {
    const f = new FormData();
    f.set("bcId", vue.bcId);
    if (facture) f.set("facture", facture);
    return demanderPaiementBcPec(f);
  });

  return (
    <div className="space-y-4">
      {error && <Retour ton="erreur" onFermer={() => setError(null)}>{error}</Retour>}
      {info && <Retour ton="succes" onFermer={() => setInfo(null)}>{info}</Retour>}
      <section aria-labelledby="lignes-bc" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="px-4 py-4">
          <h2 id="lignes-bc" className="text-base font-semibold">Ce que porte le BC n°{vue.numero}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Vous n&apos;achetez que ces lignes. Une ligne barrée a été retirée avant l&apos;achat : ne l&apos;achetez pas.</p>
        </div>
        <ul className="divide-y divide-border">
          {vue.lignes.map((l) => <LigneBc key={l.id} l={l} signe={vue.signeFinances} paiement={vue.paiement.demande} busy={busy} geste={geste} />)}
        </ul>
      </section>

      <section aria-labelledby="paiement-bc" className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
        <h2 id="paiement-bc" className="text-base font-semibold">Paiement</h2>
        {vue.paiement.demande ? (
          <p className="text-sm">Paiement demandé — ordre de dépense <strong>{vue.paiement.reference}</strong> ({vue.paiement.statut === "PAID" ? "payé" : "au centre de paiement, puis aux Finances"}).</p>
        ) : (
          <>
            <p className="text-sm">À payer : <strong>{formatCurrency(vue.aPayer)}</strong> — achats réels, remboursements déduits. La facture est obligatoire.</p>
            {vue.refusPaiement && <p className="text-sm text-muted-foreground">{vue.refusPaiement}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm hover:bg-secondary">
                <FileText className="h-4 w-4" /> <span className="max-w-[16rem] truncate">{facture?.name ?? "Joindre la facture"}</span>
                <input type="file" className="sr-only" onChange={(e) => setFacture(e.target.files?.[0] ?? null)} />
              </label>
              <BoutonDecisif type="button" disabled={busy !== null || !facture || Boolean(vue.refusPaiement)} onClick={demanderPaiement}>
                {busy === "paiement" && <Loader2 className="h-4 w-4 animate-spin" />} Demander le paiement
              </BoutonDecisif>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

type Geste = (cle: string, fn: () => Promise<ActionResult>) => Promise<boolean>;

function LigneBc({ l, signe, paiement, busy, geste }: { l: PageAchatVue["lignes"][number]; signe: boolean; paiement: boolean; busy: string | null; geste: Geste }) {
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const [reference, setReference] = React.useState("");
  const [montant, setMontant] = React.useState("");
  const [corriger, setCorriger] = React.useState(false);
  const billet = l.serviceKind === "TICKET";
  const hotel = l.serviceKind === "HOTEL";
  const barree = l.statut === "RETIREE_AVANT_ACHAT";
  const acheter = () => geste(`a:${l.id}`, () => {
    const f = new FormData();
    f.set("ligneId", l.id);
    if (reference) f.set("reference", reference);
    if (montant) f.set("montant", montant);
    for (const x of fichiers) f.append("pieces", x);
    return acheterLignePec(f);
  });
  const etat = l.statut === "ACHETEE" ? "Acheté" : barree ? "Retiré avant achat" : l.statut === "RETIREE_APRES_ACHAT"
    ? (l.rembourse == null ? "Retiré après achat — remboursé ?" : l.rembourse ? `Remboursé (${formatCurrency(l.rembourseDzd ?? 0)})` : "Retiré — non remboursé")
    : signe ? "À acheter" : "En attente de la signature des Finances";

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={`min-w-0 font-semibold [overflow-wrap:anywhere] ${barree ? "text-muted-foreground line-through" : ""}`}>{l.libelle}</span>
        <span className="text-sm tabular-nums">
          {formatCurrency(l.montantDzd)}{l.montantAchatDzd != null && l.montantAchatDzd !== l.montantDzd && <span className="text-muted-foreground"> → acheté {formatCurrency(l.montantAchatDzd)}</span>}
          <span className="ml-2 text-xs text-muted-foreground">{etat}</span>
        </span>
      </div>
      {l.statut === "ACTIVE" && signe && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs hover:bg-secondary">
            <Upload className="h-3.5 w-3.5" /> {fichiers.length ? `${fichiers.length} fichier(s)` : billet ? "Le billet émis" : hotel ? "La confirmation" : "La pièce (facultative)"}
            <input type="file" multiple className="sr-only" onChange={(e) => setFichiers(Array.from(e.target.files ?? []))} />
          </label>
          {(billet || hotel) && <Input aria-label="Référence de réservation" placeholder={billet ? "PNR" : "N° de confirmation"} value={reference} onChange={(e) => setReference(e.target.value)} className="w-36" />}
          <Input aria-label="Montant d'achat, s'il a changé" placeholder="Montant si changé" inputMode="decimal" value={montant} onChange={(e) => setMontant(e.target.value)} className="w-40" />
          <BoutonDecisif type="button" size="sm" disabled={busy !== null || ((billet || hotel) && fichiers.length === 0)} onClick={acheter}>
            {busy === `a:${l.id}` && <Loader2 className="h-4 w-4 animate-spin" />} {billet ? "Déposer le billet" : hotel ? "Déposer la confirmation" : "Marquer acheté"}
          </BoutonDecisif>
        </div>
      )}
      {l.statut === "ACHETEE" && !paiement && (
        corriger ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Nouveau montant d'achat" inputMode="decimal" placeholder="Nouveau montant" value={montant} onChange={(e) => setMontant(e.target.value)} className="w-40" />
            <Button type="button" size="sm" variant="outline" disabled={busy !== null || !montant}
              onClick={() => geste(`m:${l.id}`, () => { const f = new FormData(); f.set("cellId", l.cellId); f.set("montant", montant); f.set("motif", "Prix d'achat corrigé"); return modifierMontantPec(f); })}>
              Corriger le montant
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCorriger(false)}>Fermer</Button>
          </div>
        ) : <Button type="button" size="sm" variant="ghost" onClick={() => setCorriger(true)}>Le prix a changé ?</Button>
      )}
      {l.statut === "RETIREE_APRES_ACHAT" && l.rembourse == null && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Remboursé ?
          <BoutonDecisif type="button" size="sm" variant="outline" disabled={busy !== null} confirmation="Remboursé : oui"
            onClick={() => geste(`r:${l.id}`, () => { const f = new FormData(); f.set("ligneId", l.id); f.set("rembourse", "oui"); return repondreRemboursementPec(f); })}>Oui</BoutonDecisif>
          <BoutonDecisif type="button" size="sm" variant="outline" disabled={busy !== null} confirmation="Remboursé : non"
            onClick={() => geste(`r:${l.id}`, () => { const f = new FormData(); f.set("ligneId", l.id); f.set("rembourse", "non"); return repondreRemboursementPec(f); })}>Non</BoutonDecisif>
        </div>
      )}
    </li>
  );
}
