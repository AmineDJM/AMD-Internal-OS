"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { enregistrerPrixProduit, revenirAuPrixExplorateur } from "@/lib/actions/prix-produit-actions";
import { LIBELLE_PRIX, type PrixResolu, type TypePrix } from "@/lib/products/fiche-360";

const dzd = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;
const jour = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("fr-FR") : null);

/**
 * LES PRIX DU PRODUIT — l'Explorateur les observe, une saisie les corrige (Direction, 07/10). La valeur qui fait foi est
 * en gras ; une saisie porte « manuel », qui et depuis quand, et garde la valeur de l'Explorateur à côté.
 */
export function PrixProduit({ productId, prix, historique, peutModifier }: {
  productId: string;
  prix: PrixResolu[];
  historique: { id: string; type: TypePrix; montant: number | null; depuis: string; note: string | null; auteur: string | null }[];
  peutModifier: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState<TypePrix | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const occupe = envoi || enCours;
  const confirmer = useConfirmer();

  async function enregistrer(e: React.FormEvent<HTMLFormElement>, kind: TypePrix) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("kind", kind);
    fd.set("amountDzd", String(f.get("amountDzd") ?? ""));
    fd.set("validFrom", String(f.get("validFrom") ?? ""));
    fd.set("note", String(f.get("note") ?? ""));
    setEnvoi(true); setErreur(null);
    try {
      const r = await enregistrerPrixProduit(fd);
      if (!r.ok) { setErreur(r.error ?? "Enregistrement impossible."); return; }
      setOuvert(null);
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  async function revenir(kind: TypePrix) {
    if (!(await confirmer("Revenir à la valeur de l'Explorateur produits ? La saisie reste dans l'historique."))) return;
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("kind", kind);
    setEnvoi(true); setErreur(null);
    try {
      const r = await revenirAuPrixExplorateur(fd);
      if (!r.ok) { setErreur(r.error ?? "Le prix n'est pas revenu à la valeur de l'Explorateur."); return; }
      rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">Prix</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Montant</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Source</th>
              {peutModifier && <th className="px-3 py-2"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {prix.map((p) => (
              <React.Fragment key={p.type}>
                <tr className="border-b border-border/60">
                  <td className="sticky left-0 z-[1] bg-card whitespace-nowrap px-3 py-2">{LIBELLE_PRIX[p.type]}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{p.montant !== null ? dzd(p.montant) : <span className="font-normal text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {p.source === "MANUEL" ? (
                      <>
                        <span className="mr-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">manuel</span>
                        {[p.auteur, jour(p.depuis) && `depuis le ${jour(p.depuis)}`].filter(Boolean).join(" · ")}
                        {p.explorateur !== null && <span className="block">Explorateur : {dzd(p.explorateur)}</span>}
                        {p.note && <span className="block italic">{p.note}</span>}
                      </>
                    ) : p.source === "EXPLORATEUR" ? (
                      <>{p.auteur}{p.depuis ? ` · ${jour(p.depuis)}` : ""}</>
                    ) : "Aucune valeur"}
                  </td>
                  {peutModifier && (
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Button type="button" size="sm" variant="outline" disabled={occupe} onClick={() => { setErreur(null); setOuvert(ouvert === p.type ? null : p.type); }}>Modifier</Button>
                      {p.source === "MANUEL" && (
                        <Button type="button" size="sm" variant="ghost" className="ml-1" disabled={occupe} onClick={() => revenir(p.type)}>Explorateur</Button>
                      )}
                    </td>
                  )}
                </tr>
                {ouvert === p.type && (
                  <tr className="border-b border-border/60 bg-muted/30">
                    <td colSpan={peutModifier ? 4 : 3} className="px-3 py-3">
                      <form onSubmit={(e) => enregistrer(e, p.type)} className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Montant (DZD)
                          <Input name="amountDzd" inputMode="decimal" required defaultValue={p.montant !== null ? String(p.montant).replace(".", ",") : ""} className="w-36" disabled={occupe} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">À compter du
                          <Input name="validFrom" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="w-40" disabled={occupe} />
                        </label>
                        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">Note
                          <Input name="note" maxLength={300} placeholder="Attestation de prix, arrêté…" disabled={occupe} />
                        </label>
                        <Button type="submit" size="sm" disabled={occupe}>{occupe && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enregistrer</Button>
                      </form>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {erreur && <p role="alert" className="px-3 py-2 text-xs text-destructive">{erreur}</p>}
      {historique.length > 0 && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">Historique des saisies ({historique.length})</summary>
          <ul className="divide-y divide-border px-3 pb-2 text-xs">
            {historique.map((h) => (
              <li key={h.id} className="py-1.5">
                <span className="font-medium">{LIBELLE_PRIX[h.type]}</span> · {h.montant !== null ? dzd(h.montant) : "retour à l'Explorateur"} · depuis le {jour(h.depuis)}
                {h.auteur && <span className="text-muted-foreground"> · {h.auteur}</span>}
                {h.note && <span className="text-muted-foreground"> · {h.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
