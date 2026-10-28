"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Download, Loader2, Paperclip, Plus, Send, X } from "lucide-react";
import type { MissionDetailDTO, VersionDTO, FraisDTO } from "@/lib/queries/missions";
import {
  proposerParticipation, deciderParticipation, repondreMission, requestMissionOrder, retirerDemandeOrdreMission,
  enregistrerBilletMission, enregistrerHotelMission, choisirBudgetMission, ajouterFraisMission, joindreJustificatifFrais,
  retirerFraisMission, enregistrerRapportMission, cloturerMission, addMissionComment,
} from "@/lib/actions/mission-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import {
  aQuiLeTour, comparerFiches, etatParticipation, ficheInitiale, lignesFiche, phaseMission, reservationsAdventum,
  resumeBilletEmis, deviseFrais, deviseMission, totalFrais, manquesCloture, etatNoteFraisMission, etatMissionOuverte,
  MODES_TRANSPORT, MODE_TRANSPORT_LIBELLE, QUI_RESERVE_LIBELLE, HEBERGEMENT_LIBELLE, NATURES_FRAIS, NATURE_FRAIS_LIBELLE,
  TRAJETS_BILLET, jourCourt,
  type Cote, type FicheParticipation, type ChoixHebergement, type NatureFrais, type Etat,
} from "@/lib/missions-equipe/participation";
import { peutDemanderOrdre, peutRetirerOrdre, noteFraisOuverte, jourIso } from "@/lib/missions-equipe/etat";
import { POLE_EQUIPE, imputationHistorique, texteImputation } from "@/lib/missions-equipe/imputation";
import { MISSION_ROLE } from "@/lib/labels";
import { formatDate, cn } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { CommentThread } from "@/components/shared/comment-thread";

type Resultat = { ok: boolean; error?: string; message?: string };
type Executer = (cle: string, action: (fd: FormData) => Promise<Resultat>, champs: Record<string, string> | FormData, apres?: () => void) => Promise<void>;

function Pastille({ etat }: { etat: Etat }) {
  return <Badge tone={etat.ton} dot={false}>{etat.texte}</Badge>;
}

const doc = (id: string) => `/api/documents/${id}`;
const montant = (n: number, devise: string) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${devise}`;

/**
 * UNE MISSION DE L'ÉQUIPE ADVENTUM (Direction, 10/2026) — une seule page, de l'invitation à la clôture.
 *
 * Tant que la participation se discute : la fiche (la personne l'envoie), les versions — la plus récente en haut,
 * ce qui a changé surligné — et, pour qui a la main, Accepter / Modifier et contre-proposer / Refuser. Une fois
 * l'accord trouvé : l'ordre de mission en un clic. Quand il est émis : avant le départ (ordre, billet, hôtel, rôle
 * sur place), après (dépenses, rapport, clôture). Le fil de commentaires reste ouvert d'un bout à l'autre.
 */
export function MissionEquipe({ detail, vue, peutDeposer, peutBudget, budgetOptions, imputationDefaut = null, currentUserId, path }: {
  detail: MissionDetailDTO;
  vue: Cote | null;
  peutDeposer: boolean;
  peutBudget: boolean;
  budgetOptions: { id: string; label: string }[];
  imputationDefaut?: { id: string; label: string } | null;
  currentUserId: string;
  path: string;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const occupe = busy !== null || enCours;
  const executer: Executer = async (cle, action, champs, apres) => {
    let fd: FormData;
    if (champs instanceof FormData) fd = champs;
    else { fd = new FormData(); for (const [k, v] of Object.entries(champs)) fd.set(k, v); }
    setBusy(cle); setMsg(null);
    let r: Resultat;
    try {
      r = await action(fd);
    } catch {
      setMsg({ ok: false, texte: actionFailureMessage("THROWN") });
      return;
    } finally {
      setBusy(null);
    }
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "Le geste n'a pas abouti.") });
    if (r.ok) { apres?.(); rafraichir(); }
  };

  const m = detail.mission;
  const p = m.participation;
  const noms = { personne: m.userName, organisateur: detail.demandeurName ?? m.organiserName };
  const omEmis = m.om.etat === "EMIS";
  const phase = phaseMission(p.etape, omEmis, Boolean(m.clotureLe));
  const terminee = noteFraisOuverte(m.dateRetour, m.dateDepart);
  const etat = phase === "PARTICIPATION" || phase === "ORDRE"
    ? (phase === "ORDRE" && m.om.etat !== "AUCUN" ? m.om.libelle : etatParticipation(p.etape, p.derniere, vue, noms, { declineReason: m.declineReason, depuis: m.createdAt }))
    : etatMissionOuverte(phase, terminee, vue, m.userName);
  const role = MISSION_ROLE[m.role]?.label ?? m.role;
  const periode = m.dateDepart ? `${formatDate(m.dateDepart)}${m.dateRetour && jourIso(m.dateRetour) !== jourIso(m.dateDepart) ? ` → ${formatDate(m.dateRetour)}` : ""}` : "dates à préciser";
  const titre = phase === "PARTICIPATION"
    ? (vue === "PERSONNE" ? "Demande de participation" : `${m.userName} — participation`)
    : (vue === "PERSONNE" ? `Ma mission — ${m.parentLabel}` : `${m.userName} — mission`);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{titre}</h1>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            <Link href={m.parentPath} className="hover:underline">{m.parentLabel}</Link>
            {m.ville ? ` · ${m.ville}` : ""} · {periode} · {role}
            {noms.organisateur ? ` · ${vue === "PERSONNE" ? "invité par" : "organisateur :"} ${noms.organisateur}` : ""}
            {omEmis && m.om.requestId ? " · ordre de mission émis" : ""}
          </p>
        </div>
        <span className="shrink-0"><Pastille etat={etat} /></span>
      </div>

      {msg && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>{msg.texte}</p>}

      {phase === "PARTICIPATION" && p.etape === "FICHE_A_REMPLIR" && vue === "PERSONNE" ? (
        <FicheARemplir detail={detail} occupe={occupe} busy={busy} executer={executer} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            {(phase === "PARTICIPATION" || phase === "ORDRE") && (
              <Propositions detail={detail} vue={vue} occupe={occupe} busy={busy} executer={executer} />
            )}
            {(phase === "MISSION" || phase === "CLOTUREE" || (phase === "ORDRE" && p.etape === "CONFIRMEE_SANS_FICHE")) && (
              <MaMission detail={detail} vue={vue} peutDeposer={peutDeposer} occupe={occupe} busy={busy} executer={executer} terminee={terminee} />
            )}
          </div>
          <div className="min-w-0 space-y-4">
            {p.convenue && <Convenu fiche={p.convenue} international={m.international} versionAccord={detail.versions.find((v) => v.statut === "ACCEPTEE") ?? null} />}
            {(p.convenue || phase !== "PARTICIPATION") && (
              <Imputation detail={detail} peutBudget={peutBudget} options={budgetOptions} defaut={imputationDefaut} occupe={occupe} executer={executer} />
            )}
            <Card id="fil" className="scroll-mt-20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1 text-base">
                  Commentaires
                  <InfoBulle align="right">Le fil reste ouvert à chaque étape, de l&apos;invitation jusqu&apos;à la clôture de la mission.</InfoBulle>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CommentThread comments={m.comments} action={addMissionComment} hiddenFields={{ assignmentId: m.id }} currentUserId={currentUserId}
                  canModerate={false} updateAction={updateComment} deleteAction={deleteComment} path={path} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── La fiche ───────────────────────────────

function Champ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)}>{label}{children}</label>;
}

/** Les champs de la fiche — pré-remplis (événement, ou version sur la table). */
function ChampsFiche({ fiche, international, role }: { fiche: FicheParticipation; international: boolean; role: string }) {
  const [heb, setHeb] = React.useState<ChoixHebergement>(fiche.hebergement.choix);
  const devise = deviseMission(international);
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <p className="text-sm font-semibold">Ma présence</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Champ label="Présent du"><Input type="date" name="presenceDu" required defaultValue={fiche.presenceDu ?? ""} /></Champ>
          <Champ label="Au"><Input type="date" name="presenceAu" required defaultValue={fiche.presenceAu ?? ""} /></Champ>
          <Champ label="Rôle"><Input value={role} readOnly /></Champ>
        </div>
      </section>
      <section className="space-y-2">
        <p className="text-sm font-semibold">Transport souhaité</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Champ label="Mode">
            <Select name="transportMode" defaultValue={fiche.transport.mode}>
              {MODES_TRANSPORT.map((x) => <option key={x} value={x}>{MODE_TRANSPORT_LIBELLE[x]}</option>)}
            </Select>
          </Champ>
          <Champ label="Départ de"><Input name="transportDepart" defaultValue={fiche.transport.depart ?? ""} /></Champ>
          <Champ label="Arrivée à"><Input name="transportArrivee" defaultValue={fiche.transport.arrivee ?? ""} /></Champ>
          <Champ label="Qui réserve">
            <Select name="transportReservation" defaultValue={fiche.transport.reservation}>
              <option value="ADVENTUM">{QUI_RESERVE_LIBELLE.ADVENTUM}</option>
              <option value="MOI">{QUI_RESERVE_LIBELLE.MOI}</option>
            </Select>
          </Champ>
          <Champ label="Aller le"><Input type="date" name="transportAller" defaultValue={fiche.transport.aller ?? ""} /></Champ>
          <Champ label="Retour le"><Input type="date" name="transportRetour" defaultValue={fiche.transport.retour ?? ""} /></Champ>
          <Champ label="Précisions" className="sm:col-span-2"><Input name="transportPrecisions" defaultValue={fiche.transport.precisions ?? ""} placeholder="horaires, contraintes…" /></Champ>
        </div>
      </section>
      <section className="space-y-2">
        <p className="text-sm font-semibold">Hébergement</p>
        <div role="radiogroup" aria-label="Hébergement" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(["ADVENTUM", "MOI", "AUCUN"] as const).map((c) => (
            <label key={c} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm", heb === c ? "border-primary bg-primary/5" : "border-border")}>
              <input type="radio" name="hebergementChoix" value={c} checked={heb === c} onChange={() => setHeb(c)} className="mt-1 accent-[hsl(var(--primary))]" />
              <span>{HEBERGEMENT_LIBELLE[c]}</span>
            </label>
          ))}
        </div>
        {heb !== "AUCUN" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Champ label={heb === "MOI" ? "Hôtel envisagé" : "Hôtel souhaité"}><Input name="hebergementHotel" defaultValue={fiche.hebergement.hotel ?? ""} placeholder={heb === "ADVENTUM" ? "hôtel du congrès…" : ""} /></Champ>
            <Champ label="Nuits"><Input name="hebergementNuits" inputMode="numeric" defaultValue={fiche.hebergement.nuits ?? ""} /></Champ>
            {heb === "MOI" && (
              <Champ label={`Estimation (${devise})`}><Input name="hebergementEstimation" inputMode="decimal" defaultValue={fiche.hebergement.estimation ?? ""} /></Champ>
            )}
          </div>
        )}
      </section>
      <section className="space-y-2">
        <Champ label="Commentaire pour l'organisateur"><Textarea name="commentaire" rows={2} defaultValue={fiche.commentaire ?? ""} /></Champ>
      </section>
    </div>
  );
}

/** La première réponse de la personne : sa fiche — ou décliner, avec un motif. */
function FicheARemplir({ detail, occupe, busy, executer }: { detail: MissionDetailDTO; occupe: boolean; busy: string | null; executer: Executer }) {
  const m = detail.mission;
  const [decliner, setDecliner] = React.useState(false);
  const fiche = ficheInitiale({ debut: jourIso(m.dateDepart) || null, fin: jourIso(m.dateRetour) || null, ville: m.ville });
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", m.id); void executer("fiche", proposerParticipation, fd); }} className="space-y-4">
          <ChampsFiche fiche={fiche} international={m.international} role={MISSION_ROLE[m.role]?.label ?? m.role} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={occupe}>{busy === "fiche" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer ma proposition</Button>
            <Button type="button" variant="outline" disabled={occupe} onClick={() => setDecliner((v) => !v)}>Décliner</Button>
          </div>
        </form>
        {decliner && <Decliner id={m.id} occupe={occupe} executer={executer} />}
      </CardContent>
    </Card>
  );
}

function Decliner({ id, occupe, executer }: { id: string; occupe: boolean; executer: Executer }) {
  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", id); fd.set("decision", "DECLINER");
      void executer("decliner", repondreMission, fd);
    }}>
      <Champ label="Pourquoi ?" className="min-w-0 flex-1"><Input name="motif" required placeholder="garde, congé, autre mission…" /></Champ>
      <Button type="submit" size="sm" variant="destructive" disabled={occupe}>Décliner la participation</Button>
    </form>
  );
}

// ─────────────────────────────── Les versions ───────────────────────────────

const LIBELLE_STATUT: Record<VersionDTO["statut"], string> = { EN_ATTENTE: "en attente", ACCEPTEE: "acceptée", REFUSEE: "refusée", REMPLACEE: "contre-proposée" };

function Propositions({ detail, vue, occupe, busy, executer }: { detail: MissionDetailDTO; vue: Cote | null; occupe: boolean; busy: string | null; executer: Executer }) {
  const m = detail.mission;
  const p = m.participation;
  const confirmer = useConfirmer();
  const [mode, setMode] = React.useState<"aucun" | "modifier" | "refuser" | "decliner">("aucun");
  const tour = aQuiLeTour(p.etape);
  const monTour = vue !== null && tour === vue;
  const derniere = detail.versions[0] ?? null;
  const enAttente = derniere?.statut === "EN_ATTENTE";
  const accord = p.etape === "ACCORD";
  const peutRouvrir = accord && vue !== null && peutDemanderOrdre(m.om.etat);
  const base = derniere?.fiche ?? p.courante ?? ficheInitiale({ debut: jourIso(m.dateDepart) || null, fin: jourIso(m.dateRetour) || null, ville: m.ville });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-base">Propositions</CardTitle>
        <span className="text-xs text-muted-foreground">la plus récente en haut</span>
      </CardHeader>
      <div>
        {accord && (
          <div className="mx-4 mb-3 flex flex-col gap-2 rounded-lg bg-success/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-success">Accord trouvé</p>
              <p className="text-xs text-muted-foreground">Ordre de mission : {m.om.libelle.texte}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {vue === "PERSONNE" && peutDemanderOrdre(m.om.etat) && (
                <Button size="sm" disabled={occupe} onClick={() => void executer("om", requestMissionOrder, { id: m.id })}>
                  {busy === "om" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Demander l&apos;ordre de mission
                </Button>
              )}
              {vue === "PERSONNE" && peutRetirerOrdre(m.om.etat) && (
                <Button size="sm" variant="ghost" disabled={occupe} onClick={async () => { if (await confirmer("Retirer votre demande d'ordre de mission ?")) void executer("omr", retirerDemandeOrdreMission, { id: m.id }); }}>Retirer la demande</Button>
              )}
              {peutRouvrir && mode !== "modifier" && (
                <Button size="sm" variant="ghost" disabled={occupe} onClick={() => setMode("modifier")}>Modifier</Button>
              )}
            </div>
          </div>
        )}

        {detail.versions.length === 0 && (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            {p.etape === "CONFIRMEE_SANS_FICHE" ? "Mission confirmée sans fiche." : `La fiche de ${m.userName} n'est pas encore arrivée.`}
          </p>
        )}

        {detail.versions.map((v, i) => {
          const avant = detail.versions[i + 1]?.fiche ?? null;
          const lignes = v.fiche ? comparerFiches(avant, v.fiche, m.international) : [];
          const premiere = i === 0;
          return (
            <div key={v.id} className={cn("space-y-2 border-t border-border px-4 py-3", !premiere && "opacity-70")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={premiere ? "purple" : "neutral"} dot={false}>Version {v.numero}</Badge>
                <b className="font-semibold">{v.auteur}</b>
                <span className="text-xs text-muted-foreground">
                  {v.nature === "PROPOSITION" ? "proposition" : "contre-proposition"} · {formatDate(v.createdAt)} · {LIBELLE_STATUT[v.statut]}
                  {v.decidePar && v.statut !== "EN_ATTENTE" ? ` par ${v.decidePar}` : ""}
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
                {lignes.map((l) => (
                  <React.Fragment key={l.cle}>
                    <dt className="text-muted-foreground">{l.libelle}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {l.segments.map((s, k) => (
                        <React.Fragment key={s.cle}>
                          {k > 0 && s.texte ? " · " : ""}
                          {s.change ? (
                            <span className="rounded bg-warning/20 px-1">
                              {s.avant && <span className="mr-1.5 text-muted-foreground line-through">{s.avant}</span>}
                              {s.texte}
                            </span>
                          ) : s.texte}
                        </React.Fragment>
                      ))}
                    </dd>
                  </React.Fragment>
                ))}
                {v.motif && (<><dt className="text-muted-foreground">Motif</dt><dd className="[overflow-wrap:anywhere]">« {v.motif} »</dd></>)}
                {v.motifDecision && v.statut === "REFUSEE" && (<><dt className="text-muted-foreground">Refus</dt><dd className="text-destructive [overflow-wrap:anywhere]">« {v.motifDecision} »</dd></>)}
              </dl>
              {premiere && monTour && mode === "aucun" && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {enAttente && (
                    <Button size="sm" disabled={occupe} onClick={() => void executer("accepter", deciderParticipation, { id: m.id, decision: "ACCEPTER" })}>
                      {busy === "accepter" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Accepter
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => setMode("modifier")}>
                    {enAttente ? "Modifier et contre-proposer" : "Modifier et reproposer"}
                  </Button>
                  {enAttente && (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={occupe} onClick={() => setMode("refuser")}><X className="h-4 w-4" /> Refuser</Button>
                  )}
                  {vue === "PERSONNE" && (
                    <Button size="sm" variant="ghost" disabled={occupe} onClick={() => setMode("decliner")}>Décliner la participation</Button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {mode === "refuser" && (
          <form className="flex flex-col gap-2 border-t border-border bg-secondary/20 px-4 py-3 sm:flex-row sm:items-end" onSubmit={(e) => {
            e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", m.id); fd.set("decision", "REFUSER");
            void executer("refuser", deciderParticipation, fd, () => setMode("aucun"));
          }}>
            <Champ label="Motif du refus" className="min-w-0 flex-1"><Input name="motif" required /></Champ>
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={occupe}>Refuser</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode("aucun")}>Annuler</Button>
            </div>
          </form>
        )}
        {mode === "decliner" && <div className="border-t border-border bg-secondary/20 px-4 py-3"><Decliner id={m.id} occupe={occupe} executer={executer} /></div>}
        {mode === "modifier" && (
          <form className="space-y-3 border-t border-border bg-primary/5 px-4 py-3" onSubmit={(e) => {
            e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", m.id);
            void executer("contre", proposerParticipation, fd, () => setMode("aucun"));
          }}>
            <ChampsFiche fiche={base} international={m.international} role={MISSION_ROLE[m.role]?.label ?? m.role} />
            <Champ label="Motif de la modification"><Input name="motif" placeholder="ce qui change, et pourquoi" /></Champ>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode("aucun")}>Annuler</Button>
              <Button type="submit" size="sm" disabled={occupe}>{busy === "contre" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer la contre-proposition</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────── Ce qui a été convenu, le budget ───────────────────────────────

function Convenu({ fiche, international, versionAccord }: { fiche: FicheParticipation; international: boolean; versionAccord: VersionDTO | null }) {
  const lignes = lignesFiche(fiche, international).filter((l) => l.cle !== "commentaire");
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Ce qui a été convenu</CardTitle></CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[100px_minmax(0,1fr)]">
          {lignes.map((l) => (
            <React.Fragment key={l.cle}>
              <dt className="text-muted-foreground">{l.libelle}</dt>
              <dd className="[overflow-wrap:anywhere]">{l.segments.map((s) => s.texte).join(" · ")}</dd>
            </React.Fragment>
          ))}
          {versionAccord && (<><dt className="text-muted-foreground">Accord</dt><dd>Version {versionAccord.numero}{versionAccord.decideLe ? `, le ${formatDate(versionAccord.decideLe)}` : ""}</dd></>)}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * L'IMPUTATION des frais de mission — au BUDGET OPERATIONS & SALES (Direction, 10/2026 : « ici le budget à imputer, ce
 * n'est pas Ad & Pro, c'est Operations & Sales »). Catégorie par défaut posée d'office ; la Direction Marketing ou la
 * Direction des opérations la change ; les autres la lisent. Une ancienne imputation Ad & Pro reste affichée telle quelle.
 */
function Imputation({ detail, peutBudget, options, defaut, occupe, executer }: { detail: MissionDetailDTO; peutBudget: boolean; options: { id: string; label: string }[]; defaut: { id: string; label: string } | null; occupe: boolean; executer: Executer }) {
  const m = detail.mission;
  const historique = imputationHistorique(m.imputation);
  const valeur = historique ? "__historique__" : m.imputation && !m.imputation.parDefaut ? m.imputation.categoryId : "";
  // « Par défaut » : celui du membre s'il est posé (son enveloppe, sa société), sinon celui de l'année.
  const defautDuMembre = m.imputation?.parDefaut && !historique ? { id: m.imputation.categoryId, label: m.imputation.libelle } : defaut;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1 text-base">
          Imputation des frais — budget {POLE_EQUIPE}
          <InfoBulle align="right">Transport, hébergement, ordre de mission et frais de mission de l&apos;équipe Adventum vont au budget {POLE_EQUIPE} de l&apos;année — plus à Ad &amp; Pro, qui porte les invités externes. La catégorie par défaut s&apos;applique tant que la Direction Marketing ou la Direction des opérations n&apos;en choisit pas une autre.</InfoBulle>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {peutBudget ? (
          <Select key={valeur} aria-label="Catégorie du budget Operations & Sales" defaultValue={valeur} disabled={occupe}
            onChange={(e) => void executer("budget", choisirBudgetMission, { id: m.id, budgetCategoryId: e.target.value })}>
            {historique && <option value="__historique__" disabled>{texteImputation(m.imputation, null)}</option>}
            <option value="">{defautDuMembre ? `Par défaut — ${defautDuMembre.label}` : `${POLE_EQUIPE} — par défaut`}</option>
            {options.filter((o) => o.id !== defautDuMembre?.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        ) : (
          <p className="text-sm">{texteImputation(m.imputation, defaut?.label ?? null)}</p>
        )}
        {historique && (
          <p className="text-xs text-warning">
            Imputation choisie avant le changement : elle reste affichée telle quelle. Les nouveaux frais de l&apos;équipe vont au budget {POLE_EQUIPE}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────── La mission ───────────────────────────────

function Etape({ n, fait, enCours, titre, sous, children }: { n: number; fait: boolean; enCours: boolean; titre: string; sous: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
        fait ? "bg-success text-white" : enCours ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>
        {fait ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{titre}</p>
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{sous}</div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">{children}</div>
    </li>
  );
}

const Phase = ({ children }: { children: React.ReactNode }) => (
  <div className="border-b border-border bg-secondary/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
);

const lienBouton = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary sm:h-8";

function MaMission({ detail, vue, peutDeposer, occupe, busy, executer, terminee }: {
  detail: MissionDetailDTO; vue: Cote | null; peutDeposer: boolean; occupe: boolean; busy: string | null; executer: Executer; terminee: boolean;
}) {
  const m = detail.mission;
  const fiche = m.participation.convenue;
  const r = fiche ? reservationsAdventum(fiche) : { billet: Boolean(m.billet.documentId), hotel: Boolean(m.hotel.documentId || m.hotel.confirmation) };
  const omEmis = m.om.etat === "EMIS";
  const moi = vue === "PERSONNE";
  const cloturee = Boolean(m.clotureLe);
  const billetResume = resumeBilletEmis(m.billet.reference, m.billet.trajets);
  const sousBillet = !fiche
    ? (billetResume || "émis")
    : r.billet
      ? (m.billet.documentId || billetResume ? `${MODE_TRANSPORT_LIBELLE[fiche.transport.mode]} · ${fiche.transport.depart ?? "?"} → ${fiche.transport.arrivee ?? "?"}${billetResume ? ` · ${billetResume}` : ""}` : "à émettre — chez l'assistante de direction")
      : fiche.transport.reservation === "MOI" ? "vous réservez — à reporter en note de frais" : MODE_TRANSPORT_LIBELLE[fiche.transport.mode];
  const sousHotel = !fiche
    ? [m.hotel.nom, m.hotel.confirmation ? `n° ${m.hotel.confirmation}` : null].filter(Boolean).join(" · ") || "confirmé"
    : r.hotel
      ? (m.hotel.documentId || m.hotel.confirmation ? [m.hotel.nom ?? fiche.hebergement.hotel, m.hotel.confirmation ? `n° ${m.hotel.confirmation}` : null, fiche.hebergement.nuits != null ? `${fiche.hebergement.nuits} nuit(s)` : null].filter(Boolean).join(" · ") : "à réserver — chez l'assistante de direction")
      : fiche.hebergement.choix === "MOI" ? "vous vous en occupez — note de frais" : "pas besoin";
  const montrerBillet = fiche ? fiche.transport.mode !== "VEHICULE_PERSONNEL" || fiche.transport.reservation === "ADVENTUM" : Boolean(m.billet.documentId || billetResume);
  const montrerHotel = fiche ? true : Boolean(m.hotel.documentId || m.hotel.confirmation);
  let n = 1;

  return (
    <Card className="overflow-hidden">
      <Phase>Avant le départ</Phase>
      <ol>
        <Etape n={n++} fait={omEmis} enCours={m.om.etat === "CHEZ_N1" || m.om.etat === "CHEZ_RH"} titre="Ordre de mission"
          sous={<>{m.om.libelle.texte}{m.om.managerNote && m.om.etat === "REFUSE_N1" ? ` — « ${m.om.managerNote} »` : ""}</>}>
          {m.om.pdfDocId && omEmis && (
            <a href={`/api/rh/document/${m.om.pdfDocId}?dl=1`} className={lienBouton}><Download className="h-4 w-4" /> Télécharger</a>
          )}
          {moi && peutDemanderOrdre(m.om.etat) && (
            <Button size="sm" disabled={occupe} onClick={() => void executer("om", requestMissionOrder, { id: m.id })}>
              {busy === "om" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Demander
            </Button>
          )}
        </Etape>
        {montrerBillet && (
          <Etape n={n++} fait={Boolean(m.billet.documentId)} enCours={r.billet && !m.billet.documentId} titre={fiche && fiche.transport.mode === "AVION" ? "Billet d'avion" : "Transport"} sous={sousBillet}>
            {m.billet.documentId && <a href={doc(m.billet.documentId)} target="_blank" rel="noreferrer" className={lienBouton}>Voir le billet</a>}
          </Etape>
        )}
        {montrerHotel && (
          <Etape n={n++} fait={Boolean(m.hotel.documentId || m.hotel.confirmation)} enCours={r.hotel && !m.hotel.documentId && !m.hotel.confirmation} titre="Hôtel" sous={sousHotel}>
            {m.hotel.documentId && <a href={doc(m.hotel.documentId)} target="_blank" rel="noreferrer" className={lienBouton}>Voir la confirmation</a>}
          </Etape>
        )}
        <Etape n={n++} fait={false} enCours={omEmis && !terminee} titre="Votre rôle sur place"
          sous={<>{MISSION_ROLE[m.role]?.label ?? m.role}{detail.accompagnes.length ? ` · ${detail.accompagnes.length} professionnel${detail.accompagnes.length > 1 ? "s" : ""} accompagné${detail.accompagnes.length > 1 ? "s" : ""} : ${detail.accompagnes.join(", ")}` : ""}</>}>
          <Link href={m.parentPath} className={lienBouton}>Ouvrir la demande</Link>
        </Etape>
      </ol>

      {peutDeposer && !cloturee && (r.billet || r.hotel || !fiche) && (
        <DepotReservation detail={detail} billet={r.billet || !fiche} hotel={r.hotel || !fiche} occupe={occupe} executer={executer} />
      )}

      {(omEmis || cloturee) && (
        <>
          <Phase>Après la mission</Phase>
          <NotesDeFrais detail={detail} moi={moi} occupe={occupe} busy={busy} executer={executer} />
          <Rapport detail={detail} moi={moi} occupe={occupe} executer={executer} />
          <Cloture detail={detail} moi={moi} occupe={occupe} busy={busy} executer={executer} terminee={terminee} />
        </>
      )}
    </Card>
  );
}

/** Le dépôt, côté plateforme : le billet émis (PNR, n° et heures aller / retour) et la confirmation d'hôtel. */
function DepotReservation({ detail, billet, hotel, occupe, executer }: { detail: MissionDetailDTO; billet: boolean; hotel: boolean; occupe: boolean; executer: Executer }) {
  const m = detail.mission;
  const [ouvert, setOuvert] = React.useState(false);
  return (
    <div id="reservation" className="scroll-mt-20 border-t border-border">
      <button type="button" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm font-medium hover:bg-secondary/40">
        <span className="inline-flex items-center gap-1">Déposer le billet émis / la confirmation d&apos;hôtel
          <InfoBulle align="left">Pour l&apos;assistante de direction (qui réserve), l&apos;organisateur, la Direction Marketing et le Super Admin. La personne est prévenue.</InfoBulle>
        </span>
        <span className="text-xs text-muted-foreground">{ouvert ? "Fermer" : "Ouvrir"}</span>
      </button>
      {ouvert && (
        <div className="space-y-4 px-4 pb-4">
          {billet && (
            <form className="space-y-2 rounded-lg border border-border p-3" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const legs = TRAJETS_BILLET.map((_, i) => ({ numero: String(fd.get(`numero${i}`) ?? ""), heureDepart: String(fd.get(`dep${i}`) ?? ""), heureArrivee: String(fd.get(`arr${i}`) ?? ""), reference: null }));
              const envoi = new FormData();
              envoi.set("id", m.id);
              envoi.set("billetReference", String(fd.get("billetReference") ?? ""));
              envoi.set("legDetails", JSON.stringify(legs));
              const f = fd.get("file");
              if (f instanceof File && f.size > 0) envoi.set("file", f);
              void executer("billet", enregistrerBilletMission, envoi);
            }}>
              <p className="text-sm font-semibold">Billet émis</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Champ label="E-billet (PDF)"><Input type="file" name="file" accept=".pdf,image/*" /></Champ>
                <Champ label="Référence / PNR"><Input name="billetReference" defaultValue={m.billet.reference ?? ""} /></Champ>
              </div>
              {TRAJETS_BILLET.map((t, i) => (
                <div key={t} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                  <p className="self-end pb-2 text-xs font-medium">{t}</p>
                  <Champ label="N° de vol / train"><Input name={`numero${i}`} defaultValue={m.billet.trajets[i]?.numero ?? ""} /></Champ>
                  <Champ label="Départ (HH:MM)"><Input name={`dep${i}`} defaultValue={m.billet.trajets[i]?.heureDepart ?? ""} placeholder="18:40" /></Champ>
                  <Champ label="Arrivée (HH:MM)"><Input name={`arr${i}`} defaultValue={m.billet.trajets[i]?.heureArrivee ?? ""} placeholder="21:15" /></Champ>
                </div>
              ))}
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={occupe}>Enregistrer le billet</Button></div>
            </form>
          )}
          {hotel && (
            <form className="space-y-2 rounded-lg border border-border p-3" onSubmit={(e) => {
              e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", m.id);
              const f = fd.get("file"); if (!(f instanceof File) || f.size === 0) fd.delete("file");
              void executer("hotel", enregistrerHotelMission, fd);
            }}>
              <p className="text-sm font-semibold">Confirmation d&apos;hôtel</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Champ label="Voucher"><Input type="file" name="file" accept=".pdf,image/*" /></Champ>
                <Champ label="Hôtel"><Input name="hotelNom" defaultValue={m.hotel.nom ?? m.participation.convenue?.hebergement.hotel ?? ""} /></Champ>
                <Champ label="N° de confirmation"><Input name="hotelConfirmation" defaultValue={m.hotel.confirmation ?? ""} /></Champ>
              </div>
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={occupe}>Enregistrer l&apos;hôtel</Button></div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** LES DÉPENSES — à l'international, en USD sauf le billet, converties au taux figé de la demande. */
function NotesDeFrais({ detail, moi, occupe, busy, executer }: { detail: MissionDetailDTO; moi: boolean; occupe: boolean; busy: string | null; executer: Executer }) {
  const m = detail.mission;
  const modifiable = moi && !m.clotureLe && m.om.etat === "EMIS";
  const [nature, setNature] = React.useState<NatureFrais>("TAXI");
  const total = totalFrais(detail.frais.map((f) => ({ montant: f.montant, devise: f.devise })), detail.taux);
  const nf = detail.noteFrais;
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <div id="frais" className="scroll-mt-20">
      <ol>
        <Etape n={5} fait={nf ? etatNoteFraisMission(nf.statut, nf.gate).ton === "success" : false} enCours={!m.clotureLe} titre="Notes de frais"
          sous={<>{nf && m.clotureLe ? etatNoteFraisMission(nf.statut, nf.gate, nf.managerNote).texte : `${detail.frais.length} dépense${detail.frais.length > 1 ? "s" : ""}${detail.frais.some((f) => !f.documentId) ? " · justificatifs à joindre" : ""}`}
            {m.international ? <> · en USD hors billet, au taux de {detail.taux}</> : null}</>}>
          {m.international && <InfoBulle align="right">À l&apos;international, chaque dépense se saisit en USD, sauf le billet (DZD). Le total part aux RH en DZD au taux figé de la demande.</InfoBulle>}
        </Etape>
      </ol>
      <div className="overflow-x-auto border-b border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
              <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">Date</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Nature</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Détail</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Montant</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Justificatif</th>
              {modifiable && <th className="px-3 py-2"><span className="sr-only">Retirer</span></th>}
            </tr>
          </thead>
          <tbody>
            {detail.frais.map((f) => <LigneFrais key={f.id} f={f} modifiable={modifiable} occupe={occupe} executer={executer} />)}
            {detail.frais.length === 0 && (
              <tr className="border-t border-border"><td colSpan={modifiable ? 6 : 5} className="sticky left-0 bg-card px-3 py-3 text-xs text-muted-foreground">Aucune dépense.</td></tr>
            )}
          </tbody>
          <tfoot>
            {modifiable && (
              <tr className="border-t border-border bg-primary/5">
                <td className="sticky left-0 z-10 bg-card px-2 py-2"><Input form="nouvelle-depense" type="date" name="date" required aria-label="Date" className="min-w-[130px]" defaultValue={jourIso(m.dateDepart)} /></td>
                <td className="px-2 py-2">
                  <Select form="nouvelle-depense" name="nature" aria-label="Nature" value={nature} onChange={(e) => setNature(e.target.value as NatureFrais)}>
                    {NATURES_FRAIS.map((x) => <option key={x} value={x}>{NATURE_FRAIS_LIBELLE[x]}</option>)}
                  </Select>
                </td>
                <td className="px-2 py-2"><Input form="nouvelle-depense" name="detail" aria-label="Détail" className="min-w-[140px]" placeholder="Aéroport → hôtel" /></td>
                <td className="px-2 py-2"><Input form="nouvelle-depense" name="montant" inputMode="decimal" required aria-label="Montant" className="min-w-[90px] text-right" placeholder={deviseFrais(m.international, nature)} /></td>
                <td className="px-2 py-2"><Input form="nouvelle-depense" type="file" name="file" aria-label="Justificatif" accept=".pdf,image/*" className="min-w-[160px]" /></td>
                <td className="px-2 py-2">
                  <Button form="nouvelle-depense" type="submit" size="sm" disabled={occupe}>{busy === "frais" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</Button>
                </td>
              </tr>
            )}
            <tr className="border-t border-border font-medium">
              <td colSpan={3} className="sticky left-0 bg-card px-3 py-2">Total</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {[total.usd > 0 ? montant(total.usd, "USD") : null, total.dzd > 0 || total.usd === 0 ? montant(total.dzd, "DZD") : null].filter(Boolean).join(" + ")}
              </td>
              <td colSpan={modifiable ? 2 : 1} className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {total.usd > 0 && total.totalDzd != null ? `≈ ${montant(total.totalDzd, "DZD")}` : ""}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {modifiable && (
        <form id="nouvelle-depense" ref={formRef} className="hidden" onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget); fd.set("id", m.id);
          const f = fd.get("file"); if (!(f instanceof File) || f.size === 0) fd.delete("file");
          void executer("frais", ajouterFraisMission, fd, () => formRef.current?.reset());
        }} />
      )}
    </div>
  );
}

function LigneFrais({ f, modifiable, occupe, executer }: { f: FraisDTO; modifiable: boolean; occupe: boolean; executer: Executer }) {
  const input = React.useRef<HTMLInputElement>(null);
  const confirmer = useConfirmer();
  return (
    <tr className="border-t border-border">
      <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2">{jourCourt(f.date)}</td>
      <td className="whitespace-nowrap px-3 py-2">{NATURE_FRAIS_LIBELLE[f.nature as NatureFrais] ?? f.nature}</td>
      <td className="px-3 py-2 [overflow-wrap:anywhere]">{f.detail ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        {montant(f.montant, f.devise)}
        {f.devise === "USD" && f.montantDzd != null && <span className="block text-xs text-muted-foreground">≈ {montant(f.montantDzd, "DZD")}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {f.documentId
          ? <a href={doc(f.documentId)} target="_blank" rel="noreferrer" className="text-primary hover:underline">voir</a>
          : <span className="text-xs text-warning">manquant</span>}
        {modifiable && (
          <>
            <input ref={input} type="file" accept=".pdf,image/*" className="hidden" aria-label="Joindre le justificatif" onChange={(e) => {
              const file = e.target.files?.[0]; if (!file) return;
              const fd = new FormData(); fd.set("ligneId", f.id); fd.set("file", file);
              void executer(`just-${f.id}`, joindreJustificatifFrais, fd);
            }} />
            <Button type="button" size="sm" variant="ghost" disabled={occupe} onClick={() => input.current?.click()}><Paperclip className="h-4 w-4" /> {f.documentId ? "Remplacer" : "Joindre"}</Button>
          </>
        )}
      </td>
      {modifiable && (
        <td className="px-3 py-2 text-right">
          <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={occupe}
            onClick={async () => { if (await confirmer("Retirer cette dépense ?")) void executer(`rm-${f.id}`, retirerFraisMission, { ligneId: f.id }); }}>Retirer</Button>
        </td>
      )}
    </tr>
  );
}

function Rapport({ detail, moi, occupe, executer }: { detail: MissionDetailDTO; moi: boolean; occupe: boolean; executer: Executer }) {
  const m = detail.mission;
  const r = detail.rapport;
  const modifiable = moi && !m.clotureLe;
  const [ouvert, setOuvert] = React.useState(false);
  const champs = [
    { cle: "deroule", label: "Déroulé", val: r.deroule },
    { cle: "medecins", label: "Médecins rencontrés", val: r.medecins },
    { cle: "retombees", label: "Retombées", val: r.retombees },
    { cle: "suites", label: "Suites à donner", val: r.suites },
  ];
  return (
    <div id="rapport" className="scroll-mt-20">
      <ol>
        <Etape n={6} fait={Boolean((r.deroule ?? "").trim())} enCours={false} titre="Rapport de mission"
          sous={r.le ? `enregistré le ${formatDate(r.le)}` : "Déroulé, médecins rencontrés, retombées, suites à donner"}>
          <Button size="sm" variant="outline" onClick={() => setOuvert((v) => !v)}>{ouvert ? "Fermer" : modifiable ? "Rédiger" : "Lire"}</Button>
        </Etape>
      </ol>
      {ouvert && (modifiable ? (
        <form className="space-y-2 border-b border-border bg-primary/5 px-4 py-3" onSubmit={(e) => {
          e.preventDefault(); const fd = new FormData(e.currentTarget); fd.set("id", m.id);
          void executer("rapport", enregistrerRapportMission, fd);
        }}>
          {champs.map((c) => <Champ key={c.cle} label={c.label}><Textarea name={c.cle} rows={c.cle === "deroule" ? 4 : 2} defaultValue={c.val ?? ""} required={c.cle === "deroule"} /></Champ>)}
          <div className="flex justify-end"><Button type="submit" size="sm" disabled={occupe}>Enregistrer le rapport</Button></div>
        </form>
      ) : (
        <dl className="space-y-2 border-b border-border px-4 py-3 text-sm">
          {champs.map((c) => (
            <div key={c.cle}><dt className="text-xs text-muted-foreground">{c.label}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{c.val || "—"}</dd></div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function Cloture({ detail, moi, occupe, busy, executer, terminee }: { detail: MissionDetailDTO; moi: boolean; occupe: boolean; busy: string | null; executer: Executer; terminee: boolean }) {
  const m = detail.mission;
  const confirmer = useConfirmer();
  const manques = manquesCloture({
    cloturee: Boolean(m.clotureLe), omEmis: m.om.etat === "EMIS", terminee, rapport: detail.rapport,
    lignes: detail.frais.map((f) => ({ justificatif: Boolean(f.documentId) })),
  });
  return (
    <ol>
      <Etape n={7} fait={Boolean(m.clotureLe)} enCours={false} titre="Clôturer la mission"
        sous={m.clotureLe ? `clôturée le ${formatDate(m.clotureLe)}` : manques.length ? manques.join(" ") : "Envoie les notes de frais à votre N+1 puis aux RH, et le rapport à l'organisateur"}>
        {moi && !m.clotureLe && (
          <Button size="sm" disabled={occupe || manques.length > 0}
            onClick={async () => { if (await confirmer("Clôturer la mission ? Les dépenses partent en note de frais et ne se modifient plus.")) void executer("cloture", cloturerMission, { id: m.id }); }}>
            {busy === "cloture" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Clôturer
          </Button>
        )}
      </Etape>
    </ol>
  );
}
