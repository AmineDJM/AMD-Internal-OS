"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { AlertCircle, CheckCircle2, Plus } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { enregistrerArticleDemandePromo, retirerArticleDemandePromo, proposerArticleAuCataloguePromo } from "@/lib/actions/promo-demande-actions";
import { ACTIONS, ACTION_AIDE, ACTION_LABEL } from "@/lib/promo-material/actions-fournisseur";
import { FAMILLES, FAMILLE_LABEL } from "@/lib/promo/catalogue";
import { libellesPromusDeLArticle, type ArticleDemandeLu } from "@/lib/promo-material/achats";
import type { ArticleDeLaFiche, EtatPrestation } from "@/lib/promo-material/fiche";
import type { OptionCatalogue } from "@/lib/queries/promo-achats";
import type { ActionResult } from "@/lib/actions/types";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { MenuLigne, type EntreeMenu } from "./menu-ligne";

/**
 * LES ARTICLES DEMANDÉS — la demande d'achat ou de location, piochée dans le catalogue (§118.165), en TABLEAU (maquette
 * validée, 10/2026) : chaque article avec ses prestations (vert : une ligne retenue les chiffre ; orange : demandées, sans
 * devis), le fournisseur retenu, le coût retenu et le coût unitaire. « Autre article » saisit librement ce qui n'est pas au
 * catalogue, et « Proposer au catalogue » l'y fait ajouter.
 *
 * L'écran ne décide d'aucun droit : `canEdit` est tranché au serveur (le demandeur ou la Direction, tant que le choix n'est
 * pas parti en validation — la règle de l'action), et l'action la relit.
 */

/** La précision du demandeur, sans les guillemets dont on l'entoure parfois. */
const sansGuillemets = (s: string) => s.trim().replace(/^["«»“”\s]+|["«»“”\s]+$/g, "");
const dzd = (n: number | null) => (n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: 2 }));
const quantite = (n: number | null) => (n == null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: 3 }));

const PASTILLE: Record<EtatPrestation, string> = {
  retenue: "bg-success/10 text-success border-transparent",
  chiffree: "border-border text-muted-foreground",
  manquante: "bg-warning/10 text-warning border-transparent",
};
const AIDE_PASTILLE: Record<EtatPrestation, string> = { retenue: "retenue", chiffree: "chiffrée, non retenue", manquante: "sans devis" };

export function PromoArticlesCard({ id, lignes, canEdit, options, avertissement, peutProposer, tientLeCatalogue }: {
  id: string;
  lignes: ArticleDeLaFiche[];
  canEdit: boolean;
  /** Ce qu'un changement de la liste entraîne à l'étape du dossier (§118.190) — dit AVANT le clic. */
  avertissement?: string | null;
  /** Le catalogue actif et les produits — chargés seulement quand la personne peut composer. */
  options: { catalogue: OptionCatalogue[]; produits: { id: string; nom: string }[] } | null;
  /** Le demandeur (ou la Direction) peut proposer un « autre article » au catalogue. */
  peutProposer: boolean;
  /** …et l'y ajoute lui-même s'il tient le catalogue. */
  tientLeCatalogue: boolean;
}) {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : une fiche ouverte avant la fin rouvrirait l'état d'avant — les gestes attendent.
  const { enCours, rafraichir } = useRafraichir();
  const [edition, setEdition] = React.useState<ArticleDemandeLu | "nouveau" | null>(null);
  const [libre, setLibre] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const occupe = saving || enCours;
  const confirmer = useConfirmer();

  const geste = async (fn: () => Promise<ActionResult>) => {
    setSaving(true); setErr(null); setMsg(null);
    let r: ActionResult;
    try {
      r = await fn();
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setSaving(false);
    }
    if (r.ok) { setMsg(r.message ?? null); rafraichir(); } else setErr(r.error ?? "Le geste n'a pas abouti.");
  };
  const fdArticle = (a: ArticleDemandeLu) => { const fd = new FormData(); fd.set("promoMaterialId", id); fd.set("requestItemId", a.id); return fd; };
  const ouvrir = (a: ArticleDemandeLu | "nouveau") => { setLibre(a !== "nouveau" && Boolean(a.horsCatalogue)); setEdition(a); };

  // `exactOptionalPropertyTypes` : une clé facultative absente ne s'écrit pas `undefined` — on la
  // pose seulement quand elle a une valeur.
  const champs = (a: ArticleDemandeLu | null): FieldDef[] => {
    const quantiteChamp: Extract<FieldDef, { type: "text" | "number" | "date" | "datetime-local" }> = { type: "number", name: "quantite", label: "Quantité souhaitée", hint: "Vide pour un support numérique ou une conception seule." };
    if (a?.quantite != null) quantiteChamp.defaultValue = a.quantite;
    const commentaire: Extract<FieldDef, { type: "textarea" }> = { type: "textarea", name: "commentaire", label: "Commentaire", placeholder: "Format, recto-verso, finition, délai…" };
    if (a?.commentaire) commentaire.defaultValue = a.commentaire;
    const autre: Extract<FieldDef, { type: "text" | "number" | "date" | "datetime-local" }> = { type: "text", name: "autre", label: "Autre produit promu (saisie libre)", hint: "Un produit qui n'est dans aucune liste — écrit tel que l'assistante le cherchera." };
    if (a?.choixPromus?.autre) autre.defaultValue = a.choixPromus.autre;
    const champs: FieldDef[] = [{ type: "hidden", name: "promoMaterialId", value: id }];
    if (a) champs.push({ type: "hidden", name: "requestItemId", value: a.id });
    if (libre) {
      // « AUTRE ARTICLE » : son nom, sa famille, une description — il entre au catalogue archivé, le temps qu'on l'y ajoute.
      const nom: Extract<FieldDef, { type: "text" | "number" | "date" | "datetime-local" }> = { type: "text", name: "autreNom", label: "Article", required: true, placeholder: "Boîte de lingettes brandées" };
      if (a?.horsCatalogue) nom.defaultValue = a.nom;
      const famille: Extract<FieldDef, { type: "select" }> = {
        type: "select", name: "autreFamille", label: "Famille", required: true, placeholder: "Choisir la famille",
        options: FAMILLES.map((f) => ({ value: f, label: FAMILLE_LABEL[f] })),
      };
      if (a?.horsCatalogue) famille.defaultValue = a.famille;
      const description: Extract<FieldDef, { type: "text" | "number" | "date" | "datetime-local" }> = { type: "text", name: "autreDescription", label: "Description", placeholder: "facultatif" };
      if (a?.horsCatalogue?.description) description.defaultValue = a.horsCatalogue.description;
      champs.push({ type: "hidden", name: "catalogueId", value: "AUTRE" }, nom, famille, description);
    } else {
      const catalogue: Extract<FieldDef, { type: "select" }> = {
        type: "select", name: "catalogueId", label: "Article du catalogue", required: true, placeholder: "Choisir l'article",
        options: (options?.catalogue ?? []).map((c) => ({
          value: c.id,
          label: `${c.reference} — ${c.nom} (${FAMILLE_LABEL[c.famille]}${c.exigeProduit ? ", par produit" : ""})`,
        })),
      };
      if (a && !a.horsCatalogue) catalogue.defaultValue = a.catalogueId;
      if (options && options.catalogue.length === 0) catalogue.hint = "Le catalogue est vide : choisissez « Autre article ».";
      champs.push(catalogue);
    }
    champs.push(
      {
        type: "multiselect", name: "produitIds", label: "Produit(s) promu(s)",
        options: (options?.produits ?? []).map((p) => ({ value: p.id, label: p.nom })),
        defaultValue: a ? (a.choixPromus?.codes ?? a.produits.map((p) => p.id)) : [],
        hint: "La société en général, une gamme, ou les produits des Business Units. Obligatoire pour un article « par produit » (fiche posologique, aide de visite).",
        searchPlaceholder: "Rechercher un produit, une gamme…", emptyLabel: "Aucune gamme ni produit actif dans les Business Units.",
      },
      autre,
      {
        type: "multiselect", name: "actions", label: "Ce qu'on attend du fournisseur", required: true,
        options: ACTIONS.map((x) => ({ value: x, label: `${ACTION_LABEL[x]} — ${ACTION_AIDE[x]}` })),
        defaultValue: a ? [...a.actions] : [],
        hint: "Une ou plusieurs : une fiche se conçoit puis s'imprime — souvent deux fournisseurs.",
      },
      quantiteChamp,
      commentaire,
    );
    return champs;
  };

  const action = async (_prev: ActionResult | undefined, fd: FormData): Promise<ActionResult> => {
    let r: ActionResult;
    try {
      r = await enregistrerArticleDemandePromo(fd);
    } catch {
      return { ok: false, error: actionFailureMessage("THROWN") };
    }
    if (r.ok) { setMsg(r.message ?? null); setErr(null); rafraichir(); }
    return r;
  };

  const entrees = (a: ArticleDemandeLu): EntreeMenu[] => [
    ...(canEdit ? [{ libelle: "Corriger", onClick: () => ouvrir(a), disabled: occupe }] : []),
    ...(peutProposer && a.horsCatalogue
      ? [{ libelle: tientLeCatalogue ? "Ajouter au catalogue" : "Proposer au catalogue", onClick: () => geste(() => proposerArticleAuCataloguePromo(fdArticle(a))), disabled: occupe }]
      : []),
    ...(canEdit ? [{ libelle: "Retirer de la demande", danger: true, onClick: async () => { if (await confirmer(`Retirer ${a.reference} ${a.nom} de la demande ?`)) void geste(() => retirerArticleDemandePromo(fdArticle(a))); }, disabled: occupe }] : []),
  ];

  return (
    <section className="surface overflow-hidden" aria-labelledby="titre-articles">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="titre-articles" className="text-[0.9375rem] font-semibold">Articles demandés</h2>
        {canEdit && (
          <span className="flex items-center gap-1">
            {avertissement && <InfoBulle align="right" label="Ce qu'entraîne un changement">{avertissement}</InfoBulle>}
            <Button size="sm" variant="outline" disabled={occupe} onClick={() => ouvrir("nouveau")}><Plus className="h-4 w-4" /> Ajouter un article</Button>
          </span>
        )}
      </header>

      {lignes.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Aucun article demandé.</p>
      ) : (
        // TABLEAU AU TÉLÉPHONE AUSSI : il défile dans son conteneur, la colonne « Article » reste fixe.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">Article</th>
                <th className="px-3 py-2 text-right font-medium">Quantité</th>
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Prestations
                    <InfoBulle label="Les couleurs des prestations" align="left">
                      Vert : une ligne de devis retenue la chiffre. Gris : chiffrée, pas retenue. Orange : demandée, aucun devis ne la chiffre encore.
                    </InfoBulle>
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">Fournisseur retenu</th>
                <th className="px-3 py-2 text-right font-medium">Coût retenu HT</th>
                <th className="px-3 py-2 text-right font-medium">Coût unitaire</th>
                <th className="w-10 px-2 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lignes.map(({ article: a, prestations, fournisseurs, coutHT, coutUnitaire }) => {
                const promus = libellesPromusDeLArticle(a);
                const precision = a.commentaire ? sansGuillemets(a.commentaire) : "";
                const secondaire = [FAMILLE_LABEL[a.famille], a.horsCatalogue?.description ?? "", promus.join(", "), precision].filter(Boolean).join(" · ");
                const menu = entrees(a);
                return (
                  <tr key={a.id} className="border-t border-border align-middle">
                    <td className="sticky left-0 z-[1] max-w-[18rem] bg-card px-3 py-2">
                      <p className="font-medium [overflow-wrap:anywhere]">
                        {a.nom}
                        {a.horsCatalogue && <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-px align-middle text-[0.6875rem] font-normal text-primary">hors catalogue</span>}
                      </p>
                      {secondaire && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{secondaire}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{quantite(a.quantite)}{a.quantite != null ? <span className="text-muted-foreground"> {a.unite}</span> : null}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {prestations.map((p) => (
                          <span key={p.action} title={AIDE_PASTILLE[p.etat]} className={`whitespace-nowrap rounded-full border px-1.5 py-px text-[0.6875rem] ${PASTILLE[p.etat]}`}>
                            {ACTION_LABEL[p.action].toLowerCase()}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2">{fournisseurs.length ? fournisseurs.join(", ") : <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{dzd(coutHT)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{dzd(coutUnitaire)}</td>
                    <td className="px-2 py-2 text-right">{menu.length > 0 && <MenuLigne entrees={menu} label={`Actions — ${a.nom}`} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(err || msg) && (
        <div className="border-t border-border px-4 py-2.5">
          {err && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{err}</span></div>}
          {msg && <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div>}
        </div>
      )}

      {canEdit && edition && (
        <Sheet
          open onClose={() => setEdition(null)} width="lg"
          title={edition === "nouveau" ? "Ajouter un article à la demande" : `Corriger — ${edition.nom}`}
          description="L'article, ses produits, la quantité souhaitée et ce qu'on attend du fournisseur."
        >
          {/* « AUTRE ARTICLE » DANS LE SÉLECTEUR DU CATALOGUE : ce qui n'y est pas se saisit librement. */}
          <div role="radiogroup" aria-label="Origine de l'article" className="mb-4 inline-flex rounded-lg border border-border p-0.5 text-sm">
            {([[false, "Du catalogue"], [true, "Autre article"]] as const).map(([v, libelle]) => (
              <button
                key={libelle} type="button" role="radio" aria-checked={libre === v} onClick={() => setLibre(v)}
                className={`min-h-9 rounded-md px-3 sm:min-h-8 ${libre === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {libelle}
              </button>
            ))}
          </div>
          <RecordForm
            key={libre ? "autre" : "catalogue"}
            fields={champs(edition === "nouveau" ? null : edition)} action={action}
            onDone={() => setEdition(null)} onCancel={() => setEdition(null)}
            submitLabel={edition === "nouveau" ? "Ajouter" : "Enregistrer"}
          />
        </Sheet>
      )}
    </section>
  );
}
