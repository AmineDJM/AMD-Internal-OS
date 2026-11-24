"use client";

import * as React from "react";
import { ArrowRightLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { cocherLigneDeSortie, ecrireLigneDeSortie, retirerLigneDeSortie, transfererLigneDeSortie } from "@/modules/rh/actions-depart";
import {
  CATEGORIES_TACHE, LIBELLE_CATEGORIE_TACHE, SOURCE_TRANSFERT_SUJETS, SOURCE_TRANSFERT_TACHES, type CategorieTache,
} from "@/modules/rh/partage";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/types";

export interface TacheVue {
  id: string;
  categorie: string;
  libelle: string;
  detail: string | null;
  source: string | null;
  faitLe: string | null;
  faitPar: string | null;
}

/** Le formulaire d'une ligne — ajout (sans `tache`) ou modification. */
function FormLigne({ departId, tache, occupe, envoyer, fermer }: {
  departId: string; tache: TacheVue | null; occupe: boolean;
  envoyer: (fd: FormData) => void; fermer: () => void;
}) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); envoyer(new FormData(e.currentTarget)); }}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2"
    >
      <input type="hidden" name="departId" value={departId} />
      {tache && <input type="hidden" name="tacheId" value={tache.id} />}
      <Select name="categorie" defaultValue={tache?.categorie ?? "AUTRE"} aria-label="Catégorie" className="w-40">
        {CATEGORIES_TACHE.map((c) => <option key={c} value={c}>{LIBELLE_CATEGORIE_TACHE[c]}</option>)}
      </Select>
      <Input name="libelle" required defaultValue={tache?.libelle ?? ""} placeholder="À récupérer ou à faire" aria-label="Libellé" className="min-w-[12rem] flex-1" />
      <Input name="detail" defaultValue={tache?.detail ?? ""} placeholder="Détail" aria-label="Détail" className="min-w-[8rem] flex-1" />
      <Button size="sm" disabled={occupe}>{tache ? "Enregistrer" : "Ajouter"}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={fermer}>Fermer</Button>
    </form>
  );
}

/**
 * LA LISTE DE SORTIE (lot rhdepart) — préremplie depuis les données réelles à l'accord final, groupée par nature ;
 * chaque ligne se coche (qui, quand), se modifie, se retire ; on en ajoute. Les transferts de tâches et de sujets au
 * supérieur hiérarchique se font d'un geste, qui coche la ligne.
 */
export function DepartSortieListe({ departId, taches, peutAgir }: { departId: string; taches: TacheVue[]; peutAgir: boolean }) {
  const { busy, error, run } = useKeyedAction();
  const [edition, setEdition] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const appel = (cle: string, fn: (fd: FormData) => Promise<ActionResult>, fd: FormData, apres?: () => void) =>
    void run(cle, async () => { const r = await fn(fd); if (r.ok) { setMsg(r.message ?? null); apres?.(); } return r; });
  const sur = (champs: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(champs)) fd.set(k, v); return fd; };

  const faites = taches.filter((t) => t.faitLe).length;
  const groupes = CATEGORIES_TACHE.map((c) => ({ c, lignes: taches.filter((t) => t.categorie === c) })).filter((g) => g.lignes.length > 0);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Liste de sortie <span className="font-normal text-muted-foreground">· {faites}/{taches.length}</span></h3>
        {peutAgir && edition !== "nouvelle" && <Button size="sm" variant="outline" onClick={() => setEdition("nouvelle")}><Plus className="h-4 w-4" /> Ajouter une ligne</Button>}
      </div>
      {edition === "nouvelle" && (
        <FormLigne departId={departId} tache={null} occupe={!!busy} fermer={() => setEdition(null)} envoyer={(fd) => appel("nouvelle", ecrireLigneDeSortie, fd, () => setEdition(null))} />
      )}
      {taches.length === 0 && <p className="text-muted-foreground">Aucune ligne : ajoutez ce qu&apos;il faut récupérer.</p>}
      {groupes.map(({ c, lignes }) => (
        <div key={c} className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{LIBELLE_CATEGORIE_TACHE[c as CategorieTache]}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {lignes.map((t) => edition === t.id ? (
              <li key={t.id} className="p-1">
                <FormLigne departId={departId} tache={t} occupe={!!busy} fermer={() => setEdition(null)} envoyer={(fd) => appel(t.id, ecrireLigneDeSortie, fd, () => setEdition(null))} />
              </li>
            ) : (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input
                  type="checkbox" className="h-4 w-4 rounded border-input" checked={!!t.faitLe} disabled={!peutAgir || !!busy}
                  aria-label={t.faitLe ? `Remettre à faire : ${t.libelle}` : `Marquer fait : ${t.libelle}`}
                  onChange={(e) => appel(`c-${t.id}`, cocherLigneDeSortie, sur({ tacheId: t.id, fait: e.target.checked ? "true" : "false" }))}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn("[overflow-wrap:anywhere]", t.faitLe && "text-muted-foreground line-through")}>{t.libelle}</p>
                  {(t.detail || t.faitLe) && (
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {t.detail}{t.detail && t.faitLe ? " · " : ""}{t.faitLe ? `fait le ${t.faitLe}${t.faitPar ? ` par ${t.faitPar}` : ""}` : ""}
                    </p>
                  )}
                </div>
                {peutAgir && !t.faitLe && (t.source === SOURCE_TRANSFERT_TACHES || t.source === SOURCE_TRANSFERT_SUJETS) && (
                  <BoutonDecisif type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => appel(`t-${t.id}`, transfererLigneDeSortie, sur({ tacheId: t.id }))}>
                    <ArrowRightLeft className="h-4 w-4" /> Transférer
                  </BoutonDecisif>
                )}
                {peutAgir && (
                  <>
                    <Button type="button" size="icon" variant="ghost" aria-label={`Modifier : ${t.libelle}`} onClick={() => setEdition(t.id)}><Pencil className="h-4 w-4" /></Button>
                    <BoutonDecisif type="button" size="icon" variant="ghost" confirmation={`Retirer « ${t.libelle} »`} aria-label={`Retirer : ${t.libelle}`} disabled={!!busy}
                      onClick={() => appel(`r-${t.id}`, retirerLigneDeSortie, sur({ tacheId: t.id }))}>
                      <Trash2 className="h-4 w-4" />
                    </BoutonDecisif>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {msg && <Retour ton="succes" onFermer={() => setMsg(null)}>{msg}</Retour>}
      <Retour>{error}</Retour>
    </section>
  );
}
