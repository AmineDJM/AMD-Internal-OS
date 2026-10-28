"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { enregistrerBesoinService, retirerBesoinService } from "@/lib/actions/besoins-services-actions";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";

export interface LignePrevisionEcran {
  cle: string;
  lieu: string;
  decideur: string | null;
  actuel: number | null;
  precedent: number | null;
  evolution: number | null;
  /** La ligne de l'année affichée, quand un seul produit est choisi — c'est elle qui se corrige. */
  ligne: { id: string; quantite: number; note: string | null } | null;
}

const nb = (n: number) => n.toLocaleString("fr-FR").replace(/ /g, " ");
const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";

/**
 * « PRÉVISIONS DES SERVICES » — le besoin que chaque décideur a annoncé pour l'an prochain, face à l'année d'avant
 * (maquette validée, 10/2026). La saisie se fait d'abord dans le rapport de visite du KAM ; ici, on ajoute ou corrige
 * — produit par produit (sur « Tous les produits », la table se lit, elle ne s'édite pas).
 */
export function PrevisionsServices({
  lignes, annee, produit, decideurs, peutSaisir,
}: {
  lignes: LignePrevisionEcran[];
  annee: number;
  /** Le produit choisi (canonique) — null sur toute la BU. */
  produit: { productId: string; nom: string } | null;
  /** Les décideurs du panel rattachés à un établissement. */
  decideurs: { id: string; libelle: string }[];
  peutSaisir: boolean;
}) {
  const { busy, err, setErr, run: lancer } = useAction();
  const confirmer = useConfirmer();
  const [ajout, setAjout] = React.useState(false);
  const [edition, setEdition] = React.useState<LignePrevisionEcran | null>(null);
  const editable = peutSaisir && !!produit;

  const run = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => lancer(() => action(fd));
  const fermer = () => { setAjout(false); setEdition(null); setErr(null); };

  return (
    <section className="surface min-w-0 overflow-hidden rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
          Prévisions des services
          <InfoBulle label="À propos : Prévisions des services">
            Le décideur (H) fixe les prévisions de son service, qui fixent le volume de l&apos;appel d&apos;offres. Besoin en boîtes
            annoncé pour {annee}, saisi par le KAM à la visite du décideur (ou ici) ; comparé à {annee - 1}.
            {peutSaisir && !produit ? " Choisissez un produit pour ajouter ou corriger." : ""}
          </InfoBulle>
        </h2>
        {editable && decideurs.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => { setErr(null); setAjout(true); }} disabled={busy}>
            <Plus className="h-4 w-4" /> Ajouter
          </Button>
        )}
      </header>
      {err && !ajout && !edition && <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p>}
      {lignes.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">Aucun besoin saisi pour {annee - 1} ni {annee}.</p>
      ) : (
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="border-b border-border">
                <th className={cn(TH, "sticky left-0 z-[1] bg-card")}>Service · décideur</th>
                <th className={cn(TH, "text-right")}>Besoin {annee}</th>
                <th className={TH}>vs {annee - 1}</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => {
                const ouvrable = editable && !!l.ligne;
                return (
                  <tr key={l.cle} className="group border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="sticky left-0 z-[1] max-w-[260px] bg-card px-3 py-2.5 group-hover:bg-secondary">
                      {ouvrable ? (
                        <button type="button" onClick={() => { setErr(null); setEdition(l); }} className="block text-left hover:text-primary hover:underline [overflow-wrap:anywhere]">
                          {l.lieu}{l.decideur ? ` · ${l.decideur}` : ""}
                        </button>
                      ) : (
                        <span className="block [overflow-wrap:anywhere]">{l.lieu}{l.decideur ? ` · ${l.decideur}` : ""}</span>
                      )}
                    </td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 text-right tabular-nums", l.actuel === null && "text-muted-foreground")}>{l.actuel === null ? "—" : nb(l.actuel)}</td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 tabular-nums", l.evolution === null ? "text-muted-foreground" : l.evolution > 0 ? "text-success" : l.evolution < 0 ? "text-destructive" : "text-muted-foreground")}>
                      {l.evolution === null ? (l.precedent === null ? "—" : `${nb(l.precedent)} en ${annee - 1}`) : l.evolution === 0 ? "=" : `${l.evolution > 0 ? "+" : "−"}${Math.round(Math.abs(l.evolution) * 100)} %`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={ajout} onClose={fermer} title={`Besoin annuel — ${produit?.nom ?? ""}`} description="Annoncé par un décideur" width="md">
        <form className="space-y-3" action={async (fd) => { if (produit) fd.set("productId", produit.productId); if (await run(enregistrerBesoinService, fd)) fermer(); }}>
          <div>
            <Label htmlFor="besoin-decideur">Décideur</Label>
            <Select id="besoin-decideur" name="decideurId" required defaultValue="">
              <option value="" disabled>— Choisir —</option>
              {decideurs.map((d) => <option key={d.id} value={d.id}>{d.libelle}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="besoin-annee">Année</Label>
              <Select id="besoin-annee" name="annee" defaultValue={String(annee)}>
                <option value={String(annee)}>{annee}</option>
                <option value={String(annee - 1)}>{annee - 1}</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="besoin-quantite">Boîtes</Label>
              <Input id="besoin-quantite" name="quantite" inputMode="numeric" required />
            </div>
          </div>
          <div>
            <Label htmlFor="besoin-note">Note</Label>
            <Input id="besoin-note" name="note" placeholder="Comité du médicament de novembre…" />
          </div>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={fermer} disabled={busy}>Annuler</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>

      <Sheet open={edition !== null} onClose={fermer} title={edition ? edition.lieu : ""} description={edition?.decideur ? `Annoncé par ${edition.decideur} · ${annee}` : String(annee)} width="md">
        {edition?.ligne && (
          <form className="space-y-3" action={async (fd) => { fd.set("id", edition.ligne!.id); if (await run(enregistrerBesoinService, fd)) fermer(); }}>
            <div>
              <Label htmlFor="besoin-edit-quantite">Boîtes</Label>
              <Input id="besoin-edit-quantite" name="quantite" inputMode="numeric" required defaultValue={String(edition.ligne.quantite)} />
            </div>
            <div>
              <Label htmlFor="besoin-edit-note">Note</Label>
              <Input id="besoin-edit-note" name="note" defaultValue={edition.ligne.note ?? ""} />
            </div>
            {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="outline" disabled={busy}
                onClick={async () => {
                  if (!(await confirmer("Retirer ce besoin ?"))) return;
                  const fd = new FormData();
                  fd.set("id", edition.ligne!.id);
                  if (await run(retirerBesoinService, fd)) fermer();
                }}>
                Retirer
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={fermer} disabled={busy}>Annuler</Button>
                <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
              </div>
            </div>
          </form>
        )}
      </Sheet>
    </section>
  );
}
