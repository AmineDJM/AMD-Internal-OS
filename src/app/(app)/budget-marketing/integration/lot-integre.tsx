"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Undo2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BADGE_HISTORIQUE, LIBELLE_TYPE_DEMANDE, ORDRE_TYPES, formatCentimes } from "@/lib/budget-marketing/integration-2026";
import { annulerIntegrationAdPro, deciderAbsenteIntegration } from "@/lib/actions/integration-adpro-actions";
import type { VueLot } from "@/lib/budget-marketing/integration-serveur";
import { ChoixAbsente } from "./assistant-integration";

const dzd = (n: number) => `${formatCentimes(Math.round(n * 100)) || "0"} DZD`;
const jour = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * UN LOT VALIDÉ : ses demandes (badge, pièces manquantes, lien), la liste « Dans la plateforme, absentes du fichier »
 * (garder / sortir, à tout moment) et l'annulation d'un bloc (motif + mot « ANNULER »).
 */
export function LotIntegre({ lot, enveloppe }: { lot: VueLot; enveloppe: string }) {
  const router = useRouter();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [motif, setMotif] = React.useState("");
  const [mot, setMot] = React.useState("");
  const [annulerOuvert, setAnnulerOuvert] = React.useState(false);

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

  const manquantes = lot.demandes.reduce((s, d) => s + d.manquantes, 0);
  return (
    <div className="space-y-4">
      <section className="surface flex flex-wrap items-center gap-3 rounded-xl p-4 text-sm">
        <CheckCircle2 className="h-5 w-5 text-success" />
        <p className="min-w-0 flex-1">
          <strong>Intégration validée</strong> le {jour(lot.integreLe)}{lot.creePar ? ` par ${lot.creePar}` : ""} sur « {enveloppe} » —
          {" "}{lot.demandes.length} demandes, <strong className="tabular-nums">{dzd(lot.total)}</strong> au centime. Fichier « {lot.fichierNom} », décisions {lot.version}.
        </p>
        {manquantes > 0 && <Badge tone="warning">{manquantes} pièce{manquantes > 1 ? "s" : ""} manquante{manquantes > 1 ? "s" : ""}</Badge>}
      </section>

      {msg && <p className={cn("rounded-xl border p-3 text-sm", msg.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5 text-destructive")}>{msg.text}</p>}

      {ORDRE_TYPES.map((t) => {
        const ds = lot.demandes.filter((d) => d.type === t);
        if (ds.length === 0) return null;
        return (
          <section key={t} className="surface overflow-hidden rounded-xl">
            <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">{LIBELLE_TYPE_DEMANDE[t]} <span className="font-normal text-muted-foreground">· {ds.length}</span></h3>
            <ul className="divide-y divide-border text-sm">
              {ds.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <span className="rounded bg-secondary px-1.5 text-xs tabular-nums">L{d.lignes.join(" + L")}</span>
                  {d.href ? <Link href={d.href} className="font-medium text-primary hover:underline">{d.libelle}</Link> : <span className="font-medium">{d.libelle}</span>}
                  {d.mode === "CREEE" ? <Badge tone="purple">{BADGE_HISTORIQUE}</Badge> : <Badge tone="info">Complétée</Badge>}
                  {d.manquantes > 0
                    ? <Badge tone="warning"><Paperclip className="h-3 w-3" /> {d.manquantes}/{d.attendues} pièce{d.manquantes > 1 ? "s" : ""} manquante{d.manquantes > 1 ? "s" : ""}</Badge>
                    : <Badge tone="success">pièces complètes</Badge>}
                  <span className="ml-auto font-semibold tabular-nums">{dzd(d.montant)}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {lot.remplacees.length > 0 && (
        <section className="surface rounded-xl p-4 text-sm">
          <h3 className="font-semibold">Remplacées par le fichier ({lot.remplacees.length})</h3>
          <p className="text-xs text-muted-foreground">Elles correspondent à une ligne : un seul montant compte, celui du fichier. Le livre de trésorerie, lui, n&apos;a pas bougé.</p>
          <ul className="mt-2 divide-y divide-border">{lot.remplacees.map((r) => <li key={r.cle} className="flex justify-between gap-2 py-1"><span>{r.libelle}</span><span className="tabular-nums">{dzd(r.montant)}</span></li>)}</ul>
        </section>
      )}

      <section className="surface rounded-xl p-4 text-sm">
        <h3 className="font-semibold">Dans la plateforme, absentes du fichier ({lot.absentes.length})</h3>
        <p className="text-xs text-muted-foreground">Ce qui comptait au budget avant l&apos;intégration et ne correspond à aucune ligne. Pour chacune : la garder dans le budget, ou l&apos;en sortir — rien n&apos;est effacé, et le choix se change à tout moment.</p>
        {lot.absentes.length === 0 ? <p className="mt-2 text-muted-foreground">Aucune.</p> : (
          <ul className="mt-2 divide-y divide-border">
            {lot.absentes.map((a) => (
              <li key={a.cle} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1">{a.reference} — {a.libelle} <span className="text-xs text-muted-foreground">· {a.categorie} · {jour(a.date)}{a.decision === null ? " · à décider (comptée en attendant)" : ""}</span></span>
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
            <Button type="button" variant="outline" onClick={() => setAnnulerOuvert(true)}><Undo2 className="h-4 w-4" /> Annuler l&apos;intégration d&apos;un bloc</Button>
          ) : (
            <>
              <p>Annuler retire les {lot.demandes.filter((d) => d.mode === "CREEE").length} demandes historiques créées par ce lot (et leurs postes) et défait les compléments des demandes existantes. Le budget revient à son état d&apos;avant ; le livre de trésorerie et les ordres ne bougent pas.</p>
              <textarea value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (obligatoire)" className="w-full rounded-lg border border-border bg-background p-2" rows={2} />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input value={mot} onChange={(e) => setMot(e.target.value)} placeholder="Tapez ANNULER" className="rounded-lg border border-border bg-background px-3 py-2 sm:w-56" aria-label="Confirmation" />
                <Button type="button" variant="destructive" disabled={!motif.trim() || mot.trim().toUpperCase() !== "ANNULER" || occupe !== null} onClick={annuler}>
                  {occupe === "annuler" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Confirmer l&apos;annulation
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAnnulerOuvert(false)}>Garder l&apos;intégration</Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
