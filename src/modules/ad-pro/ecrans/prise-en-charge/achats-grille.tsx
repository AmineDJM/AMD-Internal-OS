"use client";

import * as React from "react";
import { Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { formatCurrency } from "@/lib/utils";
import type { PageChiffrageVue } from "../../infra/requetes/achats-pec";
import { enregistrerMontantsPec } from "../../actions-prise-en-charge-chiffrage";

/**
 * LA GRILLE « CHIFFRER » (maquette Chiffrage, validée le 24/11/2026) — professionnel × poste × détail × montant × pièce
 * facultative. « Enregistrer » garde la saisie (la demande passe « en cours ») ; « Envoyer les montants » la termine et
 * prévient la Direction Marketing. Le montant se saisit dans la devise du poste (le dollar à l'international, hors billet).
 */
export function GrilleChiffrage({ vue }: { vue: PageChiffrageVue }) {
  const { busy, error, setError, run } = useKeyedAction();
  const [info, setInfo] = React.useState<string | null>(null);
  const [montants, setMontants] = React.useState<Record<string, string>>(
    Object.fromEntries(vue.lignes.map((l) => [l.cellId, l.montant != null ? String(l.montant) : ""])),
  );
  const [fichiers, setFichiers] = React.useState<Record<string, File | null>>({});
  const lire = (v: string) => { const n = Number(v.replace(/[\s  ]/g, "").replace(",", ".")); return v.trim() && Number.isFinite(n) ? n : null; };
  const versDzd = (l: PageChiffrageVue["lignes"][number], n: number | null) => (n == null ? 0 : l.devise === "USD" ? n * (vue.taux ?? 0) : n);
  const total = vue.lignes.reduce((s, l) => s + versDzd(l, lire(montants[l.cellId] ?? "")), 0);
  const manquants = vue.lignes.filter((l) => lire(montants[l.cellId] ?? "") == null).length;

  const envoyer = (envoi: boolean) => run(envoi ? "envoyer" : "enregistrer", async () => {
    setInfo(null);
    const f = new FormData();
    f.set("scope", vue.scope);
    f.set("requestId", vue.requestId);
    if (envoi) f.set("envoyer", "oui");
    for (const l of vue.lignes) {
      f.append("cellIds", l.cellId);
      f.append("montants", montants[l.cellId] ?? "");
      const fichier = fichiers[l.cellId];
      if (fichier) { f.append("pieces", fichier); f.append("pieceCellIds", l.cellId); }
    }
    const r = await enregistrerMontantsPec(f);
    if (r.ok) { setInfo(r.message ?? null); setFichiers({}); }
    return r;
  });

  return (
    <section aria-labelledby="grille-montants" className="overflow-hidden rounded-xl border border-border bg-card">
      <h2 id="grille-montants" className="px-4 py-4 text-base font-semibold">Montants</h2>
      {error && <Retour ton="erreur" onFermer={() => setError(null)} className="mx-4 mb-3">{error}</Retour>}
      {info && <Retour ton="succes" onFermer={() => setInfo(null)} className="mx-4 mb-3">{info}</Retour>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead>
            <tr className="bg-secondary/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-semibold">Professionnel</th>
              <th scope="col" className="px-3 py-2 font-semibold">Poste</th>
              <th scope="col" className="px-3 py-2 font-semibold">Détail</th>
              <th scope="col" className="px-3 py-2 font-semibold">Montant</th>
              <th scope="col" className="px-4 py-2 font-semibold">Pièce (facultative)</th>
            </tr>
          </thead>
          <tbody>
            {vue.lignes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Aucun poste à chiffrer : le demandeur ajoute d&apos;abord les postes (billet, hôtel…) sur la fiche de chaque professionnel.</td></tr>
            )}
            {vue.lignes.map((l) => (
              <tr key={l.cellId} className="border-t border-border">
                <td className="px-4 py-3 font-semibold">{l.pro}</td>
                <td className="px-3 py-3">{l.poste}{l.dejaEnBc && <span className="block text-xs text-muted-foreground">dans un BC — marge de 10 %</span>}</td>
                <td className="px-3 py-3 text-muted-foreground [overflow-wrap:anywhere]">{l.detail}</td>
                <td className="px-3 py-3">
                  <label className="sr-only" htmlFor={`m-${l.cellId}`}>Montant {l.poste} — {l.pro}</label>
                  <div className="flex items-center gap-1.5">
                    <Input id={`m-${l.cellId}`} inputMode="decimal" value={montants[l.cellId] ?? ""} placeholder="0"
                      onChange={(e) => setMontants((m) => ({ ...m, [l.cellId]: e.target.value }))} className="w-32 text-right" />
                    <span className="text-xs text-muted-foreground">{l.devise}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs hover:bg-secondary">
                    <Paperclip className="h-3.5 w-3.5" />
                    <span className="max-w-[12rem] truncate">{fichiers[l.cellId]?.name ?? l.piece?.name ?? "Joindre"}</span>
                    <input type="file" className="sr-only" onChange={(e) => setFichiers((f) => ({ ...f, [l.cellId]: e.target.files?.[0] ?? null }))} />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {vue.lignes.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="text-sm">Total : <strong>{formatCurrency(Math.round(total * 100) / 100)}</strong>{manquants > 0 && <span className="text-muted-foreground"> · {manquants} montant{manquants > 1 ? "s" : ""} manquant{manquants > 1 ? "s" : ""}</span>}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => envoyer(false)}>
              {busy === "enregistrer" && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
            </Button>
            <BoutonDecisif type="button" disabled={busy !== null || manquants > 0} onClick={() => envoyer(true)}>
              {busy === "envoyer" && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer les montants
            </BoutonDecisif>
          </div>
        </div>
      )}
    </section>
  );
}
