"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, FileCheck2, Loader2, Plus, Trash2, Upload, Library, PenSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PartyPicker } from "@/components/directory/party-picker";
import { ComposerPieceButton, type ComposerPieceProps } from "@/components/pieces/composer-piece";
import { createValidationRequest } from "@/lib/actions/validation-actions";
import { LIBELLE_SOURCE_BC, SOURCES_BC, type SourceBC } from "@/lib/bons-de-commande/prevalidation";
import { cn } from "@/lib/utils";

/**
 * « DEMANDER UNE VALIDATION » (Direction, 10/2026).
 *
 *   • L'OBJET à valider : un objet libre, ou un BON DE COMMANDE — importé depuis Legal, déposé depuis l'ordinateur, ou
 *     composé ici. Le BC est alors en PRÉ-VALIDATION : aucun centre ne le voit avant la validation finale.
 *   • LES VALIDATEURS : un principal, puis « + » pour en ajouter d'autres, dans l'ordre du circuit.
 *   • « Module concerné (routage auto si aucun validateur) » est retiré : on choisit qui valide.
 *
 * Le formulaire construit son envoi lui-même (comme le compositeur) : le compositeur, ouvert depuis ici, a ses propres
 * champs, qu'un `<form>` englobant enverrait avec les nôtres.
 */

export interface DemandeValidationProps {
  personnes: { value: string; label: string }[];
  priorites: { value: string; label: string }[];
  /** Les BC que la personne peut importer depuis Legal (`bcImportables`). */
  bcImportables: { id: string; label: string; montant: number | null }[];
  /** Peut-elle déposer un BC au registre ? (Legal ou Finances en création.) */
  peutDeposerBC: boolean;
  /** Le compositeur de BC, quand la personne peut en émettre. */
  composition: Omit<ComposerPieceProps, "typeInitial" | "typesAutorises" | "prevalidation" | "onEmis"> | null;
}

type Nature = "AUTRE" | "BON_DE_COMMANDE";

const ICONE_SOURCE: Record<SourceBC, typeof Library> = { LEGAL: Library, ORDINATEUR: Upload, COMPOSER: PenSquare };

export function DemanderUneValidation(props: DemandeValidationProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden /> Demander une validation
      </Button>
      {open && <Formulaire {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function Formulaire(props: DemandeValidationProps & { onClose: () => void }) {
  const router = useRouter();
  const [nature, setNature] = React.useState<Nature>("AUTRE");
  const [titre, setTitre] = React.useState("");
  const sourcesOuvertes = SOURCES_BC.filter((s) => s === "LEGAL" || (s === "ORDINATEUR" ? props.peutDeposerBC : props.composition !== null));
  const [source, setSource] = React.useState<SourceBC>("LEGAL");
  const [bcLegal, setBcLegal] = React.useState("");
  const [bcCompose, setBcCompose] = React.useState<{ legalDocumentId: string; reference: string } | null>(null);
  const [bcFichier, setBcFichier] = React.useState<File | null>(null);
  const [bcMontant, setBcMontant] = React.useState("");
  const [bcReference, setBcReference] = React.useState("");
  const [validateurs, setValidateurs] = React.useState<string[]>([""]);
  const [priorite, setPriorite] = React.useState("MEDIUM");
  const [echeance, setEcheance] = React.useState("");
  const [lien, setLien] = React.useState("");
  const [details, setDetails] = React.useState("");
  const [pieces, setPieces] = React.useState<File[]>([]);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [succes, setSucces] = React.useState<string | null>(null);
  const [envoi, startEnvoi] = React.useTransition();
  const fournisseurRef = React.useRef<HTMLDivElement>(null);

  const choisis = new Set(validateurs.filter(Boolean));
  const optionsPour = (i: number) => props.personnes.filter((p) => p.value === validateurs[i] || !choisis.has(p.value));
  const setValidateur = (i: number, v: string) => setValidateurs((l) => l.map((x, j) => (j === i ? v : x)));

  const envoyer = () => {
    setErreur(null);
    const fd = new FormData();
    fd.set("title", titre.trim());
    for (const v of validateurs) if (v) fd.append("validatorId", v);
    fd.set("priority", priorite);
    if (echeance) fd.set("deadline", echeance);
    if (details.trim()) fd.set("description", details.trim());
    for (const f of pieces) fd.append("files", f);
    if (nature === "BON_DE_COMMANDE") {
      fd.set("objectKind", "BON_DE_COMMANDE");
      fd.set("bcSource", source);
      if (source === "LEGAL" && bcLegal) fd.set("legalDocumentId", bcLegal);
      if (source === "COMPOSER" && bcCompose) fd.set("legalDocumentId", bcCompose.legalDocumentId);
      if (source === "ORDINATEUR") {
        if (bcFichier) fd.set("bcFile", bcFichier);
        if (bcMontant) fd.set("bcAmount", bcMontant);
        if (bcReference.trim()) fd.set("bcReference", bcReference.trim());
        // Le fournisseur vient de l'annuaire (le sélecteur pose ses champs cachés) : la même règle que Legal.
        fournisseurRef.current?.querySelectorAll<HTMLInputElement>('input[name="bcCounterpartyIds"]').forEach((i) => fd.append("bcCounterpartyIds", i.value));
      }
    } else if (lien.trim()) {
      fd.set("link", lien.trim());
    }
    startEnvoi(async () => {
      const r = await createValidationRequest(undefined, fd);
      if (!r.ok) { setErreur(r.error ?? "La demande n'a pas pu être envoyée."); return; }
      setSucces(r.message ?? "Demande envoyée.");
      router.refresh();
    });
  };

  if (succes) {
    return (
      <Sheet open onClose={props.onClose} title="Demander une validation">
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> {succes}
          </p>
          <Button type="button" onClick={props.onClose}>Fermer</Button>
        </div>
      </Sheet>
    );
  }

  const bcPret = nature !== "BON_DE_COMMANDE"
    || (source === "LEGAL" && Boolean(bcLegal))
    || (source === "COMPOSER" && bcCompose !== null)
    || (source === "ORDINATEUR" && bcFichier !== null);
  const peutEnvoyer = titre.trim() !== "" && Boolean(validateurs[0]) && bcPret && !envoi;

  return (
    <Sheet
      open onClose={props.onClose} width="lg"
      title="Demander une validation"
      description="Choisissez qui valide : un validateur principal, et d'autres au besoin, dans l'ordre du circuit."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose}>Annuler</Button>
          <Button type="button" onClick={envoyer} disabled={!peutEnvoyer}>
            {envoi && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {nature === "BON_DE_COMMANDE" ? "Envoyer en pré-validation" : "Envoyer la demande"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="dv-titre">Objet à valider</Label>
          <Input id="dv-titre" value={titre} onChange={(e) => setTitre(e.target.value)} placeholder="Ex. Courrier à signer, bon de commande stand JNC…" />
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium">Nature de l&apos;objet</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(["AUTRE", "BON_DE_COMMANDE"] as const).map((n) => (
              <button
                key={n} type="button" role="radio" aria-checked={nature === n} onClick={() => setNature(n)}
                className={cn("rounded-lg border px-3 py-2 text-left text-sm transition-colors", nature === n ? "border-primary bg-primary/5 font-medium text-primary" : "border-border hover:bg-secondary")}
              >
                {n === "AUTRE" ? "Autre objet" : "Bon de commande"}
              </button>
            ))}
          </div>
        </fieldset>

        {nature === "BON_DE_COMMANDE" && (
          <section className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Origine du bon de commande">
              {sourcesOuvertes.map((s) => {
                const Icone = ICONE_SOURCE[s];
                return (
                  <button
                    key={s} type="button" role="tab" aria-selected={source === s} onClick={() => setSource(s)}
                    className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium", source === s ? "border-primary bg-card text-primary" : "border-border bg-card/60 text-muted-foreground hover:text-foreground")}
                  >
                    <Icone className="h-3.5 w-3.5" aria-hidden /> {LIBELLE_SOURCE_BC[s]}
                  </button>
                );
              })}
            </div>

            {source === "LEGAL" && (
              <div className="space-y-1.5">
                <Label htmlFor="dv-bc">Bon de commande</Label>
                {props.bcImportables.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucun bon de commande à soumettre : ceux que vous lisez au registre sont déjà validés, signés ou soumis.</p>
                ) : (
                  <Select id="dv-bc" value={bcLegal} onChange={(e) => setBcLegal(e.target.value)}>
                    <option value="">— Choisir un bon de commande —</option>
                    {props.bcImportables.map((b) => (
                      <option key={b.id} value={b.id}>{b.label}{b.montant != null ? ` — ${Math.round(b.montant).toLocaleString("fr-FR")} DZD` : ""}</option>
                    ))}
                  </Select>
                )}
              </div>
            )}

            {source === "ORDINATEUR" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="dv-bc-fichier">Fichier du bon de commande</Label>
                  <Input id="dv-bc-fichier" type="file" onChange={(e) => setBcFichier(e.target.files?.[0] ?? null)} />
                </div>
                <div className="space-y-1.5 sm:col-span-2" ref={fournisseurRef}>
                  <Label>Fournisseur</Label>
                  <PartyPicker name="bcCounterpartyIds" arity={1} placeholder="Chercher le fournisseur dans l'annuaire" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dv-bc-montant">Montant TTC (DZD)</Label>
                  <Input id="dv-bc-montant" type="number" min={0} step="0.01" value={bcMontant} onChange={(e) => setBcMontant(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="dv-bc-ref">N° du bon de commande</Label>
                  <Input id="dv-bc-ref" value={bcReference} onChange={(e) => setBcReference(e.target.value)} placeholder="Ex. 040/DG/2026" />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Il est enregistré au registre Legal, en pré-validation.</p>
              </div>
            )}

            {source === "COMPOSER" && props.composition && (
              <div className="space-y-2">
                {bcCompose ? (
                  <p className="flex items-center gap-2 text-sm">
                    <FileCheck2 className="h-4 w-4 text-success" aria-hidden />
                    Bon de commande <strong>{bcCompose.reference || "composé"}</strong> émis, en pré-validation.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Composez le bon de commande sur le papier en-tête de la société : il naît en pré-validation et s&apos;attache à cette demande.</p>
                )}
                <ComposerPieceButton
                  {...props.composition}
                  typeInitial="BON_DE_COMMANDE"
                  typesAutorises={["BON_DE_COMMANDE"]}
                  prevalidation
                  onEmis={(p) => setBcCompose(p)}
                />
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Pré-validation : quand tous les validateurs auront accepté, vous demanderez la validation finale. Le bon de commande partira alors au centre de validation, puis à la signature (module Bons de commande).
            </p>
          </section>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium">Validateurs</legend>
          {validateurs.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{i === 0 ? "Principal" : `${i + 1}ᵉ validateur`}</span>
              <Select aria-label={i === 0 ? "Validateur principal" : `${i + 1}ᵉ validateur`} value={v} onChange={(e) => setValidateur(i, e.target.value)} className="min-w-0 flex-1">
                <option value="">— Choisir —</option>
                {optionsPour(i).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
              {i > 0 && (
                <button type="button" onClick={() => setValidateurs((l) => l.filter((_, j) => j !== i))} className="rounded-md p-2 text-muted-foreground hover:bg-secondary" aria-label="Retirer ce validateur">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setValidateurs((l) => [...l, ""])} disabled={!validateurs[validateurs.length - 1]}>
            <Plus className="h-4 w-4" aria-hidden /> Ajouter un validateur
          </Button>
          {validateurs.filter(Boolean).length > 1 && <p className="text-xs text-muted-foreground">Ils valident l&apos;un après l&apos;autre, dans cet ordre.</p>}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dv-prio">Priorité</Label>
            <Select id="dv-prio" value={priorite} onChange={(e) => setPriorite(e.target.value)}>
              {props.priorites.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dv-echeance">Échéance</Label>
            <Input id="dv-echeance" type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} />
          </div>
          {nature === "AUTRE" && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="dv-lien">Lien vers l&apos;objet (optionnel)</Label>
              <Input id="dv-lien" value={lien} onChange={(e) => setLien(e.target.value)} placeholder="/courrier/… ou /demandes/…" />
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="dv-details">Détails / contexte</Label>
            <Textarea id="dv-details" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="dv-pieces">Pièces jointes (optionnel)</Label>
            <Input id="dv-pieces" type="file" multiple onChange={(e) => setPieces(Array.from(e.target.files ?? []))} />
          </div>
        </div>

        {erreur && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {erreur}
          </p>
        )}
      </div>
    </Sheet>
  );
}
