"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, EyeOff, Loader2, Lock, Save, Send, Trash2 } from "lucide-react";
import { enregistrerOffre, supprimerOffre } from "@/lib/actions/offres-emploi-actions";
import { redigerOffreAvecIA } from "@/lib/actions/site-web-redaction-actions";
import { fusionnerRedaction, type DisponibiliteRedaction, type OffreRedigee } from "@/lib/site-web/redaction";
import { RedigerAvecIA } from "@/components/site-web/rediger-ia";
import type { ActionResult } from "@/lib/actions/types";
import { LIMITES_OFFRE, lignes, refusOffre, TYPES_CONTRAT_SITE, type OffreSaisie } from "@/lib/site-web/contrat";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { EtatPublicationBadge, type EtatVisible } from "@/components/site-web/etat-badge";
import { cn } from "@/lib/utils";

/**
 * L'ÉDITEUR D'UNE OFFRE D'EMPLOI DU SITE (§118.158).
 *
 * Mêmes principes que l'éditeur d'article : ce qui bloque est calculé ici par la fonction de
 * l'action serveur (`refusOffre`), et l'écran ne promet jamais « en ligne » — seul le site le dit.
 * Une offre rattachée à un recrutement le dit en tête, avec ce qui en découle : tant que le poste
 * n'est pas ouvert, elle reste invisible, publiée ou non.
 */
export interface OffreEditee {
  id: string | null;
  title: string;
  department: string;
  location: string;
  contractLabel: string;
  experience: string;
  summary: string;
  /** Une ligne par élément. */
  mission: string;
  profile: string;
  offer: string;
  published: boolean;
}

export interface DemandeLiee {
  id: string;
  reference: string;
  poste: string;
  etape: string;
  ouvert: boolean;
}

type Intention = "brouillon" | "publier" | "enregistrer" | "retirer";

export function OffreForm({
  offre, dejaEnvoye, etat, demande, peutEcrire, peutSupprimer, prerempliDepuisDemande = false, ia,
}: {
  offre: OffreEditee;
  /** « Rédiger avec l'IA » : disponible, ou la raison pour laquelle il ne l'est pas (§118.160). */
  ia: DisponibiliteRedaction;
  dejaEnvoye: boolean;
  etat: EtatVisible | null;
  demande: DemandeLiee | null;
  peutEcrire: boolean;
  peutSupprimer: boolean;
  prerempliDepuisDemande?: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [v, setV] = React.useState<OffreEditee>(offre);
  const [enCours, setEnCours] = React.useState<Intention | "supprimer" | null>(null);
  const [retour, setRetour] = React.useState<{ ok: boolean; texte: string } | null>(null);
  // Les champs d'AVANT la rédaction par l'IA : un texte remplacé d'un clic revient d'un clic.
  const [avantIA, setAvantIA] = React.useState<OffreEditee | null>(null);
  const modifie = React.useMemo(() => JSON.stringify(v) !== JSON.stringify(offre), [v, offre]);

  React.useEffect(() => { setV(offre); }, [offre]);
  React.useEffect(() => {
    if (!modifie) return;
    const avant = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", avant);
    return () => window.removeEventListener("beforeunload", avant);
  }, [modifie]);

  const champ = <K extends keyof OffreEditee>(k: K) => (valeur: OffreEditee[K]) => setV((x) => ({ ...x, [k]: valeur }));

  // Les champs DU FORMULAIRE, et eux seuls : ni rémunération ni justification n'existent ici,
  // donc elles ne peuvent pas partir chez le modèle (`lireEntreeOffre` relit clé par clé).
  const redigerIA = (consigne: string, partirDuTexte: boolean) => {
    const fd = new FormData();
    fd.set("consigne", consigne);
    if (partirDuTexte) {
      for (const k of ["title", "department", "location", "contractLabel", "experience", "summary", "mission", "profile", "offer"] as const) fd.set(k, v[k]);
    }
    return redigerOffreAvecIA(fd);
  };
  // Un champ que l'IA rend VIDE garde sa valeur (`fusionnerRedaction`) : le département ou le
  // contrat repris de la demande de recrutement ne disparaissent pas parce que la consigne ne les
  // répétait pas.
  const appliquerIA = (c: OffreRedigee) => {
    setAvantIA(v);
    setV((x) => fusionnerRedaction(x, c));
  };

  const mission = lignes(v.mission);
  const profile = lignes(v.profile);
  const offer = lignes(v.offer);
  const saisie: OffreSaisie = {
    title: v.title, department: v.department || null, location: v.location || null, type: v.contractLabel || null,
    experience: v.experience || null, summary: v.summary || null, mission, profile, offer, published: true,
  };
  const refus = refusOffre(saisie);
  const bloque = refus.length > 0;
  const typesProposes: string[] = [...TYPES_CONTRAT_SITE];
  if (v.contractLabel && !typesProposes.includes(v.contractLabel)) typesProposes.push(v.contractLabel);

  const agir = async (intention: Intention) => {
    if (intention === "retirer" && !(await confirmer(
      "Retirer l'offre du site ?\n\nLe site la garde en brouillon, invisible des candidats : elle reste republiable.",
    ))) return;
    setEnCours(intention); setRetour(null);
    const fd = new FormData();
    if (v.id) fd.set("id", v.id);
    else if (demande) fd.set("recruitmentRequestId", demande.id);
    fd.set("intention", intention);
    for (const k of ["title", "department", "location", "contractLabel", "experience", "summary", "mission", "profile", "offer"] as const) {
      fd.set(k, v[k]);
    }
    let r: ActionResult;
    try { r = await enregistrerOffre(fd); } catch {
      r = { ok: false, error: "Le serveur n'a pas répondu. Rechargez la page avant de recommencer : l'enregistrement a peut-être eu lieu." };
    }
    setEnCours(null);
    if (!r.ok) {
      setRetour({ ok: false, texte: r.error ?? "Enregistrement impossible." });
      if (r.id && !v.id) router.replace(`/site-web/offres/${r.id}`);
      return;
    }
    setRetour({ ok: true, texte: r.message ?? "Enregistrée." });
    if (!v.id && r.id) router.replace(`/site-web/offres/${r.id}`);
    else rafraichir();
  };

  const supprimer = async () => {
    if (!v.id) return;
    if (!(await confirmer(
      "Supprimer définitivement cette offre ?\n\nSi elle est sur le site, sa page en est retirée. Pour la masquer sans la perdre, préférez « Retirer du site ».",
    ))) return;
    setEnCours("supprimer"); setRetour(null);
    const fd = new FormData();
    fd.set("id", v.id);
    let r: ActionResult;
    try { r = await supprimerOffre(fd); } catch { r = { ok: false, error: "Le serveur n'a pas répondu." }; }
    setEnCours(null);
    if (!r.ok) { setRetour({ ok: false, texte: r.error ?? "Suppression impossible." }); return; }
    router.push("/site-web/offres");
    rafraichir();
  };

  const occupe = enCours !== null;
  const bouton = (intention: Intention, libelle: string, o: { variante?: "primary" | "outline"; desactive?: boolean; titre?: string } = {}) => (
    <Button type="button" variant={o.variante ?? "primary"} onClick={() => void agir(intention)} disabled={occupe || Boolean(o.desactive)} title={o.titre} className="flex-1 sm:flex-none">
      {enCours === intention ? <Loader2 className="h-4 w-4 animate-spin" /> : intention === "publier" ? <Send className="h-4 w-4" /> : intention === "retirer" ? <EyeOff className="h-4 w-4" /> : <Save className="h-4 w-4" />}
      {libelle}
    </Button>
  );
  const pourquoiBloque = bloque ? "Corrigez d'abord ce que signalent les contrôles." : undefined;
  const meta = [v.department, v.location, v.contractLabel, v.experience].map((x) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-4">
      {demande && (
        <div className={cn("rounded-xl border px-4 py-3 text-sm", demande.ouvert ? "border-border bg-muted/30" : "border-warning/40 bg-warning/5")}>
          <p>
            Rattachée à la demande de recrutement{" "}
            <Link href={`/recrutement/${demande.id}`} className="font-medium text-primary hover:underline">{demande.reference}</Link>
            {" "}— « {demande.poste} », étape : <span className="font-medium">{demande.etape}</span>.
          </p>
          {!demande.ouvert && (
            <p className="mt-1 text-warning">
              Le poste n&apos;est pas ouvert : même publiée, l&apos;offre reste invisible sur le site. Elle passera en ligne d&apos;elle-même
              quand les RH ouvriront le poste, et redeviendra invisible dès qu&apos;il sera pourvu ou clos.
            </p>
          )}
          {prerempliDepuisDemande && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Préremplie depuis la demande : intitulé, direction, contrat, missions et compétences. La rémunération et la justification
              restent internes — elles ne sont jamais reprises.
            </p>
          )}
        </div>
      )}

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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {peutEcrire && (
            <RedigerAvecIA<OffreRedigee>
              disponibilite={ia}
              exemple="Ex. : délégué médical oncologie pour l'Est (Constantine), 3 ans d'expérience, visite des CHU, véhicule de fonction."
              aSaisie={Boolean(v.title.trim() || v.summary.trim() || v.mission.trim() || v.profile.trim())}
              rediger={redigerIA}
              appliquer={appliquerIA}
              annuler={avantIA ? () => { setV(avantIA); setAvantIA(null); } : null}
            />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="offre-titre">Intitulé du poste</Label>
            <Input id="offre-titre" value={v.title} onChange={(e) => champ("title")(e.target.value)} disabled={!peutEcrire} placeholder="Délégué médical — Oncologie" />
            <p className="text-xs text-muted-foreground">Il forme l&apos;adresse de la page (/carrieres/…). {v.title.trim().length} / {LIMITES_OFFRE.title}.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="offre-departement">Département</Label>
              <Input id="offre-departement" value={v.department} onChange={(e) => champ("department")(e.target.value)} disabled={!peutEcrire} placeholder="Promotion médicale" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="offre-lieu">Lieu</Label>
              <Input id="offre-lieu" value={v.location} onChange={(e) => champ("location")(e.target.value)} disabled={!peutEcrire} placeholder="Alger" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="offre-contrat">Type de contrat</Label>
              <Select id="offre-contrat" value={v.contractLabel} onChange={(e) => champ("contractLabel")(e.target.value)} disabled={!peutEcrire}>
                <option value="">Non précisé</option>
                {typesProposes.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="offre-experience">Expérience</Label>
              <Input id="offre-experience" value={v.experience} onChange={(e) => champ("experience")(e.target.value)} disabled={!peutEcrire} placeholder="3 à 5 ans" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="offre-resume">Résumé</Label>
            <Textarea id="offre-resume" rows={3} value={v.summary} onChange={(e) => champ("summary")(e.target.value)} disabled={!peutEcrire} placeholder="Le poste en deux phrases : ce qu'on attend, et pourquoi il compte." />
            <p className={cn("text-xs", v.summary.trim().length > LIMITES_OFFRE.summary ? "text-destructive" : "text-muted-foreground")}>
              {v.summary.trim().length} / {LIMITES_OFFRE.summary} caractères.
            </p>
          </div>
          {([
            ["mission", "Missions", mission.length, "Animer le réseau de prescripteurs de la région Centre\nPréparer les congrès régionaux"],
            ["profile", "Profil recherché", profile.length, "Formation en pharmacie ou biologie\nPermis B"],
            ["offer", "Ce que nous offrons", offer.length, "Véhicule de fonction\nFormation continue"],
          ] as const).map(([k, libelle, n, exemple]) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`offre-${k}`}>{libelle}</Label>
              <Textarea id={`offre-${k}`} rows={4} value={v[k]} onChange={(e) => champ(k)(e.target.value)} disabled={!peutEcrire} placeholder={exemple} />
              <p className={cn("text-xs", n > LIMITES_OFFRE.liste ? "text-destructive" : "text-muted-foreground")}>
                Une ligne par élément — {n} / {LIMITES_OFFRE.liste}.
              </p>
            </div>
          ))}
        </div>

        <aside className="min-w-0 space-y-4">
          <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
            <p className="font-semibold">Avant publication</p>
            {bloque ? (
              <ul className="space-y-1.5">
                {refus.map((r) => (
                  <li key={r} className="flex gap-1.5 text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{r}</span></li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-1.5 text-success"><CheckCircle2 className="h-4 w-4" /> Le site acceptera cette offre.</p>
            )}
            {!v.summary.trim() && <p className="text-xs text-warning">Sans résumé, la page de l&apos;offre commence directement par les missions.</p>}
          </div>

          <div className="space-y-2 rounded-xl border border-border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Aperçu</p>
            <p className="break-words text-base font-semibold">{v.title.trim() || "Intitulé du poste"}</p>
            {meta.length > 0 && <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>}
            {v.summary.trim() && <p className="whitespace-pre-line break-words text-sm">{v.summary.trim()}</p>}
            {([["Missions", mission], ["Profil recherché", profile], ["Ce que nous offrons", offer]] as const).map(([titre, xs]) => xs.length > 0 && (
              <div key={titre}>
                <p className="mt-2 text-sm font-medium">{titre}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{xs.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul>
              </div>
            ))}
          </div>
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
              {bouton("brouillon", dejaEnvoye ? "Enregistrer (reste retirée)" : "Enregistrer le brouillon", {
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
