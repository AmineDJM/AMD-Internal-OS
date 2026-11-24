"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Plus, RotateCcw, Sparkles, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { actionFailureMessage } from "@/lib/action-outcome";
import { formatCurrency } from "@/lib/utils";
import { addAdProItem } from "../actions-postes";
import { proposerPostesDepuisFichier } from "../actions-postes-fichier";
import { ITEM_KIND_LABELS, type AdProParent } from "../domaine/postes";
import {
  LIGNE_VIDE, ligneDepuisPoste, lireNombre, NATURES_DU_FICHIER, posteDepuisLaSaisie, versFormulaireDuPoste, voieProposee, type LigneSaisie,
} from "../domaine/postes-fichier";
import { voieAgencePossible } from "../domaine/parcours-agence";
import type { AdProItemKind } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER LES POSTES DEPUIS UN FICHIER (recette 24/11/2026) — à côté de « Ajouter un poste », pour qui ajoute les
 * postes de la demande.
 *
 *   1. elle dépose UN fichier — le cahier des charges ; il reste dans les pièces de la demande ;
 *   2. « L'IA lit le document… » ; la liste proposée s'affiche en CARTES (une par poste), modifiables : nature,
 *      libellé, description, quantité, montant estimé — retirer une ligne, en ajouter une vide ;
 *   3. RIEN n'est créé avant « Créer les N postes » : chaque ligne passe alors par `addAdProItem`, l'action
 *      ordinaire d'ajout, une à une — ses gardes, son audit. Une ligne refusée reste à l'écran, corrigeable, avec
 *      la raison ; les autres sont créées.
 *
 * Toutes les lignes se relisent AVANT la première création (`posteDepuisLaSaisie`) : une faute de saisie ne laisse
 * pas une liste à moitié créée. Fermer le panneau ne perd rien : la proposition attend qu'on le rouvre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que le lecteur commun sait lire (`FORMATS_LUS`) : le filtre du sélecteur évite un aller-retour, le serveur revérifie. */
const ACCEPTES = ".pdf,.docx,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.tif,.tiff,application/pdf,image/*";

const CHAMP = "mt-1 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 disabled:opacity-60 sm:text-sm";

interface Ligne extends LigneSaisie {
  cle: number;
  /** Le montant vient du document, pas d'une saisie — l'écran le dit sous le champ. */
  montantLu: boolean;
  erreur: string | null;
}

type Etape = "fichier" | "lecture" | "relecture";

export function PostesDepuisFichier({ parent, parentId, tardif, verrouille, masquerLeBouton = false, onFait, assistantes = [], marketing = false }: {
  parent: AdProParent;
  parentId: string;
  /** Les assistantes de direction — la Direction Marketing choisit celle qui prospecte les postes « par une agence ». */
  assistantes?: { id: string; name: string }[];
  /** La personne qui regarde tranche pour la Direction Marketing : ses postes « par une agence » partent en prospection. */
  marketing?: boolean;
  /** Un poste ajouté maintenant l'est après la décision (§118.151) — dit ici comme dans « Ajouter un poste ». */
  tardif: boolean;
  /** Le panneau des postes est occupé (une action, un rafraîchissement) : le bouton attend. */
  verrouille: boolean;
  /** Le formulaire « Ajouter un poste » est ouvert : le bouton se retire, la proposition en cours reste. */
  masquerLeBouton?: boolean;
  /** Des postes ont été créés : le panneau le dit et se rafraîchit. */
  onFait: (r: { ok: boolean; text: string; crees: number }) => void;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  const [etape, setEtape] = React.useState<Etape>("fichier");
  const [fichier, setFichier] = React.useState<File | null>(null);
  // Le champ fichier n'est pas contrôlé : changer sa clé le vide quand on recommence.
  const [cleChamp, setCleChamp] = React.useState(0);
  const [erreur, setErreur] = React.useState<{ text: string; fichierGarde: boolean } | null>(null);
  const [phrase, setPhrase] = React.useState<string | null>(null);
  const [remarques, setRemarques] = React.useState<string[]>([]);
  const [lignes, setLignes] = React.useState<Ligne[]>([]);
  const [creation, setCreation] = React.useState(false);
  const [bilan, setBilan] = React.useState<string | null>(null);
  const [assistanteId, setAssistanteId] = React.useState(assistantes.length === 1 ? assistantes[0]!.id : "");
  const verrou = React.useRef(false);
  const compteur = React.useRef(0);

  const nouvelle = (l: LigneSaisie, montantLu = false): Ligne => {
    compteur.current += 1;
    return { ...l, cle: compteur.current, montantLu, erreur: null };
  };

  const recommencer = () => {
    setEtape("fichier"); setFichier(null); setCleChamp((c) => c + 1); setErreur(null);
    setPhrase(null); setRemarques([]); setLignes([]); setBilan(null);
  };

  // Pendant la création, le panneau reste ouvert : la liste dit ce qui est créé et ce qui reste.
  const fermer = () => { if (!creation) setOuvert(false); };

  async function lire() {
    if (!fichier || verrou.current) return;
    verrou.current = true;
    setEtape("lecture"); setErreur(null); setBilan(null);
    const fd = new FormData();
    fd.append("parent", parent);
    fd.append("parentId", parentId);
    fd.append("fichier", fichier);
    try {
      const r = await proposerPostesDepuisFichier(fd);
      if (!r.ok) {
        setErreur({ text: r.error, fichierGarde: r.fichierGarde });
        setEtape("fichier");
        return;
      }
      setPhrase(r.phrase);
      setRemarques(r.remarques);
      setLignes(r.postes.length > 0 ? r.postes.map((p) => nouvelle(ligneDepuisPoste(p), p.montant !== null)) : [nouvelle(LIGNE_VIDE)]);
      setEtape("relecture");
    } catch {
      // Une action qui LÈVE (connexion coupée, redéploiement) : le fichier a pu être déposé avant la coupure.
      setErreur({ text: "La lecture n'a pas abouti (connexion ou serveur). Regardez les pièces de la demande avant de relancer : le fichier a pu y être déposé.", fichierGarde: false });
      setEtape("fichier");
    } finally {
      verrou.current = false;
    }
  }

  /** L'IA n'a pas pu lire, mais le fichier est gardé : la même liste, saisie à la main. */
  const saisirALaMain = () => {
    setErreur(null); setPhrase(null); setRemarques([]); setBilan(null);
    setLignes([nouvelle(LIGNE_VIDE)]);
    setEtape("relecture");
  };

  const modifier = (cle: number, champ: keyof LigneSaisie, valeur: string) => {
    // Changer la nature repropose SA voie (la règle du formulaire « Ajouter un poste »).
    setLignes((ls) => ls.map((l) => (l.cle === cle
      ? { ...l, [champ]: valeur, ...(champ === "nature" ? { voie: voieProposee(valeur) } : {}), montantLu: champ === "montant" ? false : l.montantLu, erreur: null }
      : l)));
  };
  const retirer = (cle: number) => setLignes((ls) => ls.filter((l) => l.cle !== cle));
  const ajouter = () => setLignes((ls) => [...ls, nouvelle(LIGNE_VIDE)]);

  async function creer() {
    if (verrou.current || lignes.length === 0) return;
    // Toutes les lignes se relisent AVANT la première création : une faute de saisie ne laisse pas une liste à moitié créée.
    const lues = lignes.map((l) => ({ l, r: posteDepuisLaSaisie(l) }));
    if (lues.some((x) => !x.r.ok)) {
      setLignes(lues.map(({ l, r }) => ({ ...l, erreur: r.ok ? null : r.error })));
      setBilan("Corrigez les lignes signalées : aucun poste n'a été créé.");
      return;
    }
    // L'ASSISTANTE QUI PROSPECTE : la Direction Marketing la choisit quand il y en a plusieurs (l'action l'exige).
    if (marketing && parAgence > 0 && assistantes.length > 1 && !assistanteId) {
      setBilan("Choisissez l'assistante de direction qui prospecte les agences : aucun poste n'a été créé.");
      return;
    }
    verrou.current = true;
    setCreation(true);
    setBilan(null);
    const restantes: Ligne[] = [];
    let crees = 0;
    // UNE À UNE, PAR L'ACTION ORDINAIRE : l'ordre de la liste est celui des postes, et chaque refus garde sa raison.
    for (const { l, r } of lues) {
      if (!r.ok) continue;
      const f = new FormData();
      for (const [k, v] of versFormulaireDuPoste(r.poste, parent, parentId, { assistanteId: assistanteId || null, fichier: fichier?.name ?? null })) f.append(k, v);
      let x: { ok: boolean; error?: string };
      try {
        x = await addAdProItem(undefined, f);
      } catch {
        x = { ok: false, error: actionFailureMessage("THROWN") };
      }
      if (x.ok) crees += 1;
      else restantes.push({ ...l, erreur: x.error ?? "Le poste n'a pas été créé." });
    }
    verrou.current = false;
    setCreation(false);
    const fait = `${crees} poste${crees > 1 ? "s" : ""} créé${crees > 1 ? "s" : ""} depuis le fichier`;
    if (restantes.length === 0) {
      onFait({ ok: true, text: `${fait}.`, crees });
      recommencer();
      setOuvert(false);
      return;
    }
    const reste = `${restantes.length} non créé${restantes.length > 1 ? "s" : ""}`;
    setLignes(restantes);
    setBilan(`${crees > 0 ? `${fait} ; ` : ""}${reste} — corrigez ${restantes.length > 1 ? "les lignes" : "la ligne"} et relancez.`);
    if (crees > 0) onFait({ ok: true, text: `${fait} ; ${reste}, à reprendre dans « Créer les postes depuis un fichier ».`, crees });
  }

  const n = lignes.length;
  const parAgence = lignes.filter((l) => l.voie === "AGENCE").length;
  const avertissementTardif = tardif && (
    <p className="flex items-start gap-1.5 text-[0.6875rem] text-warning">
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      L&apos;opération est déjà tranchée : les postes créés seront marqués « ajoutés après décision », et la Direction en est prévenue.
    </p>
  );

  return (
    <>
      {!masquerLeBouton && (
        <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" disabled={verrouille} onClick={() => setOuvert(true)}>
          <Sparkles className="h-4 w-4" /> Créer les postes depuis un fichier
        </Button>
      )}
      <Sheet
        open={ouvert}
        onClose={fermer}
        width="lg"
        title="Créer les postes depuis un fichier"
        description="L'IA lit le document et propose les postes ; rien n'est créé avant votre validation."
        footer={etape === "relecture" ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={fermer} disabled={creation}>Fermer</Button>
            <Button type="button" onClick={() => void creer()} disabled={creation || n === 0}>
              {creation ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {creation ? "Création des postes…" : n === 0 ? "Aucun poste à créer" : n === 1 ? "Créer le poste" : `Créer les ${n} postes`}
            </Button>
          </div>
        ) : undefined}
      >
        {etape !== "relecture" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Déposez le cahier des charges — PDF, Word (.docx), Excel, ou une photo / un scan. L&apos;IA en tire la liste des postes,
              que vous relisez avant de créer. Le fichier reste dans les pièces de la demande.
            </p>
            <label className="block text-xs">
              Fichier
              <input
                key={cleChamp}
                type="file"
                accept={ACCEPTES}
                disabled={etape === "lecture"}
                onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setErreur(null); }}
                className="mt-1 block w-full min-w-0 max-w-full text-sm [overflow-wrap:anywhere]"
              />
            </label>
            {avertissementTardif}
            {erreur && (
              <div role="alert" className="space-y-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <p className="flex items-start gap-2">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{erreur.text}</span>
                </p>
                {erreur.fichierGarde && (
                  <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={saisirALaMain}>
                    <Plus className="h-4 w-4" /> Saisir les postes vous-même
                  </Button>
                )}
              </div>
            )}
            {etape === "lecture" ? (
              <p role="status" className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                L&apos;IA lit le document… (jusqu&apos;à une minute pour un scan)
              </p>
            ) : (
              <Button type="button" className="w-full sm:w-auto" disabled={!fichier} onClick={() => void lire()}>
                <FileUp className="h-4 w-4" /> Lire le document
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {phrase && (
              <p role="status" className="flex items-start gap-2 rounded-xl bg-primary/5 px-3 py-2 text-sm">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{phrase}</span>
              </p>
            )}
            {remarques.length > 0 && (
              <div className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" /> À vérifier
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
                  {remarques.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            )}
            {avertissementTardif}
            {bilan && (
              <p role="alert" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{bilan}</span>
              </p>
            )}

            {parAgence > 0 && (
              <div className="space-y-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm">
                <p className="text-muted-foreground">
                  {marketing
                    ? "Les postes « par une agence » partent tout de suite en prospection chez l'assistante, avec le cahier des charges ; les autres attendent votre accord (montant et budget)."
                    : "Les postes « par une agence » sont soumis à la Direction Marketing, qui lance la prospection ; les autres lui sont soumis pour accord."}
                </p>
                {marketing && assistantes.length > 1 && (
                  <label htmlFor="pf-assistante" className="block text-xs">
                    Assistante qui prospecte les agences
                    <select id="pf-assistante" value={assistanteId} disabled={creation} onChange={(e) => setAssistanteId(e.target.value)} className={CHAMP}>
                      <option value="">— Choisir —</option>
                      {assistantes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                )}
                {marketing && assistantes.length === 1 && (
                  <p className="text-xs text-muted-foreground">Assistante qui prospecte : {assistantes[0]!.name}.</p>
                )}
              </div>
            )}
            {n === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                Aucune ligne : ajoutez-en une, ou fermez le panneau.
              </p>
            ) : (
              <ol className="space-y-3">
                {lignes.map((l, i) => {
                  const id = (champ: string) => `pf-${l.cle}-${champ}`;
                  const montant = l.montant.trim() ? lireNombre(l.montant) : null;
                  return (
                    <li key={l.cle} aria-label={`Poste ${i + 1}`} className={`space-y-2 rounded-xl border bg-card p-3 ${l.erreur ? "border-destructive/50" : "border-border"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Poste {i + 1}</span>
                        <Button type="button" size="sm" variant="ghost" onClick={() => retirer(l.cle)} disabled={creation} aria-label={`Retirer le poste ${i + 1}`}>
                          <Trash2 className="h-4 w-4" /> Retirer
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label htmlFor={id("nature")} className="block min-w-0 text-xs">
                          Nature
                          <select id={id("nature")} value={l.nature} disabled={creation} onChange={(e) => modifier(l.cle, "nature", e.target.value)} className={CHAMP}>
                            {NATURES_DU_FICHIER.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
                          </select>
                        </label>
                        <label htmlFor={id("libelle")} className="block min-w-0 text-xs">
                          Libellé
                          <input
                            id={id("libelle")} value={l.libelle} required maxLength={160} disabled={creation}
                            placeholder="Stand 12 m² — hall B"
                            onChange={(e) => modifier(l.cle, "libelle", e.target.value)} className={CHAMP}
                          />
                        </label>
                      </div>
                      <label htmlFor={id("description")} className="block text-xs">
                        Description <span className="text-muted-foreground">(facultatif)</span>
                        <textarea
                          id={id("description")} value={l.description} rows={2} maxLength={600} disabled={creation}
                          onChange={(e) => modifier(l.cle, "description", e.target.value)} className={CHAMP}
                        />
                      </label>
                      <label htmlFor={id("voie")} className="block text-xs">
                        Comment ce poste se paie
                        <select id={id("voie")} value={l.voie} disabled={creation} onChange={(e) => modifier(l.cle, "voie", e.target.value)} className={CHAMP}>
                          {l.voie === "" && <option value="">À choisir ensuite sur la carte du poste</option>}
                          {voieAgencePossible(l.nature as AdProItemKind) && <option value="AGENCE">Par une agence — prospection par l&apos;assistante</option>}
                          <option value="DIRECT">Directement — sans agence</option>
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label htmlFor={id("quantite")} className="block min-w-0 text-xs">
                          Quantité
                          <input
                            id={id("quantite")} value={l.quantite} inputMode="numeric" placeholder="—" disabled={creation}
                            onChange={(e) => modifier(l.cle, "quantite", e.target.value)} className={CHAMP}
                          />
                        </label>
                        <label htmlFor={id("montant")} className="block min-w-0 text-xs">
                          Montant estimé (DZD)
                          <input
                            id={id("montant")} value={l.montant} inputMode="decimal" placeholder="Non écrit" disabled={creation}
                            onChange={(e) => modifier(l.cle, "montant", e.target.value)} className={CHAMP}
                          />
                          {(montant !== null || l.montantLu) && (
                            <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">
                              {montant !== null ? formatCurrency(montant) : ""}{l.montantLu ? " · lu dans le document" : ""}
                            </span>
                          )}
                        </label>
                      </div>
                      {l.erreur && (
                        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                          <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 [overflow-wrap:anywhere]">{l.erreur}</span>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={ajouter} disabled={creation}>
                <Plus className="h-4 w-4" /> Ajouter une ligne
              </Button>
              <Button type="button" size="sm" variant="ghost" className="w-full sm:w-auto" onClick={recommencer} disabled={creation}>
                <RotateCcw className="h-4 w-4" /> Lire un autre fichier
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
