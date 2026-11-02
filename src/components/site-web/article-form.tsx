"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, EyeOff, Loader2, Save, Send, Trash2 } from "lucide-react";
import { enregistrerArticle, supprimerArticle } from "@/lib/actions/site-web-actions";
import { redigerArticleAvecIA } from "@/lib/actions/site-web-redaction-actions";
import { fusionnerRedaction, type ArticleRedige, type DisponibiliteRedaction } from "@/lib/site-web/redaction";
import { RedigerAvecIA } from "@/components/site-web/rediger-ia";
import type { ActionResult } from "@/lib/actions/types";
import {
  avertissementsArticle, DEFAUTS_SITE, DESCRIPTION_IDEALE, LIMITES_ARTICLE, lignes, refusAdresseDuDepot, refusArticle, slugSuggere,
  type ArticleSaisi,
} from "@/lib/site-web/contrat";
import { lecture, refusTitresNiveau1, sommaire } from "@/lib/site-web/markdown";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ApercuMarkdown } from "@/components/site-web/apercu-markdown";
import { EtatPublicationBadge, type EtatVisible } from "@/components/site-web/etat-badge";
import { cn } from "@/lib/utils";

/**
 * L'ÉDITEUR D'UN ARTICLE DE BLOG (§118.158).
 *
 * Ce qui BLOQUE la publication est calculé ICI, en direct, par les MÊMES fonctions que l'action
 * serveur (`refusArticle`, `refusTitresNiveau1`) : l'auteur voit « le titre `# …` ligne 12 » avant
 * de cliquer, et le serveur dira exactement la même chose s'il clique quand même. Deux règles
 * écrites deux fois finiraient par ne plus s'accorder, et le symptôme serait un bouton actif qu'une
 * action refuse (§118.5).
 *
 * N'importe que des modules PURS (`contrat.ts`, `markdown.ts`) et des actions serveur : ce fichier
 * est compilé pour le navigateur (garde `client-bundle-guard.test.ts`).
 */
export interface ArticleEdite {
  id: string | null;
  title: string;
  slug: string;
  description: string;
  body: string;
  category: string;
  tags: string;
  author: string;
  /** `AAAA-MM-JJ`, ou vide. */
  publishedOn: string;
  featured: boolean;
  /** L'état ENREGISTRÉ dans l'ERP (pas celui du site). */
  published: boolean;
}

type Intention = "brouillon" | "publier" | "enregistrer" | "retirer";

export function ArticleForm({
  article, dejaEnvoye, etat, slugsDuDepot, depotConnuAu, peutEcrire, peutSupprimer, categories, ia,
}: {
  article: ArticleEdite;
  /** « Rédiger avec l'IA » : disponible, ou la raison pour laquelle il ne l'est pas (§118.160). */
  ia: DisponibiliteRedaction;
  dejaEnvoye: boolean;
  etat: EtatVisible | null;
  slugsDuDepot: string[];
  depotConnuAu: string | null;
  peutEcrire: boolean;
  peutSupprimer: boolean;
  categories: string[];
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [v, setV] = React.useState<ArticleEdite>(article);
  const [onglet, setOnglet] = React.useState<"rediger" | "apercu">("rediger");
  const [enCours, setEnCours] = React.useState<Intention | "supprimer" | null>(null);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);
  // Les champs d'AVANT la rédaction par l'IA : un texte remplacé d'un clic revient d'un clic.
  const [avantIA, setAvantIA] = React.useState<ArticleEdite | null>(null);
  const modifie = React.useMemo(() => JSON.stringify(v) !== JSON.stringify(article), [v, article]);

  // L'état enregistré change après un envoi (router.refresh) : on repart de la version serveur.
  React.useEffect(() => { setV(article); }, [article]);

  React.useEffect(() => {
    if (!modifie) return;
    const avant = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", avant);
    return () => window.removeEventListener("beforeunload", avant);
  }, [modifie]);

  const champ = <K extends keyof ArticleEdite>(k: K) => (valeur: ArticleEdite[K]) => setV((x) => ({ ...x, [k]: valeur }));

  const redigerIA = (consigne: string, partirDuTexte: boolean) => {
    const fd = new FormData();
    fd.set("consigne", consigne);
    if (partirDuTexte) {
      fd.set("title", v.title); fd.set("description", v.description); fd.set("body", v.body); fd.set("category", v.category);
    }
    for (const c of categories) fd.append("categories", c);
    return redigerArticleAvecIA(fd);
  };
  // Un champ que l'IA rend VIDE garde sa valeur (`fusionnerRedaction`).
  const appliquerIA = (c: ArticleRedige) => {
    setAvantIA(v);
    setV((x) => fusionnerRedaction(x, c));
    setOnglet("rediger");
  };

  // ── Les contrôles, en direct, par les mêmes fonctions que le serveur ─────────────────
  const tags = React.useMemo(() => lignes(v.tags.replace(/,/g, "\n")), [v.tags]);
  const saisie: ArticleSaisi = {
    title: v.title, body: v.body, description: v.description || null, slug: v.slug || null, category: v.category || null,
    tags, author: v.author || null, date: v.publishedOn ? new Date(v.publishedOn) : null, updated: null,
    featured: v.featured, published: true,
  };
  const titresFautifs = React.useMemo(() => refusTitresNiveau1(v.body), [v.body]);
  const refusContrat = refusArticle(saisie, titresFautifs);
  const avertissements = avertissementsArticle(saisie);
  const plan = React.useMemo(() => sommaire(v.body), [v.body]);
  const lu = React.useMemo(() => lecture(v.body), [v.body]);
  const slugPropose = slugSuggere(v.title);
  const slugEffectif = v.slug.trim() || slugPropose;
  const collisionDepot = Boolean(slugEffectif) && slugsDuDepot.includes(slugEffectif);
  // Une adresse EXPLICITE prise par un article du dépôt est refusée par l'action (même phrase) ;
  // une adresse dérivée du titre n'est qu'une supposition sur ce que fera le site : on prévient.
  const refus = v.slug.trim() && collisionDepot
    ? [...refusContrat, refusAdresseDuDepot(v.slug.trim())]
    : refusContrat;
  const bloque = refus.length > 0;
  const longueurDescription = v.description.trim().length;

  const agir = async (intention: Intention) => {
    if (intention === "retirer" && !(await confirmer(
      "Retirer l'article du site ?\n\nLe site le garde en brouillon, invisible du public : il reste republiable en un clic.",
    ))) return;
    setEnCours(intention); setRetour(null);
    const fd = new FormData();
    if (v.id) fd.set("id", v.id);
    fd.set("intention", intention);
    fd.set("title", v.title);
    fd.set("body", v.body);
    fd.set("description", v.description);
    fd.set("slug", v.slug);
    fd.set("category", v.category);
    fd.set("tags", v.tags);
    fd.set("author", v.author);
    fd.set("publishedOn", v.publishedOn);
    if (v.featured) fd.set("featured", "on");
    let r: ActionResult;
    try { r = await enregistrerArticle(fd); } catch {
      r = { ok: false, error: "Le serveur n'a pas répondu. Rechargez la page avant de recommencer : l'enregistrement a peut-être eu lieu." };
    }
    setEnCours(null);
    if (!r.ok) {
      setRetour({ ok: false, texte: r.error ?? "Enregistrement impossible." });
      if (r.id && !v.id) router.replace(`/site-web/articles/${r.id}`);
      return;
    }
    setRetour({ ok: true, texte: r.message ?? "Enregistré." });
    if (!v.id && r.id) router.replace(`/site-web/articles/${r.id}`);
    else rafraichir();
  };

  const supprimer = async () => {
    if (!v.id) return;
    if (!(await confirmer(
      "Supprimer définitivement cet article ?\n\nS'il est sur le site, sa page en est retirée. Pour le masquer sans le perdre, préférez « Retirer du site ».",
    ))) return;
    setEnCours("supprimer"); setRetour(null);
    const fd = new FormData();
    fd.set("id", v.id);
    let r: ActionResult;
    try { r = await supprimerArticle(fd); } catch { r = { ok: false, error: "Le serveur n'a pas répondu." }; }
    setEnCours(null);
    if (!r.ok) { setRetour({ ok: false, texte: r.error ?? "Suppression impossible." }); return; }
    router.push("/site-web/articles");
    rafraichir();
  };

  const occupe = enCours !== null;
  // Une FONCTION de rendu, pas un composant déclaré dans le rendu : ce dernier changerait d'identité
  // à chaque frappe, et React démonterait le bouton (le focus clavier sauterait).
  const bouton = (intention: Intention, libelle: string, o: { variante?: "primary" | "outline"; desactive?: boolean; titre?: string } = {}) => (
    <Button type="button" variant={o.variante ?? "primary"} onClick={() => void agir(intention)} disabled={occupe || Boolean(o.desactive)} title={o.titre} className="flex-1 sm:flex-none">
      {enCours === intention ? <Loader2 className="h-4 w-4 animate-spin" /> : intention === "publier" ? <Send className="h-4 w-4" /> : intention === "retirer" ? <EyeOff className="h-4 w-4" /> : <Save className="h-4 w-4" />}
      {libelle}
    </Button>
  );
  const pourquoiBloque = bloque ? "Corrigez d'abord ce que signalent les contrôles." : undefined;

  return (
    <div className="space-y-4">
      {(etat || retour) && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          {etat ? <EtatPublicationBadge etat={etat} avecDetail /> : <span />}
          {retour && (
            <p role={retour.ok ? "status" : "alert"} className={cn("whitespace-pre-line text-sm", retour.ok ? "text-success" : "text-destructive")}>
              {retour.texte}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ── Le texte ─────────────────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          {peutEcrire && (
            <RedigerAvecIA<ArticleRedige>
              disponibilite={ia}
              exemple="Ex. : un article sur la sérialisation des médicaments en Algérie — ce qui change pour les pharmacies, le calendrier, ce que fait Adventum."
              aSaisie={Boolean(v.title.trim() || v.body.trim() || v.description.trim())}
              rediger={redigerIA}
              appliquer={appliquerIA}
              annuler={avantIA ? () => { setV(avantIA); setAvantIA(null); } : null}
            />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="article-titre">Titre</Label>
            <Input
              id="article-titre" value={v.title} onChange={(e) => champ("title")(e.target.value)} disabled={!peutEcrire}
              placeholder="Traçabilité des lots : ce que change la sérialisation en 2027" maxLength={LIMITES_ARTICLE.title + 50}
            />
            <p className="text-xs text-muted-foreground">
              Titre de la page et balise &lt;title&gt;. {v.title.trim().length} / {LIMITES_ARTICLE.title} caractères.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="article-description">Description (moteurs de recherche)</Label>
            <Textarea
              id="article-description" value={v.description} onChange={(e) => champ("description")(e.target.value)} disabled={!peutEcrire}
              rows={2} placeholder="Ce que Google affichera sous le titre — une phrase qui donne envie de lire."
            />
            <p className={cn(
              "text-xs",
              longueurDescription === 0 ? "text-muted-foreground"
                : longueurDescription >= DESCRIPTION_IDEALE.min && longueurDescription <= DESCRIPTION_IDEALE.max ? "text-success"
                  : longueurDescription > LIMITES_ARTICLE.description ? "text-destructive" : "text-warning",
            )}
            >
              {longueurDescription} caractères — idéal {DESCRIPTION_IDEALE.min} à {DESCRIPTION_IDEALE.max}, {LIMITES_ARTICLE.description} au plus.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="article-corps">Corps (Markdown)</Label>
              <div role="tablist" aria-label="Mode d'affichage du corps" className="inline-flex rounded-lg border border-border p-0.5 text-xs">
                {(["rediger", "apercu"] as const).map((o) => (
                  <button
                    key={o} type="button" role="tab" aria-selected={onglet === o} onClick={() => setOnglet(o)}
                    className={cn("rounded-md px-3 py-1.5 sm:py-1", onglet === o ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {o === "rediger" ? "Rédiger" : "Aperçu"}
                  </button>
                ))}
              </div>
            </div>
            {onglet === "rediger" ? (
              <Textarea
                id="article-corps" value={v.body} onChange={(e) => champ("body")(e.target.value)} disabled={!peutEcrire}
                className="min-h-[20rem] font-mono text-base leading-relaxed sm:min-h-[28rem] sm:text-[13px]"
                placeholder={"Introduction…\n\n## Première partie\n\nTexte, **gras**, *italique*, [lien](https://…).\n\n- une puce\n- une autre\n\n## Deuxième partie\n…"}
              />
            ) : (
              <div className="min-h-[20rem] rounded-lg border border-border bg-card p-3 sm:min-h-[28rem] sm:p-4">
                <ApercuMarkdown titre={v.title} corps={v.body} />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Structurez en sections <code className="rounded bg-muted px-1">## Titre</code> (et <code className="rounded bg-muted px-1">###</code> pour une sous-partie).
              Pas de <code className="rounded bg-muted px-1"># Titre</code> : le titre de l&apos;article en tient lieu, et le site le refuserait.
            </p>
          </div>
        </div>

        {/* ── La publication et les contrôles ───────────────────────────────────── */}
        <aside className="min-w-0 space-y-4">
          <div className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm font-semibold">Publication</p>
            <div className="space-y-1.5">
              <Label htmlFor="article-date">Date affichée</Label>
              <Input id="article-date" type="date" value={v.publishedOn} onChange={(e) => champ("publishedOn")(e.target.value)} disabled={!peutEcrire} />
              <p className="text-xs text-muted-foreground">Vide : la date de la première mise en ligne.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="article-categorie">Catégorie</Label>
              <Input
                id="article-categorie" list="article-categories" value={v.category} onChange={(e) => champ("category")(e.target.value)}
                disabled={!peutEcrire} placeholder={DEFAUTS_SITE.category}
              />
              <datalist id="article-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="article-tags">Mots-clés</Label>
              <Input
                id="article-tags" value={v.tags} onChange={(e) => champ("tags")(e.target.value)} disabled={!peutEcrire}
                placeholder="pharmacovigilance, traçabilité"
              />
              <p className="text-xs text-muted-foreground">Séparés par des virgules — {tags.length} / {LIMITES_ARTICLE.tags}.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="article-auteur">Auteur</Label>
              <Input
                id="article-auteur" value={v.author} onChange={(e) => champ("author")(e.target.value)} disabled={!peutEcrire}
                placeholder={DEFAUTS_SITE.author}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="article-slug">Adresse</Label>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="shrink-0">/blog/</span>
                <Input
                  id="article-slug" value={v.slug} onChange={(e) => champ("slug")(e.target.value.trim())} disabled={!peutEcrire}
                  placeholder={slugPropose || "tracabilite-des-lots"} className="h-10 min-w-0 font-mono text-base sm:h-9 sm:text-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Vide : le site la dérive du titre. Ne la changez plus une fois l&apos;article en ligne — les liens existants casseraient.
              </p>
              {collisionDepot && (
                <p className="text-xs text-warning">
                  /blog/{slugEffectif} est l&apos;adresse d&apos;un article du dépôt du site : c&apos;est lui qui s&apos;afficherait, pas celui-ci.
                  {v.slug.trim() ? " Choisissez une autre adresse." : " Donnez une adresse à cet article pour l'éviter."}
                </p>
              )}
              {!depotConnuAu && (
                <p className="text-xs text-muted-foreground">Les adresses déjà prises par le site ne sont connues qu&apos;après un premier rapprochement.</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={v.featured} onChange={(e) => champ("featured")(e.target.checked)} disabled={!peutEcrire} className="h-4 w-4" />
              À la une
            </label>
          </div>

          <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
            <p className="font-semibold">Avant publication</p>
            {bloque ? (
              <ul className="space-y-1.5">
                {refus.map((r) => (
                  <li key={r} className="flex gap-1.5 text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{r}</span></li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-1.5 text-success"><CheckCircle2 className="h-4 w-4" /> Le site acceptera cet article.</p>
            )}
            {avertissements.length > 0 && (
              <ul className="space-y-1 text-xs text-warning">
                {avertissements.map((a) => <li key={a}>{a}</li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              {lu.mots.toLocaleString("fr-FR")} mots · environ {lu.minutes} min de lecture
            </p>
          </div>

          {plan.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-border p-4">
              <p className="text-sm font-semibold">Sommaire</p>
              <ol className="space-y-0.5 text-xs">
                {plan.map((t) => (
                  <li key={`${t.ligne}-${t.texte}`} className={cn("truncate", t.niveau === 3 && "pl-3 text-muted-foreground")}>{t.texte}</li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>

      {peutEcrire && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-1 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
          {v.published ? (
            <>
              {bouton("enregistrer", "Enregistrer les modifications", { desactive: bloque, titre: pourquoiBloque })}
              {bouton("retirer", "Retirer du site", { variante: "outline" })}
            </>
          ) : (
            <>
              {bouton("publier", dejaEnvoye ? "Republier" : "Publier sur le site", { desactive: bloque, titre: pourquoiBloque })}
              {bouton("brouillon", dejaEnvoye ? "Enregistrer (reste retiré)" : "Enregistrer le brouillon", {
                variante: "outline", desactive: dejaEnvoye && bloque, titre: dejaEnvoye && bloque ? pourquoiBloque : undefined,
              })}
            </>
          )}
          {modifie && <span className="text-xs text-warning">Modifications non enregistrées</span>}
          {v.id && peutSupprimer && (
            <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={() => void supprimer()} disabled={occupe}>
              {enCours === "supprimer" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Supprimer
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
