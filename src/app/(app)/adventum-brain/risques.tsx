"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, MoreHorizontal, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";
import { agirSurRisque } from "@/lib/actions/adventum-actions";
import { HISTORY_LABEL, libelleEtat, type BrainStatus } from "@/lib/adventum/lifecycle-rules";
import type { LigneRisque } from "@/lib/adventum/brain-read";
import type { AutopilotPayload } from "@/lib/adventum/risks";

type Personne = { id: string; name: string };
type Geste = "prendre" | "relancer" | "ignorer" | "resoudre";

const NIVEAU: Record<string, { label: string; dot: string }> = {
  critical: { label: "Critique", dot: "bg-destructive" },
  high: { label: "Élevé", dot: "bg-warning" },
  medium: { label: "Moyen", dot: "bg-amber-400" },
  low: { label: "Faible", dot: "bg-muted-foreground/60" },
};
const PILL: Record<BrainStatus, string> = {
  NOUVEAU: "bg-destructive/10 text-destructive",
  PRIS_EN_CHARGE: "bg-accent text-accent-foreground",
  IGNORE: "bg-secondary text-muted-foreground",
  RESOLU: "bg-success/10 text-success",
};

const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" });

export function Point({ level }: { level: string }) {
  const n = NIVEAU[level] ?? NIVEAU.low;
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", n.dot)} title={n.label} aria-label={n.label} />;
}

export function EtatPill({ r }: { r: Pick<LigneRisque, "status" | "snoozedUntil" | "taskId"> }) {
  return <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", PILL[r.status])}>{libelleEtat(r)}</span>;
}

/** Le geste recommandé : le premier que le détecteur propose. */
function gesteRecommande(r: LigneRisque): { geste: Geste; label: string; payload: AutopilotPayload | null } {
  const p = r.actions.find((a) => a.payload)?.payload ?? null;
  if (p?.kind === "task") return { geste: "prendre", label: "Créer", payload: p };
  if (p?.kind === "notify") return { geste: "relancer", label: "Relancer", payload: p };
  return { geste: "prendre", label: "Prendre en charge", payload: null };
}

// ───────────────────────────── Dialogue d'un geste ─────────────────────────────

function DialogueGeste({ risque, geste, personnes, onClose }: { risque: LigneRisque; geste: Geste; personnes: Personne[]; onClose: () => void }) {
  const { enCours, rafraichir } = useRafraichir();
  const [envoi, setEnvoi] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const tache = risque.actions.find((a) => a.payload?.kind === "task")?.payload;
  const relance = risque.actions.find((a) => a.payload?.kind === "notify")?.payload;
  const assigneParDefaut = tache?.kind === "task" ? tache.assigneeId ?? "" : "";
  const demain = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const titre = geste === "prendre" ? "Prendre en charge" : geste === "relancer" ? "Relancer" : geste === "ignorer" ? "Ignorer jusqu'à…" : "Marquer résolu";

  const soumettre = async (fd: FormData) => {
    setEnvoi(true); setErr(null);
    try {
      const r = await agirSurRisque(fd);
      if (r.ok) { onClose(); rafraichir(); } else setErr(r.error ?? "Geste impossible.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title={titre} description={`${risque.title} · ${risque.object}`}>
      <form action={soumettre} className="space-y-4 text-sm">
        <input type="hidden" name="riskId" value={risque.id} />
        <input type="hidden" name="geste" value={geste} />
        {geste === "prendre" && (
          <>
            <p className="rounded-lg bg-secondary/60 p-3">Tâche : {tache?.kind === "task" ? tache.title : `${risque.title} — ${risque.object}`}</p>
            <div className="space-y-1">
              <Label htmlFor="assigneeId">Pour</Label>
              <Select id="assigneeId" name="assigneeId" defaultValue={assigneParDefaut}>
                <option value="">Moi</option>
                {personnes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>
          </>
        )}
        {geste === "relancer" && (
          <p className="rounded-lg bg-secondary/60 p-3">
            {relance?.kind === "notify" ? <>Notification : {relance.title}<br /><span className="text-muted-foreground">{relance.body}</span></> : risque.assigneeName ? `Notification à ${risque.assigneeName}` : "Aucune personne désignée."}
          </p>
        )}
        {geste === "ignorer" && (
          <>
            <div className="space-y-1">
              <Label htmlFor="jusquau">Jusqu&apos;au</Label>
              <Input id="jusquau" name="jusquau" type="date" min={demain} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="motif">Motif</Label>
              <Textarea id="motif" name="motif" rows={2} required />
            </div>
          </>
        )}
        {geste === "resoudre" && (
          <div className="space-y-1">
            <Label htmlFor="motif">Note (facultatif)</Label>
            <Textarea id="motif" name="motif" rows={2} />
          </div>
        )}
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={envoi || enCours}>{envoi && <Loader2 className="h-4 w-4 animate-spin" />}Confirmer</Button>
        </div>
      </form>
    </Sheet>
  );
}

/** Le menu ⋯ d'un risque : les gestes secondaires. */
function MenuGestes({ risque, onGeste, sauf }: { risque: LigneRisque; onGeste: (g: Geste) => void; sauf?: Geste }) {
  const [ouvert, setOuvert] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ouvert) return;
    const ailleurs = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOuvert(false); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("touchstart", ailleurs);
    return () => { document.removeEventListener("mousedown", ailleurs); document.removeEventListener("touchstart", ailleurs); };
  }, [ouvert]);
  const items: { g: Geste; label: string }[] = [
    { g: "prendre", label: "Assigner (tâche)" },
    { g: "relancer", label: "Relancer" },
    { g: "ignorer", label: "Ignorer jusqu'à…" },
    { g: "resoudre", label: "Marquer résolu" },
  ];
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOuvert((o) => !o); }} aria-label="Autres gestes" aria-expanded={ouvert}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-secondary sm:h-8 sm:w-8">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {ouvert && (
        <div role="menu" className="absolute right-0 z-40 mt-1 flex w-52 flex-col rounded-lg border border-border bg-background p-1.5 shadow-lg">
          {items.filter((i) => i.g !== sauf && !(risque.status === "RESOLU" && (i.g === "resoudre" || i.g === "ignorer"))).map((i) => (
            <button key={i.g} type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setOuvert(false); onGeste(i.g); }} className="rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary">{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── « À décider » ─────────────────────────────

export function ADecider({ risques, personnes }: { risques: LigneRisque[]; personnes: Personne[] }) {
  const [dialogue, setDialogue] = React.useState<{ r: LigneRisque; g: Geste } | null>(null);
  if (risques.length === 0) return <p className="px-4 py-6 text-sm text-muted-foreground">Rien à décider ce matin.</p>;
  return (
    <ul className="divide-y divide-border">
      {risques.map((r) => {
        const reco = gesteRecommande(r);
        return (
          <li key={r.id} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-1.5"><Point level={r.level} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{r.title}</p>
              <p className="text-xs text-muted-foreground">{r.object}{r.ageDays ? ` · ${r.ageDays} j` : ""} · chez {r.owner}</p>
              <p className="mt-0.5 text-xs text-primary">→ {r.recommendation}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" onClick={() => setDialogue({ r, g: reco.geste })}>{reco.label}</Button>
              <MenuGestes risque={r} onGeste={(g) => setDialogue({ r, g })} />
            </div>
          </li>
        );
      })}
      {dialogue && <DialogueGeste risque={dialogue.r} geste={dialogue.g} personnes={personnes} onClose={() => setDialogue(null)} />}
    </ul>
  );
}

// ───────────────────────────── « Risques » ─────────────────────────────

const ETATS: { v: string; label: string }[] = [
  { v: "ouverts", label: "Ouverts" },
  { v: "NOUVEAU", label: "Nouveaux" },
  { v: "PRIS_EN_CHARGE", label: "Pris en charge" },
  { v: "IGNORE", label: "Ignorés" },
  { v: "RESOLU", label: "Résolus (14 j)" },
];

export function RisquesTable({ risques, personnes }: { risques: LigneRisque[]; personnes: Personne[] }) {
  const [etat, setEtat] = React.useState("ouverts");
  const [module, setModule] = React.useState("");
  const [niveau, setNiveau] = React.useState("");
  const [choisi, setChoisi] = React.useState<LigneRisque | null>(null);
  const [dialogue, setDialogue] = React.useState<{ r: LigneRisque; g: Geste } | null>(null);
  const modules = [...new Set(risques.map((r) => r.module))].sort((a, b) => a.localeCompare(b, "fr"));
  const rang: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const liste = risques
    .filter((r) => (etat === "ouverts" ? r.status !== "RESOLU" : r.status === etat))
    .filter((r) => !module || r.module === module)
    .filter((r) => !niveau || r.level === niveau)
    .sort((a, b) => (rang[a.level] ?? 9) - (rang[b.level] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return (
    <div className="surface overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Select aria-label="État" value={etat} onChange={(e) => setEtat(e.target.value)} className="h-9 w-auto">
          {ETATS.map((e) => <option key={e.v} value={e.v}>{e.label}</option>)}
        </Select>
        <Select aria-label="Module" value={module} onChange={(e) => setModule(e.target.value)} className="h-9 w-auto max-w-[14rem]">
          <option value="">Tous les modules</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
        <Select aria-label="Niveau" value={niveau} onChange={(e) => setNiveau(e.target.value)} className="h-9 w-auto">
          <option value="">Tous les niveaux</option>
          {Object.entries(NIVEAU).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{liste.length} risque{liste.length > 1 ? "s" : ""}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-muted/90">Risque</TableHead>
            <TableHead>Module</TableHead>
            <TableHead>Chez qui</TableHead>
            <TableHead className="text-right">Âge</TableHead>
            <TableHead>État</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {liste.map((r) => (
            <TableRow key={r.id} className="cursor-pointer" onClick={() => setChoisi(r)}>
              <TableCell className="sticky left-0 z-10 bg-card">
                <span className="flex min-w-[14rem] items-center gap-2"><Point level={r.level} /><span className="font-medium">{r.title}</span></span>
                <span className="block pl-[1.125rem] text-xs text-muted-foreground">{r.object}</span>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{r.module}</TableCell>
              <TableCell className="whitespace-nowrap">{r.assigneeName ?? r.owner}</TableCell>
              <TableCell className="text-right tabular-nums">{r.ageDays !== null ? `${r.ageDays} j` : "—"}</TableCell>
              <TableCell><EtatPill r={r} /></TableCell>
            </TableRow>
          ))}
          {liste.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">Aucun risque.</TableCell></TableRow>}
        </TableBody>
      </Table>
      {choisi && !dialogue && (
        <PanneauRisque r={choisi} onClose={() => setChoisi(null)} onGeste={(g) => setDialogue({ r: choisi, g })} />
      )}
      {dialogue && <DialogueGeste risque={dialogue.r} geste={dialogue.g} personnes={personnes} onClose={() => { setDialogue(null); setChoisi(null); }} />}
    </div>
  );
}

function PanneauRisque({ r, onClose, onGeste }: { r: LigneRisque; onClose: () => void; onGeste: (g: Geste) => void }) {
  const reco = gesteRecommande(r);
  return (
    <Sheet
      open onClose={onClose} title={r.title} description={`${r.module} · ${r.object}`}
      footer={r.status !== "RESOLU" ? (
        <div className="flex items-center justify-end gap-2">
          {r.href && <Link href={r.href} className="mr-auto inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ExternalLink className="h-4 w-4" />Ouvrir le dossier</Link>}
          <MenuGestes risque={r} onGeste={onGeste} sauf={reco.geste} />
          <Button onClick={() => onGeste(reco.geste)}>{reco.label}</Button>
        </div>
      ) : r.href ? <Link href={r.href} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"><ExternalLink className="h-4 w-4" />Ouvrir le dossier</Link> : undefined}
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Point level={r.level} /><span className="text-muted-foreground">{NIVEAU[r.level]?.label}</span>
          <EtatPill r={r} />
          <span className="text-muted-foreground">· chez {r.assigneeName ?? r.owner}</span>
        </div>
        {r.probableCause && <section><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cause</h3><p className="mt-1">{r.probableCause}</p></section>}
        {r.evidence.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preuves</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{r.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </section>
        )}
        <section className="rounded-lg bg-primary/5 p-3">
          <h3 className="text-xs font-semibold text-primary">Recommandation</h3>
          <p className="mt-0.5">{r.recommendation}</p>
          {r.impact && <p className="mt-1 text-xs text-muted-foreground">{r.impact}</p>}
        </section>
        {r.note && <p className="text-muted-foreground">Note : {r.note}</p>}
        <section>
          <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Histoire
            <InfoBulle>Un risque résolu revient s&apos;il réapparaît ; un risque ignoré revient à sa date s&apos;il est toujours là.</InfoBulle>
          </h3>
          <ol className="mt-1 space-y-1">
            {[...r.history].reverse().map((h, i) => (
              <li key={i} className="flex gap-2"><span className="w-16 shrink-0 tabular-nums text-muted-foreground">{jour(h.at)}</span><span>{HISTORY_LABEL[h.kind] ?? h.kind}{h.by ? ` — ${h.by}` : ""}{h.note ? ` · ${h.note}` : ""}</span></li>
            ))}
          </ol>
        </section>
      </div>
    </Sheet>
  );
}
