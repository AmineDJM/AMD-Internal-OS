"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Eye, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Sheet } from "@/components/ui/sheet";
import { useAutoOpen } from "@/components/shared/use-auto-open";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MultiSelectField } from "@/components/shared/create-record-button";
import { createPromoMaterial } from "@/lib/actions/promo-material-actions";
import { ACTIONS, ACTION_AIDE, ACTION_LABEL } from "@/lib/promo-material/actions-fournisseur";
import { FAMILLES, FAMILLE_LABEL, familleQuantifiee } from "@/lib/promo/catalogue";
import { MENU_CATALOGUE_PROMO } from "@/lib/chemins/stock-promo";
import type { LigneDemandeSaisie } from "@/lib/promo-material/lignes-demande";
import { lettreDeSecours, texteDeLaLettre } from "../domaine/demande-devis-lettre";
import type { OptionCatalogue } from "@/lib/queries/promo-achats";

/**
 * LA DEMANDE DE MATÉRIEL PROMOTIONNEL, COMPOSÉE DE LIGNES DÈS SA CRÉATION (§118.171).
 *
 * « C'est directement ici que le demandeur ajoute les différentes lignes de matériel qu'il cherche
 * (selon les trois familles), la quantité et les actions — il peut ajouter des lignes à chaque
 * fois. » Un formulaire à champs fixes ne sait pas dire « autant de lignes que je veux » : celui-ci
 * tient une liste, et l'envoie en un seul champ (`lignes`) que l'action relit avec la règle de la
 * fiche. Ce composant ne décide RIEN : il ne valide pas une ligne (la règle est au serveur, et une
 * seconde copie ici finirait par ne plus accepter la même chose, §118.5) ; il compose et il montre
 * ce que le serveur refuse, ligne par ligne.
 *
 * Ce qu'il NE demande plus (décision du 01/10) : la Business Unit (« pas du tout pertinent ici »),
 * le budget estimé (« on ne l'a pas au début »), l'assistante qui retranscrira les devis, et
 * l'entité — celle où la personne travaille, déduite au serveur. Ni le « type de matériel »
 * (§118.173) : le catalogue EST la liste des supports, et chaque ligne en désigne un — un type
 * choisi à côté redisait la même chose, et pouvait la contredire (« Stylos » sur une demande de
 * fiches POSO).
 *
 * LA DEMANDE DE DEVIS SE VOIT AVANT DE PARTIR (§118.204). Elle n'a plus de geste à elle : elle part
 * d'elle-même à l'assistante de direction (tout de suite, ou dès que la demande est validée). Le
 * demandeur la voit donc ICI, dans « Articles demandés », avec ses précisions — l'aperçu est le texte
 * EXACT que l'assistante recevra (`texteDemandeDeDevis`, la même rédaction que le serveur).
 */

type Ligne = { uid: string; catalogueId: string; produitsOuverts: boolean };

export function DemandeMaterielForm({ catalogue, produits, onDone, onCancel, cancelLabel = "Annuler" }: {
  catalogue: OptionCatalogue[];
  produits: { id: string; nom: string }[];
  onDone?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const router = useRouter();
  // Une clé par ligne, stable quand on en RETIRE une : l'indice décalerait les saisies d'une
  // ligne sur sa voisine. `useId` plutôt qu'un compteur de module, que le serveur et le navigateur
  // ne compteraient pas pareil.
  const base = React.useId();
  const suivante = React.useRef(0);
  const nouvelleLigne = React.useCallback((): Ligne => ({ uid: `${base}${++suivante.current}`, catalogueId: "", produitsOuverts: false }), [base]);
  const [lignes, setLignes] = React.useState<Ligne[]>(() => [{ uid: `${base}0`, catalogueId: "", produitsOuverts: false }]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Verrou SYNCHRONE : un double clic part avant que `busy` n'ait désactivé le bouton, et ferait
  // deux demandes identiques (la règle de `RecordForm`, que ce formulaire ne peut pas emprunter).
  const verrou = React.useRef(false);
  const parId = React.useMemo(() => new Map(catalogue.map((c) => [c.id, c])), [catalogue]);
  const libellePromu = React.useMemo(() => new Map(produits.map((p) => [p.id, p.nom])), [produits]);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [apercuOuvert, setApercuOuvert] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [apercu, setApercu] = React.useState("");
  // L'APERÇU SE LIT APRÈS LE RENDU : les sélecteurs écrivent leurs champs cachés au commit — lu pendant le
  // rendu, le formulaire rendrait l'état d'un clic plus tôt.
  React.useEffect(() => {
    if (!apercuOuvert || !formRef.current) return;
    const saisie = new FormData(formRef.current);
    const texte = (k: string) => String(saisie.get(k) ?? "").trim();
    // LA LETTRE QUE L'AGENCE RECEVRA (Direction, 07/10) — sa version sans modèle ; Luna rédige la finale à l'envoi.
    setApercu(texteDeLaLettre(lettreDeSecours({
      titre: texte("title") || "(sans titre)", brief: texte("description") || null,
      articles: lignes.flatMap((l) => {
        const c = parId.get(l.catalogueId);
        if (!c) return [];
        const q = Number(texte(`${l.uid}:quantite`).replace(/\s/g, "").replace(",", "."));
        const autre = texte(`${l.uid}:autre`);
        return [{
          designation: c.nom, unite: c.unite,
          quantite: texte(`${l.uid}:quantite`) && Number.isFinite(q) ? q : null,
          prestations: saisie.getAll(`${l.uid}:actions`).map((a) => ACTION_LABEL[String(a) as keyof typeof ACTION_LABEL] ?? String(a)),
          produits: [...saisie.getAll(`${l.uid}:produitIds`).map((v) => libellePromu.get(String(v)) ?? String(v)), ...(autre ? [autre] : [])],
          precision: texte(`${l.uid}:commentaire`) || null,
        }];
      }),
    })));
  }, [apercuOuvert, tick, lignes, parId, libellePromu]);

  const maj = (uid: string, patch: Partial<Ligne>) => setLignes((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  async function envoyer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (verrou.current) return;
    verrou.current = true;
    setBusy(true);
    setErr(null);
    const saisie = new FormData(e.currentTarget);
    const fd = new FormData();
    for (const cle of ["title", "description", "neededBy"]) {
      const v = saisie.get(cle);
      if (typeof v === "string") fd.set(cle, v);
    }
    const envoi: LigneDemandeSaisie[] = lignes.map((l) => ({
      catalogueId: l.catalogueId,
      quantite: String(saisie.get(`${l.uid}:quantite`) ?? ""),
      actions: saisie.getAll(`${l.uid}:actions`).map(String),
      produitIds: saisie.getAll(`${l.uid}:produitIds`).map(String),
      autre: String(saisie.get(`${l.uid}:autre`) ?? ""),
      commentaire: String(saisie.get(`${l.uid}:commentaire`) ?? ""),
    }));
    fd.set("lignes", JSON.stringify(envoi));
    try {
      const r = await createPromoMaterial(undefined, fd);
      if (r.ok && r.id) {
        onDone?.();
        router.push(`/promo-material/${r.id}`);
        return;
      }
      setErr(r.error ?? "La demande n'a pas pu être créée.");
    } catch {
      setErr("L'enregistrement n'a pas abouti (connexion ou serveur). VÉRIFIEZ D'ABORD LA LISTE : la demande a pu être créée malgré tout — recommencer à l'aveugle créerait un doublon.");
    } finally {
      verrou.current = false;
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={envoyer} onChange={() => setTick((t) => t + 1)} onClick={() => setTick((t) => t + 1)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="mp-title">Campagne / matériel <span className="text-destructive">*</span></Label>
        <Input id="mp-title" name="title" required placeholder="Ex. Brochure Cardiomax 2026" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mp-description">Brief / description</Label>
        <Textarea id="mp-description" name="description" rows={3} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mp-needed-by" className="inline-flex items-center gap-1">
          Date de besoin
          <InfoBulle label="Date de besoin" align="left">
            Le jour où vous avez besoin du matériel. Elle s&apos;affiche en haut de la demande, en orange quand il reste moins de 15 jours
            et que le matériel n&apos;est pas livré. Vous pourrez la modifier.
          </InfoBulle>
        </Label>
        <Input id="mp-needed-by" name="neededBy" type="date" min={new Date().toISOString().slice(0, 10)} className="sm:max-w-[12rem]" />
      </div>

      <fieldset className="space-y-3">
        <legend className="flex items-center gap-1 text-sm font-semibold">
          Articles demandés <span className="text-destructive">*</span>
          <InfoBulle label="Comment remplir les articles" align="left">
            Une ligne par article du catalogue : sa quantité et ce qu&apos;on attend du fournisseur. C&apos;est ce qui sera fait chiffrer.
          </InfoBulle>
        </legend>
        {catalogue.length === 0 && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
            Le catalogue promotionnel est vide : le Super Admin (ou qui il désigne) y ajoute les supports, depuis
            {MENU_CATALOGUE_PROMO}.
          </p>
        )}
        <ol className="space-y-3">
          {lignes.map((l, i) => {
            const article = parId.get(l.catalogueId) ?? null;
            const quantifiee = article ? familleQuantifiee(article.famille) : true;
            const montreProduits = Boolean(article?.exigeProduit) || l.produitsOuverts;
            return (
              <li key={l.uid} className="space-y-2 rounded-lg border border-border p-3" aria-label={`Ligne ${i + 1}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">Ligne {i + 1}</span>
                  {lignes.length > 1 && (
                    <Button
                      type="button" size="sm" variant="ghost" disabled={busy}
                      onClick={() => setLignes((ls) => ls.filter((x) => x.uid !== l.uid))}
                      aria-label={`Retirer la ligne ${i + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div className="space-y-1">
                    <Label htmlFor={`${l.uid}-article`}>Article du catalogue</Label>
                    <Select
                      id={`${l.uid}-article`} value={l.catalogueId}
                      onChange={(e) => maj(l.uid, { catalogueId: e.target.value })}
                    >
                      <option value="">— Choisir l&apos;article —</option>
                      {FAMILLES.map((f) => {
                        const articles = catalogue.filter((c) => c.famille === f);
                        if (articles.length === 0) return null;
                        return (
                          <optgroup key={f} label={FAMILLE_LABEL[f]}>
                            {articles.map((c) => (
                              <option key={c.id} value={c.id}>{c.reference} — {c.nom}{c.exigeProduit ? " (par produit)" : ""}</option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${l.uid}-quantite`}>Quantité{article ? ` (${article.unite})` : ""}</Label>
                    <Input
                      id={`${l.uid}-quantite`} name={`${l.uid}:quantite`} inputMode="decimal"
                      disabled={!quantifiee} placeholder={quantifiee ? "Ex. 500" : "Sans quantité"}
                      className="text-right tabular-nums"
                    />
                    {!quantifiee && <p className="text-[0.6875rem] text-muted-foreground">Support numérique : pas de quantité.</p>}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs font-medium">Ce qu&apos;on attend du fournisseur</span>
                  <div className="flex flex-wrap gap-1.5">
                    {ACTIONS.map((a) => (
                      <label key={a} title={ACTION_AIDE[a]} className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-input px-3 py-1.5 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/10 sm:min-h-0 sm:px-2.5 sm:py-1">
                        <input type="checkbox" name={`${l.uid}:actions`} value={a} className="h-4 w-4 rounded border-input sm:h-3.5 sm:w-3.5" />
                        {ACTION_LABEL[a]}
                      </label>
                    ))}
                  </div>
                </div>
                {montreProduits ? (
                  <div className="space-y-1">
                    <span className="text-xs font-medium">Produit(s) promu(s){article?.exigeProduit ? " *" : ""}</span>
                    <MultiSelectField
                      field={{
                        type: "multiselect", name: `${l.uid}:produitIds`, label: `Produit(s) de la ligne ${i + 1}`,
                        options: produits.map((p) => ({ value: p.id, label: p.nom })),
                        required: Boolean(article?.exigeProduit),
                        searchPlaceholder: "Rechercher un produit, une gamme…", emptyLabel: "Aucune gamme ni produit actif dans les Business Units.",
                      }}
                    />
                    <Input name={`${l.uid}:autre`} aria-label={`Autre produit promu, ligne ${i + 1}`} placeholder="Autre produit (saisie libre)" />
                  </div>
                ) : (
                  <button type="button" onClick={() => maj(l.uid, { produitsOuverts: true })} className="min-h-9 py-2 text-left text-xs font-medium text-primary hover:underline sm:min-h-0 sm:py-0">
                    + Produits promus (facultatif)
                  </button>
                )}
                <div className="space-y-1">
                  <Label htmlFor={`${l.uid}-commentaire`}>Précision (facultatif)</Label>
                  <Input id={`${l.uid}-commentaire`} name={`${l.uid}:commentaire`} placeholder="Format, recto-verso, finition, délai…" />
                </div>
              </li>
            );
          })}
        </ol>
        <Button type="button" size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy || catalogue.length === 0} onClick={() => setLignes((ls) => [...ls, nouvelleLigne()])}>
          <Plus className="h-4 w-4" /> Ajouter une ligne
        </Button>
        {/* L'APERÇU AVANT ENVOI — fermé, discret : on vérifie si l'on veut, on ne lit pas un encadré de plus. La demande
            de devis part d'elle-même (à l'enregistrement, ou dès que la demande est validée) : c'est dit dans le ⓘ. */}
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <button
              type="button" onClick={() => setApercuOuvert((o) => !o)} aria-expanded={apercuOuvert}
              className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary hover:underline sm:min-h-0"
            >
              <Eye className="h-3.5 w-3.5" /> {apercuOuvert ? "Masquer la demande de devis" : "Voir la demande de devis"}
            </button>
            <InfoBulle label="Où part la demande de devis" align="left">
              La demande de devis part d&apos;elle-même au secrétariat (à l&apos;enregistrement, ou dès que votre demande est validée),
              en PDF et Word sur papier en-tête. Luna en rédige la version finale ; ceci en est l&apos;aperçu.
            </InfoBulle>
          </div>
          {apercuOuvert && (
            <pre aria-label="Aperçu de la demande de devis" className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs">{apercu}</pre>
          )}
        </div>
      </fieldset>

      {err && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{err}</span>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la demande
        </Button>
        {onCancel && <Button type="button" variant="outline" disabled={busy} onClick={onCancel} className="w-full sm:w-auto">{cancelLabel}</Button>}
      </div>
    </form>
  );
}

/**
 * LE BOUTON DE L'ÉCRAN « Matériel promotionnel » — le même formulaire que le panneau commun
 * d'Ad & Pro : une seule définition, deux portes d'entrée. `?new=1` l'ouvre (lien direct de la
 * vue unifiée, `createHref`).
 */
export function NouvelleDemandeMaterielButton({ catalogue, produits }: {
  catalogue: OptionCatalogue[];
  produits: { id: string; nom: string }[];
}) {
  const [open, setOpen] = React.useState(false);
  useAutoOpen("new", () => setOpen(true));
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvelle demande</Button>
      <Sheet
        open={open} onClose={() => setOpen(false)} width="lg"
        title="Demande de matériel promotionnel"
        description="Les articles à faire produire, acheter ou louer."
      >
        {open && <DemandeMaterielForm catalogue={catalogue} produits={produits} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}
