"use client";

import * as React from "react";
import { Loader2, Sparkles, Copy, ExternalLink, Check, Undo2, Send, Globe, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useKeyedAction as useAction } from "@/components/shared/use-action";
import {
  preparerPostLinkedIn, enregistrerTexteCanal, marquerCanalPublie, retirerCanal,
  publierOffreSiteDuRecrutement, envoyerOffreEmploitic,
} from "@/lib/actions/recrutement-diffusion-actions";
import { pastilleCanal, lienPartageLinkedIn, LIMITE_POST_LINKEDIN, type TonPastille } from "@/lib/recruitment/diffusion";

/**
 * LA CARTE « DIFFUSION » (Direction, 07/10) — les canaux de l'offre, et les RH qui choisissent le ou lesquels.
 *
 * Une TABLE qui reste une table au téléphone (elle défile dans son cadre) : un canal par ligne, son état en pastille,
 * son geste principal ; ce qui demande une saisie (le texte du post, l'adresse d'une publication) s'ouvre dessous.
 * L'écran ne décide d'aucun droit : `peutAgir` vient de `abilities().diffuse`, et chaque action le revérifie.
 */

export interface EtatCanalAffiche {
  statut: string | null;
  contenu: string | null;
  url: string | null;
  erreur: string | null;
  publieLe: string | null;
}

export interface DiffusionProps {
  id: string;
  peutAgir: boolean;
  site: { offreId: string | null; publiee: boolean; libelle: string | null; ton: TonPastille; lien: string | null };
  linkedin: EtatCanalAffiche;
  emploitic: EtatCanalAffiche & { configure: boolean };
  autre: EtatCanalAffiche;
}

type Editeur = null | "texte" | "publie-linkedin" | "publie-autre";

const fd = (entries: Record<string, string | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) if (v) f.set(k, v);
  return f;
};

function Pastille({ libelle, ton }: { libelle: string; ton: TonPastille }) {
  return <Badge tone={ton} dot={false} className="whitespace-nowrap">{libelle}</Badge>;
}

export function DiffusionCard({ id, peutAgir, site, linkedin, emploitic, autre }: DiffusionProps) {
  const { busy, error, run } = useAction();
  const [editeur, setEditeur] = React.useState<Editeur>(null);
  const [texte, setTexte] = React.useState(linkedin.contenu ?? "");
  const [url, setUrl] = React.useState("");
  const [note, setNote] = React.useState("");
  const [copie, setCopie] = React.useState(false);
  React.useEffect(() => { setTexte(linkedin.contenu ?? ""); }, [linkedin.contenu]);

  const occupe = busy !== null;
  const pLinkedin = pastilleCanal(linkedin.statut, linkedin.publieLe);
  const pEmploitic = emploitic.configure ? pastilleCanal(emploitic.statut, emploitic.publieLe) : { libelle: "API à configurer", ton: "neutral" as const };
  const pAutre = pastilleCanal(autre.statut, autre.publieLe);
  const texteCourant = texte.trim() || linkedin.contenu || "";

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(texteCourant);
      setCopie(true);
      setTimeout(() => setCopie(false), 2000);
    } catch {
      setCopie(false);
    }
  };

  const spin = (cle: string, icone: React.ReactNode) => (busy === cle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icone);

  return (
    <div className="space-y-3">
      <Table className="min-w-[34rem]">
        <TableHeader>
          <TableRow>
            <TableHead>Canal</TableHead>
            <TableHead>État</TableHead>
            <TableHead className="text-right">Geste</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* SITE WEB — l'offre JobPosting, seule source de vérité de ce canal. */}
          <TableRow>
            <TableCell className="font-medium"><span className="inline-flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Site web</span></TableCell>
            <TableCell><Pastille libelle={site.offreId ? site.libelle ?? (site.publiee ? "Publiée" : "Brouillon") : "Pas d'offre"} ton={site.offreId ? site.ton : "neutral"} /></TableCell>
            <TableCell className="text-right">
              <div className="flex flex-wrap justify-end gap-1.5">
                {!site.offreId && peutAgir && (
                  <a href={`/site-web/offres/nouvelle?demande=${id}`} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-secondary">
                    <Pencil className="h-3.5 w-3.5" /> Préparer l&apos;offre
                  </a>
                )}
                {site.offreId && peutAgir && !site.publiee && (
                  <Button size="sm" disabled={occupe} onClick={() => run("site", () => publierOffreSiteDuRecrutement(fd({ id, intention: "publier" })))}>
                    {spin("site", <Send className="h-3.5 w-3.5" />)} Publier
                  </Button>
                )}
                {site.offreId && peutAgir && site.publiee && (
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => run("site", () => publierOffreSiteDuRecrutement(fd({ id, intention: "retirer" })))}>
                    {spin("site", <Undo2 className="h-3.5 w-3.5" />)} Retirer
                  </Button>
                )}
                {site.offreId && (
                  <a href={site.lien ?? `/site-web/offres/${site.offreId}`} target={site.lien ? "_blank" : undefined} rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-primary hover:underline">
                    Ouvrir <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </TableCell>
          </TableRow>

          {/* LINKEDIN — préparé en un clic, publié par la personne (aucune API configurée), puis marqué publié. */}
          <TableRow>
            <TableCell className="font-medium">LinkedIn</TableCell>
            <TableCell>
              <Pastille {...pLinkedin} />
              {linkedin.statut === "PUBLIE" && linkedin.url && (
                <a href={linkedin.url} target="_blank" rel="noreferrer" className="ml-1.5 text-xs text-primary hover:underline">voir</a>
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex flex-wrap justify-end gap-1.5">
                {peutAgir && !linkedin.contenu && (
                  <Button size="sm" disabled={occupe} onClick={() => run("li-prep", () => preparerPostLinkedIn(fd({ id })))}>
                    {spin("li-prep", <Sparkles className="h-3.5 w-3.5" />)} Préparer le post
                  </Button>
                )}
                {linkedin.contenu && linkedin.statut !== "PUBLIE" && (
                  <a
                    href={lienPartageLinkedIn(texteCourant)} target="_blank" rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Ouvrir LinkedIn
                  </a>
                )}
                {linkedin.contenu && (
                  <Button size="sm" variant="outline" onClick={() => setEditeur(editeur === "texte" ? null : "texte")}>
                    <Pencil className="h-3.5 w-3.5" /> Texte
                  </Button>
                )}
                {peutAgir && linkedin.contenu && linkedin.statut !== "PUBLIE" && (
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => setEditeur(editeur === "publie-linkedin" ? null : "publie-linkedin")}>
                    <Check className="h-3.5 w-3.5" /> Marquer publié
                  </Button>
                )}
                {peutAgir && linkedin.statut === "PUBLIE" && (
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => run("li-ret", () => retirerCanal(fd({ id, canal: "LINKEDIN" })))}>
                    {spin("li-ret", <Undo2 className="h-3.5 w-3.5" />)} Retiré
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>

          {/* EMPLOITIC — le point d'extension : « API à configurer » tant que la clé manque. */}
          <TableRow>
            <TableCell className="font-medium">Emploitic</TableCell>
            <TableCell>
              <Pastille {...pEmploitic} />
              {emploitic.erreur && emploitic.statut === "ECHEC" && <p className="mt-0.5 text-xs text-destructive">{emploitic.erreur}</p>}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex flex-wrap items-center justify-end gap-1">
                {peutAgir && (
                  <Button
                    size="sm" variant="outline" disabled={occupe || !emploitic.configure || emploitic.statut === "PUBLIE"}
                    onClick={() => run("emp", () => envoyerOffreEmploitic(fd({ id })))}
                  >
                    {spin("emp", <Send className="h-3.5 w-3.5" />)} Envoyer
                  </Button>
                )}
                {!emploitic.configure && (
                  <InfoBulle label="Emploitic : API à configurer">
                    L&apos;envoi à Emploitic s&apos;ouvrira quand la clé d&apos;API sera posée (variable EMPLOITIC_API_KEY dans
                    Render). D&apos;ici là, publiez sur Emploitic à la main et notez-le dans « Autre ».
                  </InfoBulle>
                )}
              </div>
            </TableCell>
          </TableRow>

          {/* AUTRE — un job board, un réseau : marqué publié avec une adresse ou une note. */}
          <TableRow>
            <TableCell className="font-medium">Autre</TableCell>
            <TableCell>
              <Pastille {...pAutre} />
              {autre.contenu && <p className="mt-0.5 max-w-[14rem] truncate text-xs text-muted-foreground">{autre.contenu}</p>}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex flex-wrap justify-end gap-1.5">
                {peutAgir && autre.statut !== "PUBLIE" && (
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => setEditeur(editeur === "publie-autre" ? null : "publie-autre")}>
                    <Check className="h-3.5 w-3.5" /> Marquer publié
                  </Button>
                )}
                {peutAgir && autre.statut === "PUBLIE" && (
                  <Button size="sm" variant="outline" disabled={occupe} onClick={() => run("au-ret", () => retirerCanal(fd({ id, canal: "AUTRE" })))}>
                    {spin("au-ret", <Undo2 className="h-3.5 w-3.5" />)} Retiré
                  </Button>
                )}
                {autre.statut === "PUBLIE" && autre.url && (
                  <a href={autre.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-primary hover:underline">
                    Ouvrir <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {editeur === "texte" && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">Le post LinkedIn ({texte.length} / {LIMITE_POST_LINKEDIN})</Label>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={copier}>
                {copie ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copie ? "Copié" : "Copier"}
              </Button>
              {peutAgir && linkedin.statut !== "PUBLIE" && (
                <Button size="sm" variant="outline" disabled={occupe} onClick={() => run("li-prep", () => preparerPostLinkedIn(fd({ id })))}>
                  {spin("li-prep", <Sparkles className="h-3.5 w-3.5" />)} Rédiger de nouveau
                </Button>
              )}
            </div>
          </div>
          <Textarea value={texte} onChange={(e) => setTexte(e.target.value)} rows={10} maxLength={LIMITE_POST_LINKEDIN} className="text-sm" readOnly={!peutAgir} />
          {peutAgir && (
            <div className="flex justify-end">
              <Button
                size="sm" disabled={occupe || !texte.trim() || texte === linkedin.contenu}
                onClick={() => run("li-txt", () => enregistrerTexteCanal(fd({ id, canal: "LINKEDIN", texte })))}
              >
                {spin("li-txt", <Check className="h-3.5 w-3.5" />)} Enregistrer le texte
              </Button>
            </div>
          )}
        </div>
      )}

      {(editeur === "publie-linkedin" || editeur === "publie-autre") && (
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Adresse de la publication {editeur === "publie-linkedin" ? "(facultative)" : ""}</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" className="h-9 text-sm" />
          </div>
          {editeur === "publie-autre" && (
            <div className="space-y-1">
              <Label className="text-xs">Où (job board, réseau…)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. Emploitic (à la main), groupe Pharma DZ" className="h-9 text-sm" />
            </div>
          )}
          <div className="flex items-end justify-end sm:col-span-2">
            <Button
              size="sm" disabled={occupe || (editeur === "publie-autre" && !url.trim() && !note.trim())}
              onClick={async () => {
                const canal = editeur === "publie-linkedin" ? "LINKEDIN" : "AUTRE";
                // `run` (useKeyedAction) est déjà gardé : il ne lève pas, il dit vrai si l'action a abouti.
                if (await run("pub", () => marquerCanalPublie(fd({ id, canal, url: url.trim(), texte: canal === "AUTRE" ? note.trim() : undefined })))) {
                  setEditeur(null); setUrl(""); setNote("");
                }
              }}
            >
              {spin("pub", <Check className="h-3.5 w-3.5" />)} Marquer publié
            </Button>
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
