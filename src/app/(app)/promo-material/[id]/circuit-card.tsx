"use client";

import * as React from "react";
import { Loader2, AlertCircle, BadgeCheck, BellRing, CheckCircle2, Circle, Clock, FileCheck2, Rocket, Send, XCircle, Undo2, RotateCcw } from "lucide-react";
import {
  startPromoCircuit, markQuoteReceived, validatePromoStep, refusePromoStep, completePromoTrack,
  renvoyerPromoStep, resoumettrePromoDemande, relancerPromo,
} from "@/lib/actions/promo-circuit-actions";
import { demanderDevisPromo, terminerRetranscriptionPromo } from "@/lib/actions/promo-devis-actions";
import { genererBonsDeCommandePromo, marquerBonDeCommandeEnvoye } from "@/lib/actions/promo-execution-actions";
import type { PromoTrack } from "@/lib/promo-material/circuit";
import type { ChiffresDuDossier, EtapeFiche, GesteFiche, OuEnEst } from "@/lib/promo-material/fiche";
import { MenuLigne, emettreGeste } from "./menu-ligne";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { InfoBulle } from "@/components/ui/info-bulle";
import type { ActionResult } from "@/lib/actions/types";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * LE SUIVI DU CIRCUIT — ce que chacun voit dépend de qui il est.
 *
 * PDG et Super Admin voient la CHAÎNE ENTIÈRE : les étapes de CE dossier, où il en est, les
 * chantiers parallèles. Tous les autres ne voient que l'ÉTAPE EN COURS et une barre d'avancement :
 * un délégué n'a pas à savoir que la comptabilité a mis onze jours à signer — afficher toute la
 * chaîne à tout le monde transformerait un outil de travail en tableau de surveillance mutuelle.
 *
 * Tout arrive DÉJÀ TRANCHÉ, en props : la frise (les étapes que CE dossier traverse, selon sa
 * version — `etapesDuDossier`), les libellés, qui peut agir, ce qui manque à chaque chantier. Ce
 * composant ne décide rien : il affiche ce qu'on lui a permis d'afficher, et une règle recopiée
 * ici finirait par montrer un bouton que l'action refuse (§118.5).
 */

export interface ChantierAffiche {
  key: PromoTrack;
  label: string;
  closed: boolean;
  /** (circuit 2) Ce qui manque encore, dit par le serveur — `null` = le chantier peut se clore. */
  manque: string | null;
}

interface Props {
  id: string;
  /** L'état du circuit, ou null pour un dossier d'avant la réforme. */
  state: string | null;
  version: 1 | 2;
  /** Tranché CÔTÉ SERVEUR par seesFullCircuit — jamais recalculé ici. */
  showFull: boolean;
  /** Les étapes que CE dossier traverse, dans l'ordre (frise). */
  etapes: { key: string; label: string }[];
  stateLabel: string;
  /** L'utilisateur peut valider / refuser l'étape en cours (canValidate, côté serveur). */
  canAct: boolean;
  /** Le bouton « Valider » a-t-il sa place ici ? Au choix des lignes du circuit 2, la validation
   *  passe par la sélection (carte « Devis ») : valider sans ligne retenue ne veut rien dire. */
  validerIci: boolean;
  /** (circuit 1) Peut confirmer la réception du devis. */
  canConfirmQuote: boolean;
  /** Peut basculer un dossier d'avant la réforme sur le circuit actuel. */
  canStart: boolean;
  /** (circuit 2) Peut demander les devis au secrétariat — le demandeur, à l'étape « devis à demander ». */
  /** Peut clore un chantier (pilote de l'exécution). */
  canDrive: boolean;
  /** Le renvoi pour correction en cours (§118.190) — affiché à tous, pour que personne ne cherche
   *  pourquoi le dossier est revenu en arrière. */
  renvoi: { depuis: string; quand: string; motif: string } | null;
  /** Les trois issues d'une validation, tranchées CÔTÉ SERVEUR par les mêmes règles que les actions. */
  canRenvoyer: boolean;
  canRefuser: boolean;
  /** Le demandeur peut resoumettre la demande corrigée (validation de la demande renvoyée). */
  canResoumettre: boolean;
  chantiers: ChantierAffiche[];
  waitingLabel: string;
  progressStep: number;
  progressTotal: number;
}

function useRun() {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : tant que les nouvelles données ne sont pas là, l'écran montre
  // l'état d'avant — renvoyer, valider ou resoumettre dessus agirait deux fois. Les gestes restent
  // fermés jusqu'à la fin du rafraîchissement.
  const { enCours, rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  /** `apres` referme le formulaire du geste qui vient d'aboutir : resté ouvert, il offrirait un second
   *  envoi que l'action refuserait — un bouton offert puis refusé n'est pas un geste (§118.83). */
  const run = async (fn: () => Promise<ActionResult>, apres?: () => void) => {
    setSaving(true); setErr(null); setMsg(null);
    const r = await fn();
    setSaving(false);
    if (r.ok) { setMsg(r.message ?? null); apres?.(); rafraichir(); } else setErr(r.error ?? "Action impossible.");
  };
  return { saving: saving || enCours, err, msg, run };
}

const Err = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div> : null;
const Ok = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div> : null;

export function PromoCircuitCard(p: Props) {
  const { saving, err, msg, run } = useRun();
  const [mode, setMode] = React.useState<null | "renvoi" | "refus">(null);
  const [motif, setMotif] = React.useState("");
  const [correction, setCorrection] = React.useState("");
  const fd = (extra?: Record<string, string>) => {
    const f = new FormData(); f.set("id", p.id);
    if (extra) for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };

  // ── Dossier d'avant la réforme : proposer de basculer sur le circuit actuel. ──
  if (!p.state) {
    if (!p.canStart) return null;
    return (
      <div className="space-y-3">
        <Err msg={err} />
        <div className="flex flex-wrap items-center gap-2">
          <BoutonDecisif size="sm" onClick={() => run(() => startPromoCircuit(fd()))} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Basculer sur le circuit actuel
          </BoutonDecisif>
          <InfoBulle align="left" label="Ce que fait la bascule">
            Ce dossier suit encore l&apos;ancien parcours. Le circuit actuel prend le relais : validation de la demande,
            devis demandés au secrétariat et retranscrits, choix des lignes, Direction Marketing (et Directeur Général
            au-dessus du seuil), puis bons de commande, factures, paiements et visa.
          </InfoBulle>
        </div>
      </div>
    );
  }

  const refused = p.state === "REFUSED";
  const completed = p.state === "COMPLETED";
  const inExec = p.state === "IN_EXECUTION";
  const stepIndex = p.etapes.findIndex((e) => e.key === p.state);
  const total = Math.max(1, p.progressTotal);

  return (
    <div className="space-y-3">
      {/* La frise ENTIÈRE pour le PDG / Super Admin — une barre horizontale qui défile dans son propre
          conteneur au téléphone ; l'avancement seul pour les autres. Le statut est déjà dans l'en-tête. */}
      {p.showFull ? (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <ol className="flex w-max items-center gap-1">
            {p.etapes.filter((e) => e.key !== "COMPLETED").map((e, i) => {
              const isPast = !refused && (completed || (stepIndex >= 0 && stepIndex > i));
              const isCurrent = p.state === e.key;
              return (
                <li key={e.key} className="flex shrink-0 items-center gap-1" aria-current={isCurrent ? "step" : undefined}>
                  {i > 0 && <span className={`h-px w-3 ${isPast || isCurrent ? "bg-emerald-500/50" : "bg-border"}`} aria-hidden />}
                  <span className={`flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${
                    isCurrent ? "bg-blue-500/10 font-medium text-blue-700 ring-1 ring-blue-500/30 dark:text-blue-300"
                    : isPast ? "text-emerald-700 dark:text-emerald-400"
                    : "text-muted-foreground/70"
                  }`}>
                    {isPast ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      : isCurrent ? <Clock className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                      : <Circle className="h-3 w-3" />}
                    {e.label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <Progress value={(Math.min(p.progressStep, total) / total) * 100} />
      )}

      {/* UNE phrase : où en est le dossier, et chez qui. */}
      <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="flex min-w-0 items-start gap-1.5 [overflow-wrap:anywhere]">
          {refused ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            : completed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            : <Clock className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />}
          {p.waitingLabel}
        </span>
        {!p.showFull && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">Étape {Math.min(p.progressStep, total)} / {total}</span>}
      </p>

      {/* Les chantiers parallèles — chacun se CONSTATE sur ses pièces : ce qui manque est dit. */}
      {(inExec || completed) && (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {p.chantiers.map((t) => {
            const closed = completed || t.closed;
            return (
              <li key={t.key} className={`space-y-2 rounded-lg border px-3 py-2 text-sm ${closed ? "border-emerald-600/30 bg-emerald-500/5" : "border-border"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {closed ?<CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    {t.label}
                  </span>
                  {!closed && p.canDrive && (
                    <Button size="sm" variant="outline" className="shrink-0" onClick={() => run(() => completePromoTrack(fd({ track: t.key })))} disabled={saving || Boolean(t.manque)}>
                      Clore
                    </Button>
                  )}
                </div>
                {!closed && t.manque && <p className="text-xs text-muted-foreground">{t.manque}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <Err msg={err} />
      <Ok msg={msg} />

      {/* CIRCUIT 2 — LA DEMANDE DE DEVIS PART D'ELLE-MÊME (§118.204) : à la création, ou à la validation de
          la demande. Son aperçu, ses précisions et, au besoin, son envoi vivent dans « Articles demandés » —
          plus de bouton « Demander les devis » ni de champ de précisions séparé ici. */}
      {/* CIRCUIT 1 — le devis est déposé comme pièce, puis confirmé. */}
      {p.version === 1 && p.state === "QUOTE_REQUESTED" && p.canConfirmQuote && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => run(() => markQuoteReceived(fd()))} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} Devis reçu et déposé
          </Button>
          <span className="text-xs text-muted-foreground">Déposez d&apos;abord le devis dans les documents ci-dessous.</span>
        </div>
      )}

      {/* LE RENVOI POUR CORRECTION (§118.190) — dit à tous, avec son motif. */}
      {p.renvoi && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">À corriger</span> — renvoyé à l&apos;étape « {p.renvoi.depuis} » le {p.renvoi.quand} : « {p.renvoi.motif} »
        </div>
      )}
      {p.canResoumettre && (
        <form
          action={(f: FormData) => { f.set("id", p.id); run(() => resoumettrePromoDemande(f), () => setCorrection("")); }}
          className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <Label htmlFor="promo-resoumission">Ce qui a changé</Label>
          <Textarea id="promo-resoumission" name="note" value={correction} onChange={(e) => setCorrection(e.target.value)} className="min-h-[60px]" placeholder="Ex. quantités revues, article ajouté, précision du brief." />
          <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={saving || !correction.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Resoumettre la demande
          </Button>
        </form>
      )}

      {/* LES TROIS ISSUES — valider, renvoyer pour correction, refuser (audit 360°, R05). */}
      {mode === null && ((p.canAct && p.validerIci) || p.canRenvoyer || p.canRefuser) && (
        <div className="flex flex-wrap gap-2">
          {p.canAct && p.validerIci && (
            <BoutonDecisif size="sm" variant="success" onClick={() => run(() => validatePromoStep(fd()))} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Valider cette étape
            </BoutonDecisif>
          )}
          {p.canRenvoyer && (
            <Button size="sm" variant="outline" onClick={() => setMode("renvoi")} disabled={saving}>
              <Undo2 className="h-4 w-4" /> Renvoyer pour correction
            </Button>
          )}
          {p.canRefuser && (
            <Button size="sm" variant="outline" onClick={() => setMode("refus")} disabled={saving}>
              <XCircle className="h-4 w-4" /> Refuser
            </Button>
          )}
        </div>
      )}
      {mode === "renvoi" && p.canRenvoyer && (
        <form
          action={(f: FormData) => { f.set("id", p.id); run(() => renvoyerPromoStep(f), () => { setMode(null); setMotif(""); }); }}
          className="space-y-2 rounded-lg border border-amber-500/40 p-3"
        >
          <Label htmlFor="promo-renvoi-motif">Ce qu&apos;il faut corriger</Label>
          <Textarea id="promo-renvoi-motif" name="motif" value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[60px]" placeholder="Ex. retenez plutôt le devis de l'imprimeur B, moins cher à qualité égale." />
          <div className="flex flex-wrap gap-2">
            <BoutonDecisif type="submit" size="sm" disabled={saving || !motif.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Renvoyer au demandeur
            </BoutonDecisif>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
          </div>
        </form>
      )}
      {mode === "refus" && p.canRefuser && (
        <form
          action={(f: FormData) => { f.set("id", p.id); run(() => refusePromoStep(f), () => { setMode(null); setMotif(""); }); }}
          className="space-y-2 rounded-lg border border-destructive/30 p-3"
        >
          <Label htmlFor="promo-refuse-reason">Motif du refus</Label>
          <Textarea id="promo-refuse-reason" name="reason" value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[60px]" placeholder="Un refus est définitif : pour une correction, renvoyez plutôt le dossier." />
          <div className="flex flex-wrap gap-2">
            <BoutonDecisif type="submit" size="sm" variant="destructive" disabled={saving || !motif.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Confirmer le refus
            </BoutonDecisif>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ═══════════════════════ CIRCUIT 2 — LA CARTE DU DOSSIER (maquette validée, 10/2026) ═══════════════════════

export interface StatutProps {
  id: string;
  frise: EtapeFiche[];
  chiffres: ChiffresDuDossier;
  ou: OuEnEst;
  /** Le geste utile à la personne qui regarde — `null` : en attente (ou rien à faire). */
  geste: GesteFiche | null;
  /** Relancer la personne attendue (demandeur, assistante, pilotes, Direction) — tranché au serveur. */
  peutRelancer: boolean;
  canRenvoyer: boolean;
  canRefuser: boolean;
  renvoi: { depuis: string; quand: string; motif: string } | null;
  /** La demande au secrétariat avant son départ : son texte exact. */
  apercuDemandeDevis: string | null;
  /** Ce qui empêche encore de terminer la retranscription — dit par le serveur. */
  manques: string[];
  /** Les chantiers encore ouverts : « Clore le dossier » les clôt l'un après l'autre. */
  chantiersOuverts: PromoTrack[];
}

const nombreDzd = (n: number | null) => (n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }));

/** Le point de la frise — fait (vert), ici (bleu), arrêté (rouge), à venir. */
const POINT: Record<EtapeFiche["etat"], string> = {
  fait: "border-success bg-success",
  ici: "border-primary bg-primary ring-4 ring-primary/15",
  arret: "border-destructive bg-destructive ring-4 ring-destructive/15",
  avenir: "border-border bg-card",
};

/**
 * LA CARTE DU DOSSIER — la frise des huit étapes, les cinq chiffres d'argent, et UNE bande « ce qu'il reste à faire » :
 * le seul geste utile à la personne qui regarde, ou « En attente — chez X » avec « Relancer ». Les chantiers « Bons de
 * commande / Factures / Visa — Clore » ont disparu : la frise et le tableau des BC disent tout ; la clôture devient le
 * geste de la dernière étape. Tout arrive tranché du serveur — ce composant ne décide d'aucun droit.
 */
export function PromoStatutCard(p: StatutProps) {
  const { saving, err, msg, run } = useRun();
  const [mode, setMode] = React.useState<null | "renvoi" | "refus">(null);
  const [motif, setMotif] = React.useState("");
  const [correction, setCorrection] = React.useState("");
  const fd = (extra?: Record<string, string>) => {
    const f = new FormData(); f.set("id", p.id);
    if (extra) for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const dossier = (extra?: Record<string, string>) => {
    const f = new FormData(); f.set("promoMaterialId", p.id);
    if (extra) for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  /** Un geste qui vit dans un tableau : la ligne s'ouvre là où il se fait. */
  const versLeTableau = (cible: string, g: GesteFiche) => {
    emettreGeste({ cle: g.cle, ...(g.quoteId ? { quoteId: g.quoteId } : {}) });
    document.getElementById(cible)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /** Clore : chaque chantier encore ouvert, l'un après l'autre — le dernier termine le dossier. */
  const clore = () => run(async () => {
    let dernier: ActionResult = { ok: true };
    for (const t of p.chantiersOuverts) {
      dernier = await completePromoTrack(fd({ track: t }));
      if (!dernier.ok) return dernier;
    }
    return dernier;
  });
  const g = p.geste;
  const decisions = (p.canRenvoyer || p.canRefuser) && mode === null;

  const bouton = (): React.ReactNode => {
    if (!g) return null;
    const occupe = saving;
    const icone = occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : null;
    switch (g.cle) {
      case "BASCULER":
        return <BoutonDecisif size="sm" onClick={() => run(() => startPromoCircuit(fd()))} disabled={occupe}>{icone ?? <Rocket className="h-4 w-4" />} Basculer</BoutonDecisif>;
      case "VALIDER_ETAPE":
        return <BoutonDecisif size="sm" variant="success" onClick={() => run(() => validatePromoStep(fd()))} disabled={occupe}>{icone ?? <BadgeCheck className="h-4 w-4" />} Valider</BoutonDecisif>;
      case "ENVOYER_DEMANDE_DEVIS":
        return <Button size="sm" onClick={() => run(() => demanderDevisPromo(dossier()))} disabled={occupe}>{icone ?? <Send className="h-4 w-4" />} Envoyer</Button>;
      case "TERMINER_RETRANSCRIPTION":
        return (
          <span className="inline-flex items-center gap-1">
            {p.manques.length > 0 && (
              <InfoBulle label="Ce qui manque" align="right">
                <span className="mb-1 block font-medium">Avant de terminer</span>
                {p.manques.map((m) => <span key={m} className="block [overflow-wrap:anywhere]">• {m}</span>)}
              </InfoBulle>
            )}
            <Button size="sm" variant="outline" onClick={() => { emettreGeste({ cle: "AJOUTER_DEVIS" }); document.getElementById("devis")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} disabled={occupe}>Ajouter un devis</Button>
            <Button size="sm" onClick={() => run(() => terminerRetranscriptionPromo(dossier()))} disabled={occupe || p.manques.length > 0}>{icone ?? <Send className="h-4 w-4" />} Retranscription terminée</Button>
          </span>
        );
      case "CHOISIR_LIGNES":
        return <Button size="sm" onClick={() => versLeTableau("devis", g)}>Choisir</Button>;
      case "PREPARER_BC":
        return <BoutonDecisif size="sm" onClick={() => run(() => genererBonsDeCommandePromo(dossier()))} disabled={occupe}>{icone} Générer les aperçus</BoutonDecisif>;
      case "ENVOYER_BC":
        return <Button size="sm" onClick={() => run(() => marquerBonDeCommandeEnvoye(dossier({ quoteId: g.quoteId ?? "" })))} disabled={occupe}>{icone ?? <Send className="h-4 w-4" />} Marquer envoyé</Button>;
      case "ADRESSER_IM":
        return <Button size="sm" onClick={() => versLeTableau("bc", g)}>Adresser</Button>;
      case "CLORE":
        return <BoutonDecisif size="sm" variant="success" onClick={clore} disabled={occupe}>{icone ?? <CheckCircle2 className="h-4 w-4" />} Clore le dossier</BoutonDecisif>;
      case "RESOUMETTRE":
        return null;
      default: {
        // Les gestes d'une ligne du tableau des BC : la ligne s'ouvre sur le bon formulaire.
        const libelle = g.cle === "VERIFIER_BC" ? "Vérifier" : g.cle === "MODIFIER_BC" ? "Corriger" : g.cle === "DEPOSER_FACTURE" ? "Déposer"
          : g.cle === "RECEPTIONNER" ? "Réceptionner" : "Ouvrir";
        return <Button size="sm" onClick={() => versLeTableau("bc", g)}>{libelle}</Button>;
      }
    }
  };

  const enAttente = !g && p.ou.chez !== null;
  return (
    <section className="surface overflow-hidden" aria-label="Où en est le dossier">
      {/* LA FRISE — huit étapes ; elle défile dans son propre conteneur au téléphone. */}
      <ol className="flex overflow-x-auto px-4 py-3.5">
        {p.frise.map((e) => (
          <li key={e.cle} className="relative flex min-w-[7.5rem] flex-1 flex-col gap-0.5 pt-[1.125rem] text-xs" aria-current={e.etat === "ici" ? "step" : undefined}>
            <span aria-hidden className={`absolute left-0 right-0 top-[5px] h-0.5 ${e.etat === "fait" ? "bg-success" : "bg-border"}`} />
            <span aria-hidden className={`absolute left-0 top-0 h-3 w-3 rounded-full border-2 ${POINT[e.etat]}`} />
            <b className={`pr-2 text-[0.8125rem] ${e.etat === "avenir" ? "font-medium text-muted-foreground" : "font-semibold"}`}>{e.libelle}</b>
            {e.detail && <span className="pr-2 text-muted-foreground">{e.detail}</span>}
          </li>
        ))}
      </ol>

      {/* LES CINQ CHIFFRES D'ARGENT — en DZD. */}
      <dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-5">
        {([
          ["Budget estimé", p.chiffres.budget],
          ["Retenu (TTC)", p.chiffres.retenu],
          ["Engagé (BC)", p.chiffres.engage],
          ["Facturé", p.chiffres.facture],
          ["Payé", p.chiffres.paye],
        ] as [string, number | null][]).map(([libelle, valeur], i) => (
          <div key={libelle} className={`bg-card px-4 py-3 ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
            <dt className="text-xs text-muted-foreground">{libelle}</dt>
            <dd className={`text-lg font-semibold tabular-nums ${!valeur ? "text-muted-foreground" : ""}`}>{nombreDzd(valeur)}</dd>
          </div>
        ))}
      </dl>

      {/* CE QU'IL RESTE À FAIRE — un seul geste, ou chez qui l'on attend. */}
      <div className="space-y-3 border-t border-border bg-primary/5 px-4 py-3.5">
        <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 text-sm">
            <p className="font-semibold [overflow-wrap:anywhere]">
              {g ? g.libelle : enAttente ? `En attente — chez ${p.ou.chez}` : p.ou.etat}
            </p>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {g || enAttente ? p.ou.etat : null}
              {p.renvoi && <> · renvoyé à l&apos;étape « {p.renvoi.depuis} » le {p.renvoi.quand} : « {p.renvoi.motif} »</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {bouton()}
            {enAttente && p.peutRelancer && (
              <Button size="sm" variant="outline" onClick={() => run(() => relancerPromo(fd()))} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />} Relancer
              </Button>
            )}
            {decisions && (
              <MenuLigne label="Autres issues" entrees={[
                ...(p.canRenvoyer ? [{ libelle: "Renvoyer pour correction", onClick: () => setMode("renvoi") }] : []),
                ...(p.canRefuser ? [{ libelle: "Refuser", danger: true, onClick: () => setMode("refus") }] : []),
              ]} />
            )}
          </div>
        </div>

        {p.apercuDemandeDevis && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Aperçu de la demande au secrétariat</summary>
            <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs [overflow-wrap:anywhere]">{p.apercuDemandeDevis}</pre>
          </details>
        )}

        {g?.cle === "RESOUMETTRE" && (
          <form
            action={(f: FormData) => { f.set("id", p.id); run(() => resoumettrePromoDemande(f), () => setCorrection("")); }}
            className="space-y-2"
          >
            <Label htmlFor="promo-resoumission-v2">Ce qui a changé</Label>
            <Textarea id="promo-resoumission-v2" name="note" value={correction} onChange={(e) => setCorrection(e.target.value)} className="min-h-[60px] bg-background" placeholder="Ex. quantités revues, article ajouté, précision du brief." />
            <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={saving || !correction.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Resoumettre la demande
            </Button>
          </form>
        )}
        {mode === "renvoi" && p.canRenvoyer && (
          <form
            action={(f: FormData) => { f.set("id", p.id); run(() => renvoyerPromoStep(f), () => { setMode(null); setMotif(""); }); }}
            className="space-y-2 rounded-lg border border-amber-500/40 bg-background p-3"
          >
            <Label htmlFor="promo-renvoi-motif-v2">Ce qu&apos;il faut corriger</Label>
            <Textarea id="promo-renvoi-motif-v2" name="motif" value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[60px]" placeholder="Ex. retenez plutôt le devis de l'imprimeur B, moins cher à qualité égale." />
            <div className="flex flex-wrap gap-2">
              <BoutonDecisif type="submit" size="sm" disabled={saving || !motif.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Renvoyer au demandeur
              </BoutonDecisif>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
            </div>
          </form>
        )}
        {mode === "refus" && p.canRefuser && (
          <form
            action={(f: FormData) => { f.set("id", p.id); run(() => refusePromoStep(f), () => { setMode(null); setMotif(""); }); }}
            className="space-y-2 rounded-lg border border-destructive/30 bg-background p-3"
          >
            <Label htmlFor="promo-refuse-reason-v2">Motif du refus</Label>
            <Textarea id="promo-refuse-reason-v2" name="reason" value={motif} onChange={(e) => setMotif(e.target.value)} className="min-h-[60px]" placeholder="Un refus est définitif : pour une correction, renvoyez plutôt le dossier." />
            <div className="flex flex-wrap gap-2">
              <BoutonDecisif type="submit" size="sm" variant="destructive" disabled={saving || !motif.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Confirmer le refus
              </BoutonDecisif>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
            </div>
          </form>
        )}
        <Err msg={err} />
        <Ok msg={msg} />
      </div>
    </section>
  );
}
