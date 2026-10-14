"use client";

import * as React from "react";
import { Loader2, Plus, Trash2, Pencil, FileText, CheckCircle2, Wand2, Upload } from "lucide-react";
import {
  deposerDevisDemande, enregistrerLignesDevisDemande, retenirLignesDevisDemande, deposerBonDeCommandeDemande,
} from "@/lib/actions/secretariat-devis-actions";
import { ApercuBcDemande } from "./apercu-bc-demande";
import { TAUX_TVA_DEVIS, nombreSaisi, totauxDesLignes, type LigneDevisNatif } from "@/lib/secretariat/devis-natif";
import { CATEGORIES_AJOUT, type NatureAjout } from "@/lib/secretariat/pieces";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { PartyPicker } from "@/components/directory/party-picker";
import { DocumentUpload } from "@/components/documents/document-upload";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select, Label } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NATIFS ET LE BON DE COMMANDE, SUR LA FICHE D'UNE DEMANDE — « une interface
 * extrêmement simple » (Direction, 10/2026).
 *
 *   • `CarteDevis` — un devis : son fichier, ses lignes. L'assistante les RETRANSCRIT (un éditeur de
 *     cinq colonnes, totaux calculés) ; le demandeur COCHE celles qu'il retient.
 *   • `BcAGenerer` — un bouton par fournisseur : « Générer le bon de commande ».
 *   • `AjouterPiece` — UN bouton, qui demande la nature : devis, bon de commande, facture, justificatif.
 *
 * Chaque bouton n'est offert que si l'action l'acceptera (§118.83) : la page lit les mêmes règles
 * (`gereLaDemande`, `commandeLaDemande`) que les actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Resultat = { ok: boolean; error?: string; message?: string };

function useGeste() {
  const { enCours, rafraichir } = useRafraichir();
  const [enVol, setEnVol] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const run = async (action: (fd: FormData) => Promise<Resultat>, fd: FormData, apres?: () => void) => {
    setEnVol(true); setErr(null); setNote(null);
    const r = await action(fd);
    setEnVol(false);
    if (r.ok) { setNote(r.message ?? null); apres?.(); rafraichir(); } else setErr(r.error ?? "Erreur.");
  };
  return { busy: enVol || enCours, err, note, run, setErr };
}

// ─────────────────────────── L'éditeur de lignes ───────────────────────────

interface Rangee { id: string | null; designation: string; reference: string; quantite: string; prixUnitaire: string; tva: string }
const vide = (): Rangee => ({ id: null, designation: "", reference: "", quantite: "", prixUnitaire: "", tva: "19" });
const enRangee = (l: LigneDevisNatif): Rangee => ({ id: l.id, designation: l.designation, reference: l.reference ?? "", quantite: String(l.quantite), prixUnitaire: String(l.prixUnitaire), tva: String(l.tva) });
const cellule = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring";

function LignesEditeur({ rangees, setRangees }: { rangees: Rangee[]; setRangees: React.Dispatch<React.SetStateAction<Rangee[]>> }) {
  const maj = (i: number, k: keyof Rangee) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setRangees((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const lisibles = rangees.map((r) => ({ quantite: nombreSaisi(r.quantite) ?? 0, prixUnitaire: nombreSaisi(r.prixUnitaire) ?? 0, tva: nombreSaisi(r.tva) ?? 0 }))
    .filter((r) => Number.isFinite(r.quantite) && Number.isFinite(r.prixUnitaire) && Number.isFinite(r.tva));
  const t = totauxDesLignes(lisibles);
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {rangees.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-1.5 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:border-0 sm:p-0">
            <input aria-label={`Ligne ${i + 1} — désignation`} placeholder="Désignation" value={r.designation} onChange={maj(i, "designation")} className={cn(cellule, "col-span-2 sm:col-span-1")} />
            <input aria-label={`Ligne ${i + 1} — référence`} placeholder="Référence" value={r.reference} onChange={maj(i, "reference")} className={cn(cellule, "col-span-2 sm:col-span-1")} />
            <input aria-label={`Ligne ${i + 1} — quantité`} placeholder="Qté" inputMode="decimal" value={r.quantite} onChange={maj(i, "quantite")} className={cn(cellule, "text-right tabular-nums")} />
            <input aria-label={`Ligne ${i + 1} — prix unitaire HT`} placeholder="PU HT" inputMode="decimal" value={r.prixUnitaire} onChange={maj(i, "prixUnitaire")} className={cn(cellule, "text-right tabular-nums")} />
            <select aria-label={`Ligne ${i + 1} — TVA`} value={r.tva} onChange={maj(i, "tva")} className={cellule}>
              {TAUX_TVA_DEVIS.map((x) => <option key={x} value={String(x)}>{x} %</option>)}
            </select>
            <Button type="button" variant="ghost" size="sm" aria-label={`Retirer la ligne ${i + 1}`} onClick={() => setRangees((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [vide()]))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setRangees((rs) => [...rs, vide()])}><Plus className="h-4 w-4" /> Ajouter une ligne</Button>
        <p className="text-xs tabular-nums text-muted-foreground">HT {formatCurrency(t.ht)} · TVA {formatCurrency(t.tva)} · <span className="font-semibold text-foreground">TTC {formatCurrency(t.ttc)}</span></p>
      </div>
    </div>
  );
}

const lignesJson = (rangees: Rangee[]) => JSON.stringify(rangees.map((r) => ({ id: r.id, designation: r.designation, reference: r.reference, quantite: r.quantite, prixUnitaire: r.prixUnitaire, tva: r.tva })));

// ─────────────────────────── Un devis ───────────────────────────

export interface DevisVue {
  id: string;
  reference: string | null;
  titre: string;
  annule: boolean;
  fournisseur: string;
  fournisseurId: string | null;
  date: string | null;
  lignes: LigneDevisNatif[];
  fichier: { id: string; name: string } | null;
  /** Le libellé (numéro) des BC qui portent ses lignes, par identifiant — seuls les BC en vie. */
  bcs: Record<string, string>;
}

export function CarteDevis({ requestId, d, peutRetranscrire, peutRetenir }: { requestId: string; d: DevisVue; peutRetranscrire: boolean; peutRetenir: boolean }) {
  const g = useGeste();
  const [edition, setEdition] = React.useState(false);
  const [rangees, setRangees] = React.useState<Rangee[]>(() => (d.lignes.length ? d.lignes.map(enRangee) : [vide()]));
  const [coches, setCoches] = React.useState<Set<string>>(() => new Set(d.lignes.filter((l) => l.retenue).map((l) => l.id)));
  const commandee = (l: LigneDevisNatif) => Boolean(l.bcId && d.bcs[l.bcId]);
  const figee = d.lignes.some(commandee);
  const t = totauxDesLignes(d.lignes);
  const tRetenu = totauxDesLignes(d.lignes.filter((l) => coches.has(l.id)));
  const change = d.lignes.some((l) => coches.has(l.id) !== l.retenue);
  const nom = d.reference ? `n° ${d.reference}` : d.titre;

  return (
    <div className={cn("rounded-xl border border-border p-3", d.annule && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">Devis {d.fournisseur || "—"} <span className="font-normal text-muted-foreground">{nom}</span></p>
          <p className="text-xs text-muted-foreground">
            {d.date ? `du ${formatDate(d.date)} · ` : ""}{d.lignes.length ? `${d.lignes.length} ligne${d.lignes.length > 1 ? "s" : ""} · ${formatCurrency(t.ttc)} TTC` : "pas encore retranscrit"}
            {d.fichier && <> · <a href={`/api/documents/${d.fichier.id}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline"><FileText className="mr-0.5 inline h-3 w-3" />{d.fichier.name}</a></>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {d.annule && <Badge tone="neutral" dot={false}>Annulé</Badge>}
          {!d.annule && d.lignes.length === 0 && <Badge tone="warning" dot={false}>À retranscrire</Badge>}
          {peutRetranscrire && !d.annule && !figee && (
            <Button type="button" variant="outline" size="sm" onClick={() => { g.setErr(null); setRangees(d.lignes.length ? d.lignes.map(enRangee) : [vide()]); setEdition(true); }}>
              <Pencil className="h-3.5 w-3.5" /> {d.lignes.length ? "Corriger les lignes" : "Retranscrire"}
            </Button>
          )}
        </div>
      </div>

      {d.lignes.length > 0 && (
        <form action={(fd) => { fd.set("id", requestId); fd.set("devisId", d.id); for (const id of coches) fd.append("ligneId", id); return g.run(retenirLignesDevisDemande, fd); }} className="mt-2 space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className="w-8 py-1.5 pr-2"><span className="sr-only">Retenue</span></th>
                  <th className="py-1.5 pr-2 font-semibold">Désignation</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">Qté</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">PU HT</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">TVA</th>
                  <th className="py-1.5 text-right font-semibold">Total HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.lignes.map((l) => (
                  <tr key={l.id} className={cn(coches.has(l.id) && "bg-primary/5")}>
                    <td className="py-1.5 pr-2 align-top">
                      <input
                        type="checkbox" aria-label={`Retenir « ${l.designation} »`} className="mt-1 h-4 w-4"
                        checked={coches.has(l.id)} disabled={!peutRetenir || d.annule || commandee(l)}
                        onChange={(e) => setCoches((s) => { const n = new Set(s); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className="font-medium">{l.designation}</span>
                      {l.reference && <span className="block text-xs text-muted-foreground">Réf. {l.reference}</span>}
                      {commandee(l) && <span className="block text-xs text-success">Commandée — {d.bcs[l.bcId!]}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{l.quantite.toLocaleString("fr-FR")}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(l.prixUnitaire)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{l.tva} %</td>
                    <td className="py-1.5 text-right tabular-nums">{formatCurrency(l.quantite * l.prixUnitaire)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {peutRetenir && !d.annule && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Retenu : <span className="font-semibold text-foreground">{formatCurrency(tRetenu.ttc)} TTC</span> ({coches.size} ligne{coches.size > 1 ? "s" : ""})</p>
              <Button type="submit" size="sm" disabled={g.busy || !change}>{g.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Retenir ces lignes</Button>
            </div>
          )}
          {!peutRetenir && d.lignes.some((l) => l.retenue) && (
            <p className="text-xs text-muted-foreground">Retenu par le demandeur : {formatCurrency(totauxDesLignes(d.lignes.filter((l) => l.retenue)).ttc)} TTC.</p>
          )}
          {!peutRetenir && !d.lignes.some((l) => l.retenue) && !d.annule && (
            <p className="text-xs text-muted-foreground">Le demandeur coche les lignes qu&apos;il retient, puis génère le bon de commande.</p>
          )}
        </form>
      )}
      {g.note && <p className="mt-1.5 text-xs text-success">{g.note}</p>}
      {g.err && !edition && <p className="mt-1.5 text-xs text-destructive">{g.err}</p>}

      <Sheet open={edition} onClose={() => setEdition(false)} title={`Retranscrire le devis ${nom}`} description="Une ligne par article : désignation, référence, quantité, prix unitaire HT et TVA. Le fichier reste attaché au devis." width="lg">
        <form action={(fd) => { fd.set("id", requestId); fd.set("devisId", d.id); fd.set("lignes", lignesJson(rangees)); return g.run(enregistrerLignesDevisDemande, fd, () => setEdition(false)); }} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Fournisseur</Label><PartyPicker name="supplierId" arity={1} defaultValue={d.fournisseurId ? [d.fournisseurId] : []} placeholder="Choisir dans l'annuaire" /></div>
            <div className="space-y-1.5"><Label htmlFor={`date-${d.id}`}>Date du devis</Label><Input id={`date-${d.id}`} type="date" name="quoteDate" defaultValue={d.date ?? undefined} /></div>
          </div>
          <LignesEditeur rangees={rangees} setRangees={setRangees} />
          {g.err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{g.err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEdition(false)}>Fermer</Button>
            <Button type="submit" disabled={g.busy}>{g.busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer les lignes</Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

// ─────────────────────────── Les BC à générer ───────────────────────────

export interface BcAGenererVue { cle: string; fournisseur: string; nbLignes: number; ttc: number; devis: string[] }

/**
 * LES BC À GÉNÉRER — UN par fournisseur. « Générer le bon de commande » OUVRE L'APERÇU (Direction, 14/10/2026 — « Je veux
 * l'aperçu obligatoire ») : le composeur pré-rempli, le PDF à blanc ; le BC n'est émis que par « Valider et envoyer », depuis
 * l'aperçu. Rien n'est écrit tant qu'on ne valide pas.
 */
export function BcAGenerer({ requestId, groupes, peutGenerer }: { requestId: string; groupes: BcAGenererVue[]; peutGenerer: boolean }) {
  const [ouvert, setOuvert] = React.useState<BcAGenererVue | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  if (groupes.length === 0 && !note) return null;
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3">
      {groupes.map((x) => (
        <div key={x.cle} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm">
            <p className="font-semibold">À commander chez {x.fournisseur}</p>
            <p className="text-xs text-muted-foreground">{x.nbLignes} ligne{x.nbLignes > 1 ? "s" : ""} retenue{x.nbLignes > 1 ? "s" : ""} · {formatCurrency(x.ttc)} TTC · {x.devis.join(", ")}</p>
          </div>
          {peutGenerer
            ? <Button type="button" size="sm" onClick={() => { setNote(null); setOuvert(x); }}><Wand2 className="h-4 w-4" /> Générer le bon de commande</Button>
            : <span className="text-xs text-muted-foreground">En attente du demandeur, qui génère le bon de commande.</span>}
        </div>
      ))}
      {peutGenerer && groupes.length > 0 && <p className="text-xs text-muted-foreground">Le bon de commande s&apos;ouvre en aperçu : relisez-le, corrigez au besoin, puis « Valider et envoyer ». Aucun numéro n&apos;est attribué avant.</p>}
      {note && <p className="text-xs text-success">{note}</p>}
      {ouvert && (
        <ApercuBcDemande requestId={requestId} cle={ouvert.cle} fournisseur={ouvert.fournisseur} onClose={() => setOuvert(null)} onEmis={setNote} />
      )}
    </div>
  );
}

// ─────────────────────────── + Ajouter une pièce ───────────────────────────

const LIBELLE_NATURE: Record<NatureAjout, string> = { DEVIS: "Devis fournisseur", BC: "Bon de commande", FACTURE: "Facture", JUSTIFICATIF: "Justificatif" };

export function AjouterPiece({ requestId, natures, devis }: {
  requestId: string;
  /** Les natures que la personne peut déposer — la page lit les règles des actions. */
  natures: NatureAjout[];
  /** Les devis de la demande, pour dire de quel devis un BC déposé découle. */
  devis: { id: string; libelle: string }[];
}) {
  const g = useGeste();
  const [ouvert, setOuvert] = React.useState(false);
  const [nature, setNature] = React.useState<NatureAjout | null>(null);
  const [rangees, setRangees] = React.useState<Rangee[]>([vide()]);
  if (natures.length === 0) return null;
  const fermer = () => { setOuvert(false); setNature(null); };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => { g.setErr(null); setNature(natures.length === 1 ? natures[0] : null); setRangees([vide()]); setOuvert(true); }}>
        <Plus className="h-4 w-4" /> Ajouter une pièce
      </Button>
      <Sheet open={ouvert} onClose={fermer} title={nature ? LIBELLE_NATURE[nature] : "Ajouter une pièce"} description={nature ? undefined : "Que déposez-vous ? La pièce se range dans sa case."} width="lg">
        {!nature && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {natures.map((n) => (
              <button key={n} type="button" onClick={() => setNature(n)} className="rounded-lg border border-border p-3 text-left text-sm font-medium hover:bg-secondary">{LIBELLE_NATURE[n]}</button>
            ))}
          </div>
        )}

        {nature === "DEVIS" && (
          <form action={(fd) => { fd.set("id", requestId); fd.set("lignes", lignesJson(rangees)); return g.run(deposerDevisDemande, fd, fermer); }} className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="devis-fichier">Le devis du fournisseur <span className="text-destructive">*</span></Label><Input id="devis-fichier" name="attachment" type="file" required /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3"><Label>Fournisseur <span className="text-destructive">*</span></Label><PartyPicker name="supplierId" arity={1} placeholder="Choisir dans l'annuaire" /></div>
              <div className="space-y-1.5"><Label htmlFor="devis-ref">N° du devis</Label><Input id="devis-ref" name="reference" /></div>
              <div className="space-y-1.5"><Label htmlFor="devis-date">Date du devis</Label><Input id="devis-date" name="quoteDate" type="date" /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Lignes du devis <span className="text-muted-foreground">(maintenant, ou plus tard depuis la carte du devis)</span></Label>
              <LignesEditeur rangees={rangees} setRangees={setRangees} />
            </div>
            {g.err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{g.err}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={fermer}>Fermer</Button><Button type="submit" disabled={g.busy}>{g.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer le devis</Button></div>
          </form>
        )}

        {nature === "BC" && (
          <form action={(fd) => { fd.set("id", requestId); return g.run(deposerBonDeCommandeDemande, fd, fermer); }} className="space-y-3">
            <p className="text-xs text-muted-foreground">Un bon de commande déjà établi : il passe par le centre de validations (au-dessus de son seuil), puis par la signature, comme un BC généré.</p>
            <div className="space-y-1.5"><Label htmlFor="bc-fichier">Le bon de commande <span className="text-destructive">*</span></Label><Input id="bc-fichier" name="attachment" type="file" required /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2"><Label>Fournisseur</Label><PartyPicker name="supplierId" arity={1} placeholder="Choisir dans l'annuaire (ou le devis ci-dessous)" /></div>
              <div className="space-y-1.5"><Label htmlFor="bc-ref">N° du BC</Label><Input id="bc-ref" name="reference" /></div>
              <div className="space-y-1.5"><Label htmlFor="bc-montant">Montant TTC (DZD) <span className="text-destructive">*</span></Label><Input id="bc-montant" name="amount" inputMode="decimal" required className="text-right tabular-nums" /></div>
              {devis.length > 0 && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="bc-devis">Découle du devis</Label>
                  <Select id="bc-devis" name="devisId" defaultValue="">
                    <option value="">— Aucun —</option>
                    {devis.map((x) => <option key={x.id} value={x.id}>{x.libelle}</option>)}
                  </Select>
                </div>
              )}
            </div>
            {g.err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{g.err}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={fermer}>Fermer</Button><BoutonDecisif type="submit" disabled={g.busy}>{g.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer le bon de commande</BoutonDecisif></div>
          </form>
        )}

        {(nature === "FACTURE" || nature === "JUSTIFICATIF") && (
          <div className="space-y-3">
            <DocumentUpload entityType="ADMIN_REQUEST" entityId={requestId} categories={CATEGORIES_AJOUT[nature]} onUploaded={() => { fermer(); }} />
          </div>
        )}
        {nature && natures.length > 1 && (
          <button type="button" className="mt-3 text-xs text-muted-foreground hover:underline" onClick={() => setNature(null)}>← Changer de nature</button>
        )}
      </Sheet>
    </>
  );
}
