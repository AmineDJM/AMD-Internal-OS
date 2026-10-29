"use client";

import * as React from "react";
import { Upload, Search, Loader2, Sparkles, CheckCircle2, XCircle, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Badge } from "@/components/ui/badge";
import {
  importReserveLetter, importReserveText, similarReserves, riskOfReserve, refreshDerivedRules,
} from "@/lib/regulatory/intelligence/reserves/library-actions";

type Similar = Awaited<ReturnType<typeof similarReserves>>[number];
type Risk = Awaited<ReturnType<typeof riskOfReserve>>;

/**
 * Import d'une lettre de réserves + recherche de précédents.
 *
 * Deux gestes, deux colonnes :
 *   • à gauche on ALIMENTE la bibliothèque (fichier ou texte collé d'un courriel) ;
 *   • à droite on l'INTERROGE : « cette réserve, l'avons-nous déjà eue ? », avec le score de
 *     risque et surtout la réponse qui avait été ACCEPTÉE.
 *
 * Le verrou anti-double-clic est un `useRef` synchrone : le `disabled` du bouton n'agit qu'au
 * rendu suivant, donc trop tard pour un double-clic rapide.
 */
export function ReserveLibraryPanel() {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = React.useState("");

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Terminé.") : (r.error ?? "L'opération n'a pas abouti.") });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };

  const upload = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) { setMsg({ ok: false, text: "Choisissez d'abord un fichier." }); return; }
    const fd = new FormData();
    fd.set("file", f);
    void run(async () => {
      const r = await importReserveLetter(fd);
      if (fileRef.current) fileRef.current.value = "";
      return r;
    });
  };

  const paste = () => {
    const fd = new FormData();
    fd.set("text", pasted);
    void run(async () => {
      const r = await importReserveText(fd);
      if (r.ok) setPasted("");
      return r;
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Alimenter ── */}
      <section className="surface space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Importer une lettre de réserves</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          PDF, scan, Word, Excel ou courriel. Un scan est lu <strong>page par page en image</strong> :
          l&apos;OCR seul rendrait un texte approximatif, sans valeur de preuve. Réimporter la même
          lettre ne coûte rien — elle est reconnue à son empreinte.
        </p>

        <input
          ref={fileRef} type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.docx,.doc,.xlsx,.xls,.csv,.txt,.eml"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
        />
        <Button size="sm" onClick={upload} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Analyser et enregistrer
        </Button>

        <div className="border-t border-border pt-3">
          <label className="text-xs font-medium">Ou coller le texte reçu par courriel</label>
          <textarea
            value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4}
            placeholder="Collez ici le corps du message de l'ANPP…"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
          />
          <Button size="sm" variant="outline" className="mt-2" onClick={paste} disabled={busy || pasted.trim().length < 40}>
            <FileText className="h-4 w-4" /> Extraire depuis le texte
          </Button>
        </div>

        {msg && (
          <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {msg.text}
          </p>
        )}

        <div className="border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={() => void run(refreshDerivedRules)} disabled={busy}>
            <Sparkles className="h-4 w-4" /> Chercher de nouvelles règles
          </Button>
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            Analyse les réserves récurrentes et propose des règles. Elles restent <strong>sans effet</strong> jusqu&apos;à votre validation.
          </p>
        </div>
      </section>

      {/* ── Interroger ── */}
      <PrecedentSearch />
    </div>
  );
}

/** « Cette réserve, l'avons-nous déjà eue ? » — avec le risque et la réponse qui a fonctionné. */
function PrecedentSearch() {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<Similar[] | null>(null);
  const [risk, setRisk] = React.useState<Risk>(null);
  const [pending, start] = React.useTransition();

  const search = () => {
    const text = q.trim();
    if (text.length < 12) return;
    start(async () => {
      const [found, r] = await Promise.all([similarReserves(text), riskOfReserve(text)]);
      setRows(found);
      setRisk(r);
    });
  };

  return (
    <section className="surface space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">L&apos;avons-nous déjà eue ?</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Collez un point de réserve, ou le libellé d&apos;un risque repéré dans un dossier en préparation.
      </p>
      <textarea
        value={q} onChange={(e) => setQ(e.target.value)} rows={3}
        placeholder="Ex. « Le certificat d'analyse du produit fini n'est pas signé par le pharmacien responsable »"
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
      />
      <Button size="sm" onClick={search} disabled={pending || q.trim().length < 12}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Chercher les précédents
      </Button>

      {risk && (
        <div className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Probabilité qu&apos;elle revienne</span>
            <Badge tone={risk.level === "ÉLEVÉ" ? "danger" : risk.level === "MOYEN" ? "warning" : "success"} dot={false}>
              {risk.level} · {Math.round(risk.score * 100)} %
            </Badge>
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {risk.reasons.map((r, i) => <li key={i} className="text-xs text-muted-foreground">• {r}</li>)}
          </ul>
          <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
            Indication fondée sur nos précédents — ce n&apos;est pas une prédiction de la décision de l&apos;ANPP.
          </p>
        </div>
      )}

      {rows !== null && (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun précédent comparable dans la bibliothèque.</p>
        ) : (
          <ul className="max-h-[26rem] divide-y divide-border overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id} className="space-y-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={r.status === "ACCEPTED" ? "success" : r.status === "REITERATED" ? "danger" : "neutral"} dot={false}>
                    {r.status === "ACCEPTED" ? "Acceptée" : r.status === "REITERATED" ? "Réitérée" : r.status}
                  </Badge>
                  {r.ctdSection && <Badge tone="info" dot={false}>{r.ctdSection}</Badge>}
                  <span className="text-xs text-muted-foreground">proximité {Math.round(r.score * 100)} %</span>
                </div>
                <p>{r.verbatim.slice(0, 260)}{r.verbatim.length > 260 ? "…" : ""}</p>
                {r.response && (
                  <p className={`rounded-lg px-2 py-1.5 text-xs ${r.status === "ACCEPTED" ? "bg-success/10" : "bg-secondary"}`}>
                    <strong>{r.status === "ACCEPTED" ? "Réponse qui a fonctionné" : "Réponse apportée"} :</strong> {r.response.slice(0, 300)}
                  </p>
                )}
                <p className="text-[0.6875rem] text-muted-foreground">
                  {[r.productName, r.dci, r.supplier].filter(Boolean).join(" · ") || "—"}
                  {r.evidenceFile ? ` · ${r.evidenceFile}${r.evidencePage ? `, p. ${r.evidencePage}` : ""}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
