"use client";

import * as React from "react";
import { AlertTriangle, FileCheck2, FileText, Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChampAnnuaire } from "@/components/directory/champ-annuaire";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sansBloquer } from "@/lib/journal";
import { cn } from "@/lib/utils";
import { ITEM_KIND_LABELS } from "../../domaine/postes";
import { lireDevisAvantDepot } from "../../actions-postes-paiement";
import type { Run } from "../items-panel";
import type { PosteFrere } from "./poste-carte";
import { RANGEE_ACTIONS } from "./elements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS D'UN POSTE, UNE CARTE PAR FICHIER (recette 24/11/2026) — l'assistante joint d'un coup les devis des
 * agences, sans refaire « Ajouter un devis » pour chacun.
 *
 *  - Les fichiers s'AJOUTENT en plusieurs fois (chaque choix complète la liste) et se retirent un à un.
 *  - Chaque fichier est SON devis : l'IA le lit (`lireDevisAvantDepot`, deux à la fois), sa carte se remplit
 *    (fournisseur, montant, référence — chaque champ « Lu par l'IA » tant qu'on ne l'a pas changé), on la relit.
 *  - « Déposer les N devis » envoie UNE `ajouterDevisPoste` PAR CARTE, l'une après l'autre : un devis déposé
 *    quitte la liste ; celui qui échoue y reste, avec sa raison, pour être corrigé et redéposé.
 *  - « Ces fichiers sont les pages d'un même devis » revient au dépôt d'UN devis (tous les fichiers joints,
 *    seul le premier lu) — le geste d'avant.
 *
 * Un seul fichier : le formulaire d'avant, mêmes champs, même dépôt.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type ChampLu = "montant" | "reference";
type EtatLecture = "attente" | "lecture" | "lu" | "echec";
type ResultatLecture = Awaited<ReturnType<typeof lireDevisAvantDepot>>;
type ResultatDepot = { ok: boolean; error?: string; id?: string; message?: string };

/** Un fichier choisi et ce que sa carte en dit — lu par l'IA, relu par la personne. */
interface DevisSaisi {
  cle: string;
  fichier: File;
  lecture: { etat: EtatLecture; phrase: string };
  montant: string;
  reference: string;
  proforma: boolean;
  fournisseurLu: { nom: string; version: number } | null;
  /** Les champs que la lecture a remplis — « Lu par l'IA » tant qu'on ne les a pas changés. */
  luParIa: ChampLu[];
  /** Les champs que la personne a tapés : une lecture qui arrive après ne les écrase pas. */
  touches: ChampLu[];
  /** La raison du dernier dépôt refusé — la carte reste, on corrige, on redépose. */
  erreur: string | null;
}

/** DEUX LECTURES À LA FOIS : chaque lecture appelle un modèle — dix devis ne partent pas d'un coup. */
const LECTURES_SIMULTANEES = 2;
/** Une lecture qui ne répond pas ne bloque pas le dépôt : au-delà, la carte se remplit à la main. */
const LECTURE_MAX_MS = 90_000;

const empreinte = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

function nouveauDevis(cle: string, fichier: File): DevisSaisi {
  return {
    cle, fichier, lecture: { etat: "attente", phrase: "En attente de lecture par l'IA…" },
    montant: "", reference: "", proforma: false, fournisseurLu: null, luParIa: [], touches: [], erreur: null,
  };
}

async function lireUnDevis(itemId: string, fichier: File): Promise<ResultatLecture> {
  const fd = new FormData();
  fd.set("id", itemId);
  fd.set("fichier", fichier);
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<ResultatLecture>((rendre) => {
    minuterie = setTimeout(() => rendre({ ok: false, raison: "La lecture n'a pas répondu à temps : remplissez les champs depuis le papier." }), LECTURE_MAX_MS);
  });
  try {
    return await Promise.race([
      lireDevisAvantDepot(fd).catch(sansBloquer<ResultatLecture>("ad-pro.devis-avant-depot.lecture", {
        ok: false, raison: "La lecture du devis a échoué : remplissez les champs depuis le papier.",
      })),
      delai,
    ]);
  } finally {
    clearTimeout(minuterie);
  }
}

/** La lecture remplit les champs que la personne n'a pas touchés, et les marque. */
function appliquerLecture(d: DevisSaisi, r: ResultatLecture): DevisSaisi {
  if (!r.ok) return { ...d, lecture: { etat: "echec", phrase: r.raison } };
  const lus: ChampLu[] = [];
  let { montant, reference } = d;
  if (r.montant != null && !d.touches.includes("montant")) { montant = String(r.montant); lus.push("montant"); }
  if (r.reference && !d.touches.includes("reference")) { reference = r.reference; lus.push("reference"); }
  return {
    ...d, montant, reference, luParIa: lus,
    fournisseurLu: r.fournisseur ? { nom: r.fournisseur, version: (d.fournisseurLu?.version ?? 0) + 1 } : d.fournisseurLu,
    lecture: { etat: "lu", phrase: r.phrase },
  };
}

/** « Lu par l'IA » — le champ qu'une lecture a rempli, tant que la personne ne l'a pas changé. */
export function MarqueIa() {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-luna"><Sparkles className="h-3 w-3" /> Lu par l&apos;IA</span>
  );
}

/** Où en est la lecture d'une pièce par l'IA — en cours, faite (sa phrase), ou échouée (la raison). */
export function BandeauLecture({ etat, phrase }: { etat: EtatLecture; phrase: string }) {
  return (
    <p className={cn(
      "flex items-start gap-1.5 rounded-md px-2 py-1.5",
      etat === "echec" ? "bg-warning/10 text-foreground" : etat === "attente" ? "bg-secondary/50 text-muted-foreground" : "bg-luna/10 text-foreground",
    )}>
      {etat === "lecture"
        ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-luna" />
        : <Sparkles className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", etat === "attente" ? "text-muted-foreground" : "text-luna")} />}
      <span>{phrase}</span>
    </p>
  );
}

const CHAMP = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:py-1.5 sm:text-sm";

/**
 * LA CARTE D'UN DEVIS — `seul` : les champs du formulaire d'avant, sans cadre (un fichier, ou les pages d'un même
 * devis) ; `carte` : son cadre, le nom du fichier et sa croix. Toujours montée à la même place (clé du fichier) : passer
 * d'un fichier à deux ne perd ni la lecture ni le fournisseur tapé. Masquée, elle se garde, désactivée.
 */
function CarteDevis({ d, rang, variante, masque, occupe, envoi, proforma, fournisseurInitial, onMaj, onRetirer }: {
  d: DevisSaisi; rang: number; variante: "seul" | "carte"; masque: boolean; occupe: boolean; envoi: boolean;
  proforma: "choix" | "imposee"; fournisseurInitial: string;
  onMaj: (f: (d: DevisSaisi) => DevisSaisi) => void; onRetirer: () => void;
}) {
  const carte = variante === "carte";
  const nom = d.fichier.name;
  const ecrire = (champ: ChampLu, valeur: string) => onMaj((x) => ({
    ...x,
    montant: champ === "montant" ? valeur : x.montant,
    reference: champ === "reference" ? valeur : x.reference,
    touches: x.touches.includes(champ) ? x.touches : [...x.touches, champ],
    luParIa: x.luParIa.filter((c) => c !== champ),
  }));
  const marque = (champ: ChampLu) => d.luParIa.includes(champ) && <MarqueIa />;
  return (
    <fieldset
      disabled={masque || occupe} hidden={masque}
      className={cn("min-w-0 space-y-2", carte && "rounded-lg border border-border bg-background p-2.5", masque && "hidden")}
    >
      {carte && (
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 font-medium text-foreground [overflow-wrap:anywhere]">{proforma === "imposee" ? "Pro forma" : "Devis"} {rang} — {nom}</p>
          <button
            type="button" onClick={onRetirer} aria-label={`Retirer « ${nom} » de la liste`}
            className="-mr-1 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:w-7"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {envoi ? (
        <p className="flex items-start gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-foreground">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> <span>Dépôt en cours…</span>
        </p>
      ) : (
        <BandeauLecture etat={d.lecture.etat} phrase={d.lecture.phrase} />
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="min-w-0">
          Montant (DZD) — facultatif{marque("montant")}
          <input
            type="number" inputMode="decimal" min="0" step="0.01" value={d.montant} onChange={(e) => ecrire("montant", e.target.value)}
            aria-label={`Montant du devis « ${nom} » (DZD)`} className={`${CHAMP} tabular-nums`}
          />
        </label>
        <label className="min-w-0">
          Référence — facultatif{marque("reference")}
          <input
            value={d.reference} onChange={(e) => ecrire("reference", e.target.value)} placeholder="N° de la pièce"
            aria-label={`Référence du devis « ${nom} »`} className={CHAMP}
          />
        </label>
        <label className="min-w-0 sm:col-span-2">
          Fournisseur — facultatif
          <ChampAnnuaire
            name={`fournisseur-${d.cle}`} defaultValue={fournisseurInitial} lu={d.fournisseurLu} className="mt-1"
            placeholder="Chercher l'agence dans l'annuaire, ou taper son nom"
          />
        </label>
      </div>
      {proforma === "choix" && (
        <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
          <input type="checkbox" checked={d.proforma} onChange={(e) => { const coche = e.target.checked; onMaj((x) => ({ ...x, proforma: coche })); }} />
          C&apos;est une facture pro forma
        </label>
      )}
      {d.erreur && (
        <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{d.erreur}</span>
        </p>
      )}
    </fieldset>
  );
}

/**
 * DÉPOSER UN OU PLUSIEURS DEVIS SUR LE POSTE — `deposer` est `ajouterDevisPoste` (la carte du poste la passe) ;
 * `onDepose` reçoit la première pièce déposée (le conseil de Luna sur son emplacement).
 */
export function DepotDevis({
  itemId, titre, aide, fournisseurInitial, proforma, freres, bouton = "Joindre", busy, run, deposer, onDepose, onClose,
}: {
  itemId: string; titre: string; aide: string; fournisseurInitial: string;
  /** « choix » = une case par devis ; « imposee » = c'est forcément une pro forma (poste payé directement). */
  proforma: "choix" | "imposee";
  /** Les autres postes que les mêmes pièces peuvent couvrir — communs à tous les devis déposés d'un geste. */
  freres: PosteFrere[];
  bouton?: string; busy: string | null; run: Run;
  deposer: (fd: FormData) => Promise<ResultatDepot>;
  onDepose: (id: string | null) => void; onClose: () => void;
}) {
  const [devis, setDevis] = React.useState<DevisSaisi[]>([]);
  const [memeDevis, setMemeDevis] = React.useState(false);
  const [envoi, setEnvoi] = React.useState<string | null>(null);
  const [ignores, setIgnores] = React.useState<string | null>(null);
  const compteur = React.useRef(0);
  const demarres = React.useRef(new Set<string>());
  const cleRun = `dev:${itemId}`;
  const occupe = busy === cleRun;
  const n = devis.length;
  const pages = memeDevis && n > 1;
  const cartes = n > 1 && !pages;
  const lecturesEnCours = cartes ? devis.filter((d) => d.lecture.etat === "attente" || d.lecture.etat === "lecture").length : 0;

  // LA FILE DES LECTURES : deux à la fois, dans l'ordre des fichiers. Les pages d'un même devis : seule la première se lit
  // (le dépôt ne lit qu'elle) — les autres attendent, et se liront si l'on revient à « un devis par fichier ».
  React.useEffect(() => {
    let places = LECTURES_SIMULTANEES - devis.filter((d) => d.lecture.etat === "lecture").length;
    for (const [i, d] of devis.entries()) {
      if (places <= 0) break;
      if (d.lecture.etat !== "attente" || demarres.current.has(d.cle) || (memeDevis && i > 0)) continue;
      demarres.current.add(d.cle);
      places -= 1;
      const { cle, fichier } = d;
      setDevis((prev) => prev.map((x) => (x.cle === cle ? { ...x, lecture: { etat: "lecture", phrase: "L'IA lit le devis…" } } : x)));
      // `map` rend toujours une liste neuve : même un fichier retiré pendant sa lecture relance la file.
      void lireUnDevis(itemId, fichier).then((r) => setDevis((prev) => prev.map((x) => (x.cle === cle ? appliquerLecture(x, r) : x))));
    }
  }, [devis, memeDevis, itemId]);

  const maj = (cle: string) => (f: (d: DevisSaisi) => DevisSaisi) => setDevis((prev) => prev.map((x) => (x.cle === cle ? f(x) : x)));
  const retirer = (cle: string) => setDevis((prev) => prev.filter((x) => x.cle !== cle));

  /** CHAQUE CHOIX COMPLÈTE LA LISTE — le même fichier n'y entre pas deux fois (il ferait deux devis). */
  const ajouter = (liste: FileList | null) => {
    const deja = new Set(devis.map((d) => empreinte(d.fichier)));
    const neufs: DevisSaisi[] = [];
    const ecartes: string[] = [];
    for (const f of Array.from(liste ?? [])) {
      if (f.size === 0) { ecartes.push(`« ${f.name} » (fichier vide)`); continue; }
      if (deja.has(empreinte(f))) { ecartes.push(`« ${f.name} » (déjà dans la liste)`); continue; }
      deja.add(empreinte(f));
      compteur.current += 1;
      neufs.push(nouveauDevis(`f${compteur.current}`, f));
    }
    setIgnores(ecartes.length ? `Non ajouté${ecartes.length > 1 ? "s" : ""} : ${ecartes.join(", ")}.` : null);
    if (neufs.length) setDevis((prev) => [...prev, ...neufs]);
  };

  /** UNE CARTE PAR APPEL, l'une après l'autre : un devis déposé quitte la liste, un refus reste sur sa carte. */
  const deposerChacun = async (lots: { d: DevisSaisi; fd: FormData }[]) => {
    const bilan = { fini: false, restants: 0 };
    await run(cleRun, async () => {
      const reussis: { nom: string; id: string | null; message: string }[] = [];
      const rates: { nom: string; erreur: string }[] = [];
      let nonEnvoyes = 0;
      for (const [i, { d, fd }] of lots.entries()) {
        setEnvoi(d.cle);
        maj(d.cle)((x) => ({ ...x, erreur: null }));
        let r: ResultatDepot;
        try {
          r = await deposer(fd);
        } catch {
          // UNE ACTION QUI LÈVE a pu enregistrer : on s'arrête, et la carte dit de vérifier la liste avant de redéposer.
          const erreur = actionFailureMessage("THROWN");
          rates.push({ nom: d.fichier.name, erreur });
          maj(d.cle)((x) => ({ ...x, erreur }));
          nonEnvoyes = lots.length - i - 1;
          break;
        }
        if (r.ok) {
          reussis.push({ nom: d.fichier.name, id: r.id ?? null, message: r.message ?? "Pièce déposée." });
          retirer(d.cle);
        } else {
          const erreur = r.error ?? "Le dépôt n'a pas abouti.";
          rates.push({ nom: d.fichier.name, erreur });
          maj(d.cle)((x) => ({ ...x, erreur }));
        }
      }
      setEnvoi(null);
      bilan.fini = true;
      bilan.restants = rates.length + nonEnvoyes;
      const premier = reussis.find((x) => x.id);
      if (premier) onDepose(premier.id);
      const arret = nonEnvoyes > 0 ? ` L'envoi s'est arrêté : ${nonEnvoyes} fichier${nonEnvoyes > 1 ? "s" : ""} non envoyé${nonEnvoyes > 1 ? "s" : ""}.` : "";
      if (reussis.length === 0) {
        const raisons = [...new Set(rates.map((x) => x.erreur))];
        return {
          ok: false,
          error: raisons.length === 1
            ? `Aucun devis n'a été déposé : ${raisons[0]}${arret}`
            : `Aucun devis n'a été déposé. ${rates.map((x) => `« ${x.nom} » : ${x.erreur}`).join(" ")}${arret}`,
        };
      }
      const s = reussis.length > 1 ? "s" : "";
      const restes = rates.length
        ? ` — ${rates.map((x) => `« ${x.nom} »`).join(", ")} : la raison est sur ${rates.length > 1 ? "leurs cartes" : "sa carte"}, restée${rates.length > 1 ? "s" : ""} dans le formulaire.`
        : "";
      const entete = bilan.restants === 0
        ? `${reussis.length} pièce${s} déposée${s}, une par fichier.`
        : `${reussis.length} pièce${s} déposée${s} sur ${lots.length}${restes}${arret}`;
      return { ok: true, message: `${entete} ${reussis.map((x) => `« ${x.nom} » : ${x.message}`).join(" ")}` };
    }, "Devis déposés.");
    if (bilan.fini && bilan.restants === 0) onClose();
  };

  const soumettre = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (n === 0 || occupe) return;
    const formulaire = new FormData(e.currentTarget);
    const autres = formulaire.getAll("autresPostes").map(String).filter(Boolean);
    // Les mêmes champs que le formulaire d'avant : montant, référence, fournisseur, pro forma, postes couverts.
    const fdDe = (d: DevisSaisi, fichiers: File[]) => {
      const fd = new FormData();
      fd.set("id", itemId);
      for (const f of fichiers) fd.append("attachment", f);
      if (d.montant.trim()) fd.set("montant", d.montant.trim());
      if (d.reference.trim()) fd.set("reference", d.reference.trim());
      const fournisseur = String(formulaire.get(`fournisseur-${d.cle}`) ?? "").trim();
      if (fournisseur) fd.set("fournisseur", fournisseur);
      if (proforma === "imposee" || d.proforma) fd.set("proforma", "on");
      for (const a of autres) fd.append("autresPostes", a);
      return fd;
    };
    if (cartes) {
      void deposerChacun(devis.map((d) => ({ d, fd: fdDe(d, [d.fichier]) })));
      return;
    }
    // UN DEVIS (un fichier, ou les pages d'un même devis) : le dépôt d'avant, les champs de la première carte.
    const fd = fdDe(devis[0], devis.map((d) => d.fichier));
    void run(cleRun, async () => {
      const r = await deposer(fd);
      if (r.ok) onDepose(r.id ?? null);
      return r;
    }, "Pièce jointe au poste.").then(onClose);
  };

  const bloque = n === 0 ? "Choisissez d'abord le fichier." : lecturesEnCours > 0 ? "L'IA lit encore des devis : le dépôt s'ouvre à la fin des lectures." : undefined;
  return (
    <form onSubmit={soumettre} className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs sm:space-y-2 sm:p-2.5">
      <p className="font-medium text-foreground">{titre}</p>
      <p className="text-muted-foreground">{aide}</p>
      <label
        className={cn(
          "flex min-h-10 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/50 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/5 focus-within:ring-2 focus-within:ring-primary/40 sm:inline-flex sm:min-h-8 sm:w-auto sm:text-xs",
          occupe && "pointer-events-none opacity-50",
        )}
      >
        <Paperclip className="h-4 w-4 shrink-0" /> {n === 0 ? "Choisir le ou les fichiers" : "Ajouter d'autres fichiers"}
        <input
          type="file" multiple className="sr-only" disabled={occupe} aria-label="Fichiers des devis à déposer"
          onChange={(e) => { ajouter(e.target.files); e.target.value = ""; }}
        />
      </label>
      {n === 0 && (
        <p className="text-muted-foreground">
          Plusieurs fichiers d&apos;un coup, ou en plusieurs fois : chaque fichier devient un devis, lu par l&apos;IA, que vous relisez avant de tout déposer.
        </p>
      )}
      {ignores && <p className="text-muted-foreground">{ignores}</p>}
      {!cartes && n > 0 && (
        <ul className="space-y-1">
          {devis.map((d, i) => (
            <li key={d.cle} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{pages ? `Page ${i + 1} — ` : ""}{d.fichier.name}</span>
              <button
                type="button" onClick={() => retirer(d.cle)} disabled={occupe} aria-label={`Retirer « ${d.fichier.name} » de la liste`}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 sm:h-7 sm:w-7"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {n > 1 && (
        <div className="space-y-1">
          <label className="inline-flex min-h-9 items-start gap-1.5 sm:min-h-0">
            <input type="checkbox" checked={memeDevis} disabled={occupe} onChange={(e) => setMemeDevis(e.target.checked)} className="mt-0.5" />
            <span>Ces fichiers sont les pages d&apos;un même devis</span>
          </label>
          <p className="text-muted-foreground">
            {pages
              ? `Un seul devis de ${n} pages : les champs valent pour tout le devis, et seule la première page est lue.`
              : `${n} devis, une carte par fichier : vérifiez chacune — chaque devis est déposé à part, avec ses propres champs.`}
          </p>
        </div>
      )}
      {n > 0 && (
        <div className="space-y-2">
          {devis.map((d, i) => (
            <CarteDevis
              key={d.cle} d={d} rang={i + 1} variante={cartes ? "carte" : "seul"} masque={!cartes && i > 0}
              occupe={occupe} envoi={envoi === d.cle} proforma={proforma} fournisseurInitial={fournisseurInitial}
              onMaj={maj(d.cle)} onRetirer={() => retirer(d.cle)}
            />
          ))}
        </div>
      )}
      {freres.length > 0 && (
        <fieldset className="min-w-0 rounded-lg border border-border p-2" disabled={occupe}>
          <legend className="px-1 text-muted-foreground">{cartes ? "Ces devis couvrent aussi…" : "Ce document couvre aussi…"}</legend>
          <div className="flex flex-col gap-1">
            {freres.map((f) => (
              <label key={f.id} className="inline-flex min-h-9 flex-wrap items-center gap-1.5 sm:min-h-0">
                <input type="checkbox" name="autresPostes" value={f.id} /> {f.label}
                {f.label.trim().toLocaleLowerCase("fr") !== ITEM_KIND_LABELS[f.kind].toLocaleLowerCase("fr") && (
                  <span className="text-muted-foreground">({ITEM_KIND_LABELS[f.kind]})</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {cartes && lecturesEnCours > 0 && (
        <p className="flex items-start gap-1.5 text-muted-foreground">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>L&apos;IA lit encore {lecturesEnCours} devis — le dépôt s&apos;ouvre à la fin des lectures.</span>
        </p>
      )}
      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={occupe || Boolean(bloque)} title={bloque}>
          {occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} {cartes ? `Déposer les ${n} devis` : bouton}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>Annuler</Button>
      </div>
    </form>
  );
}
