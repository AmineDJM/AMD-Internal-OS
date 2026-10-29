"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Eye, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { formatCurrency } from "@/lib/utils";
import { ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";
import {
  apercuBcPromo, modifierApercuBcPromo, annulerApercuBcPromo, validerEtEnvoyerBcPromo, type ApercuBcPromoResultat,
} from "@/lib/actions/promo-execution-actions";
import type { ActionResult } from "@/lib/actions/types";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DU BON DE COMMANDE D'UN DEVIS PROMOTIONNEL, À VALIDER PAR LE DEMANDEUR (Direction, 10/2026).
 *
 * Le même parcours que l'aperçu du BC d'un poste Ad & Pro : le PDF tel qu'il sera imprimé (numéro « À attribuer à la
 * validation » : rien n'est numéroté ni envoyé), la correction de ce que le BC imprime — Référence, contact, modalités de
 * paiement, livraison, notes, taxe —, puis, pour le demandeur seulement, « Valider et envoyer aux Finances ». Les LIGNES ne
 * se corrigent pas ici : ce sont les lignes retenues et validées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BrouillonAffiche {
  objet: string | null;
  notes: string | null;
  contact: { nom: string | null; telephone: string | null } | null;
  modePaiement: string | null;
  conditionsPaiement: string | null;
  livraison: { adresse: string | null; date: string | null; delai: string | null } | null;
  numeroChoisi: string | null;
  /** La taxe supplémentaire : `undefined` (absente) = celle du devis ; `null` = aucune. Taux en fraction (0,02). */
  taxe: { libelle: string; taux: number } | null | undefined;
  parNom: string | null;
}

const MODES: { valeur: string; libelle: string }[] = [
  { valeur: "", libelle: "—" }, { valeur: "VIREMENT", libelle: "Virement bancaire" }, { valeur: "CHEQUE", libelle: "Chèque" },
  { valeur: "ESPECES", libelle: "Espèces" }, { valeur: "AUTRE", libelle: "À convenir" },
];

export function ApercuBcPromo({ promoMaterialId, quoteId, fournisseur, brouillon, peutValider, onClose, onDone }: {
  promoMaterialId: string;
  quoteId: string;
  fournisseur: string;
  brouillon: BrouillonAffiche;
  /** Valider et envoyer aux Finances : le demandeur du dossier, ou le Super Admin — tranché au serveur. */
  peutValider: boolean;
  onClose: () => void;
  /** Après une validation ou un retrait : le message, et la fiche se rafraîchit. */
  onDone: (r: ActionResult) => void;
}) {
  const b = brouillon;
  const [objet, setObjet] = React.useState(b.objet ?? "");
  const [notes, setNotes] = React.useState(b.notes ?? "");
  const [contactNom, setContactNom] = React.useState(b.contact?.nom ?? "");
  const [contactTel, setContactTel] = React.useState(b.contact?.telephone ?? "");
  const [mode, setMode] = React.useState(b.modePaiement ?? "");
  const [conditions, setConditions] = React.useState(b.conditionsPaiement ?? "");
  const [lieu, setLieu] = React.useState(b.livraison?.adresse ?? "");
  const [dateLivraison, setDateLivraison] = React.useState(b.livraison?.date ?? "");
  const [delai, setDelai] = React.useState(b.livraison?.delai ?? "");
  const [taxeLibelle, setTaxeLibelle] = React.useState(b.taxe ? b.taxe.libelle : "");
  const [taxeTaux, setTaxeTaux] = React.useState(b.taxe ? String(Math.round(b.taxe.taux * 10000) / 100) : b.taxe === null ? "0" : "");
  const [numeroChoisi, setNumeroChoisi] = React.useState(b.numeroChoisi ?? "");

  const [apercu, setApercu] = React.useState<ApercuBcPromoResultat | null>(null);
  const [url, setUrl] = React.useState<string | null>(null);
  const [charge, startCharge] = React.useTransition();
  const [enregistre, startEnregistre] = React.useTransition();
  const [valide, startValide] = React.useTransition();
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [edition, setEdition] = React.useState(false);
  const occupe = charge || enregistre || valide;

  const simple = React.useCallback((): FormData => {
    const fd = new FormData(); fd.set("promoMaterialId", promoMaterialId); fd.set("quoteId", quoteId); return fd;
  }, [promoMaterialId, quoteId]);
  const formulaire = (): FormData => {
    const fd = simple();
    fd.set("objet", objet); fd.set("notes", notes);
    fd.set("contactNom", contactNom); fd.set("contactTelephone", contactTel);
    fd.set("modePaiement", mode); fd.set("conditionsPaiement", conditions);
    fd.set("livraisonAdresse", lieu); fd.set("livraisonDate", dateLivraison); fd.set("livraisonDelai", delai);
    fd.set("extraTaxLabel", taxeLibelle); fd.set("extraTaxRate", taxeTaux);
    fd.set("numeroChoisi", numeroChoisi);
    if (apercu && apercu.ok) fd.set("numeroSuggere", apercu.numeroPrevu);
    return fd;
  };

  const montrer = React.useCallback(() => {
    setErreur(null);
    startCharge(async () => {
      const r = await apercuBcPromo(simple());
      setApercu(r);
      // LE N° DE RÉFÉRENCE PRÉREMPLI (Direction, 14/10/2026) : le prochain numéro, à garder ou à réécrire à la main.
      if (r.ok) setNumeroChoisi((n) => n.trim() ? n : r.numeroPrevu);
      setUrl((ancien) => {
        if (ancien) URL.revokeObjectURL(ancien);
        if (!r.ok || !r.pdfBase64) return null;
        const octets = Uint8Array.from(atob(r.pdfBase64), (c) => c.charCodeAt(0));
        return URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
      });
    });
  }, [simple]);

  React.useEffect(() => { montrer(); }, [montrer]);
  React.useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const enregistrer = () => {
    setErreur(null);
    startEnregistre(async () => {
      let r: ActionResult;
      try {
        r = await modifierApercuBcPromo(formulaire());
      } catch {
        setErreur(actionFailureMessage("THROWN"));
        return;
      }
      if (!r.ok) { setErreur(r.error ?? "L'enregistrement n'a pas abouti."); return; }
      setEdition(false);
      montrer();
    });
  };
  const valider = () => {
    setErreur(null);
    startValide(async () => {
      const fd = simple(); fd.set("numeroChoisi", numeroChoisi);
      if (apercu && apercu.ok) fd.set("numeroSuggere", apercu.numeroPrevu);
      const r = await validerEtEnvoyerBcPromo(fd);
      if (!r.ok) { setErreur(r.error ?? "La validation n'a pas abouti."); return; }
      onDone(r);
    });
  };
  const retirer = () => {
    setErreur(null);
    startValide(async () => {
      const r = await annulerApercuBcPromo(simple());
      if (!r.ok) { setErreur(r.error ?? "Le retrait n'a pas abouti."); return; }
      onDone(r);
    });
  };

  const totaux = apercu && apercu.ok ? apercu.totaux : null;
  const bloquants = apercu && apercu.ok ? apercu.bloquants : [];

  return (
    <Sheet open onClose={onClose} width="xl" title={`Bon de commande — ${fournisseur}`} description={`${ETIQUETTE_BROUILLON} : aucun numéro n'est attribué et rien ne part aux Finances avant la validation.`}>
      <div className="space-y-4 text-sm">
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <Eye className="h-4 w-4 shrink-0" aria-hidden />
            <span>{ETIQUETTE_BROUILLON}</span>
            <span className="font-normal text-muted-foreground">
              · N° à attribuer à la validation{apercu && apercu.ok ? ` (prochain : ${apercu.numeroPrevu})` : ""}{b.parNom ? ` · préparé par ${b.parNom}` : ""}
            </span>
            <InfoBulle label="Pourquoi pas de numéro ?" align="left">
              Le numéro NNN/DG/AAAA suit l&apos;ordre de validation : il n&apos;est attribué qu&apos;au moment d&apos;envoyer le BC aux Finances,
              pour que la série reste continue, sans trou, même si un aperçu est corrigé ou abandonné.
            </InfoBulle>
          </p>
          {apercu && apercu.ok && peutValider && (
            <div className="space-y-1">
              <Label htmlFor="bc-promo-numero">N° de référence du BC à valider</Label>
              <Input id="bc-promo-numero" value={numeroChoisi} onChange={(e) => setNumeroChoisi(e.target.value)} placeholder={apercu.numeroPrevu} className="text-sm" />
              <p className="text-xs text-muted-foreground">Proposé : le prochain numéro ({apercu.numeroPrevu}). Gardez-le, ou écrivez le vôtre — il doit être libre ; le compteur ne recule jamais.</p>
            </div>
          )}
        </div>

        {charge && !apercu ? (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</p>
        ) : apercu && !apercu.ok ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" role="alert">{apercu.error}</p>
        ) : url ? (
          <object data={url} type="application/pdf" aria-label="Aperçu du bon de commande" className="h-[65vh] w-full rounded-md border border-border bg-card">
            <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Ouvrir l&apos;aperçu PDF</a>
          </object>
        ) : null}

        {bloquants.length > 0 && (
          <ul className="space-y-0.5 text-destructive">{bloquants.map((x) => <li key={x} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {x}</li>)}</ul>
        )}
        {apercu && apercu.ok && apercu.avertissements.length > 0 && (
          <ul className="space-y-0.5 text-muted-foreground">{apercu.avertissements.map((x) => <li key={x}>{x}</li>)}</ul>
        )}
        {totaux && (
          <p className="tabular-nums text-muted-foreground">
            Total HT {formatCurrency(totaux.totalHt)}{totaux.totalTaxes > 0 ? ` · taxes ${formatCurrency(totaux.totalTaxes)}` : ""} · TVA {formatCurrency(totaux.totalTva)} ·{" "}
            <span className="font-semibold text-foreground">TTC {formatCurrency(totaux.totalTtc)}</span>
          </p>
        )}

        {edition && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <p className="flex items-center gap-1 font-medium">
              Corriger ce que le bon de commande imprime
              <InfoBulle label="Ce qui se corrige" align="left">Un champ vide reprend ce que le devis donne. Les lignes sont celles qui ont été retenues et validées : elles ne se corrigent pas ici.</InfoBulle>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="abp-objet">Référence</Label><Input id="abp-objet" value={objet} onChange={(e) => setObjet(e.target.value)} placeholder="Matériel promotionnel — MP-2026-041" /></div>
              <div className="space-y-1"><Label htmlFor="abp-cnom">Contact</Label><Input id="abp-cnom" value={contactNom} onChange={(e) => setContactNom(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="abp-ctel">Téléphone du contact</Label><Input id="abp-ctel" type="tel" inputMode="tel" value={contactTel} onChange={(e) => setContactTel(e.target.value)} /></div>
              <div className="space-y-1">
                <Label htmlFor="abp-mode">Modalités de paiement</Label>
                <select id="abp-mode" value={mode} onChange={(e) => setMode(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:text-sm">
                  {MODES.map((m) => <option key={m.valeur} value={m.valeur}>{m.libelle}</option>)}
                </select>
              </div>
              <div className="space-y-1"><Label htmlFor="abp-cond">Précision sur le paiement</Label><Input id="abp-cond" value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="30 jours fin de mois" /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="abp-lieu">Lieu de livraison</Label><Input id="abp-lieu" value={lieu} onChange={(e) => setLieu(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="abp-date">Date de livraison</Label><Input id="abp-date" type="date" value={dateLivraison} onChange={(e) => setDateLivraison(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="abp-delai">Délai de livraison</Label><Input id="abp-delai" value={delai} onChange={(e) => setDelai(e.target.value)} placeholder="15 jours" /></div>
              <div className="space-y-1"><Label htmlFor="abp-taxe">Taxe supplémentaire (libellé)</Label><Input id="abp-taxe" value={taxeLibelle} onChange={(e) => setTaxeLibelle(e.target.value)} placeholder="Taxe Pub" /></div>
              <div className="space-y-1">
                <Label htmlFor="abp-taux" className="inline-flex items-center gap-1">
                  Taux (%)
                  <InfoBulle label="Comment la taxe est calculée">Sur le HT, hors base de TVA. Vide : celle du devis ; 0 : aucune.</InfoBulle>
                </Label>
                <Input id="abp-taux" value={taxeTaux} onChange={(e) => setTaxeTaux(e.target.value)} inputMode="decimal" placeholder="2" />
              </div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="abp-notes">Notes</Label><Textarea id="abp-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={enregistrer} disabled={occupe}>{enregistre ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />} Enregistrer et actualiser l&apos;aperçu</Button>
              <Button size="sm" variant="ghost" onClick={() => setEdition(false)} disabled={occupe}>Annuler</Button>
            </div>
          </div>
        )}

        {erreur && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" role="alert">{erreur}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {peutValider ? (
            <BoutonDecisif size="sm" onClick={valider} disabled={occupe || edition || bloquants.length > 0 || !apercu || !apercu.ok}>
              {valide ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Valider et envoyer aux Finances
            </BoutonDecisif>
          ) : (
            <p className="flex items-center gap-1 text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Le demandeur valide cet aperçu.</p>
          )}
          {!edition && <Button size="sm" variant="outline" onClick={() => setEdition(true)} disabled={occupe}><Pencil className="h-3.5 w-3.5" /> Modifier</Button>}
          <Button size="sm" variant="ghost" onClick={montrer} disabled={occupe}><Eye className="h-3.5 w-3.5" /> Actualiser</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={retirer} disabled={occupe}><Trash2 className="h-3.5 w-3.5" /> Retirer l&apos;aperçu</Button>
        </div>
      </div>
    </Sheet>
  );
}
