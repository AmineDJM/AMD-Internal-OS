"use client";

import * as React from "react";
import { Loader2, PackagePlus, CheckCircle2, Archive, FlaskConical, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { seedRulePacksAction, setRulePackStatus, toggleRuleActive, runRulePackTests, type PackTestReport } from "@/lib/regulatory/intelligence/rules/admin-actions";

interface Rule { id: string; code: string; kind: string; sectionCode: string | null; factKey: string | null; severity: string; blocker: boolean; active: boolean; title: string }
interface Pack { id: string; code: string; name: string; description: string | null; jurisdiction: string; version: string; status: string; _count: { rules: number }; rules: Rule[] }

const KIND_LABEL: Record<string, string> = {
  SECTION_REQUIRED: "Section obligatoire", SECTION_EXPECTED: "Section attendue",
  DOCUMENT_PRESENT: "Document présent", FACT_REQUIRED: "Donnée requise", CUSTOM: "Personnalisée",
};

export function RulePacksAdmin({ packs, hasPacks }: { packs: Pack[]; hasPacks: boolean }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [tests, setTests] = React.useState<Record<string, PackTestReport>>({});

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(key); setError(null);
    try {
      const r = await fn();
      if (r.ok) rafraichir(); else setError(r.error ?? "Le paquet de règles n'a pas été modifié.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function seed() {
    setBusy("seed"); setError(null);
    try {
      const r = await seedRulePacksAction();
      if (r.ok) rafraichir(); else setError(r.error ?? "Les paquets de règles n'ont pas été amorcés.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  async function test(packId: string) {
    setBusy(`test-${packId}`); setError(null);
    const fd = new FormData(); fd.set("packId", packId);
    try {
      const r = await runRulePackTests(fd);
      setTests((t) => ({ ...t, [packId]: r }));
      if (!r.ok) setError(r.error ?? "Échec des tests.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!hasPacks && (
          <Button type="button" size="sm" disabled={busy !== null} onClick={seed}>
            {busy === "seed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Amorcer les packs de règles ANPP
          </Button>
        )}
        {hasPacks && (
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={seed}>
            {busy === "seed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Compléter les packs manquants
          </Button>
        )}
      </div>
      <Retour ton="erreur">{error}</Retour>

      <div className="space-y-2">
        {packs.map((p) => {
          const rep = tests[p.id];
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setOpen(isOpen ? null : p.id)} aria-expanded={isOpen} className="flex min-h-9 min-w-0 items-center gap-1.5 text-left text-sm font-medium sm:min-h-0">
                  <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`} /> {p.name}
                </button>
                <span className={`rounded px-1.5 py-0.5 text-xs ${p.status === "ACTIVE" ? "bg-success/10 text-success" : p.status === "RETIRED" ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-600"}`}>{p.status}</span>
                <span className="text-xs text-muted-foreground">{p._count.rules} règle·s · {p.jurisdiction} · v{p.version}</span>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <button type="button" disabled={busy !== null} onClick={() => test(p.id)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-xs text-muted-foreground hover:text-foreground">
                    {busy === `test-${p.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />} Tester
                  </button>
                  {p.status !== "ACTIVE" && (
                    <button type="button" disabled={busy !== null} onClick={() => run(`act-${p.id}`, () => { const fd = new FormData(); fd.set("packId", p.id); fd.set("status", "ACTIVE"); return setRulePackStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-success/40 px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-xs text-success"><CheckCircle2 className="h-3 w-3" /> Activer</button>
                  )}
                  {p.status !== "RETIRED" && (
                    <button type="button" disabled={busy !== null} onClick={() => run(`ret-${p.id}`, () => { const fd = new FormData(); fd.set("packId", p.id); fd.set("status", "RETIRED"); return setRulePackStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-xs text-muted-foreground"><Archive className="h-3 w-3" /> Retirer</button>
                  )}
                </div>
              </div>
              {p.description && <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>}

              {rep && rep.ok && (
                <p className={`mt-2 text-xs font-medium ${rep.passed === rep.total ? "text-success" : "text-destructive"}`}>
                  Tests golden : {rep.passed}/{rep.total} cas conformes{rep.passed === rep.total ? " ✓" : " — écarts détectés"}
                </p>
              )}

              {isOpen && (
                <div className="mt-2 space-y-1">
                  {p.rules.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
                      <span className={`rounded px-1 py-0.5 ${r.blocker ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"}`}>{r.severity}</span>
                      <span className="font-medium">{r.title}</span>
                      <span className="text-muted-foreground">· {KIND_LABEL[r.kind] ?? r.kind}{r.sectionCode ? ` ${r.sectionCode}` : r.factKey ? ` ${r.factKey}` : ""}</span>
                      <button type="button" disabled={busy !== null} onClick={() => run(`rule-${r.id}`, () => { const fd = new FormData(); fd.set("ruleId", r.id); fd.set("active", String(!r.active)); return toggleRuleActive(fd); })} className={`ml-auto rounded border px-2 py-1.5 sm:px-1.5 sm:py-0.5 ${r.active ? "border-success/40 text-success" : "border-border text-muted-foreground"}`}>
                        {r.active ? "Active" : "Inactive"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {packs.length === 0 && <p className="text-sm text-muted-foreground">Aucun pack de règles. Amorcez les packs ANPP pour piloter les contrôles depuis la base (sinon les profils codés font foi).</p>}
      </div>
    </div>
  );
}
