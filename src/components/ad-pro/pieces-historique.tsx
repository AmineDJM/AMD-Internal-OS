"use client";

import * as React from "react";
import { CheckCircle2, Circle, Link2, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn } from "@/lib/utils";
import { joindrePiecesIntegration, rattacherPieceIntegration, relierEcritureIntegration } from "@/lib/actions/integration-adpro-actions";
import type { EtatPiece } from "@/lib/budget-marketing/integration-vue";

/**
 * LES PIÈCES ATTENDUES / MANQUANTES d'une demande intégrée — obligatoires mais NON bloquantes. Plusieurs fichiers d'un
 * coup, à tout moment ; une pièce déjà dans la plateforme se RATTACHE (sur la demande, un poste, le registre) au lieu
 * d'être redéposée — et le serveur la reconnaît de lui-même si on la redépose.
 */
export function PiecesHistorique({ demandeRowId, pieces, manquantes, rattachables, peutJoindre, apres }: {
  demandeRowId: string;
  pieces: EtatPiece[];
  manquantes: number;
  rattachables: { documentId: string; nom: string; ou: string }[];
  peutJoindre: boolean;
  /** Après un dépôt ou un rattachement réussi (un panneau relit sa fiche). */
  apres?: () => void;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const verrou = React.useRef(false);

  async function envoyer(cle: string, fichiers: FileList | null) {
    if (!fichiers || fichiers.length === 0 || verrou.current) return;
    verrou.current = true; setOccupe(cle); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("demandeRowId", demandeRowId); fd.set("cle", cle);
      for (const f of Array.from(fichiers)) fd.append("fichiers", f);
      const r = await joindrePiecesIntegration(fd);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Pièces jointes." : r.error ?? "Échec." });
      if (r.ok) { rafraichir(); apres?.(); }
    } finally { setOccupe(null); verrou.current = false; }
  }

  async function rattacher(cle: string, documentId: string) {
    if (!documentId || verrou.current) return;
    verrou.current = true; setOccupe(cle); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("demandeRowId", demandeRowId); fd.set("cle", cle); fd.set("documentId", documentId);
      const r = await rattacherPieceIntegration(fd);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Rattachée." : r.error ?? "Échec." });
      if (r.ok) { rafraichir(); apres?.(); }
    } finally { setOccupe(null); verrou.current = false; }
  }

  return (
    <div>
      <h3 className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Pièces attendues
        {manquantes > 0 ? <Badge tone="warning">{manquantes} pièce{manquantes > 1 ? "s" : ""} manquante{manquantes > 1 ? "s" : ""}</Badge> : <Badge tone="success">complètes</Badge>}
      </h3>
      {msg && <p className={cn("mb-2 rounded-lg border p-2 text-xs", msg.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5 text-destructive")}>{msg.text}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {pieces.map((p) => (
          <li key={p.cle} className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {p.fournie ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Circle className="h-4 w-4 text-warning" />}
              <span className="min-w-0 flex-1">{p.libelle}</span>
              {!p.fournie && <span className="text-xs text-warning">à joindre</span>}
              {peutJoindre && (
                <label className={cn("inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary", (occupe !== null || enCours) && "pointer-events-none opacity-50")}>
                  {occupe === p.cle ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Joindre
                  <input type="file" multiple className="sr-only" onChange={(e) => { void envoyer(p.cle, e.target.files); e.target.value = ""; }} />
                </label>
              )}
            </div>
            {p.fichiers.length > 0 && (
              <ul className="pl-6 text-xs">
                {p.fichiers.map((f) => (
                  <li key={f.id} className="flex items-center gap-1">
                    {f.rattachee && <Link2 className="h-3 w-3 text-muted-foreground" />}
                    <a href={f.href ?? `/api/documents/${encodeURIComponent(f.id)}`} className="truncate text-primary hover:underline" target="_blank" rel="noreferrer">{f.nom}</a>
                    {f.rattachee && <span className="text-muted-foreground">(déjà dans la plateforme — rattachée)</span>}
                  </li>
                ))}
              </ul>
            )}
            {peutJoindre && rattachables.length > 0 && (
              <div className="pl-6">
                <select
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs sm:w-auto" defaultValue=""
                  disabled={occupe !== null || enCours}
                  onChange={(e) => { const v = e.target.value; e.target.value = ""; void rattacher(p.cle, v); }}
                  aria-label={`Rattacher une pièce existante à « ${p.libelle} »`}
                >
                  <option value="">Rattacher une pièce déjà dans la plateforme…</option>
                  {rattachables.map((r) => <option key={r.documentId} value={r.documentId}>{r.nom} — {r.ou}</option>)}
                </select>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!peutJoindre && <p className="mt-1 text-xs text-muted-foreground">Le gestionnaire de l&apos;enveloppe ou qui peut modifier cette demande joint les pièces.</p>}
    </div>
  );
}

/**
 * RELIER L'ÉCRITURE DE TRÉSORERIE qui a payé la dépense (facultatif) — par sa référence, en lecture seule : le livre n'est
 * pas modifié, la demande affiche le montant payé et l'écart avec la ligne du fichier.
 */
export function RelierEcriture({ demandeRowId, actuelle }: { demandeRowId: string; actuelle: string | null }) {
  const { enCours, rafraichir } = useRafraichir();
  const [reference, setReference] = React.useState(actuelle ?? "");
  const [occupe, setOccupe] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function relier() {
    if (occupe) return;
    setOccupe(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.set("demandeRowId", demandeRowId); fd.set("reference", reference.trim());
      const r = await relierEcritureIntegration(fd);
      setMsg({ ok: r.ok, text: r.ok ? r.message ?? "Reliée." : r.error ?? "Échec." });
      if (r.ok) rafraichir();
    } finally { setOccupe(false); }
  }
  return (
    <div className="flex flex-col gap-1 text-xs sm:flex-row sm:items-center">
      <label className="text-muted-foreground" htmlFor={`ecriture-${demandeRowId}`}>Écriture de trésorerie qui l&apos;a payée (facultatif, lecture seule)</label>
      <input id={`ecriture-${demandeRowId}`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="FIN-2026-…" className="rounded-md border border-border bg-background px-2 py-1 sm:w-40" />
      <button type="button" onClick={relier} disabled={occupe || enCours} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-secondary disabled:opacity-50">
        {occupe ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} {reference.trim() ? "Relier" : "Délier"}
      </button>
      {msg && <span className={msg.ok ? "text-success" : "text-destructive"}>{msg.text}</span>}
    </div>
  );
}
