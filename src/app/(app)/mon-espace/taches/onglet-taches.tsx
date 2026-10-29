"use client";

import * as React from "react";
import { actionFailureMessage } from "@/lib/action-outcome";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BellRing, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, MapPin, MessageSquare, MoreHorizontal,
  Navigation, Play, Send, SlidersHorizontal, Users, X,
} from "lucide-react";
import {
  annulerDemandeTache, createTask, deleteTask, reattribuerDemandeTache, relanceTaskRequest, reopenTaskWork,
  respondTaskRequest, startTask, submitTaskWork, updateTaskStatus,
} from "@/lib/actions/task-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DocumentList } from "@/components/documents/document-list";
import { DocumentUpload } from "@/components/documents/document-upload";
import { VUES_TACHES, ONGLET_TACHES_HREF, type VueTaches } from "@/lib/tasks/onglet-taches";
import { cn, formatDate } from "@/lib/utils";
import type { LigneTache, LigneMissionAAccepter, OngletTaches as Donnees } from "@/lib/queries/mes-taches";
import type { InvitationMissionDTO, OrdreAValiderDTO } from "@/lib/queries/missions";
import { repondreMission, deciderOrdreMissionN1 } from "@/lib/actions/mission-actions";
import { MISSION_ROLE } from "@/lib/labels";
import { lienMission } from "@/lib/chemins/espace";
import { TaskWorkPanel } from "./[id]/work-panel";
import { TaskComments } from "./[id]/comments";

type Resultat = { ok: boolean; error?: string; message?: string };

/** Un geste serveur, puis le rafraîchissement suivi (§118.172) — et l'erreur dite, pas avalée. */
function useGeste() {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = React.useCallback(async (fn: () => Promise<Resultat>, apres?: () => void) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (r.ok) { apres?.(); rafraichir(); } else setErr(r.error ?? "La tâche n'a pas été mise à jour.");
      return r.ok;
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return false;
    } finally {
      setBusy(false);
    }
  }, [rafraichir]);
  return { ferme: busy || enCours, busy, err, setErr, run };
}

const fd = (champs: Record<string, string | null | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) if (v) f.set(k, v);
  return f;
};

const TON_PILL: Record<string, string> = {
  warning: "bg-warning/10 text-warning",
  info: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * L'ONGLET « TÂCHES » (Direction, 07/10) — un seul endroit pour toutes les tâches.
 *
 * En haut, ce qu'on me demande (accepter / refuser). Puis une ligne pour créer (« Pour moi », « Demander
 * à… »), quatre vues, un tableau trié par échéance. Un clic sur une ligne ouvre le panneau : description,
 * état — chez qui, le travail, les pièces, le fil.
 */
export function OngletTaches({ data, champsComplets, peutCreer, ouvrir }: {
  data: Donnees;
  champsComplets: FieldDef[];
  peutCreer: boolean;
  ouvrir: string | null;
}) {
  const [ouverte, setOuverte] = React.useState<string | null>(ouvrir);
  const toutes = React.useMemo(() => [...data.aAccepter, ...data.lignes], [data.aAccepter, data.lignes]);
  const selection = ouverte ? toutes.find((t) => t.id === ouverte) ?? null : null;
  // `?tache=` (une notification) VISE UNE TÂCHE QUI N'EST PAS DANS CETTE VUE (déplacée, terminée, page
  // suivante) : sa fiche l'ouvre à coup sûr — un panneau qui ne s'ouvre pas laisserait croire au lien mort.
  const router = useRouter();
  const ouvrirAuDepart = React.useRef(ouvrir);
  React.useEffect(() => {
    const id = ouvrirAuDepart.current;
    if (id && !toutes.some((t) => t.id === id)) router.replace(`/mon-espace/taches/${encodeURIComponent(id)}`);
    ouvrirAuDepart.current = null;
  }, [toutes, router]);

  return (
    <div className="space-y-4">
      {(data.aAccepter.length > 0 || data.aAccepterMissions.length > 0) && (
        <AAccepter lignes={data.aAccepter} missions={data.aAccepterMissions} ouvrir={setOuverte} />
      )}

      <Card>
        {peutCreer && <BarreCreation personnes={data.personnes} champsComplets={champsComplets} />}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <Vues vue={data.vue} compteurs={data.compteurs} />
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {data.vue === "terminees" ? "30 derniers jours" : "tri : échéance"}
            <InfoBulle label="Les vues">
              <strong>À faire</strong> : chez vous — demandes acceptées, vos tâches, celles créées par la plateforme.{" "}
              <strong>Demandées</strong> : ce que vous attendez des autres, et chez qui c&apos;est.{" "}
              <strong>Partagées</strong> : vous participez ou suivez en lecture.
            </InfoBulle>
          </span>
        </div>
        {data.vue === "demandees"
          ? <TableDemandees lignes={data.lignes} personnes={data.personnes} ouvrir={setOuverte} />
          : <TableTaches lignes={data.lignes} vue={data.vue} ouvrir={setOuverte} />}
        {data.pagination && data.pagination.pages > 1 && <Pagination {...data.pagination} />}
      </Card>

      <PanneauTache
        ligne={selection}
        detail={selection ? data.details[selection.id] ?? { fil: [], pieces: [] } : null}
        personnes={data.personnes}
        fermer={() => setOuverte(null)}
      />
    </div>
  );
}

// ─── À accepter ────────────────────────────────────────────────────────────────────────────

function AAccepter({ lignes, missions, ouvrir }: { lignes: LigneTache[]; missions: LigneMissionAAccepter[]; ouvrir: (id: string) => void }) {
  return (
    <Card>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">À accepter <span className="ml-1 text-muted-foreground">{lignes.length + missions.length}</span></h2>
        <InfoBulle label="À accepter">
          On vous demande ces tâches. En acceptant, elles passent dans « À faire » ; refuser se fait avec un motif court, facultatif.
          {missions.length > 0 && <> Les invitations à une mission et les ordres de mission de votre équipe y figurent aussi : ce ne sont pas des tâches, leur réponse est celle de « Mes missions ».</>}
        </InfoBulle>
      </header>
      <ul className="divide-y divide-border">
        {missions.map((m) => m.type === "ORDRE_MISSION_N1"
          ? <LigneOrdreMissionN1 key={m.cle} ordre={m.ordre} />
          : <LigneInvitationMission key={m.cle} invitation={m.invitation} />)}
        {lignes.map((l) => <LigneAAccepter key={l.id} l={l} ouvrir={ouvrir} />)}
      </ul>
    </Card>
  );
}

const periodeMission = (d: string | null, f: string | null) =>
  d ? `${formatDate(d)}${f && f.slice(0, 10) !== d.slice(0, 10) ? ` → ${formatDate(f)}` : ""}` : "dates à préciser";

/**
 * Une demande de participation où la balle est chez moi (Direction, 10/2026) : la fiche se remplit — ou la
 * contre-proposition se lit — sur la mission ; décliner (motif) reste possible d'ici (`repondreMission`).
 */
function LigneInvitationMission({ invitation: m }: { invitation: InvitationMissionDTO }) {
  const { ferme, err, run } = useGeste();
  const [refus, setRefus] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const sousTitre = [
    MISSION_ROLE[m.role]?.label ?? m.role, periodeMission(m.dateDepart, m.dateRetour), m.ville,
    m.organiserName ? `par ${m.organiserName}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="bg-warning/5 px-4 py-3 last:rounded-b-[var(--radius)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <span className="block break-words font-medium">
            <span className={cn("mr-2 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium", TON_PILL.info)}>{m.attente === "FICHE" ? "Demande de participation" : "Contre-proposition"}</span>
            <Link href={m.parentPath} className="hover:underline">{m.parentLabel}</Link>
          </span>
          <span className="block text-xs text-muted-foreground">{sousTitre}</span>
        </div>
        {!refus && (
          <div className="flex shrink-0 gap-2">
            <Link href={lienMission(m.id)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-success hover:bg-secondary sm:h-8">
              <Check className="h-3.5 w-3.5" /> {m.attente === "FICHE" ? "Remplir ma fiche" : "Répondre"}
            </Link>
            <Button size="sm" variant="outline" className="text-destructive" disabled={ferme} onClick={() => setRefus(true)}>
              <X className="h-3.5 w-3.5" /> Je décline
            </Button>
          </div>
        )}
      </div>
      {refus && (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => { e.preventDefault(); void run(() => repondreMission(fd({ id: m.id, decision: "DECLINER", motif: motif.trim() }))); }}
        >
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} required placeholder="Pourquoi ? (garde, congé, autre mission…)" aria-label="Motif du refus" className="h-9 sm:max-w-sm" autoFocus />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={ferme || !motif.trim()}>Confirmer le refus</Button>
            <Button type="button" size="sm" variant="ghost" disabled={ferme} onClick={() => setRefus(false)}>Annuler</Button>
          </div>
        </form>
      )}
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </li>
  );
}

/** L'ordre de mission d'un membre de mon équipe, à valider comme N+1 — même geste que « Mes missions » (`deciderOrdreMissionN1`). */
function LigneOrdreMissionN1({ ordre: o }: { ordre: OrdreAValiderDTO }) {
  const { ferme, busy, err, run } = useGeste();
  const [refus, setRefus] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const sousTitre = [periodeMission(o.dates.depart, o.dates.retour), o.destination, o.montant != null ? `${o.montant.toLocaleString("fr-FR")} DZD` : null].filter(Boolean).join(" · ");
  return (
    <li className="bg-warning/5 px-4 py-3 last:rounded-b-[var(--radius)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <span className="block break-words font-medium">
            <span className={cn("mr-2 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium", TON_PILL.info)}>{o.nature === "NF" ? "Note de frais de mission à valider" : "Ordre de mission à valider"}</span>
            {o.employeeName} — {o.missionId && o.nature === "NF" ? <Link href={lienMission(o.missionId, "frais")} className="hover:underline">{o.mission}</Link> : o.mission}
          </span>
          <span className="block text-xs text-muted-foreground">{sousTitre}</span>
        </div>
        {!refus && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="text-success" disabled={ferme}
              onClick={() => run(() => deciderOrdreMissionN1(fd({ requestId: o.requestId, decision: "VALIDER" })))}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Valider
            </Button>
            <Button size="sm" variant="outline" className="text-destructive" disabled={ferme} onClick={() => setRefus(true)}>
              <X className="h-3.5 w-3.5" /> Refuser
            </Button>
          </div>
        )}
      </div>
      {refus && (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => { e.preventDefault(); void run(() => deciderOrdreMissionN1(fd({ requestId: o.requestId, decision: "REFUSER", motif: motif.trim() }))); }}
        >
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} required placeholder="Motif du refus" aria-label="Motif du refus" className="h-9 sm:max-w-sm" autoFocus />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={ferme || !motif.trim()}>Confirmer le refus</Button>
            <Button type="button" size="sm" variant="ghost" disabled={ferme} onClick={() => setRefus(false)}>Annuler</Button>
          </div>
        </form>
      )}
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </li>
  );
}

function LigneAAccepter({ l, ouvrir }: { l: LigneTache; ouvrir: (id: string) => void }) {
  const { ferme, busy, err, run } = useGeste();
  const [refus, setRefus] = React.useState(false);
  const [motif, setMotif] = React.useState("");
  const sousTitre = [`de ${l.deNom ?? l.de}`, l.echeance ? `pour ${l.echeanceTexte}` : null, l.ou?.libelle ?? null].filter(Boolean).join(" · ");
  return (
    <li className="bg-warning/5 px-4 py-3 last:rounded-b-[var(--radius)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" onClick={() => ouvrir(l.id)} className="min-w-0 text-left">
          <span className="block break-words font-medium hover:underline">{l.titre}</span>
          <span className={cn("block text-xs text-muted-foreground", l.echeanceTon === "retard" && "text-destructive")}>{sousTitre}</span>
        </button>
        {!refus && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="text-success" disabled={ferme}
              onClick={() => run(() => respondTaskRequest(fd({ id: l.id, accept: "1" })))}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Accepter
            </Button>
            <Button size="sm" variant="outline" className="text-destructive" disabled={ferme} onClick={() => setRefus(true)}>
              <X className="h-3.5 w-3.5" /> Refuser
            </Button>
          </div>
        )}
      </div>
      {refus && (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => { e.preventDefault(); void run(() => respondTaskRequest(fd({ id: l.id, accept: "0", reason: motif.trim() }))); }}
        >
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (facultatif)" aria-label="Motif du refus" className="h-9 sm:max-w-sm" autoFocus />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={ferme}>Confirmer le refus</Button>
            <Button type="button" size="sm" variant="ghost" disabled={ferme} onClick={() => setRefus(false)}>Annuler</Button>
          </div>
        </form>
      )}
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </li>
  );
}

// ─── Créer en une ligne ────────────────────────────────────────────────────────────────────

function BarreCreation({ personnes, champsComplets }: { personnes: Donnees["personnes"]; champsComplets: FieldDef[] }) {
  const [titre, setTitre] = React.useState("");
  const [demander, setDemander] = React.useState(false);
  const [complet, setComplet] = React.useState(false);
  const { ferme, err, run } = useGeste();

  const pourMoi = () => {
    const t = titre.trim();
    if (!t) return;
    void run(() => createTask(undefined, fd({ title: t })), () => setTitre(""));
  };

  return (
    <div className="border-b border-border px-3 py-3 sm:px-4">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); pourMoi(); }}>
        <Input
          value={titre} onChange={(e) => setTitre(e.target.value)} aria-label="Nouvelle tâche"
          placeholder="Nouvelle tâche… (ex. « Appeler le CHU Oran vendredi »)" className="min-w-[14rem] flex-1"
        />
        <Button type="submit" variant="outline" disabled={ferme || !titre.trim()}>Pour moi</Button>
        <Button type="button" disabled={ferme} onClick={() => setDemander(true)}><Send className="h-4 w-4" /> Demander à…</Button>
        <Button type="button" variant="ghost" size="icon" aria-label="Formulaire complet (participants, pièces, lieu…)" title="Formulaire complet"
          onClick={() => setComplet(true)}>
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </form>
      {err && <p className="mt-1.5 text-xs text-destructive">{err}</p>}

      <DemanderA ouvert={demander} fermer={() => setDemander(false)} titreInitial={titre} personnes={personnes} apres={() => setTitre("")} />

      <Sheet open={complet} onClose={() => setComplet(false)} title="Nouvelle tâche" width="md"
        description="Pour vous : une to-do. Pour quelqu'un d'autre : une demande, qu'il accepte ou refuse.">
        {complet && <RecordForm fields={champsComplets} action={createTask} onDone={() => setComplet(false)} onCancel={() => setComplet(false)} />}
      </Sheet>
    </div>
  );
}

function DemanderA({ ouvert, fermer, titreInitial, personnes, apres }: {
  ouvert: boolean; fermer: () => void; titreInitial: string; personnes: Donnees["personnes"]; apres: () => void;
}) {
  const { ferme, err, setErr, run } = useGeste();
  const [titre, setTitre] = React.useState(titreInitial);
  React.useEffect(() => { if (ouvert) { setTitre(titreInitial); setErr(null); } }, [ouvert, titreInitial, setErr]);

  return (
    <Sheet open={ouvert} onClose={fermer} title="Demander à…" width="md">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(() => createTask(undefined, f), () => { apres(); fermer(); });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="demande-titre">Tâche</Label>
          <Input id="demande-titre" name="title" required value={titre} onChange={(e) => setTitre(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demande-personne">Personne</Label>
          <Select id="demande-personne" name="assignedToId" required defaultValue="">
            <option value="" disabled>Choisir…</option>
            {personnes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demande-echeance">Pour le</Label>
          <Input id="demande-echeance" name="dueDate" type="date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="demande-description">Description (facultatif)</Label>
          <Textarea id="demande-description" name="description" rows={3} />
        </div>
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={fermer} disabled={ferme}>Annuler</Button>
          <Button type="submit" disabled={ferme}>{ferme ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer la demande</Button>
        </div>
      </form>
    </Sheet>
  );
}

// ─── Vues ──────────────────────────────────────────────────────────────────────────────────

function Vues({ vue, compteurs }: { vue: VueTaches; compteurs: Donnees["compteurs"] }) {
  const n: Record<VueTaches, number | null> = {
    "a-faire": compteurs.aFaire, demandees: compteurs.demandees, partagees: compteurs.partagees, terminees: null,
  };
  return (
    <nav aria-label="Vue" className="no-scrollbar -mx-1 flex max-w-full overflow-x-auto px-1">
      <div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
        {VUES_TACHES.map((v) => (
          <Link
            key={v.cle}
            href={v.cle === "a-faire" ? ONGLET_TACHES_HREF : `${ONGLET_TACHES_HREF}?vue=${v.cle}`}
            aria-current={vue === v.cle ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              vue === v.cle ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.libelle}{n[v.cle] !== null ? ` · ${n[v.cle]}` : ""}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function Pagination({ page, pages, total }: { page: number; pages: number; total: number }) {
  const lien = (p: number) => `${ONGLET_TACHES_HREF}?vue=terminees${p > 1 ? `&page=${p}` : ""}`;
  const cls = "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border";
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
      <span>{total} tâche{total > 1 ? "s" : ""}</span>
      <div className="flex items-center gap-2">
        {page > 1 ? <Link href={lien(page - 1)} aria-label="Page précédente" className={cn(cls, "hover:bg-secondary")}><ChevronLeft className="h-4 w-4" /></Link>
          : <span aria-hidden className={cn(cls, "opacity-40")}><ChevronLeft className="h-4 w-4" /></span>}
        <span className="tabular-nums">{page} / {pages}</span>
        {page < pages ? <Link href={lien(page + 1)} aria-label="Page suivante" className={cn(cls, "hover:bg-secondary")}><ChevronRight className="h-4 w-4" /></Link>
          : <span aria-hidden className={cn(cls, "opacity-40")}><ChevronRight className="h-4 w-4" /></span>}
      </div>
    </div>
  );
}

// ─── Tableaux ──────────────────────────────────────────────────────────────────────────────

const STICKY = "sticky left-0 z-[1] bg-card";
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function Vide({ vue }: { vue: VueTaches }) {
  const texte: Record<VueTaches, string> = {
    "a-faire": "Rien à faire — tout est à jour.",
    demandees: "Vous n'attendez rien des autres.",
    partagees: "Aucune tâche partagée avec vous.",
    terminees: "Aucune tâche terminée ces 30 derniers jours.",
  };
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{texte[vue]}</p>;
}

function Titre({ l, ouvrir }: { l: LigneTache; ouvrir: (id: string) => void }) {
  return (
    <button type="button" onClick={(e) => { stop(e); ouvrir(l.id); }} className="block max-w-[22rem] text-left sm:max-w-[28rem]">
      <span className={cn("block truncate font-medium hover:underline", l.status === "DONE" && "text-muted-foreground line-through decoration-muted-foreground/50")}>{l.titre}</span>
      {l.contexte && <span className="block truncate text-xs text-muted-foreground">{l.contexte}</span>}
    </button>
  );
}

function Echeance({ l }: { l: LigneTache }) {
  return (
    <span className={cn("whitespace-nowrap", l.echeanceTon === "retard" ? "font-medium text-destructive" : l.echeanceTon === "aujourdhui" ? "font-medium text-warning" : l.echeance ? "" : "text-muted-foreground")}
      title={l.echeance ? formatDate(l.echeance) : undefined}>
      {l.echeanceTexte}
    </span>
  );
}

function Ou({ l }: { l: LigneTache }) {
  if (!l.ou) return <span className="text-muted-foreground">—</span>;
  const pill = "inline-flex max-w-[12rem] items-center truncate rounded-full px-2 py-0.5 text-xs font-medium";
  return l.ou.href
    ? <Link href={l.ou.href} onClick={stop} className={cn(pill, "bg-primary/10 text-primary hover:underline")}>{l.ou.libelle}</Link>
    : <span className={cn(pill, "bg-muted text-muted-foreground")}>{l.ou.libelle}</span>;
}

/** La case : terminer (ou rouvrir) — seulement pour qui fait le travail (`canDoWork`). */
function Coche({ l }: { l: LigneTache }) {
  const { ferme, err, run } = useGeste();
  const fait = l.status === "DONE";
  const actif = fait ? l.peutRouvrir : l.peutCocher;
  const basculer = () => run(() =>
    fait
      ? reopenTaskWork(fd({ id: l.id }))
      // Une DEMANDE se termine en rendant le travail (le demandeur est prévenu) ; une to-do, d'un statut.
      : l.estDemande ? submitTaskWork(fd({ id: l.id })) : updateTaskStatus(fd({ id: l.id, status: "DONE" })),
  );
  return (
    <span onClick={stop} className="inline-flex" title={err ?? undefined}>
      <button
        type="button" role="checkbox" aria-checked={fait} disabled={!actif || ferme}
        aria-label={fait ? `Rouvrir « ${l.titre} »` : `Terminer « ${l.titre} »`}
        onClick={() => void basculer()}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-[5px] border-2 transition-colors",
          fait ? "border-success bg-success text-white" : "border-border hover:border-primary",
          !actif && "cursor-not-allowed opacity-40", err && "border-destructive",
        )}
      >
        {ferme ? <Loader2 className="h-3 w-3 animate-spin" /> : fait ? <Check className="h-3 w-3" /> : null}
      </button>
    </span>
  );
}

function TableTaches({ lignes, vue, ouvrir }: { lignes: LigneTache[]; vue: VueTaches; ouvrir: (id: string) => void }) {
  if (lignes.length === 0) return <Vide vue={vue} />;
  const terminees = vue === "terminees";
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-10"><span className="sr-only">Fait</span></TableHead>
          <TableHead className={STICKY}>Tâche</TableHead>
          <TableHead>De</TableHead>
          <TableHead>{terminees ? "Terminée" : "Échéance"}</TableHead>
          <TableHead>Où</TableHead>
          <TableHead className="text-center"><MessageSquare className="mx-auto h-3.5 w-3.5" aria-label="Échanges" /></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lignes.map((l) => (
          <TableRow key={l.id} className="group cursor-pointer" onClick={() => ouvrir(l.id)}>
            <TableCell className="w-10"><Coche l={l} /></TableCell>
            <TableCell className={cn(STICKY, "group-hover:bg-secondary")}><Titre l={l} ouvrir={ouvrir} /></TableCell>
            <TableCell className={cn("whitespace-nowrap", (l.de === "moi" || l.de === "Automatique") && "text-muted-foreground")} title={l.deNom ?? undefined}>{l.de}</TableCell>
            <TableCell>{terminees ? <span className="whitespace-nowrap text-muted-foreground">{l.termineeLe ? formatDate(l.termineeLe, { day: "numeric", month: "short" }) : "—"}</span> : <Echeance l={l} />}</TableCell>
            <TableCell><Ou l={l} /></TableCell>
            <TableCell className={cn("text-center tabular-nums", !l.commentaires && "text-muted-foreground")}>{l.commentaires || "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TableDemandees({ lignes, personnes, ouvrir }: { lignes: LigneTache[]; personnes: Donnees["personnes"]; ouvrir: (id: string) => void }) {
  if (lignes.length === 0) return <Vide vue="demandees" />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={STICKY}>Tâche</TableHead>
          <TableHead>À</TableHead>
          <TableHead>État</TableHead>
          <TableHead>Échéance</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lignes.map((l) => (
          <TableRow key={l.id} className="group cursor-pointer" onClick={() => ouvrir(l.id)}>
            <TableCell className={cn(STICKY, "group-hover:bg-secondary")}>
              <button type="button" onClick={(e) => { stop(e); ouvrir(l.id); }} className="block max-w-[22rem] truncate text-left font-medium hover:underline sm:max-w-[28rem]">{l.titre}</button>
            </TableCell>
            <TableCell className="whitespace-nowrap" title={l.aNom ?? undefined}>{l.a}</TableCell>
            <TableCell>
              <span className={cn("inline-block max-w-[18rem] truncate whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium align-middle", TON_PILL[l.etat.ton])} title={l.etat.libelle}>
                {l.etat.libelle}
              </span>
            </TableCell>
            <TableCell><Echeance l={l} /></TableCell>
            <TableCell onClick={stop}>
              <div className="flex items-center justify-end gap-1.5">
                <GesteDemande l={l} personnes={personnes} ouvrir={ouvrir} />
                <MenuPlus l={l} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** LE seul geste utile d'une demande : Relancer, Vérifier ou Réattribuer. */
function GesteDemande({ l, personnes, ouvrir }: { l: LigneTache; personnes: Donnees["personnes"]; ouvrir: (id: string) => void }) {
  const [reattribuer, setReattribuer] = React.useState(false);
  if (l.etat.geste === "verifier") {
    return <Button size="sm" onClick={() => ouvrir(l.id)}>Vérifier</Button>;
  }
  if (l.etat.geste === "reattribuer" && l.peutReattribuer) {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setReattribuer(true)}>Réattribuer</Button>
        <Reattribuer l={l} personnes={personnes} ouvert={reattribuer} fermer={() => setReattribuer(false)} />
      </>
    );
  }
  if (l.etat.geste === "relancer" && l.relance) return <Relancer l={l} />;
  return null;
}

function Relancer({ l, compact = true }: { l: LigneTache; compact?: boolean }) {
  const { ferme, err, run } = useGeste();
  const r = l.relance!;
  return (
    <span className="inline-flex flex-col items-end">
      <Button size="sm" variant="outline" disabled={ferme} title={r.ok ? "La personne reçoit une alerte ; la relance s'inscrit dans le fil." : r.raison ?? undefined}
        onClick={() => void run(() => relanceTaskRequest(fd({ id: l.id })))}>
        {ferme ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
        {r.rang > 0 ? `Relancer (${r.rang})` : "Relancer"}
      </Button>
      {err && <span className={cn("mt-1 text-xs text-destructive", compact && "max-w-[14rem] whitespace-normal text-right")}>{err}</span>}
    </span>
  );
}

function Reattribuer({ l, personnes, ouvert, fermer }: { l: LigneTache; personnes: Donnees["personnes"]; ouvert: boolean; fermer: () => void }) {
  return (
    <Sheet open={ouvert} onClose={fermer} title="Réattribuer la demande" description={l.titre} width="md">
      {ouvert && <FormReattribuer l={l} personnes={personnes} apres={fermer} annuler={fermer} />}
    </Sheet>
  );
}

function FormReattribuer({ l, personnes, apres, annuler }: { l: LigneTache; personnes: Donnees["personnes"]; apres: () => void; annuler?: () => void }) {
  const { ferme, err, run } = useGeste();
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget); f.set("id", l.id);
      void run(() => reattribuerDemandeTache(f), apres);
    }}>
      <div className="space-y-1.5">
        <Label htmlFor={`reattribuer-${l.id}`}>Nouvelle personne</Label>
        <Select id={`reattribuer-${l.id}`} name="assignedToId" required defaultValue="">
          <option value="" disabled>Choisir…</option>
          {personnes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {annuler && <Button type="button" variant="outline" onClick={annuler} disabled={ferme}>Annuler</Button>}
        <Button type="submit" disabled={ferme}>{ferme ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer la demande</Button>
      </div>
    </form>
  );
}

/** Les gestes rares — annuler sa demande (motif facultatif), supprimer — confirmés d'un second clic. */
function GestesRares({ l, apres }: { l: LigneTache; apres?: () => void }) {
  const { ferme, err, run } = useGeste();
  const [motif, setMotif] = React.useState("");
  return (
    <div className="flex flex-col gap-2">
      {l.peutAnnuler && (
        <>
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (facultatif)" aria-label="Motif de l'annulation" className="h-9" />
          <BoutonDecisif brut type="button" disabled={ferme} confirmation="Annuler la demande"
            onClick={() => void run(() => annulerDemandeTache(fd({ id: l.id, motif: motif.trim() })), apres)}
            className="w-full rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10 disabled:opacity-50">
            Annuler la demande
          </BoutonDecisif>
        </>
      )}
      {l.peutSupprimer && (
        <BoutonDecisif brut type="button" disabled={ferme} confirmation="Supprimer la tâche"
          onClick={() => void run(() => deleteTask(fd({ id: l.id })), apres)}
          className="w-full rounded-md px-2 py-1.5 text-left text-destructive hover:bg-destructive/10 disabled:opacity-50">
          Supprimer la tâche
        </BoutonDecisif>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

/**
 * « ⋯ » — les gestes rares d'une ligne. Menu en position FIXE : dans un tableau qui défile, un menu absolu
 * serait coupé par le bord du tableau.
 */
function MenuPlus({ l }: { l: LigneTache }) {
  const [pos, setPos] = React.useState<{ top: number; right: number } | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const bouton = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!pos) return;
    const ailleurs = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node) && !bouton.current?.contains(e.target as Node)) setPos(null);
    };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setPos(null); };
    const bouge = () => setPos(null);
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    document.addEventListener("keydown", echap);
    window.addEventListener("resize", bouge);
    window.addEventListener("scroll", bouge, true);
    return () => {
      document.removeEventListener("mousedown", ailleurs);
      document.removeEventListener("touchstart", ailleurs);
      document.removeEventListener("keydown", echap);
      window.removeEventListener("resize", bouge);
      window.removeEventListener("scroll", bouge, true);
    };
  }, [pos]);

  if (!l.peutAnnuler && !l.peutSupprimer) return <span className="inline-block w-8" aria-hidden />;
  return (
    <>
      <button
        ref={bouton} type="button" aria-haspopup="menu" aria-expanded={Boolean(pos)} aria-label="Autres actions"
        onClick={() => {
          if (pos) { setPos(null); return; }
          const r = bouton.current!.getBoundingClientRect();
          setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
        }}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-8 sm:w-8"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {pos && (
        <div ref={ref} role="menu" style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-background p-2.5 text-sm shadow-lg">
          <GestesRares l={l} apres={() => setPos(null)} />
        </div>
      )}
    </>
  );
}

// ─── Le panneau ────────────────────────────────────────────────────────────────────────────

function PanneauTache({ ligne: l, detail, personnes, fermer }: {
  ligne: LigneTache | null;
  detail: Donnees["details"][string] | null;
  personnes: Donnees["personnes"];
  fermer: () => void;
}) {
  return (
    <Sheet open={Boolean(l)} onClose={fermer} title={l?.titre ?? ""} description={l?.etatChezQui} width="lg">
      {l && detail && <ContenuPanneau l={l} detail={detail} personnes={personnes} />}
    </Sheet>
  );
}

function ContenuPanneau({ l, detail, personnes }: { l: LigneTache; detail: Donnees["details"][string]; personnes: Donnees["personnes"] }) {
  const { ferme, err, run } = useGeste();
  const [reattribuer, setReattribuer] = React.useState(false);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Champ libelle="De">{l.deNom ?? l.de}</Champ>
        <Champ libelle="Chez">{l.aNom ?? l.a}</Champ>
        <Champ libelle="Échéance">{l.echeance ? <Echeance l={l} /> : "—"}</Champ>
        <Champ libelle="Où"><Ou l={l} /></Champ>
      </dl>
      {l.description && <p className="whitespace-pre-wrap break-words text-sm">{l.description}</p>}
      {l.adresse && (
        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.adresse)}`} target="_blank" rel="noopener noreferrer"
          className="inline-flex max-w-full items-start gap-1 text-sm font-medium text-primary [overflow-wrap:anywhere] hover:underline">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l.adresse}
        </a>
      )}
      {l.cercle && <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Users className="mt-px h-3.5 w-3.5 shrink-0" /> {l.cercle}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {l.peutDemarrer && (l.adresse
          ? <Button size="sm" variant="outline" disabled={ferme} onClick={() => void run(() => startTask(fd({ id: l.id })))}><Navigation className="h-3.5 w-3.5" /> Partir</Button>
          : <Button size="sm" variant="outline" disabled={ferme} onClick={() => void run(() => updateTaskStatus(fd({ id: l.id, status: "IN_PROGRESS" })))}><Play className="h-3.5 w-3.5" /> Démarrer</Button>)}
        {l.relance && <Relancer l={l} compact={false} />}
        {l.peutReattribuer && !reattribuer && (
          <Button size="sm" variant="outline" onClick={() => setReattribuer(true)}>Réattribuer</Button>
        )}
        <Link href={`/mon-espace/taches/${l.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          Ouvrir la fiche <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {/* Pas de panneau dans le panneau : la réattribution et les gestes rares s'ouvrent SUR PLACE. */}
      {l.peutReattribuer && reattribuer && (
        <Card className="p-4">
          <FormReattribuer l={l} personnes={personnes} apres={() => setReattribuer(false)} annuler={() => setReattribuer(false)} />
        </Card>
      )}

      <TaskWorkPanel id={l.id} status={l.status} note={l.compteRendu} canRespond={l.peutRepondre} canWork={l.peutTravailler} />

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Pièces <span className="font-normal text-muted-foreground">({detail.pieces.length})</span></h3>
        {l.peutJoindre && (
          <DocumentUpload entityType="TASK" entityId={l.id} compact categories={["SUPPORTING_DOC", "QUOTE", "INVOICE", "PHOTO", "ID_DOCUMENT", "OTHER"]} />
        )}
        {detail.pieces.length > 0 && (
          <DocumentList documents={detail.pieces} canDelete={l.peutJoindre} canRename={l.peutJoindre} path={ONGLET_TACHES_HREF} />
        )}
      </Card>

      <TaskComments id={l.id} items={detail.fil} canWrite={l.peutCommenter} />

      {(l.peutAnnuler || l.peutSupprimer) && (
        <details className="rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" /> Autres actions
          </summary>
          <div className="px-4 pb-3"><GestesRares l={l} /></div>
        </details>
      )}
    </div>
  );
}

function Champ({ libelle, children }: { libelle: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{libelle}</dt>
      <dd className="break-words font-medium">{children}</dd>
    </div>
  );
}
