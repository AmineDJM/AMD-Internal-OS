"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Download, Loader2, MessageSquare, Plus } from "lucide-react";
import type { MissionAssignmentDTO, OrdreAValiderDTO, EtapeLieeDTO } from "@/lib/queries/missions";
import {
  repondreMission, requestMissionOrder, retirerDemandeOrdreMission, ajouterEtapeMission, retirerEtapeMission,
  demanderLogistiqueMission, demanderMaterielMission, deposerNoteFraisMission, deciderOrdreMissionN1, modifierMission,
  addMissionComment,
} from "@/lib/actions/mission-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import {
  etapesVisibles, etapesAAjouter, peutDemanderOrdre, peutRetirerOrdre, noteFraisOuverte, demandeRelancable, jourIso,
  LIBELLE_ETAPE, type EtapeFacultative, type Etat,
} from "@/lib/missions-equipe/etat";
import { etatParticipation, aQuiLeTour } from "@/lib/missions-equipe/participation";
import { lienMission } from "@/lib/chemins/espace";
import { MISSION_ROLE } from "@/lib/labels";
import { formatDate, cn } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList } from "@/components/documents/document-list";
import { CommentThread } from "@/components/shared/comment-thread";

type Resultat = { ok: boolean; error?: string; message?: string };
type Executer = (cle: string, action: (fd: FormData) => Promise<Resultat>, champs: Record<string, string> | FormData, apres?: () => void) => Promise<void>;
const PATH = "/mon-espace/missions";
const MISSION_DOC_CATEGORIES = ["MISSION_ORDER", "SUPPORTING_DOC", "OTHER"];

const periode = (d: string | null, f: string | null) =>
  d ? `${formatDate(d)}${f && jourIso(f) !== jourIso(d) ? ` → ${formatDate(f)}` : ""}` : "dates à préciser";

function Pastille({ etat }: { etat: Etat }) {
  return <Badge tone={etat.ton} dot={false}>{etat.texte}</Badge>;
}

/**
 * « MES MISSIONS » (Mon espace, Direction 10/2026). En tête, ce qui attend un geste : les ordres de mission à valider
 * comme N+1, puis les invitations (Je confirme / Je décline). Ensuite, une carte par mission confirmée : SEUL l'ordre
 * de mission paraît d'office ; transport, hébergement, matériel et note de frais n'apparaissent que si la personne
 * les ajoute par « ⋯ ».
 */
export function MesMissions({ missions, aValider, articles, currentUserId }: {
  missions: MissionAssignmentDTO[];
  aValider: OrdreAValiderDTO[];
  articles: { id: string; libelle: string }[];
  currentUserId: string;
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
    const r = await action(fd);
    setBusy(null);
    setMsg({ ok: r.ok, texte: r.ok ? (r.message ?? "Enregistré.") : (r.error ?? "Échec.") });
    if (r.ok) { apres?.(); rafraichir(); }
  };

  // LA DEMANDE DE PARTICIPATION (Direction, 10/2026) : une fiche à remplir en tête ; les participations en discussion
  // ou convenues dans un tableau qui dit « où — chez qui » ; les missions d'avant la fiche gardent leur carte.
  const invitations = missions.filter((m) => m.participation.etape === "FICHE_A_REMPLIR");
  const participations = missions.filter((m) => m.participation.nbVersions > 0 && m.response !== "DECLINEE");
  const confirmees = missions.filter((m) => m.participation.etape === "CONFIRMEE_SANS_FICHE");
  const declinees = missions.filter((m) => m.response === "DECLINEE");

  return (
    <div className="space-y-5">
      {msg && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>{msg.texte}</p>}

      {aValider.length > 0 && <OrdresAValider lignes={aValider} occupe={occupe} busy={busy} executer={executer} />}

      {invitations.length > 0 && (
        <Card className="overflow-hidden">
          {invitations.map((m) => <Invitation key={m.id} m={m} occupe={occupe} executer={executer} />)}
        </Card>
      )}

      {participations.length > 0 && <MesParticipations lignes={participations} />}

      {confirmees.map((m) => (
        <CarteMission key={m.id} m={m} articles={articles} occupe={occupe} busy={busy} executer={executer} currentUserId={currentUserId} />
      ))}

      {missions.length === 0 && aValider.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          Aucune mission. Quand un organisateur vous invite sur un congrès, un événement ou un sponsoring, l&apos;invitation arrive ici.
        </p>
      )}

      {declinees.length > 0 && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {declinees.map((m) => (
            <p key={m.id}>Déclinée — <Link href={m.parentPath} className="hover:underline">{m.parentLabel}</Link>{m.declineReason ? ` · « ${m.declineReason} »` : ""}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── N+1 ───────────────────────────────

function OrdresAValider({ lignes, occupe, busy, executer }: { lignes: OrdreAValiderDTO[]; occupe: boolean; busy: string | null; executer: Executer }) {
  const [refus, setRefus] = React.useState<string | null>(null);
  return (
    <section id="a-valider" className="scroll-mt-20 space-y-2">
      <h2 className="flex items-center gap-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        À valider comme N+1 ({lignes.length})
        <InfoBulle align="left">Ordres de mission et notes de frais de mission de votre équipe : votre validation les envoie aux RH. Un refus porte un motif et prévient la personne.</InfoBulle>
      </h2>
      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
              <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">Personne</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Mission</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Dates</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Lieu</th>
              <th className="px-3 py-2"><span className="sr-only">Décision</span></th>
            </tr>
          </thead>
          <tbody>
            {lignes.map((l) => (
              <React.Fragment key={l.requestId}>
                <tr className="border-t border-border">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">{l.employeeName}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="mr-1.5 text-xs text-muted-foreground">{l.nature === "NF" ? "Note de frais" : "Ordre de mission"} ·</span>
                    {l.missionId && l.nature === "NF" ? <Link href={lienMission(l.missionId, "frais")} className="text-primary hover:underline">{l.mission}</Link> : l.mission}
                    {l.montant != null ? ` · ${l.montant.toLocaleString("fr-FR")} DZD` : ""}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{periode(l.dates.depart, l.dates.retour)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{l.destination || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="inline-flex gap-1.5">
                      <Button size="sm" disabled={occupe} onClick={() => void executer(`n1-${l.requestId}`, deciderOrdreMissionN1, { requestId: l.requestId, decision: "VALIDER" })}>
                        {busy === `n1-${l.requestId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Valider
                      </Button>
                      <Button size="sm" variant="outline" disabled={occupe} onClick={() => setRefus(refus === l.requestId ? null : l.requestId)}>Refuser</Button>
                    </div>
                  </td>
                </tr>
                {refus === l.requestId && (
                  <tr className="border-t border-border bg-secondary/20">
                    <td colSpan={5} className="px-3 py-2">
                      <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget); fd.set("requestId", l.requestId); fd.set("decision", "REFUSER");
                        void executer(`n1r-${l.requestId}`, deciderOrdreMissionN1, fd, () => setRefus(null));
                      }}>
                        <div className="min-w-0 flex-1 space-y-1">
                          <Label htmlFor={`motif-${l.requestId}`}>Motif du refus</Label>
                          <Input id={`motif-${l.requestId}`} name="motif" required />
                        </div>
                        <Button type="submit" size="sm" variant="destructive" disabled={occupe}>Refuser</Button>
                      </form>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

// ─────────────────────────────── Mes participations ───────────────────────────────

/** Les participations en discussion ou convenues — une ligne chacune, « où en est-on — chez qui », et la mission à ouvrir. */
function MesParticipations({ lignes }: { lignes: MissionAssignmentDTO[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
            <th className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">Mission</th>
            <th className="whitespace-nowrap px-3 py-2 font-medium">Rôle</th>
            <th className="whitespace-nowrap px-3 py-2 font-medium">Dates</th>
            <th className="whitespace-nowrap px-3 py-2 font-medium">Où en est-on</th>
            <th className="whitespace-nowrap px-3 py-2 font-medium">Ordre de mission</th>
            <th className="px-3 py-2"><span className="sr-only">Ouvrir</span></th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((m) => {
            const p = m.participation;
            const etat = m.clotureLe ? { texte: "clôturée", ton: "success" as const } : etatParticipation(p.etape, p.derniere, "PERSONNE", { personne: m.userName, organisateur: m.organiserName });
            const aMoi = aQuiLeTour(p.etape) === "PERSONNE";
            return (
              <tr key={m.id} className="border-t border-border">
                <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-2 font-medium">
                  <Link href={lienMission(m.id)} className="text-primary hover:underline">{m.parentLabel}</Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{MISSION_ROLE[m.role]?.label ?? m.role}</td>
                <td className="whitespace-nowrap px-3 py-2">{periode(m.dateDepart, m.dateRetour)}</td>
                <td className="whitespace-nowrap px-3 py-2"><Pastille etat={etat} /></td>
                <td className="whitespace-nowrap px-3 py-2">{m.om.etat === "AUCUN" ? <span className="text-muted-foreground">—</span> : <Pastille etat={m.om.libelle} />}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Link href={lienMission(m.id)} className={cn("inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium", aMoi ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border hover:bg-secondary")}>
                    {aMoi ? "Répondre" : m.om.etat === "EMIS" ? "Ma mission" : "Ouvrir"}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ─────────────────────────────── Invitation ───────────────────────────────

function Invitation({ m, occupe, executer }: { m: MissionAssignmentDTO; occupe: boolean; executer: Executer }) {
  const [decliner, setDecliner] = React.useState(false);
  return (
    <div className="border-b border-border bg-warning/10 px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium">Demande de participation — <Link href={m.parentPath} className="hover:underline">{m.parentLabel}</Link></p>
          <p className="text-xs text-muted-foreground">
            {MISSION_ROLE[m.role]?.label ?? m.role} · {periode(m.dateDepart, m.dateRetour)}{m.ville ? ` · ${m.ville}` : ""}{m.organiserName ? ` · par ${m.organiserName}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Link href={lienMission(m.id)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 sm:h-8">
<Check className="h-4 w-4" /> Remplir ma fiche
          </Link>
          <Button size="sm" variant="outline" disabled={occupe} onClick={() => setDecliner((v) => !v)}>Je décline</Button>
        </div>
      </div>
      {decliner && (
        <form className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget); fd.set("id", m.id); fd.set("decision", "DECLINER");
          void executer(`ko-${m.id}`, repondreMission, fd, () => setDecliner(false));
        }}>
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={`decline-${m.id}`}>Pourquoi ?</Label>
            <Input id={`decline-${m.id}`} name="motif" required placeholder="garde, congé, autre mission…" />
          </div>
          <Button type="submit" size="sm" variant="destructive" disabled={occupe}>Décliner</Button>
        </form>
      )}
    </div>
  );
}

// ─────────────────────────────── Une mission confirmée ───────────────────────────────

function CarteMission({ m, articles, occupe, busy, executer, currentUserId }: {
  m: MissionAssignmentDTO; articles: { id: string; libelle: string }[]; occupe: boolean; busy: string | null; executer: Executer; currentUserId: string;
}) {
  const [ouverte, setOuverte] = React.useState<EtapeFacultative | "DATES" | null>(null);
  const [pieces, setPieces] = React.useState(false);
  const liees: EtapeFacultative[] = [
    m.transport ? "TRANSPORT" : null, m.hebergement ? "HEBERGEMENT" : null, m.materiel ? "MATERIEL" : null, m.noteFrais ? "NOTE_FRAIS" : null,
  ].filter((x): x is EtapeFacultative => x !== null);
  const visibles = etapesVisibles(m.etapes, liees);
  const aAjouter = etapesAAjouter(m.etapes, liees);
  const lien: Record<EtapeFacultative, EtapeLieeDTO | null> = { TRANSPORT: m.transport, HEBERGEMENT: m.hebergement, MATERIEL: m.materiel, NOTE_FRAIS: m.noteFrais };
  const nfOuverte = noteFraisOuverte(m.dateRetour, m.dateDepart);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-semibold">{m.parentLabel}</p>
          <p className="text-xs text-muted-foreground">{MISSION_ROLE[m.role]?.label ?? m.role} · {periode(m.dateDepart, m.dateRetour)}{m.ville ? ` · ${m.ville}` : ""}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone="success" dot={false}>confirmée</Badge>
          <Link href={m.parentPath} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary sm:h-8">Ouvrir la demande</Link>
          <MenuDossier>
            {aAjouter.length > 0 && <p className="px-2 text-xs font-medium text-muted-foreground">Ajouter</p>}
            {aAjouter.map((e) => (
              <Button key={e} size="sm" variant="ghost" className="justify-start" disabled={occupe}
                onClick={() => void executer(`add-${m.id}-${e}`, ajouterEtapeMission, { id: m.id, etape: e }, () => setOuverte(e))}>
                <Plus className="h-4 w-4" /> {LIBELLE_ETAPE[e]}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="justify-start" onClick={() => setOuverte(ouverte === "DATES" ? null : "DATES")}>Modifier dates / ville</Button>
            <Button size="sm" variant="ghost" className="justify-start" onClick={() => setPieces((v) => !v)}>
              <MessageSquare className="h-4 w-4" /> Pièces & discussion ({m.documents.length + m.comments.length})
            </Button>
          </MenuDossier>
        </div>
      </div>

      {ouverte === "DATES" && (
        <FormulaireEtape onSubmit={(fd) => { fd.set("id", m.id); void executer(`dates-${m.id}`, modifierMission, fd, () => setOuverte(null)); }} occupe={occupe} bouton="Enregistrer" onAnnuler={() => setOuverte(null)}>
          <Champ label="Ville"><Input name="ville" defaultValue={m.ville ?? ""} /></Champ>
          <Champ label="Départ"><Input name="dateDepart" type="date" defaultValue={jourIso(m.dateDepart)} /></Champ>
          <Champ label="Retour"><Input name="dateRetour" type="date" defaultValue={jourIso(m.dateRetour)} /></Champ>
        </FormulaireEtape>
      )}

      <ol>
        {/* 1. L'ORDRE DE MISSION — toujours là. */}
        <Etape n={1} fait={m.om.etat === "EMIS"} enCours={m.om.etat === "CHEZ_N1" || m.om.etat === "CHEZ_RH"} titre="Ordre de mission"
          sous={<>{m.om.libelle.texte}{m.om.managerNote && (m.om.etat === "REFUSE_N1") ? ` — « ${m.om.managerNote} »` : ""}</>}>
          {m.om.pdfDocId && m.om.etat === "EMIS" && (
            <a href={`/api/rh/document/${m.om.pdfDocId}?dl=1`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary sm:h-8">
              <Download className="h-4 w-4" /> Télécharger
            </a>
          )}
          {peutDemanderOrdre(m.om.etat) && (
            <Button size="sm" disabled={occupe} onClick={() => void executer(`om-${m.id}`, requestMissionOrder, { id: m.id })}>
              {busy === `om-${m.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Demander
            </Button>
          )}
          {peutRetirerOrdre(m.om.etat) && (
            <Button size="sm" variant="ghost" disabled={occupe} onClick={() => { if (window.confirm("Retirer votre demande d'ordre de mission ?")) void executer(`omr-${m.id}`, retirerDemandeOrdreMission, { id: m.id }); }}>Retirer</Button>
          )}
          {m.om.etat !== "AUCUN" && !peutDemanderOrdre(m.om.etat) && !peutRetirerOrdre(m.om.etat) && !m.om.pdfDocId && <Pastille etat={m.om.libelle} />}
        </Etape>

        {/* 2… LES ÉTAPES AJOUTÉES — et elles seules. */}
        {visibles.map((e, i) => {
          const l = lien[e];
          const peutDemander = demandeRelancable(l?.statut ?? null) && (e !== "NOTE_FRAIS" || nfOuverte);
          return (
            <React.Fragment key={e}>
              <Etape n={i + 2} fait={l?.etat.ton === "success"} enCours={Boolean(l) && l?.etat.ton !== "success" && !demandeRelancable(l?.statut ?? null)} titre={LIBELLE_ETAPE[e]}
                sous={l ? <>{l.etat.texte}{l.detail ? ` · ${l.detail}` : ""}</> : e === "NOTE_FRAIS" && !nfOuverte ? `après le ${m.dateRetour ? formatDate(m.dateRetour) : "retour"}` : "à demander"}>
                {l?.href && !demandeRelancable(l.statut) && <Link href={l.href} className="text-xs text-primary hover:underline">Ouvrir</Link>}
                {peutDemander && (
                  <Button size="sm" variant={ouverte === e ? "ghost" : undefined} disabled={occupe} onClick={() => setOuverte(ouverte === e ? null : e)}>
                    {ouverte === e ? "Fermer" : e === "NOTE_FRAIS" ? "Déposer" : "Demander"}
                  </Button>
                )}
                {!l && (
                  <button type="button" className="text-xs text-muted-foreground hover:underline" disabled={occupe}
                    onClick={() => void executer(`rm-${m.id}-${e}`, retirerEtapeMission, { id: m.id, etape: e })}>Retirer</button>
                )}
              </Etape>
              {ouverte === e && peutDemander && (
                <FormulaireDeLEtape etape={e} m={m} articles={articles} occupe={occupe} executer={executer} fermer={() => setOuverte(null)} />
              )}
            </React.Fragment>
          );
        })}
      </ol>

      {pieces && (
        <div className="space-y-4 border-t border-border bg-secondary/20 px-4 py-3">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pièces</p>
            <DocumentUpload entityType="MISSION_ASSIGNMENT" entityId={m.id} categories={MISSION_DOC_CATEGORIES} compact />
            <DocumentList documents={m.documents} canDelete={false} canRename canEdit={false} path={PATH} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Discussion avec l&apos;organisateur</p>
            <CommentThread comments={m.comments} action={addMissionComment} hiddenFields={{ assignmentId: m.id }} currentUserId={currentUserId}
              canModerate={false} updateAction={updateComment} deleteAction={deleteComment} path={PATH} />
          </div>
        </div>
      )}
    </Card>
  );
}

function Etape({ n, fait, enCours, titre, sous, children }: { n: number; fait: boolean; enCours: boolean; titre: string; sous: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
        fait ? "bg-success text-white" : enCours ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>
        {fait ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{titre}</p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{sous}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">{children}</div>
    </li>
  );
}

function Champ({ label, children, large = false }: { label: string; children: React.ReactNode; large?: boolean }) {
  return <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", large && "sm:col-span-2")}>{label}{children}</label>;
}

function FormulaireEtape({ onSubmit, occupe, bouton, onAnnuler, children }: {
  onSubmit: (fd: FormData) => void; occupe: boolean; bouton: string; onAnnuler: () => void; children: React.ReactNode;
}) {
  return (
    <form className="space-y-2 border-b border-border bg-primary/5 px-4 py-3 sm:pl-[60px]" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">{children}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onAnnuler}>Annuler</Button>
        <Button type="submit" size="sm" disabled={occupe}>{bouton}</Button>
      </div>
    </form>
  );
}

/** Les formulaires des étapes — tout pré-rempli depuis la mission (ville, dates, objet). */
function FormulaireDeLEtape({ etape, m, articles, occupe, executer, fermer }: {
  etape: EtapeFacultative; m: MissionAssignmentDTO; articles: { id: string; libelle: string }[]; occupe: boolean; executer: Executer; fermer: () => void;
}) {
  const depart = jourIso(m.dateDepart);
  const retour = jourIso(m.dateRetour);
  const nuits = depart && retour ? Math.max(1, Math.round((new Date(retour).getTime() - new Date(depart).getTime()) / 86_400_000)) : 1;
  const envoyer = (action: (fd: FormData) => Promise<Resultat>, extra: Record<string, string> = {}) => (fd: FormData) => {
    fd.set("id", m.id);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    void executer(`etape-${m.id}-${etape}`, action, fd, fermer);
  };

  if (etape === "TRANSPORT") {
    return (
      <FormulaireEtape onSubmit={envoyer(demanderLogistiqueMission, { etape: "TRANSPORT" })} occupe={occupe} bouton="Envoyer au secrétariat" onAnnuler={fermer}>
        <Champ label="Départ de"><Input name="villeDepart" placeholder="Alger" /></Champ>
        <Champ label="Vers"><Input name="ville" defaultValue={m.ville ?? ""} /></Champ>
        <Champ label="Aller"><Input name="dateDepart" type="date" defaultValue={depart} /></Champ>
        <Champ label="Retour"><Input name="dateRetour" type="date" defaultValue={retour} /></Champ>
        <Champ label="Précisions" large><Input name="details" placeholder="horaires, préférence…" /></Champ>
      </FormulaireEtape>
    );
  }
  if (etape === "HEBERGEMENT") {
    return (
      <FormulaireEtape onSubmit={envoyer(demanderLogistiqueMission, { etape: "HEBERGEMENT" })} occupe={occupe} bouton="Envoyer au secrétariat" onAnnuler={fermer}>
        <Champ label="Ville"><Input name="ville" defaultValue={m.ville ?? ""} /></Champ>
        <Champ label="Arrivée"><Input name="dateDepart" type="date" defaultValue={depart} /></Champ>
        <Champ label="Départ"><Input name="dateRetour" type="date" defaultValue={retour} /></Champ>
        <Champ label="Nuits"><Input name="nbNuits" type="number" min={1} defaultValue={nuits} /></Champ>
        <Champ label="Préférence" large>
          <Select name="hotelPref" defaultValue="Hôtel du congrès / de l'événement">
            <option>Hôtel du congrès / de l&apos;événement</option>
            <option>Au plus proche du lieu</option>
            <option>Indifférent</option>
          </Select>
        </Champ>
      </FormulaireEtape>
    );
  }
  if (etape === "MATERIEL") {
    return (
      <FormulaireEtape onSubmit={envoyer(demanderMaterielMission)} occupe={occupe} bouton="Envoyer au magasin" onAnnuler={fermer}>
        <Champ label="Article" large>
          <Select name="itemId" required defaultValue="">
            <option value="">{articles.length ? "— Choisir —" : "— Aucun article disponible —"}</option>
            {articles.map((a) => <option key={a.id} value={a.id}>{a.libelle}</option>)}
          </Select>
        </Champ>
        <Champ label="Quantité"><Input name="quantite" inputMode="decimal" required /></Champ>
        <Champ label="Note"><Input name="note" /></Champ>
      </FormulaireEtape>
    );
  }
  return (
    <FormulaireEtape onSubmit={envoyer(deposerNoteFraisMission)} occupe={occupe} bouton="Déposer aux RH" onAnnuler={fermer}>
      <Champ label="Mois"><Input name="expenseMonth" type="month" required defaultValue={(retour || depart || new Date().toISOString()).slice(0, 7)} /></Champ>
      <Champ label="Montant (DZD)"><Input name="expenseAmount" inputMode="decimal" required /></Champ>
      <Champ label="Justificatif" large><Input name="files" type="file" multiple required /></Champ>
      <Champ label="Motif" large><Textarea name="details" rows={2} placeholder="taxi, repas…" /></Champ>
    </FormulaireEtape>
  );
}
