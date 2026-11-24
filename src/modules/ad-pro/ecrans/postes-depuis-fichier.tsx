"use client";

import * as React from "react";
import { AlertTriangle, FileUp, Loader2, Plus, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { actionFailureMessage } from "@/lib/action-outcome";
import { addAdProItem } from "../actions-postes";
import { proposerPostesDepuisFichier } from "../actions-postes-fichier";
import type { AdProParent } from "../domaine/postes";
import { initialDuPoste } from "../domaine/postes-fichier";
import { AddItemForm } from "./postes/formulaires";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER LES POSTES DEPUIS UN FICHIER (recette 24/11/2026) — à côté de « Ajouter un poste », pour qui ajoute les
 * postes de la demande.
 *
 *   1. elle dépose UN fichier — le cahier des charges ; il reste dans les pièces de la demande ;
 *   2. « L'IA lit le document… » ; chaque poste proposé s'affiche dans LE FORMULAIRE « AJOUTER UN POSTE » lui-même,
 *      pré-rempli (nature, libellé, précisions, cahier des charges) ;
 *   3. « LES POSTES DU CAHIER DES CHARGES SUIVENT EXACTEMENT LE CHEMIN DES POSTES SAISIS À LA MAIN » (Direction,
 *      24/11/2026) : la voie de paiement, le contrôle de conformité, les fiches (voyageurs, hôtellerie) et l'assistante
 *      se choisissent dans ce même formulaire, et son bouton (« Ajouter », « Ajouter et demander la prospection »)
 *      envoie le même formulaire à la même action (`addAdProItem`). Ni montant ni budget à la publication.
 *
 * Rien n'est créé sans le clic de la personne sur la proposition ; « Retirer » l'écarte. Fermer le panneau ne perd
 * rien : les propositions attendent qu'on le rouvre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que le lecteur commun sait lire (`FORMATS_LUS`) : le filtre du sélecteur évite un aller-retour, le serveur revérifie. */
const ACCEPTES = ".pdf,.docx,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.tif,.tiff,application/pdf,image/*";

type Initial = ReturnType<typeof initialDuPoste>;
interface Proposition {
  cle: number;
  /** `null` : une proposition vide (saisie à la main quand l'IA n'a pas pu lire). */
  initial: Initial | null;
  erreur: string | null;
}

type Etape = "fichier" | "lecture" | "relecture";

export function PostesDepuisFichier({ parent, parentId, tardif, verrouille, masquerLeBouton = false, onFait, assistantes = [], marketing = false, libelle = "Créer les postes depuis un fichier" }: {
  parent: AdProParent;
  parentId: string;
  /** Les assistantes de direction — la Direction Marketing choisit celle qui prospecte (dans le formulaire du poste). */
  assistantes?: { id: string; name: string }[];
  /** La personne qui regarde tranche pour la Direction Marketing : « Ajouter » lance aussi la prospection. */
  marketing?: boolean;
  /** Un poste ajouté maintenant l'est après la décision (§118.151) — dit dans le formulaire comme à la main. */
  tardif: boolean;
  /** Le panneau des postes est occupé (une action, un rafraîchissement) : le bouton attend. */
  verrouille: boolean;
  /** Le formulaire « Ajouter un poste » est ouvert : le bouton se retire, la proposition en cours reste. */
  masquerLeBouton?: boolean;
  /** Un poste a été créé : le panneau le dit et se rafraîchit. */
  onFait: (r: { ok: boolean; text: string; crees: number }) => void;
  /** Le libellé du bouton — « Depuis un cahier des charges » dans l'en-tête du tableau des postes (24/11/2026). */
  libelle?: string;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  const [etape, setEtape] = React.useState<Etape>("fichier");
  const [fichier, setFichier] = React.useState<File | null>(null);
  // Le champ fichier n'est pas contrôlé : changer sa clé le vide quand on recommence.
  const [cleChamp, setCleChamp] = React.useState(0);
  const [erreur, setErreur] = React.useState<{ text: string; fichierGarde: boolean } | null>(null);
  const [phrase, setPhrase] = React.useState<string | null>(null);
  const [remarques, setRemarques] = React.useState<string[]>([]);
  const [propositions, setPropositions] = React.useState<Proposition[]>([]);
  const [enCours, setEnCours] = React.useState<number | null>(null);
  const verrou = React.useRef(false);
  const compteur = React.useRef(0);

  const nouvelle = (initial: Initial | null): Proposition => {
    compteur.current += 1;
    return { cle: compteur.current, initial, erreur: null };
  };

  const recommencer = () => {
    setEtape("fichier"); setFichier(null); setCleChamp((c) => c + 1); setErreur(null);
    setPhrase(null); setRemarques([]); setPropositions([]);
  };

  // Pendant un ajout, le panneau reste ouvert : la proposition dit ce qui se passe.
  const fermer = () => { if (enCours === null) setOuvert(false); };

  async function lire() {
    if (!fichier || verrou.current) return;
    verrou.current = true;
    setEtape("lecture"); setErreur(null);
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
      setPropositions(r.postes.length > 0 ? r.postes.map((p) => nouvelle(initialDuPoste(p, fichier.name))) : [nouvelle(null)]);
      setEtape("relecture");
    } catch {
      // Une action qui LÈVE (connexion coupée, redéploiement) : le fichier a pu être déposé avant la coupure.
      setErreur({ text: "La lecture n'a pas abouti (connexion ou serveur). Regardez les pièces de la demande avant de relancer : le fichier a pu y être déposé.", fichierGarde: false });
      setEtape("fichier");
    } finally {
      verrou.current = false;
    }
  }

  /** L'IA n'a pas pu lire, mais le fichier est gardé : le formulaire ordinaire, vide. */
  const saisirALaMain = () => {
    setErreur(null); setPhrase(null); setRemarques([]);
    setPropositions([nouvelle(null)]);
    setEtape("relecture");
  };

  const retirer = (cle: number) => setPropositions((ps) => ps.filter((p) => p.cle !== cle));

  /** LE MÊME GESTE QU'À LA MAIN : le formulaire de la proposition, envoyé tel quel à `addAdProItem`. */
  async function ajouter(cle: number, fd: FormData) {
    if (enCours !== null) return;
    setEnCours(cle);
    let r: { ok: boolean; error?: string; message?: string };
    try {
      r = await addAdProItem(undefined, fd);
    } catch {
      r = { ok: false, error: actionFailureMessage("THROWN") };
    }
    setEnCours(null);
    if (!r.ok) {
      setPropositions((ps) => ps.map((p) => (p.cle === cle ? { ...p, erreur: r.error ?? "Le poste n'a pas été créé." } : p)));
      return;
    }
    const restantes = propositions.filter((p) => p.cle !== cle);
    setPropositions(restantes);
    onFait({ ok: true, text: r.message ?? "Poste ajouté.", crees: 1 });
    if (restantes.length === 0) { recommencer(); setOuvert(false); }
  }

  const n = propositions.length;

  return (
    <>
      {!masquerLeBouton && (
        <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" disabled={verrouille} onClick={() => setOuvert(true)}>
          <Sparkles className="h-4 w-4" /> {libelle}
        </Button>
      )}
      <Sheet
        open={ouvert}
        onClose={fermer}
        width="lg"
        title="Créer les postes depuis un fichier"
        description="L'IA lit le document et pré-remplit le formulaire « Ajouter un poste » pour chaque poste ; vous complétez et ajoutez chacun comme à la main."
      >
        {etape !== "relecture" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Déposez le cahier des charges — PDF, Word (.docx), Excel, ou une photo / un scan. L&apos;IA en tire la liste des postes ;
              chacun s&apos;ajoute ensuite par le formulaire habituel. Le fichier reste dans les pièces de la demande.
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

            {n === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                Plus aucune proposition : ajoutez-en une vide, lisez un autre fichier, ou fermez le panneau.
              </p>
            ) : (
              <ol className="space-y-3">
                {propositions.map((p, i) => (
                  <li key={p.cle} aria-label={`Poste proposé ${i + 1}`} className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Poste proposé {i + 1} sur {n}</p>
                    <AddItemForm
                      parent={parent}
                      parentId={parentId}
                      decided={tardif}
                      assistantes={assistantes}
                      marketing={marketing}
                      busy={enCours === p.cle}
                      initial={p.initial ?? undefined}
                      libelleAnnuler="Retirer"
                      onCancel={() => retirer(p.cle)}
                      onSubmit={(fd) => void ajouter(p.cle, fd)}
                    />
                    {p.erreur && (
                      <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                        <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{p.erreur}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => setPropositions((ps) => [...ps, nouvelle(null)])} disabled={enCours !== null}>
                <Plus className="h-4 w-4" /> Ajouter un poste vide
              </Button>
              <Button type="button" size="sm" variant="ghost" className="w-full sm:w-auto" onClick={recommencer} disabled={enCours !== null}>
                <RotateCcw className="h-4 w-4" /> Lire un autre fichier
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
