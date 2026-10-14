"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { setAdProDgThreshold, setBcValidationThreshold } from "@/lib/actions/settings-actions";
import { deciderVisaCentreAdPro, reexaminerVisaCentreAdPro } from "@/lib/actions/ad-pro-centre-actions";
import { approveAdProItemOrder } from "@/lib/actions/ad-pro-item-actions";
import type { LigneCentre, FormePorte, FormeBC } from "@/lib/ad-pro/centre";
import type { VisaTranche } from "@/lib/queries/ad-pro-centre";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { SurlignerCible } from "@/components/shared/surligner-cible";
import { ancreLigneCentre } from "@/lib/chemins/ad-pro";

/**
 * LE PLAN DE TRAVAIL DU CENTRE.
 *
 * Deux gestes possibles par ligne, et la distinction n'est pas un confort :
 *
 *   • `VISA_CENTRE` (consulting, autres demandes) — le visa EST la porte, il n'y a pas d'étape de
 *     circuit ailleurs : on tranche ICI. De même pour les BONS DE COMMANDE d'un poste ou du
 *     registre Legal (§118.148) : un BC se juge sur sa ligne — prestataire, montant, message.
 *   • `ETAPE_CIRCUIT` / `ETAPE_PROMO` — la décision se prend DEVANT LE DOSSIER, par l'action de
 *     son circuit. Arbitrer 1,2 M DZD depuis une ligne de liste, sans les pièces, sans la
 *     catégorie budgétaire, sans le fil des avis, c'est valider en regardant autre chose
 *     (§104.7). Le centre dit CE QUI attend et POURQUOI, et y mène en un clic.
 */

const LIBELLE_FORME: Record<FormePorte | FormeBC, string> = {
  ETAPE_CIRCUIT: "Étape du circuit",
  ETAPE_PROMO: "Circuit matériel promotionnel",
  VISA_CENTRE: "Visa du centre",
  BC_POSTE: "Bon de commande d'un poste",
  BC_LEGAL: "Bon de commande (Legal)",
  BC_PROMO: "Bon de commande — matériel promotionnel",
};

const estBC = (r: LigneCentre) => r.forme === "BC_POSTE" || r.forme === "BC_LEGAL" || r.forme === "BC_PROMO";

/**
 * DEUX LISTES, PARCE QUE CE SONT DEUX QUESTIONS.
 *
 * Une DEMANDE est ici parce que son budget dépasse le seuil des DEMANDES ; un BON DE COMMANDE est
 * ici parce que son montant dépasse le seuil des BONS DE COMMANDE (§118.149) — deux chiffres
 * distincts, réglés chacun sur cet écran. Les mêler ferait lire « au-dessus du seuil » sur un BC
 * jugé contre l'autre chiffre — une raison fausse, affichée à celui qui décide.
 */
export function CentreAdProBoard({ rows, seuil, seuilBC, tranches, ligneAOuvrir }: {
  rows: LigneCentre[]; seuil: number; seuilBC: number; tranches: { lignes: VisaTranche[]; total: number };
  /** La ligne dont parle la notification (`?ligne=`) : elle vient sous les yeux et s'entoure. */
  ligneAOuvrir?: string | null;
}) {
  const demandes = rows.filter((r) => !estBC(r));
  const bcs = rows.filter(estBC);
  const regleBC = seuilBC > 0
    ? `au-dessus de ${seuilBC.toLocaleString("fr-FR")} DZD — en deçà, ils passent directement à la signature des Finances`
    : "tous, quel que soit leur montant (aucun seuil fixé)";
  return (
    <div className="space-y-5">
      <SurlignerCible ids={[ligneAOuvrir ? ancreLigneCentre(ligneAOuvrir) : null]} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SeuilForm seuil={seuil} />
        <SeuilBCForm seuil={seuilBC} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bons de commande à valider</CardTitle>
          <CardDescription>
            {bcs.length === 0
              ? `Aucun bon de commande n'attend le centre. Y passent les BC nés d'Ad & Pro ${regleBC}.`
              : `${bcs.length} bon(s) de commande né(s) d'Ad & Pro, le plus ancien en tête — y passent ceux ${regleBC}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bcs.length === 0 ? (
            <EmptyState
              title="Aucun bon de commande en attente"
              description={`La demande de bon de commande d'un poste, et toute pièce BC enregistrée dans Legal depuis une demande Ad & Pro, arrivent ici avant d'engager la société — une fois validées, elles passent à la signature des Finances (${MENU_BONS_DE_COMMANDE}).`}
            />
          ) : (
            <ul className="space-y-3">
              {bcs.map((r) => (
                <LigneCard key={`${r.entityType}:${r.entityId}`} row={r} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Demandes au-dessus du seuil</CardTitle>
          <CardDescription>
            {demandes.length === 0
              ? "Rien n'attend le centre."
              : `${demandes.length} demande(s) en attente d'arbitrage, la plus ancienne en tête.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {demandes.length === 0 ? (
            <EmptyState
              title="Aucune demande en attente"
              description="Les demandes Ad & Pro dont le budget total dépasse le seuil apparaîtront ici dès leur soumission. En dessous du seuil, la porte est franchie automatiquement et tracée."
            />
          ) : (
            <ul className="space-y-3">
              {demandes.map((r) => (
                <LigneCard key={`${r.entityType}:${r.entityId}`} row={r} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* LES REFUS ET LES RENVOIS RÉCENTS (audit 360°, R07) : un refus se RÉEXAMINE par un siège,
          motif à l'appui ; un renvoi attend son demandeur, qui la resoumet depuis la fiche. */}
      {tranches.lignes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Refusées ou renvoyées récemment</CardTitle>
            <CardDescription>
              {tranches.total > tranches.lignes.length
                ? `Les ${tranches.lignes.length} plus récentes sur ${tranches.total}.`
                : `${tranches.lignes.length} décision(s).`} Un refus se réexamine ici ; une demande renvoyée revient quand son demandeur la resoumet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {tranches.lignes.map((t) => <LigneTranchee key={`${t.entityType}:${t.entityId}`} t={t} />)}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LigneTranchee({ t }: { t: VisaTranche }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  return (
    <li id={ancreLigneCentre(t.entityId)} className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={t.href} className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-primary hover:underline [overflow-wrap:anywhere]">
          {t.reference ? `${t.reference} — ` : ""}{t.intitule} <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </Link>
        <Badge tone={t.etat === "REFUSED" ? "danger" : "warning"} dot={false}>{t.etat === "REFUSED" ? "Refusée" : "À corriger"}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {t.decideur ?? "Le centre"}{t.decidedAt ? ` · ${new Date(t.decidedAt).toLocaleDateString("fr-FR")}` : ""}{t.note ? ` — « ${t.note} »` : ""}
      </p>
      {t.etat === "REFUSED" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Input
            value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Motif du réexamen — ${t.intitule}`}
            placeholder="Pourquoi le centre réexamine (obligatoire)" className="min-w-0 flex-1"
          />
          <BoutonDecisif
            size="sm" variant="outline" className="max-sm:w-full" disabled={busy || !note.trim()}
            onClick={async () => {
              setBusy(true); setError(null);
              const fd = new FormData();
              fd.set("entityType", t.entityType); fd.set("entityId", t.entityId); fd.set("note", note);
              const r = await reexaminerVisaCentreAdPro(fd);
              setBusy(false);
              if (!r.ok) setError(r.error ?? "Échec.");
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Réexaminer
          </BoutonDecisif>
        </div>
      )}
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </li>
  );
}

function SeuilForm({ seuil }: { seuil: number }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Le seuil des demandes</CardTitle>
        <CardDescription>
          Au-dessus de ce montant — <strong>strictement</strong> au-dessus —, une demande Ad &amp; Pro passe
          par ce centre. En dessous, sa porte est franchie automatiquement et tracée. Réglable par la
          Direction Générale et le Super Admin, ici comme dans Administration › Réglages : c&apos;est le
          même réglage, écrit à un seul endroit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={async (fd) => {
            setSaving(true); setError(null);
            const r = await setAdProDgThreshold(fd);
            setSaving(false);
            if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
            else setError(r.error ?? "Échec.");
          }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        >
          <div className="space-y-1">
            <Label htmlFor="adProDgThreshold">Seuil (DZD)</Label>
            <Input id="adProDgThreshold" name="adProDgThreshold" type="number" inputMode="decimal" min="0" step="any" defaultValue={seuil} />
            <p className="text-xs text-muted-foreground">
              <strong>0</strong> = aucune demande ne passe par le centre. Une demande <em>sans montant
              renseigné</em> y passe quand même : on ne franchit pas un contrôle sur une absence de donnée.
            </p>
          </div>
          <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
            {saved ? "Enregistré" : "Enregistrer"}
          </Button>
        </form>
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * LE SEUIL DES BONS DE COMMANDE (§118.149) — « tout BC supérieur à un montant configuré dans les
 * centres de validations Ad&Pro devra passer par la validation d'un des centres ».
 *
 * Depuis 10/2026, il ne vaut plus que pour les bons de commande NÉS D'AD & PRO : le centre de validations règle le
 * sien pour les autres (« mets-moi un seuil là-bas aussi »). La phrase le dit. La réponse de l'action DIT ce que le
 * changement a déplacé.
 */
function SeuilBCForm({ seuil }: { seuil: number }) {
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Le seuil des bons de commande</CardTitle>
        <CardDescription>
          Un bon de commande <strong>né d&apos;Ad &amp; Pro</strong> et <strong>strictement</strong> au-dessus de ce
          montant passe par ce centre avant la signature des Finances. En deçà, il passe directement à leur signature
          ({MENU_BONS_DE_COMMANDE}). Les bons de commande hors Ad &amp; Pro ont leur propre seuil, réglé depuis le
          centre de validations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={async (fd) => {
            setSaving(true); setError(null); setMessage(null);
            const r = await setBcValidationThreshold(fd);
            setSaving(false);
            if (r.ok) setMessage(r.message ?? "Enregistré.");
            else setError(r.error ?? "Échec.");
          }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        >
          <div className="space-y-1">
            <Label htmlFor="bcValidationThreshold">Seuil des bons de commande (DZD)</Label>
            <Input id="bcValidationThreshold" name="bcValidationThreshold" type="number" inputMode="decimal" min="0" step="any" defaultValue={seuil} />
            <p className="text-xs text-muted-foreground">
              <strong>0</strong> = tout bon de commande passe par un centre. Un BC <em>sans montant
              renseigné</em> y passe quand même. Les BC en cours qui changent de côté du seuil sont
              réaiguillés aussitôt ; une validation déjà donnée ou une signature ne se retirent pas.
            </p>
          </div>
          <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Enregistrer
          </Button>
        </form>
        {message && <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground">{message}</p>}
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function LigneCard({ row }: { row: LigneCentre }) {
  const jours = Math.floor((Date.now() - new Date(row.depuis).getTime()) / 86_400_000);
  return (
    <li id={ancreLigneCentre(row.entityId)} className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {/* Deux lignes plutôt qu'un intitulé coupé au premier mot au téléphone : c'est lui qu'on arbitre. */}
          <p className="line-clamp-2 font-medium [overflow-wrap:anywhere]" title={row.intitule}>{row.intitule}</p>
          <p className="text-xs text-muted-foreground">
            {row.demandeur ? `Demandé par ${row.demandeur} · ` : ""}
            en attente depuis {jours === 0 ? "aujourd'hui" : `${jours} jour(s)`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone="neutral" dot={false}>{LIBELLE_FORME[row.forme]}</Badge>
          {jours >= 7 && <Badge tone="danger" dot={false}>dort depuis {jours} j</Badge>}
        </div>
      </div>

      <p className="text-sm">
        {/* Le montant ET le seuil, côte à côte : c'est le RAPPORT des deux qui explique pourquoi
            cette demande est ici, et un montant seul ne le dit pas. Un BC, lui, n'a pas de seuil :
            il est ici parce que TOUT bon de commande y passe, et c'est ce qu'on écrit. */}
        {row.montant != null && row.montant > 0
          ? <><strong>{row.montant.toLocaleString("fr-FR")} DZD</strong>{row.seuil ? <> — au-dessus du seuil de {row.seuil.toLocaleString("fr-FR")} DZD</> : null}</>
          : estBC(row)
            ? <span className="text-muted-foreground">Montant non renseigné sur la pièce — ouvrez-la pour le lire avant de décider.</span>
            : <span className="text-muted-foreground">Montant non renseigné — la porte s&apos;ouvre par défaut : on ne franchit pas un contrôle sur une absence de donnée.</span>}
      </p>
      {row.detail && (
        <p className="rounded-lg bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground">
          <strong>{row.forme === "BC_POSTE" ? "Message du demandeur :" : "Note :"}</strong> {row.detail}
        </p>
      )}

      {row.forme === "VISA_CENTRE" || row.forme === "BC_LEGAL" || row.forme === "BC_POSTE"
        ? <DecisionVisa row={row} />
        : (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={row.href}
              className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-ring sm:h-8 sm:w-auto"
            >
              Ouvrir le dossier et décider <ExternalLink className="h-3.5 w-3.5" />
            </Link>
            <p className="text-xs text-muted-foreground">
              La décision se prend devant le dossier — avec ses pièces, sa catégorie budgétaire et le fil des avis.
            </p>
          </div>
        )}
    </li>
  );
}

function DecisionVisa({ row }: { row: LigneCentre }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");

  // TROIS ISSUES là où le centre est la porte (audit 360°, R07/R10) : valider, RENVOYER pour
  // correction, refuser. Le BC d'un poste garde les deux siennes — un refus s'y redemande depuis le poste.
  const troisIssues = row.forme === "VISA_CENTRE" || row.forme === "BC_LEGAL";
  const decider = async (choix: "VALIDER" | "RENVOYER" | "REFUSER") => {
    const approuve = choix === "VALIDER";
    setBusy(true); setError(null);
    const fd = new FormData();
    let r: { ok: boolean; error?: string };
    // LE BC D'UN POSTE se décide par l'action du poste — la MÊME que le bouton de la fiche, avec
    // la même garde : le centre est une lentille, jamais une seconde autorisation.
    if (row.forme === "BC_POSTE") {
      fd.set("id", row.entityId);
      fd.set("decision", approuve ? "APPROVE" : "REFUSE");
      fd.set("note", note);
      // CE QUE LE CENTRE A LU (§118.187) : un montant ou un prestataire changé pendant la lecture
      // ne se vise pas sans avoir été vu — l'action compare et refuse en le disant.
      if (row.montant != null) fd.set("montantVu", String(row.montant));
      fd.set("prestataireVu", row.prestataire ?? "");
      r = await approveAdProItemOrder(undefined, fd);
    } else {
      fd.set("entityType", row.entityType);
      fd.set("entityId", row.entityId);
      fd.set("decision", choix);
      fd.set("note", note);
      r = await deciderVisaCentreAdPro(fd);
    }
    setBusy(false);
    if (!r.ok) setError(r.error ?? "Échec.");
  };
  const libelleAccord = row.forme === "VISA_CENTRE" ? "Autoriser le dépassement" : "Valider le bon de commande";

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={`note-${row.entityId}`}>Motif <span className="text-muted-foreground">({troisIssues ? "obligatoire pour renvoyer ou refuser" : "obligatoire pour refuser"})</span></Label>
        <Input
          id={`note-${row.entityId}`} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Ce que le demandeur doit savoir"
        />
      </div>
      {/* Au téléphone, les issues s'empilent en pleine largeur : trois boutons serrés sur une ligne
          se manquent au pouce — et ici chaque geste engage de l'argent. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <BoutonDecisif size="sm" className="max-sm:w-full" disabled={busy} onClick={() => decider("VALIDER")}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {libelleAccord}
        </BoutonDecisif>
        {troisIssues && (
          <BoutonDecisif size="sm" variant="outline" className="max-sm:w-full" disabled={busy || !note.trim()} onClick={() => decider("RENVOYER")}>Renvoyer pour correction</BoutonDecisif>
        )}
        <BoutonDecisif size="sm" variant="destructive" className="max-sm:w-full" disabled={busy} onClick={() => decider("REFUSER")}>Refuser</BoutonDecisif>
        <Link
          href={row.href}
          className="inline-flex items-center justify-center gap-1 py-2 text-xs text-primary hover:underline sm:justify-start sm:py-0"
        >
          Voir le dossier <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
