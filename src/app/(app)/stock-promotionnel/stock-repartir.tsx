"use client";

import * as React from "react";
import { AlertCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn } from "@/lib/utils";
import { lireRepartition } from "@/lib/promo/stock";
import type { ArticleVue, PageStock } from "@/lib/queries/promo-stock";
import { repartirArticle } from "@/lib/actions/promo-stock-actions";
import { Vide, distribuable, nombre, quantiteDe } from "./stock-commun";

/**
 * RÉPARTIR UN ARTICLE DU MAGASIN ENTRE PLUSIEURS PERSONNES (Direction, 23/11/2026 : « Assia décide à
 * qui donner chaque quantité de chaque matériel pour les délégués ») — à côté de « Doter », qui en
 * sert une seule.
 *
 * Une ligne par personne qui peut recevoir — la MÊME liste que « Doter » : celles qui ont le module,
 * donc qui pourront confirmer —, une quantité à côté de chacune, et le total en DIRECT face au
 * distribuable du magasin. La saisie est lue par la règle que l'action relit (`lireRepartition`) :
 * l'écran ne promet pas un envoi que l'action refuserait (§118.83). Le filtre ne fait que MASQUER :
 * une quantité saisie puis filtrée reste comptée dans le total, et part.
 */
export function FormulaireRepartir({ article: a, page, onClose, onSucces }: {
  article: ArticleVue;
  page: PageStock;
  onClose: () => void;
  onSucces: (texte: string) => void;
}) {
  const { rafraichir } = useRafraichir();
  const dispo = distribuable(a, null);
  const [quantites, setQuantites] = React.useState<Record<string, string>>({});
  const [filtre, setFiltre] = React.useState("");
  const [note, setNote] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [occupe, setOccupe] = React.useState(false);

  const lecture = lireRepartition(page.destinataires.map((p) => ({ versId: p.id, quantite: quantites[p.id] ?? "" })));
  const saisie = Object.values(quantites).some((v) => v.trim() !== "");
  const total = lecture.ok ? lecture.total : 0;
  const depasse = total > dispo;
  const q = filtre.trim().toLowerCase();
  const visibles = q ? page.destinataires.filter((p) => p.nom.toLowerCase().includes(q)) : page.destinataires;

  const envoyer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!lecture.ok || depasse) return;
    setOccupe(true);
    setErreur(null);
    const fd = new FormData();
    fd.set("itemId", a.id);
    for (const l of lecture.lignes) {
      fd.append("versId", l.versId);
      fd.append("quantite", String(l.quantite));
    }
    if (note.trim()) fd.set("note", note.trim());
    try {
      const r = await repartirArticle(fd);
      if (r.ok) { onSucces(r.message ?? "Répartition en route."); rafraichir(); onClose(); }
      else setErreur(r.error ?? "La répartition n'est pas partie.");
    } catch {
      setErreur("La répartition n'a pas abouti (connexion ou serveur). Rechargez la page avant de recommencer : elle a pu partir malgré tout.");
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Sheet open onClose={onClose} width="lg"
      title={`Répartir — ${a.libelle}`}
      description="Une dotation par personne : chacune la voit « en route » et confirme la réception. Tout part ensemble, ou rien ne part."
    >
      <form onSubmit={envoyer} className="space-y-4">
        <div className="flex flex-col gap-1 rounded-lg bg-secondary/40 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>
            Distribuable au magasin : <strong className="tabular-nums">{nombre(dispo)}</strong> {a.catalogue.unite}
            <span className="text-xs text-muted-foreground"> (hors lots périmés)</span>
          </span>
          <span aria-live="polite" className={cn("font-medium tabular-nums", depasse ? "text-destructive" : "text-foreground")}>
            Réparti : {nombre(total)} / {nombre(dispo)}{lecture.ok ? ` · ${lecture.lignes.length} personne(s)` : ""}
          </span>
        </div>
        {depasse && (
          <p role="alert" className="text-xs text-destructive">
            {nombre(Math.round((total - dispo) * 1000) / 1000)} de plus que le distribuable : réduisez une ou plusieurs lignes.
          </p>
        )}

        {page.destinataires.length > 8 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={filtre} onChange={(e) => setFiltre(e.target.value)} placeholder="Rechercher une personne…" className="pl-8" aria-label="Rechercher une personne" />
          </div>
        )}

        {page.destinataires.length === 0 ? (
          <Vide>Personne ne peut recevoir de matériel : le module « Stock promotionnel » n&apos;est ouvert à aucun délégué.</Vide>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {visibles.map((p) => {
              const enMain = quantiteDe(a, p.id);
              return (
                <li key={p.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">{p.id === page.moi ? `${p.nom} (moi)` : p.nom}</p>
                    {enMain > 0 && <p className="text-xs text-muted-foreground">{nombre(enMain)} déjà en main</p>}
                  </div>
                  {/* Au téléphone, le champ prend la largeur : on répartit au pouce. */}
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Input
                      type="number" min={0} step="any" inputMode="decimal" placeholder="0" value={quantites[p.id] ?? ""}
                      onChange={(e) => { const v = e.target.value; setQuantites((avant) => ({ ...avant, [p.id]: v })); }}
                      aria-label={`Quantité pour ${p.nom}`} className="h-11 min-w-0 flex-1 text-right sm:h-10 sm:w-28 sm:flex-none"
                    />
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{a.catalogue.unite}</span>
                  </div>
                </li>
              );
            })}
            {visibles.length === 0 && <li className="px-3 py-2.5 text-sm text-muted-foreground">Personne ne correspond à « {filtre} ».</li>}
          </ul>
        )}

        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Note (facultative) — jointe à chaque dotation</span>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Tournée de décembre, congrès…" />
        </label>

        {(erreur || (saisie && !lecture.ok)) && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {erreur ?? (lecture.ok ? null : lecture.error)}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
          <Button type="submit" disabled={occupe || !lecture.ok || depasse}>
            {occupe ? "Envoi…" : lecture.ok ? `Envoyer ${nombre(total)} à ${lecture.lignes.length} personne(s)` : "Envoyer"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
