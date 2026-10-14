"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Undo2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BADGE_HISTORIQUE, LIBELLE_TYPE_DEMANDE, ORDRE_TYPES, formatCentimes } from "@/lib/budget-marketing/integration-2026";
import { annulerIntegrationAdPro, deciderAbsenteIntegration } from "@/lib/actions/integration-adpro-actions";
import type { VueLot } from "@/lib/budget-marketing/integration-serveur";
import { ChoixAbsente } from "./assistant-integration";
import { FicheDemandeSheet, type FicheOuverte } from "../fiche-demande";

const dzd = (n: number) => `${formatCentimes(Math.round(n * 100)) || "0"} DZD`;
const jour = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export type FiltreLot = "TOUT" | "MANQUANTES" | "COMPLETES";

/**
 * UN LOT VALIDÉ, SUIVI COMME UN CHANTIER (maquette « onglets » validée, 10/2026) : tuiles (demandes, payé intégré,
 * pièces jointes / attendues, absentes à décider), les demandes du lot filtrables (« pièces manquantes »), chacune
 * ouvrant sa fiche en panneau ; « Remplacées par le fichier » ; « Dans la plateforme, absentes du fichier » (garder /
 * sortir, à tout moment) ; l'annulation d'un bloc, REPLIÉE par défaut (motif + mot « ANNULER »).
 */
export function LotIntegre({ lot, enveloppe, filtreInitial = "TOUT" }: { lot: VueLot; enveloppe: string; filtreInitial?: FiltreLot }) {
  const router = useRouter();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [motif, setMotif] = React.useState("");
  const [mot, setMot] = React.useState("");
  const [annulerOuvert, setAnnulerOuvert] = React.useState(false);
  const [filtre, setFiltre] = React.useState<FiltreLot>(filtreInitial);
  const [fiche, setFiche] = React.useState<FicheOuverte | null>(null);

  async function decider(a: VueLot["absentes"][number], decision: "GARDER" | "SORTIR") {
    setOccupe(a.cle); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("lotId", lot.id); fd.set("cleSource", a.cle); fd.set("decision", decision);
      fd.set("libelle", `${a.reference} — ${a.libelle}`); fd.set("montant", String(a.montant));
      const r = await deciderAbsenteIntegration(fd);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Enregistré." : r.error ?? "Échec." });
      if (r.ok) router.refresh();
    } finally { setOccupe(null); }
  }

  async function annuler() {
    setOccupe("annuler"); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("lotId", lot.id); fd.set("motif", motif); fd.set("confirmation", mot);
      const r = await annulerIntegrationAdPro(fd);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Annulée." : r.error ?? "Échec." });
      if (r.ok) router.refresh();
    } finally { setOccupe(null); }
  }

  const attendues = lot.demandes.reduce((s, d) => s + d.attendues, 0);
  const manquantes = lot.demandes.reduce((s, d) => s + d.manquantes, 0);
  const creees = lot.demandes.filter((d) => d.mode === "CREEE").length;
  const nIncompletes = lot.demandes.filter((d) => d.manquantes > 0).length;
  const aDecider = lot.absentes.filter((a) => a.decision === null).length;
  const lignesFichier = lot.demandes.reduce((s, d) => s + Math.max(1, d.lignes.length), 0);
  const passe = (d: VueLot["demandes"][number]) => filtre === "TOUT" || (filtre === "MANQUANTES" ? d.manquantes > 0 : d.manquantes === 0);
  const ouvrir = (d: VueLot["demandes"][number]) => setFiche({
    cle: `${d.type}:${d.demandeId}`, libelle: d.libelle, nature: LIBELLE_TYPE_DEMANDE[d.type], href: d.href, mode: d.mode, lignes: d.lignes.length ? d.lignes : [d.ligne],
  });

  return (
    <div className="space-y-4">
      <section className="surface flex flex-wrap items-center gap-3 rounded-xl p-4 text-sm">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
        <p className="min-w-0 flex-1 basis-[16rem]">
          <strong>Intégration validée</strong> le {jour(lot.integreLe)}{lot.creePar ? ` par ${lot.creePar}` : ""} sur « {enveloppe} » —
          {" "}{lot.demandes.length} demandes, <strong className="tabular-nums">{dzd(lot.total)}</strong> au centime. Fichier « {lot.fichierNom} », décisions {lot.version}.
        </p>
        {manquantes > 0 && <Badge tone="warning">{manquantes} pièce{manquantes > 1 ? "s" : ""} manquante{manquantes > 1 ? "s" : ""}</Badge>}
      </section>

      <section className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4" aria-label="Le lot en un coup d'œil">
        <Tuile k="Demandes" v={String(lot.demandes.length)} c={`${creees} ${BADGE_HISTORIQUE} · ${lot.demandes.length - creees} complétée${lot.demandes.length - creees > 1 ? "s" : ""}`} />
        <Tuile k="Payé intégré" v={formatCentimes(Math.round(lot.total * 100)) || "0"} c={`DZD · ${lignesFichier} ligne${lignesFichier > 1 ? "s" : ""} du fichier`} />
        <div className="surface grid min-w-0 content-start gap-1 rounded-xl px-4 py-3.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><i className="inline-block h-2 w-2 rounded-sm bg-warning" aria-hidden />Pièces jointes</span>
          <span className="text-[22px] font-bold tabular-nums">{attendues - manquantes} / {attendues}</span>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary" role="img" aria-label={`${attendues - manquantes} pièces jointes sur ${attendues}`}>
            <span className="block h-full rounded-full bg-success" style={{ width: `${attendues > 0 ? ((attendues - manquantes) / attendues) * 100 : 0}%` }} />
          </div>
        </div>
        <Tuile k="Absentes à décider" pastille="bg-violet-500" v={String(aDecider)} c={aDecider ? "comptées au budget en attendant" : "toutes décidées"} />
      </section>

      {msg && <p role="status" className={cn("rounded-xl border p-3 text-sm", msg.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5 text-destructive")}>{msg.text}</p>}

      <section className="surface min-w-0 overflow-hidden rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Les demandes du lot</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer les demandes du lot">
            {([["TOUT", "Toutes", lot.demandes.length], ["MANQUANTES", "Pièces manquantes", nIncompletes], ["COMPLETES", "Complètes", lot.demandes.length - nIncompletes]] as const).map(([k, l, n]) => (
              <button key={k} type="button" aria-pressed={filtre === k} onClick={() => setFiltre(k)}
                className={cn("rounded-full border px-3 py-1 text-xs font-medium", filtre === k ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-secondary")}>
                {l}<span className="ml-1 tabular-nums text-muted-foreground">{n}</span>
              </button>
            ))}
          </div>
        </header>
        {ORDRE_TYPES.map((t) => {
          const ds = lot.demandes.filter((d) => d.type === t && passe(d));
          if (ds.length === 0) return null;
          return (
            <div key={t}>
              <h3 className="flex justify-between gap-2 border-b border-border bg-secondary/50 px-4 py-2 text-[13px] font-semibold">{LIBELLE_TYPE_DEMANDE[t]} <span className="font-normal text-muted-foreground tabular-nums">{ds.length}</span></h3>
              <ul className="divide-y divide-border text-sm">
                {ds.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-2.5">
                    <span className="rounded border border-border bg-secondary px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">L{(d.lignes.length ? d.lignes : [d.ligne]).join(" + L")}</span>
                    <button type="button" className="min-w-0 text-left font-semibold text-primary hover:underline [overflow-wrap:anywhere]" onClick={() => ouvrir(d)}>{d.libelle}</button>
                    {d.mode === "CREEE" ? <Badge tone="purple">{BADGE_HISTORIQUE}</Badge> : <Badge tone="info">Complétée</Badge>}
                    {d.attendues === 0 ? null : d.manquantes > 0
                      ? <Badge tone="warning"><Paperclip className="h-3 w-3" /> {d.manquantes}/{d.attendues} manquante{d.manquantes > 1 ? "s" : ""}</Badge>
                      : <Badge tone="success">pièces complètes</Badge>}
                    <span className="ml-auto whitespace-nowrap font-semibold tabular-nums">{dzd(d.montant)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {lot.demandes.every((d) => !passe(d)) && <p className="px-4 py-5 text-sm text-muted-foreground">Aucune demande pour ce filtre.</p>}
      </section>

      {lot.remplacees.length > 0 && (
        <section className="surface min-w-0 overflow-hidden rounded-xl text-sm">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="font-semibold">Remplacées par le fichier ({lot.remplacees.length})</h2>
            <span className="text-xs text-muted-foreground">Un seul montant compte, celui du fichier. Le livre de trésorerie n&apos;a pas bougé.</span>
          </header>
          <ul className="divide-y divide-border">{lot.remplacees.map((r) => <li key={r.cle} className="flex flex-wrap justify-between gap-2 px-4 py-2"><span className="min-w-0 [overflow-wrap:anywhere]">{r.libelle} <span className="text-xs text-muted-foreground">· {r.raison}</span></span><span className="font-semibold tabular-nums">{dzd(r.montant)}</span></li>)}</ul>
        </section>
      )}

      <section id="absentes" className="surface min-w-0 scroll-mt-20 overflow-hidden rounded-xl text-sm">
        <header className="border-b border-border px-4 py-3">
          <h2 className="font-semibold">Dans la plateforme, absentes du fichier ({lot.absentes.length})</h2>
          <p className="text-xs text-muted-foreground">Ce qui comptait au budget avant l&apos;intégration et ne correspond à aucune ligne. Pour chacune : la garder dans le budget, ou l&apos;en sortir — rien n&apos;est effacé, et le choix se change à tout moment.</p>
        </header>
        {lot.absentes.length === 0 ? <p className="px-4 py-3 text-muted-foreground">Aucune.</p> : (
          <ul className="divide-y divide-border">
            {lot.absentes.map((a) => (
              <li key={a.cle} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 basis-[16rem] [overflow-wrap:anywhere]">{a.reference} — {a.libelle} <span className="text-xs text-muted-foreground">· {a.categorie} · {jour(a.date)}{a.decision === null ? " · à décider (comptée en attendant)" : a.decision === "GARDER" ? " · gardée au budget" : " · sortie du budget"}</span></span>
                <span className="tabular-nums">{dzd(a.montant)}</span>
                {occupe === a.cle ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChoixAbsente valeur={a.decision} disabled={!lot.peutGerer || occupe !== null} onChange={(v) => decider(a, v)} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      {lot.peutGerer && (
        <section className="surface space-y-3 rounded-xl border-destructive/30 p-4 text-sm">
          {!annulerOuvert ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className="text-destructive" onClick={() => setAnnulerOuvert(true)}><Undo2 className="h-4 w-4" /> Annuler l&apos;intégration d&apos;un bloc</Button>
              <span className="text-xs text-muted-foreground">Réservé au gestionnaire de l&apos;enveloppe.</span>
            </div>
          ) : (
            <>
              <p>Annuler retire les {creees} demandes historiques créées par ce lot (et leurs postes) et défait les compléments des {lot.demandes.length - creees} demandes existantes. Le budget revient à son état d&apos;avant ; le livre de trésorerie et les ordres ne bougent pas.</p>
              <textarea value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (obligatoire)" className="w-full rounded-lg border border-border bg-background p-2" rows={2} aria-label="Motif de l'annulation" />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input value={mot} onChange={(e) => setMot(e.target.value)} placeholder="Tapez ANNULER" className="rounded-lg border border-border bg-background px-3 py-2 sm:w-56" aria-label="Confirmation" />
                <Button type="button" variant="destructive" disabled={!motif.trim() || mot.trim().toUpperCase() !== "ANNULER" || occupe !== null} onClick={annuler}>
                  {occupe === "annuler" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Confirmer l&apos;annulation
                </Button>
                <Button type="button" variant="ghost" onClick={() => { setAnnulerOuvert(false); setMotif(""); setMot(""); }}>Garder l&apos;intégration</Button>
              </div>
            </>
          )}
        </section>
      )}

      <FicheDemandeSheet fiche={fiche} onClose={() => setFiche(null)} />
    </div>
  );
}

function Tuile({ k, v, c, pastille }: { k: string; v: string; c: string; pastille?: string }) {
  return (
    <div className="surface grid min-w-0 content-start gap-1 rounded-xl px-4 py-3.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{pastille && <i className={cn("inline-block h-2 w-2 rounded-sm", pastille)} aria-hidden />}{k}</span>
      <span className="text-[22px] font-bold tabular-nums tracking-tight [overflow-wrap:anywhere]">{v}</span>
      <span className="text-xs text-muted-foreground">{c}</span>
    </div>
  );
}
