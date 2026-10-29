"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, ThumbsUp, ThumbsDown, RotateCcw, X, Split, FileCheck2 } from "lucide-react";
import type { AdProItemKind, AdProItemStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { budgetKindLocked, ITEM_KINDS, ITEM_KIND_LABELS, ITEM_STATUS_LABELS, ITEM_BUDGET_KIND_LABELS, type AdProParent } from "../../domaine/postes";
import { decideAdProItem } from "../../actions-postes-decision";
import { PIECE_SECRETARIAT, type NaturePieceSecretariat } from "../../domaine/pieces-secretariat";
import { NATURES_REPARTITION } from "../../domaine/repartition";
import { porteDesVoyageurs } from "../../domaine/voyageurs";
import { porteDesHebergements } from "../../domaine/hebergements";
import { NATURE_MATERIEL_STOCK } from "@/lib/promo/reservations";
import { FichesNouveauPoste, joindreFichiersDesFiches, type FicheBrouillon } from "../fiches-nouveau-poste";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import type { ItemRow, Run } from "../items-panel";
import type { PosteFrere } from "./poste-carte";
import { estPosteStock, RANGEE_ACTIONS } from "./elements";

// Les petits formulaires de la carte d'un poste : décision, demande et visa du BC, pièces, secrétariat,
// geste motivé, montant accordé, répartition d'un sponsoring indirect, ajout et correction d'un poste.

/**
 * TRANCHER UN POSTE — trois temps, une boîte.
 *  - `OPERATIONS` : la Direction des opérations valide (premier temps) ;
 *  - `MARKETING` : la Direction Marketing valide ET fixe le montant accordé ET choisit le budget
 *    (`decideAdProItem` exige le budget à l'accord) ;
 *  - `STOCK` : la décision unique du matériel du stock.
 * Renvoyer et refuser exigent un motif à chaque temps.
 */
export function BoiteDecision({ item, mode, budgetOptions, busy, run, fdOf, onCancel, revoir = false, accordSeul = false }: {
  item: ItemRow; mode: "OPERATIONS" | "MARKETING" | "STOCK"; budgetOptions: { id: string; label: string }[];
  busy: string | null; run: Run; fdOf: (extra?: Record<string, string>) => FormData; onCancel: () => void;
  /** REVOIR UNE DÉCISION DÉJÀ PRISE (audit R12) : la décision d'hier reste à l'historique. */
  revoir?: boolean;
  /** UN BC ÉTABLI DANS LEGAL lit sa validation sur ce poste : seul l'accord se redonne. */
  accordSeul?: boolean;
}) {
  const [note, setNote] = React.useState("");
  const montantDepart = item.amountGranted ?? item.amountEstimated;
  const [montant, setMontant] = React.useState(montantDepart != null ? String(montantDepart) : "");
  const [budget, setBudget] = React.useState(item.budgetCategoryId ?? "");
  const occupe = busy === `dec:${item.id}`;
  const offrir = (s: AdProItemStatus) => (!revoir || item.status !== s) && (!accordSeul || s === "APPROVED");
  const marketing = mode === "MARKETING";
  const montantOk = Number(montant.replace(",", ".")) > 0;
  const accordPret = !marketing || (montantOk && Boolean(budget));
  const decider = (decision: AdProItemStatus, ok: string) => void run(`dec:${item.id}`, () => decideAdProItem(undefined, fdOf({
    decision, note: note.trim(),
    ...(marketing && decision === "APPROVED" ? { amountGranted: montant.replace(",", "."), budgetCategoryId: budget } : {}),
  })), ok);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5">
      {revoir && (
        <p className="text-xs text-muted-foreground">
          Revoir la décision ({ITEM_STATUS_LABELS[item.status].label.toLowerCase()}) — elle reste à l&apos;historique ; le demandeur est prévenu.
        </p>
      )}
      {accordSeul && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Un bon de commande est déjà établi dans Legal ({item.bcEtablis.join(", ")}) : pour refuser ou renvoyer ce poste, annulez d&apos;abord la demande de BC
          {item.refusAnnulationBc ? ` — ${item.refusAnnulationBc}` : " (« Annuler la demande de BC » l'annule avec elle)."}
        </p>
      )}
      {marketing && offrir("APPROVED") && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Montant accordé (DZD)
            <input
              type="number" inputMode="decimal" min="0" step="0.01" name="amountGranted" value={montant} onChange={(e) => setMontant(e.target.value)}
              aria-label="Montant accordé à ce poste"
              className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm"
            />
          </label>
          <label className="text-xs">
            Budget
            <select
              value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Budget qui portera ce poste"
              className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm"
            >
              <option value="">Choisir le budget…</option>
              {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Motif (obligatoire pour renvoyer ou refuser)"
        aria-label="Motif de la décision sur le poste"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        {offrir("APPROVED") && (
          <BoutonDecisif
            size="sm" className="max-sm:w-full" disabled={occupe || !accordPret}
            title={!accordPret ? "Indiquez le montant accordé et choisissez le budget." : mode === "STOCK" ? "Accorder réserve le matériel au magasin." : undefined}
            onClick={() => decider("APPROVED", mode === "OPERATIONS" ? "Validé — transmis au second temps." : mode === "STOCK" ? "Poste accordé — le matériel est réservé au magasin." : "Poste accordé.")}
          >
            <ThumbsUp className="h-4 w-4" /> {mode === "OPERATIONS" ? "Valider" : mode === "STOCK" ? "Accorder et réserver" : "Accorder"}
          </BoutonDecisif>
        )}
        {offrir("REVISION") && (
          <BoutonDecisif
            size="sm" variant="outline" className="max-sm:w-full" disabled={occupe || !note.trim()}
            title={!note.trim() ? "Indiquez ce qu'il faut revoir" : undefined}
            onClick={() => decider("REVISION", "Renvoyé au demandeur pour correction.")}
          >
            <RotateCcw className="h-4 w-4" /> {mode === "STOCK" ? "Revoir la liste" : "Renvoyer"}
          </BoutonDecisif>
        )}
        {offrir("REJECTED") && (
          <BoutonDecisif
            size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={occupe || !note.trim()}
            title={!note.trim() ? "Indiquez le motif du refus" : undefined}
            onClick={() => decider("REJECTED", "Poste refusé.")}
          >
            <ThumbsDown className="h-4 w-4" /> Refuser
          </BoutonDecisif>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * LE MESSAGE QUI PART AVEC LA DEMANDE DE BON DE COMMANDE — ce que l'assistante de direction lit pour
 * l'ÉTABLIR. S'il y a plusieurs assistantes, on choisit celle qui l'établira (l'action l'exige).
 */
export function DemandeBC({ busy, onSend, onCancel, assistantes, initial = "", bouton = "Envoyer la demande" }: {
  busy: boolean; onSend: (message: string, assistantId: string) => void; onCancel: () => void;
  assistantes: { id: string; name: string }[];
  /** Le message déjà envoyé, quand on CORRIGE une demande en cours (§118.187) — rien à retaper. */
  initial?: string;
  bouton?: string;
}) {
  const [message, setMessage] = React.useState(initial);
  const [assistante, setAssistante] = React.useState("");
  const choix = assistantes.length > 1;
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      {choix && (
        <select
          value={assistante} onChange={(e) => setAssistante(e.target.value)} aria-label="Assistante de direction qui établira le bon de commande"
          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
        >
          <option value="">Assistante de direction…</option>
          {assistantes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      <textarea
        value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        placeholder="Contenu du bon de commande, références, coordonnées du fournisseur — ce que l'assistante doit y porter."
        aria-label="Message de la demande d'émission du bon de commande"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" disabled={busy || (choix && !assistante)} title={choix && !assistante ? "Choisissez l'assistante de direction" : undefined} onClick={() => onSend(message, assistante)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {bouton}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/** Le demandeur VÉRIFIE le bon de commande que l'assistante a déposé : l'accepter l'envoie à la suite du circuit. */
export function VerifierBC({ demandeId, busy, onDecide, onCancel }: {
  demandeId: string; busy: boolean; onDecide: (accepte: boolean, note: string) => void; onCancel: () => void;
}) {
  const [note, setNote] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <Link href={`/pieces/${demandeId}`} target="_blank" className="inline-flex items-center gap-1 py-1 font-medium text-primary hover:underline">
        Ouvrir le bon de commande déposé <ExternalLink className="h-3 w-3" />
      </Link>
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Ce qui ne va pas (obligatoire pour refuser)"
        aria-label="Remarque sur le bon de commande déposé"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <BoutonDecisif size="sm" className="max-sm:w-full" disabled={busy} onClick={() => onDecide(true, note.trim())}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />} Accepter le BC
        </BoutonDecisif>
        <BoutonDecisif
          size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={busy || !note.trim()}
          title={note.trim() ? undefined : "Indiquez ce qu'il faut corriger"} onClick={() => onDecide(false, note.trim())}
        >
          <ThumbsDown className="h-4 w-4" /> Refuser
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * DÉPOSER UNE PIÈCE SUR LE POSTE — un devis / une pro forma (`ajouterDevisPoste`), ou la facture qui
 * demande le paiement (`demanderPaiementPoste`). Le fichier est toujours exigé (l'action le refuse aussi).
 */
export function FormulairePiece({
  titre, aide, bouton, busy, onSubmit, onCancel, montantInitial, montantMax = null, montantObligatoire = false,
  fournisseurInitial, proforma, freres = [], libelleFichier = "Fichier", fichierObligatoire = true, factureFacultative = false,
  plusieursDevis = false,
}: {
  /**
   * DÉPÔT DE DEVIS : plusieurs fichiers joints d'un coup sont, d'office, PLUSIEURS devis — chacun lu et transformé en lignes
   * (`ajouterDevisPoste`, `unDevisParFichier`). La case se décoche quand les fichiers sont les pages d'un même devis.
   */
  plusieursDevis?: boolean;
  titre: string; aide: string; bouton: string; busy: boolean; onSubmit: (fd: FormData) => void; onCancel: () => void;
  montantInitial: number | null; montantMax?: number | null; montantObligatoire?: boolean;
  /** Ce que le fichier principal EST (« Proforma / lettre de demande de sponsoring » pour un versement à l'association). */
  libelleFichier?: string;
  /** Faux quand la pièce exigée est déjà sur le poste : rien de plus à joindre. */
  fichierObligatoire?: boolean;
  /** Un second fichier, la facture, qu'on peut joindre mais qu'on n'exige pas (sponsoring direct). */
  factureFacultative?: boolean;
  /** Le fournisseur (devis seulement). */
  fournisseurInitial?: string;
  /** Devis : « choix » = case à cocher ; « imposee » = c'est forcément une pro forma (sponsoring direct). */
  proforma?: "choix" | "imposee";
  /** Les autres postes que la même pièce peut couvrir (devis seulement). */
  freres?: PosteFrere[];
}) {
  const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm";
  const [nbFichiers, setNbFichiers] = React.useState(0);
  const [unParFichier, setUnParFichier] = React.useState(true);
  const separes = plusieursDevis && nbFichiers > 1 && unParFichier;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}
      className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs sm:space-y-2 sm:p-2.5"
    >
      <p className="font-medium text-foreground">{titre}</p>
      <p className="text-muted-foreground">{aide}</p>
      <label className="block">
        {libelleFichier}{fichierObligatoire ? "" : " — déjà sur le poste"}
        <input
          type="file" name="attachment" multiple required={fichierObligatoire} className="mt-1 block w-full text-xs"
          onChange={(e) => setNbFichiers(e.target.files?.length ?? 0)}
        />
      </label>
      {plusieursDevis && nbFichiers > 1 && (
        <label className="inline-flex min-h-9 items-start gap-1.5 sm:min-h-0">
          <input type="checkbox" name="unDevisParFichier" checked={unParFichier} onChange={(e) => setUnParFichier(e.target.checked)} className="mt-0.5" />
          <span>
            Un devis par fichier ({nbFichiers} devis) — chacun est lu et transformé en lignes. Décochez si ces fichiers sont les pages d&apos;un même devis.
          </span>
        </label>
      )}
      {factureFacultative && (
        <label className="block">
          Facture — facultative
          <input type="file" name="facture" multiple className="mt-1 block w-full text-xs" />
        </label>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* Plusieurs devis d'un coup : le montant et la référence se lisent sur CHACUN — un champ unique serait faux pour tous. */}
        {!separes && (
          <>
            <label>
              Montant (DZD){montantObligatoire ? "" : " — facultatif"}
              <input
                type="number" inputMode="decimal" name="montant" min="0" step="0.01" required={montantObligatoire}
                max={montantMax ?? undefined} defaultValue={montantInitial ?? ""} className={`${champ} tabular-nums`}
              />
            </label>
            <label>
              Référence — facultatif
              <input name="reference" placeholder="N° de la pièce" className={champ} />
            </label>
          </>
        )}
        {fournisseurInitial !== undefined && (
          <label className="sm:col-span-2">
            Fournisseur — facultatif
            <input name="fournisseur" defaultValue={fournisseurInitial} className={champ} />
          </label>
        )}
      </div>
      {proforma === "imposee" && <input type="hidden" name="proforma" value="on" />}
      {proforma === "choix" && (
        <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
          <input type="checkbox" name="proforma" /> C&apos;est une facture pro forma
        </label>
      )}
      {freres.length > 0 && (
        <fieldset className="rounded-lg border border-border p-2">
          <legend className="px-1 text-muted-foreground">Ce document couvre aussi…</legend>
          <div className="flex flex-col gap-1">
            {freres.map((f) => (
              <label key={f.id} className="inline-flex min-h-9 flex-wrap items-center gap-1.5 sm:min-h-0">
                <input type="checkbox" name="autresPostes" value={f.id} /> {f.label}
                {f.label.trim().toLocaleLowerCase("fr") !== ITEM_KIND_LABELS[f.kind].toLocaleLowerCase("fr") && (
                  <span className="text-muted-foreground">({ITEM_KIND_LABELS[f.kind]})</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} {bouton}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/** Demander un devis (ou réclamer la facture) à l'assistante — le message part AVEC la demande. */
export function DemandeSecretariat({ nature, busy, onSend, onCancel }: {
  nature: NaturePieceSecretariat; busy: boolean; onSend: (message: string) => void; onCancel: () => void;
}) {
  const [message, setMessage] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <textarea
        value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        placeholder={PIECE_SECRETARIAT[nature].aide}
        aria-label={`Message de la demande de ${PIECE_SECRETARIAT[nature].libelle.toLowerCase()}`}
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" disabled={busy} onClick={() => onSend(message)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer à l&apos;assistante
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
      </div>
    </div>
  );
}

/**
 * UN GESTE QUI EXIGE UN MOTIF — retirer une demande de BC, annuler un ordre, demander une révision
 * (§118.187). Le motif est ce que lira la personne d'en face : le bouton reste fermé tant qu'il est vide,
 * et l'action le refuse aussi (un formulaire se forge).
 */
export function GesteAvecMotif({ titre, aide, bouton, danger = false, busy, extra, onSend, onCancel }: {
  titre: string; aide: string; bouton: string; danger?: boolean; busy: boolean;
  /** Un second champ facultatif (une nouvelle estimation). */
  extra?: { nom: string; libelle: string };
  onSend: (motif: string, extra: string) => void; onCancel: () => void;
}) {
  const [motif, setMotif] = React.useState("");
  const [valeur, setValeur] = React.useState("");
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background p-2 text-xs">
      <p className="font-medium text-foreground">{titre}</p>
      <p className="text-muted-foreground">{aide}</p>
      <textarea
        value={motif} onChange={(e) => setMotif(e.target.value)} rows={2}
        placeholder="Motif (obligatoire)"
        aria-label={`Motif — ${titre}`}
        className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
      />
      {extra && (
        <input
          type="number" inputMode="decimal" min={0} step="any" value={valeur} onChange={(e) => setValeur(e.target.value)}
          placeholder={extra.libelle} aria-label={extra.libelle}
          className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-xs"
        />
      )}
      <div className={RANGEE_ACTIONS}>
        <BoutonDecisif
          size="sm" variant={danger ? "outline" : "primary"} className={danger ? "text-destructive max-sm:w-full" : "max-sm:w-full"}
          disabled={busy || !motif.trim()} title={motif.trim() ? undefined : "Indiquez le motif"}
          onClick={() => onSend(motif.trim(), valeur.trim())}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {bouton}
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={onCancel}>Retour</Button>
      </div>
    </div>
  );
}

/** Le centre de validation Ad & Pro vise le bon de commande — un refus porte son motif. */
export function VisaBC({ busy, onDecide, onCancel }: { busy: boolean; onDecide: (decision: "APPROVE" | "REFUSE", note: string) => void; onCancel: () => void }) {
  const [note, setNote] = React.useState("");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 sm:flex-row sm:flex-wrap sm:items-center">
      <BoutonDecisif size="sm" className="max-sm:w-full" disabled={busy} onClick={() => onDecide("APPROVE", note)}>
        <ThumbsUp className="h-4 w-4" /> Valider le BC
      </BoutonDecisif>
      <BoutonDecisif
        size="sm" variant="outline" className="text-destructive max-sm:w-full" disabled={busy || !note.trim()}
        title={note.trim() ? undefined : "Indiquez le motif du refus dans le champ ci-dessous."}
        onClick={() => onDecide("REFUSE", note)}
      >
        <ThumbsDown className="h-4 w-4" /> Refuser
      </BoutonDecisif>
      <input
        value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Motif (obligatoire pour refuser)"
        aria-label="Motif de la décision sur le bon de commande"
        className="order-first min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:order-none sm:py-1 sm:text-xs"
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
    </div>
  );
}

/** Saisie du montant affecté, validée à la sortie du champ — pas de bouton par ligne. */
export function AllocateField({ itemId, current, busy, onSave }: { itemId: string; current: number | null; busy: boolean; onSave: (v: string) => void }) {
  const [value, setValue] = React.useState(current != null ? String(current) : "");
  React.useEffect(() => { setValue(current != null ? String(current) : ""); }, [current]);

  return (
    <label className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      Montant accordé :
      <input
        type="number" inputMode="decimal" min="0" step="0.01" value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== (current != null ? String(current) : "")) onSave(value); }}
        aria-label={`Montant affecté au poste ${itemId}`}
        className="w-36 rounded-lg border border-border bg-background px-2 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:w-32 sm:py-1 sm:text-sm"
      />
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      <span className="text-xs">DZD</span>
    </label>
  );
}

// ─────────────────────────────── Répartir un sponsoring indirect ───────────────────────────────

interface LigneSaisie { kind: string; montant: string; precision: string; payeA: string }

const ligneVide = (): LigneSaisie => ({ kind: "", montant: "", precision: "", payeA: "" });

/**
 * LES NATURES D'UN SPONSORING INDIRECT — une ligne par nature, le total sous les yeux (§118.175).
 * Le formulaire envoie un JSON (`repartition`) : des clés `ligne-3-montant` rendraient l'action
 * illisible à la dérivation des contrats (§118.73).
 */
function EditeurRepartition({ origine }: { origine?: number | null }) {
  const [lignes, setLignes] = React.useState<LigneSaisie[]>([ligneVide(), ligneVide()]);
  const total = lignes.reduce((s, l) => {
    const n = Number(l.montant.replace(/\s/g, "").replace(",", "."));
    return s + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  const maj = (i: number, champ: keyof LigneSaisie, v: string) => setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, [champ]: v } : l)));
  const champ = "w-full rounded-lg border border-border bg-background px-2 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm";
  return (
    <div className="space-y-2">
      <input type="hidden" name="repartition" value={JSON.stringify(lignes)} />
      <p className="text-xs text-muted-foreground">
        Donnez la ou les natures et leur montant — par exemple <strong>imprimerie 400 000</strong> et <strong>hôtellerie 600 000</strong>.
        Chaque nature devient un poste, qui se valide, se commande et se paie à part.
      </p>
      {lignes.map((l, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1.2fr_0.8fr_1fr_1fr_auto]">
          <select value={l.kind} onChange={(e) => maj(i, "kind", e.target.value)} aria-label={`Prise en charge ${i + 1}`} className={champ}>
            <option value="">— Prise en charge —</option>
            {NATURES_REPARTITION.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
          <input value={l.montant} onChange={(e) => maj(i, "montant", e.target.value)} inputMode="decimal" placeholder="Montant DZD" aria-label={`Montant ${i + 1}`} className={`${champ} tabular-nums`} />
          <input value={l.precision} onChange={(e) => maj(i, "precision", e.target.value)} placeholder="Précision (facultatif)" aria-label={`Précision ${i + 1}`} className={champ} />
          <input value={l.payeA} onChange={(e) => maj(i, "payeA", e.target.value)} placeholder="Fournisseur (facultatif)" aria-label={`Fournisseur ${i + 1}`} className={champ} />
          <button
            type="button" disabled={lignes.length <= 1}
            onClick={() => setLignes((ls) => ls.filter((_, j) => j !== i))}
            aria-label={`Retirer la ligne ${i + 1}`}
            className="inline-flex items-center justify-center justify-self-end rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 sm:justify-self-auto sm:p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button" onClick={() => setLignes((ls) => [...ls, ligneVide()])}
          className="inline-flex h-10 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-primary/50 px-3 text-sm font-medium text-primary hover:bg-primary/5 sm:h-8 sm:w-auto sm:text-xs"
        >
          <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Ajouter une nature
        </button>
        <span className="ml-auto text-muted-foreground">
          Total : <strong className="tabular-nums text-foreground">{formatCurrency(total)}</strong>
          {origine != null && Math.round(origine) !== Math.round(total) && total > 0 && (
            <> — le poste portait <span className="tabular-nums">{formatCurrency(origine)}</span></>
          )}
        </span>
      </div>
    </div>
  );
}

export function FormulaireRepartition({ origine, busy, onSubmit, onCancel }: {
  origine: number | null; busy: boolean; onSubmit: (fd: FormData) => void; onCancel: () => void;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <EditeurRepartition origine={origine} />
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />} Répartir
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

// ─────────────────────────────── Ajouter / modifier ───────────────────────────────

export function AddItemForm({ parent, parentId, decided, busy, onCancel, onSubmit }: {
  parent: AdProParent; parentId: string; decided: boolean; busy: boolean; onCancel: () => void; onSubmit: (fd: FormData) => void;
}) {
  // « MATÉRIEL DU STOCK » n'a ni fournisseur, ni montant, ni nature de budget (§118.167) : ces
  // champs disparaissent quand on la choisit — les envoyer quand même ferait refuser l'ajout.
  // « SPONSORING INDIRECT » se donne en NATURES (§118.175) : le montant unique cède la place à la
  // répartition, qui crée un poste par nature.
  const [nature, setNature] = React.useState<AdProItemKind>("STAND");
  const stock = nature === NATURE_MATERIEL_STOCK;
  const indirect = nature === "INDIRECT_SUPPORT";
  // LES FICHES SAISIES AVEC LE POSTE (Direction, 10/2026) : billetterie → voyageurs, hôtellerie → personnes logées.
  const natureFiches = porteDesVoyageurs(nature) ? "VOYAGEUR" as const : porteDesHebergements(nature) ? "HEBERGEMENT" as const : null;
  const [fiches, setFiches] = React.useState<FicheBrouillon[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (natureFiches) joindreFichiersDesFiches(fd, fiches, natureFiches);
        onSubmit(fd);
      }}
      className="space-y-2 rounded-xl border border-border p-3"
    >
      <input type="hidden" name="parent" value={parent} />
      <input type="hidden" name="parentId" value={parentId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Nature
          <select
            name="kind" value={nature} onChange={(e) => { setNature(e.target.value as AdProItemKind); setFiches([]); }}
            className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm"
          >
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">
          Libellé
          <input
            name="label" required
            placeholder={stock ? "Matériel du stand — congrès SAHO" : indirect ? "Sponsoring indirect — congrès SAHO" : "Stand 12 m² — hall B"}
            className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm"
          />
        </label>
        {!stock && !indirect && (
          <>
            <label className="text-xs">
              Payé à
              <input name="supplier" placeholder="Organisateur, agence, association…" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm" />
            </label>
            <label className="text-xs">
              Montant estimé (DZD)
              <input name="amountEstimated" type="number" inputMode="decimal" min="0" step="0.01" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base tabular-nums outline-none focus:border-primary/60 sm:text-sm" />
            </label>
          </>
        )}
      </div>

      {indirect && <EditeurRepartition />}

      {natureFiches && <FichesNouveauPoste key={natureFiches} nature={natureFiches} fiches={fiches} onChange={setFiches} />}

      {stock && (
        <p className="rounded-lg bg-secondary/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          Vous listerez ensuite les articles du magasin et leurs quantités. Rien n&apos;en sort avant l&apos;accord du poste ;
          après l&apos;événement, vous direz ce qui a été remis, et le reste reviendra au magasin.
        </p>
      )}

      {/* LA question à poser au moment de l'ajout : cet argent est-il déjà accordé, ou en plus ? */}
      {!stock && (
        <fieldset className="rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">Ce poste est-il déjà couvert par le budget accordé ?</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="INCLUDED" defaultChecked /> Inclus dans le budget accordé
            </label>
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="ADDITIONAL" /> Budget supplémentaire (rallonge)
            </label>
          </div>
        </fieldset>
      )}
      <label className="block text-xs">
        Précisions
        <input name="notes" placeholder="Facultatif" className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm" />
      </label>

      {decided && !stock && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          L&apos;opération est déjà tranchée : ce poste sera marqué « ajouté après décision ». S&apos;il
          est <strong>inclus</strong> dans le budget accordé, il fera apparaître un dépassement tant
          qu&apos;il n&apos;est pas compensé ; s&apos;il s&apos;agit d&apos;une <strong>rallonge</strong>, il sera compté à part.
        </p>
      )}

      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * MODIFIER UN POSTE — ce qui le DÉCRIT, pas ce qui l'engage.
 *
 * Ces champs ne portent aucun engagement financier — seul le montant AFFECTÉ a été transmis aux
 * Finances, et lui seul se verrouille avec l'ordre de dépense. La nature de budget (inclus /
 * rallonge) reste modifiable tant que la Direction n'a pas tranché : après, c'est sur quoi elle
 * s'est prononcée.
 */
export function EditItemForm({ item, busy, onCancel, onSave }: {
  item: ItemRow; busy: boolean; onCancel: () => void; onSave: (fd: FormData) => void;
}) {
  const budgetLocked = budgetKindLocked(item);
  const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm";
  // UN POSTE « MATÉRIEL DU STOCK » ne se décrit que par son libellé et ses précisions : ni montant,
  // ni fournisseur, ni nature de budget — et sa nature ne change plus hors d'un brouillon vierge
  // (`refusChangementNature`). Son matériel se compose dans son propre bloc.
  if (estPosteStock(item)) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <label className="block text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>
        <div className={RANGEE_ACTIONS}>
          <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
        </div>
      </form>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Nature
          <select name="kind" defaultValue={item.kind} className={champ}>
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="text-xs">Payé à<input name="supplier" defaultValue={item.supplier ?? ""} placeholder="Organisateur, agence, association…" className={champ} /></label>
        <label className="text-xs">
          Montant estimé (DZD)
          <input name="amountEstimated" type="number" inputMode="decimal" min="0" step="0.01" defaultValue={item.amountEstimated ?? ""} className={`${champ} tabular-nums`} />
        </label>
      </div>
      <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>

      {budgetLocked ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          La Direction a tranché : la nature du budget ({ITEM_BUDGET_KIND_LABELS[item.budgetKind]}) ne change plus —
          c&apos;est sur elle qu&apos;elle s&apos;est prononcée.
        </p>
      ) : (
        <fieldset className="rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">Ce poste est-il couvert par le budget accordé ?</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="INCLUDED" defaultChecked={item.budgetKind === "INCLUDED"} /> Inclus dans le budget accordé
            </label>
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="ADDITIONAL" defaultChecked={item.budgetKind === "ADDITIONAL"} /> Budget supplémentaire (rallonge)
            </label>
          </div>
        </fieldset>
      )}

      {item.expenseOrderId && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warning" />
          Un ordre de dépense a été émis : le <strong>montant affecté</strong> ne change plus. Le reste se corrige librement.
        </p>
      )}

      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

export function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "success" }) {
  const cls = tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : "";
  return (
    <div className="min-w-0 rounded-lg border border-border px-2.5 py-2 sm:px-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums [overflow-wrap:anywhere] sm:text-base ${cls}`}>{value}</p>
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}
