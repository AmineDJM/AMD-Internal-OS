"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { decideValidation, commenterValidation } from "@/lib/actions/validation-actions";
import { annulerMonGeste } from "@/modules/assistant-ia/actions-gestes";
import { lienDemandeDeValidation } from "@/lib/chemins/validations";
import { cn, formatDate, formatMontant } from "@/lib/utils";
import {
  alerteCourte, alertesDeLaDemande, etatCourt, libelleAccepter, ligneInitiale, messageDecision, motifsDeRefus, nomCourt,
  phraseApres, questionPosee,
  type LigneCentre, type LigneDecidee, type LigneEnvoyee, type PanneauCentre,
} from "@/lib/validations/centre-affichage";
import { FicheValidation } from "./fiche-validation";
import { PanneauDecides, PanneauEnvoyees, PanneauRegles } from "./panneaux-centre";
import { Etiquette } from "./etiquette";

type Decision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

const TITRES: Record<PanneauCentre, string> = {
  decides: "Déjà décidés", envoyees: "Mes demandes envoyées", regles: "Règles de validation", supervision: "Supervision",
};

const TON_ETAT = { rouge: "font-semibold text-destructive", bleu: "font-semibold text-primary", orange: "font-semibold text-warning", neutre: "" } as const;

/**
 * LE CENTRE DE VALIDATIONS (maquette validée le 24/11/2026) — l'en-tête et son menu ⋯, la file « À décider » à gauche,
 * la fiche à droite ; au téléphone, la file d'abord, la fiche en plein écran au toucher.
 *
 * LES GESTES SONT CEUX D'HIER : `decideValidation` (accepter, refuser avec motif, renvoyer pour correction avec ce qu'il
 * faut corriger) et `commenterValidation` (la question, dans le fil de la demande). Accepter et refuser passent par le
 * bouton décisif ; la décision confirmée, la ligne quitte la file et la suivante s'ouvre. Le bandeau qui la dit offre
 * « Annuler » quand le geste est réversible (`actionReversible` → `annulerMonGeste`).
 */
export function CentreValidations(props: {
  file: LigneCentre[]; decides: LigneDecidee[]; envoyees: LigneEnvoyee[];
  seuilBC: number; peutReglerSeuil: boolean; estSuperAdmin: boolean; nbSupervision: number; nbPaiements: number;
  focus: string | null; demande: string | null; vue: PanneauCentre | null;
  demander: React.ReactNode; paiements: React.ReactNode; supervision: React.ReactNode;
}) {
  const { busy, err, setErr, run } = useAction();
  const now = React.useMemo(() => new Date(), []);
  const [panneau, setPanneau] = React.useState<PanneauCentre | null>(props.vue);
  // Les étapes décidées ici sortent AUSSITÔT de la file, sans attendre les nouvelles données.
  const [decidees, setDecidees] = React.useState<ReadonlySet<string>>(new Set());
  const file = props.file.filter((l) => !decidees.has(l.stepId));
  const designee = ligneInitiale(props.file, props.focus, props.demande);
  const [choisi, setChoisi] = React.useState<string | null>(designee);
  // Au téléphone, la fiche désignée par l'adresse s'ouvre d'emblée en plein écran — pas la première venue.
  const [pleinEcran, setPleinEcran] = React.useState(
    props.file.some((l) => l.stepId === props.focus || l.requestId === props.demande),
  );
  const [refusOuvert, setRefusOuvert] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const [precisionOuverte, setPrecisionOuverte] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [renvoyer, setRenvoyer] = React.useState(false);
  const [bandeau, setBandeau] = React.useState<{ texte: string; gesteId: string | null; stepId: string } | null>(null);
  const [lienCopie, setLienCopie] = React.useState(false);

  const courant = file.find((l) => l.stepId === choisi) ?? null;
  // La ligne choisie a quitté la file (décidée ici ou ailleurs) : la fiche passe à la première qui attend.
  React.useEffect(() => {
    if (courant || file.length === 0) return;
    setChoisi(file[0]!.stepId);
  }, [courant, file]);
  // L'ancre des notifications (`#val-<étape>`) : la ligne visée défile à l'écran.
  React.useEffect(() => {
    if (props.focus) document.getElementById(`val-${props.focus}`)?.scrollIntoView({ block: "center" });
  }, [props.focus]);

  const fermerGestes = () => { setRefusOuvert(false); setMotif(""); setPrecisionOuverte(false); setQuestion(""); setRenvoyer(false); setErr(null); setLienCopie(false); };
  const choisir = (stepId: string) => { setChoisi(stepId); setPleinEcran(true); fermerGestes(); };

  async function decider(l: LigneCentre, decision: Decision, raison?: string) {
    const fd = new FormData();
    fd.set("stepId", l.stepId);
    fd.set("decision", decision);
    // Le motif est exigé pour refuser ou renvoyer (l'action le revérifie) ; l'accord n'en demande pas.
    if (raison !== undefined) fd.set("reason", raison.trim());
    let gesteId: string | null = null;
    await run(async () => {
      const r = await decideValidation(fd);
      gesteId = (r as { annulable?: { gesteId: string } }).annulable?.gesteId ?? null;
      return r;
    }, () => {
      setDecidees((avant) => new Set(avant).add(l.stepId));
      setBandeau({ texte: messageDecision(decision, l, raison), gesteId, stepId: l.stepId });
      fermerGestes();
      const prochain = file.find((x) => x.stepId !== l.stepId);
      if (prochain) setChoisi(prochain.stepId); else setPleinEcran(false);
    });
  }

  async function poserQuestion(l: LigneCentre) {
    const fd = new FormData();
    fd.set("requestId", l.requestId);
    fd.set("body", question.trim());
    await run(() => commenterValidation(fd), () => setQuestion(""), { succes: `Question envoyée à ${nomCourt(l.demandeur)}.` });
  }

  async function annulerDecision() {
    if (!bandeau?.gesteId) return;
    const { gesteId, stepId } = bandeau;
    await run(async () => {
      const r = await annulerMonGeste(gesteId);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }, () => {
      setDecidees((avant) => { const s = new Set(avant); s.delete(stepId); return s; });
      setChoisi(stepId);
      setBandeau(null);
    });
  }

  const copierLien = async (l: LigneCentre) => {
    try {
      await navigator.clipboard.writeText(new URL(lienDemandeDeValidation(l.requestId), window.location.origin).toString());
      setLienCopie(true);
    } catch {
      setErr("Le lien n'a pas pu être copié : ouvrez la fiche de la demande et copiez son adresse.");
    }
  };

  const ouvrir = (p: PanneauCentre) => { setPanneau(p); setPleinEcran(false); };
  const menu = (
    <MenuDossier key={panneau ?? "file"} label="Autres : déjà décidés, mes demandes envoyées, règles de validation" doigt>
      <ItemMenu onClick={() => ouvrir("decides")} libelle="Déjà décidés" compte={props.decides.length} />
      <ItemMenu onClick={() => ouvrir("envoyees")} libelle="Mes demandes envoyées" compte={props.envoyees.length} />
      <ItemMenu onClick={() => ouvrir("regles")} libelle="Règles de validation" />
      {props.estSuperAdmin && <ItemMenu onClick={() => ouvrir("supervision")} libelle="Supervision" compte={props.nbSupervision} />}
    </MenuDossier>
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Centre de validations</h1>
        {menu}
      </header>

      {bandeau && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-[10px] bg-foreground px-4 py-3 text-sm text-background">
          <span className="min-w-0 [overflow-wrap:anywhere]">{bandeau.texte}</span>
          {bandeau.gesteId ? (
            <button type="button" onClick={() => void annulerDecision()} disabled={busy} className="shrink-0 font-semibold text-primary-foreground underline-offset-2 hover:underline disabled:opacity-60">
              Annuler
            </button>
          ) : (
            <button type="button" onClick={() => setBandeau(null)} className="shrink-0 font-semibold hover:underline">Fermer</button>
          )}
        </div>
      )}

      {panneau ? (
        <section aria-labelledby="panneau-centre" className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="panneau-centre" className="text-lg font-bold">{TITRES[panneau]}</h2>
            <Button type="button" variant="outline" className="h-10" onClick={() => setPanneau(null)}>Retour à la file</Button>
          </div>
          {panneau === "decides" && <PanneauDecides decides={props.decides} />}
          {panneau === "envoyees" && <PanneauEnvoyees envoyees={props.envoyees} demander={props.demander} paiements={props.paiements} estSuperAdmin={props.estSuperAdmin} />}
          {panneau === "regles" && <PanneauRegles seuil={props.seuilBC} peutRegler={props.peutReglerSeuil} />}
          {panneau === "supervision" && props.supervision}
        </section>
      ) : (
        <div className="flex flex-col items-start gap-4 lg:flex-row">
          <section aria-labelledby="file-validations" className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:max-w-[440px] lg:flex-[1_1_360px]">
            <h2 id="file-validations" className="px-4 pb-2.5 pt-4 text-base font-semibold">À décider · {file.length}</h2>
            {file.length === 0 && (
              <p className="px-4 pb-6 pt-1 text-sm text-muted-foreground">Rien à décider. Les demandes qui vous sont adressées arrivent ici.</p>
            )}
            <ul>
              {file.map((l) => {
                const actif = l.stepId === choisi;
                const etat = etatCourt(l, now, questionPosee(l.fil));
                const alerte = alerteCourte(alertesDeLaDemande(l, now));
                return (
                  <li key={l.stepId} id={`val-${l.stepId}`} className="scroll-mt-24 border-t border-border">
                    <button
                      type="button" onClick={() => choisir(l.stepId)} aria-current={actif ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors hover:bg-secondary/60",
                        actif && "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-[15px] font-semibold [overflow-wrap:anywhere]"><Etiquette genre={l.genre}>{l.etiquette}</Etiquette>{l.objet}</span>
                        {l.montant !== null && <span className="whitespace-nowrap text-[15px] font-bold tabular-nums">{formatMontant(l.montant)}</span>}
                      </span>
                      <span className="flex justify-between gap-3 text-[13px] text-muted-foreground">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{l.demandeur || "—"}</span>
                        <span className={cn("whitespace-nowrap", TON_ETAT[etat.ton])}>{etat.texte}</span>
                      </span>
                      {alerte && <span className={cn("text-[13px] font-semibold", alerte.ton === "rouge" ? "text-destructive" : "text-warning")}>{alerte.texte}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section
            aria-labelledby="fiche-validation"
            className={cn(
              "min-w-0 bg-card p-4 sm:p-5 lg:static lg:block lg:flex-[999_1_560px] lg:rounded-xl lg:border lg:border-border",
              courant && pleinEcran ? "fixed inset-0 z-40 overflow-y-auto" : "hidden",
            )}
          >
            {courant ? (
              <>
                <button type="button" onClick={() => setPleinEcran(false)} className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-primary lg:hidden">
                  <ArrowLeft className="h-4 w-4" /> Retour à la file
                </button>
                <FicheValidation
                  l={courant}
                  now={now}
                  decision={
                    <Gestes
                      l={courant} busy={busy} err={err}
                      refusOuvert={refusOuvert} motif={motif} precisionOuverte={precisionOuverte} question={question} renvoyer={renvoyer}
                      onRefus={() => { setErr(null); setMotif(""); setPrecisionOuverte(false); setRefusOuvert((o) => !o); }}
                      onMotif={setMotif}
                      onPrecision={(o) => { setErr(null); setRefusOuvert(false); setPrecisionOuverte(o); if (!o) setRenvoyer(false); }}
                      onQuestion={setQuestion}
                      onRenvoyer={() => setRenvoyer((r) => !r)}
                      accepter={() => void decider(courant, "APPROVED")}
                      refuser={() => void decider(courant, "REJECTED", motif)}
                      envoyer={() => void (renvoyer ? decider(courant, "CHANGES_REQUESTED", question) : poserQuestion(courant))}
                    />
                  }
                  pied={
                    <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3 text-[13px] text-muted-foreground">
                      <Link href={lienDemandeDeValidation(courant.requestId)} className="font-semibold text-primary hover:underline">Ouvrir la fiche complète</Link>
                      <button type="button" onClick={() => void copierLien(courant)} className="font-semibold text-primary hover:underline">
                        {lienCopie ? "Lien copié" : "Copier le lien de la demande"}
                      </button>
                    </div>
                  }
                />
              </>
            ) : (
              <p className="text-[15px] text-muted-foreground">Tout est décidé. Vos décisions sont dans ⋯ › Déjà décidés.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ItemMenu({ onClick, libelle, compte }: { onClick: () => void; libelle: string; compte?: number }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-secondary">
      <span>{libelle}</span>
      {compte !== undefined && <span className="text-muted-foreground">{compte}</span>}
    </button>
  );
}

/**
 * LES GESTES DE LA FICHE — « Demander une précision », « Refuser » (motif en un clic, ou écrit), « Accepter ». La
 * précision ouvre le fil des échanges avec le demandeur ; l'interrupteur « Lui renvoyer la demande pour correction »
 * fait de la question le motif du renvoi.
 */
function Gestes(p: {
  l: LigneCentre; busy: boolean; err: string | null;
  refusOuvert: boolean; motif: string; precisionOuverte: boolean; question: string; renvoyer: boolean;
  onRefus: () => void; onMotif: (m: string) => void; onPrecision: (o: boolean) => void; onQuestion: (q: string) => void; onRenvoyer: () => void;
  accepter: () => void; refuser: () => void; envoyer: () => void;
}) {
  const { l } = p;
  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-4">
      <p className="text-[13px] text-muted-foreground">{phraseApres(l)}</p>

      {p.refusOuvert && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Motif du refus — c&apos;est ce que lira le demandeur</p>
          <div className="flex flex-wrap gap-1.5">
            {motifsDeRefus(l.genre).map((m) => (
              <button
                key={m} type="button" onClick={() => p.onMotif(m)} aria-pressed={p.motif === m}
                className={cn("min-h-9 rounded-full border px-3 text-[13px]", p.motif === m ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-secondary")}
              >{m}</button>
            ))}
          </div>
          <Textarea aria-label="Motif du refus" rows={2} value={p.motif} onChange={(e) => p.onMotif(e.target.value)} placeholder="Ou écrivez le vôtre…" />
        </div>
      )}

      {p.precisionOuverte && (
        <div className="flex flex-col gap-2 rounded-[10px] bg-secondary/50 p-3">
          <p className="text-sm font-semibold">Échanges avec {nomCourt(l.demandeur)}</p>
          {l.fil.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Aucun échange pour l&apos;instant.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {l.fil.map((m) => (
                <li key={m.id} className={cn("rounded-lg px-2.5 py-2 text-[13px]", m.deMoi ? "bg-primary/10" : "border border-border bg-card")}>
                  <strong>{m.deMoi ? "Vous" : m.auteur}</strong> · <span className="text-muted-foreground">{formatDate(m.le, { day: "numeric", month: "short" })}</span>
                  <br /><span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.texte}</span>
                </li>
              ))}
            </ul>
          )}
          <Textarea aria-label="Votre question" rows={2} value={p.question} onChange={(e) => p.onQuestion(e.target.value)} placeholder="Votre question au demandeur…" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" role="switch" aria-checked={p.renvoyer} onClick={p.onRenvoyer} className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className={cn("inline-flex h-5 w-[34px] items-center rounded-full p-0.5 transition-colors", p.renvoyer ? "bg-primary" : "bg-border")}>
                <span className={cn("block h-4 w-4 rounded-full bg-card transition-transform", p.renvoyer && "translate-x-3.5")} />
              </span>
              Lui renvoyer la demande pour correction
            </button>
            {p.renvoyer ? (
              <BoutonDecisif type="button" variant="outline" className="h-10" disabled={p.busy || !p.question.trim()} onClick={p.envoyer}>
                {p.busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer et renvoyer
              </BoutonDecisif>
            ) : (
              <Button type="button" variant="outline" className="h-10" disabled={p.busy || !p.question.trim()} onClick={p.envoyer}>
                {p.busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer la question
              </Button>
            )}
          </div>
        </div>
      )}

      {p.err && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{p.err}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {!p.precisionOuverte && !p.refusOuvert && (
          <Button type="button" variant="ghost" className="h-11 text-primary" onClick={() => p.onPrecision(true)}>
            Demander une précision{l.fil.length ? ` · ${l.fil.length}` : ""}
          </Button>
        )}
        {p.precisionOuverte && (
          <Button type="button" variant="ghost" className="h-11" onClick={() => p.onPrecision(false)}>Fermer les échanges</Button>
        )}
        <Button type="button" variant="outline" className="h-11" disabled={p.busy} onClick={p.onRefus}>
          {p.refusOuvert ? "Annuler" : "Refuser"}
        </Button>
        {p.refusOuvert ? (
          <BoutonDecisif type="button" variant="destructive" className="h-11" disabled={p.busy || !p.motif.trim()} onClick={p.refuser}>
            {p.busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer le refus
          </BoutonDecisif>
        ) : (
          <BoutonDecisif type="button" className="h-11" disabled={p.busy} onClick={p.accepter}>
            {p.busy && <Loader2 className="h-4 w-4 animate-spin" />} {libelleAccepter(l.genre)}
          </BoutonDecisif>
        )}
      </div>
    </div>
  );
}
