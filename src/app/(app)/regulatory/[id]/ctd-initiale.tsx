"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileArchive, FileText, FolderPlus, Loader2, Pencil, Replace, Trash2, Check, X, Info, Archive } from "lucide-react";
import { DocumentPreview } from "@/components/documents/document-preview";
import { DocumentUpload } from "@/components/documents/document-upload";
import type { DocItem } from "@/components/documents/document-list";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { remplacerCtdInitiale, renommerDossierCtd, supprimerCtdInitiale } from "@/lib/actions/regulatory-ctd-actions";
import {
  CTD_INITIALE_CATEGORIE, CTD_INITIALE_ENTITE, CTD_INITIALE_ETAPE, CTD_INITIALE_LIBELLE,
  arborescenceCtd, dossiersDeLaCtd, resumeCtd, cheminSur, type NoeudCtd,
} from "@/lib/regulatory/ctd-initiale";
import { cn, formatDate } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

const humanSize = (n: number) => {
  if (!n) return "0 o";
  const u = ["o", "Ko", "Mo", "Go"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const s = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** « Quel geste est ouvert ? » — un seul panneau à la fois : on ne remplace pas pendant qu'on ajoute. */
type Panneau = "ajout" | "remplacement" | "suppression" | null;

/** La destination « nouveau dossier » du menu — une valeur qu'aucun chemin de dossier ne peut porter. */
const NOUVEAU = "\u0000nouveau";

/**
 * LA CTD INITIALE — le bloc de l'étape 1 du processus (« Réception du CTD complet »), bien visible,
 * avec la même importance que celui des réserves ANPP (§118.213).
 *
 * « Lors de la création d'un dossier, on doit pouvoir mettre un dossier ZIP complet (ou un dossier
 * entier) : il est mis dans la première étape du process, NOMMÉ « CTD initiale ». Elle pourra être
 * supprimée, remplacée, ou recevoir des fichiers et des dossiers dans un endroit particulier. »
 *
 * Ce que le bloc MONTRE : ce que la CTD contient (dossiers dépliables, un .zip s'ouvre dans sa
 * fenêtre sans être téléchargé). Ce qu'il OFFRE, et à qui : déposer (ajouter, ou la première fois)
 * à qui peut téléverser sur le dossier ; remplacer, supprimer et renommer un dossier à qui peut en
 * plus MODIFIER le dossier (`canManage`, lu sur la porte du serveur — l'écran ne l'invente pas).
 * Retirer ou remplacer met la CTD à la corbeille d'un bloc : récupérable par le Super Admin.
 */
export function CtdInitiale({
  productId, reference, docs, canUpload, canManage, canDelete, path, depotEnCours, retiree,
}: {
  productId: string;
  reference: string;
  /** Les documents de la CTD (catégorie « CTD complet » rattachée à l'étape 1) — déjà filtrés par le serveur. */
  docs: DocItem[];
  canUpload: boolean;
  canManage: boolean;
  /** Supprimer UN fichier de la CTD (irréversible : le droit de suppression du module, pas celui du dépôt). */
  canDelete: boolean;
  path: string;
  /** Le dossier vient d'être créé avec une CTD : l'envoi continue en arrière-plan. */
  depotEnCours: boolean;
  /** La dernière CTD retirée de ce dossier, restaurable depuis la corbeille par le Super Admin. */
  retiree: { quand: string; fichiers: number; remplacee: boolean } | null;
}) {
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const [ouvert, setOuvert] = React.useState(true);
  const [panneau, setPanneau] = React.useState<Panneau>(null);
  const [destination, setDestination] = React.useState("");
  const [nouveauDossier, setNouveauDossier] = React.useState("");
  const [enEcriture, setOccupe] = React.useState(false);
  const [message, setMessage] = React.useState<{ ton: "ok" | "erreur"; texte: string } | null>(null);
  // Un remplacement vient de partir : l'ancienne CTD est à la corbeille et la nouvelle monte en arrière-plan. Entre les
  // deux le bloc est vide — sans ce fait, il proposerait de la déposer une seconde fois.
  const [remplacementLance, setRemplacementLance] = React.useState(false);

  const arbre = React.useMemo(() => arborescenceCtd(docs), [docs]);
  const resume = React.useMemo(() => resumeCtd(docs), [docs]);
  const dossiers = React.useMemo(() => dossiersDeLaCtd(docs), [docs]);
  const vide = docs.length === 0;

  // Tant que la fiche n'a pas reçu l'état écrit, ses gestes restent fermés (§118.172).
  const occupe = enEcriture || rafraichit;

  const dossierBase = destination === NOUVEAU ? cheminSur(nouveauDossier) : cheminSur(destination);

  async function lancer(action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, extra: Record<string, string> = {}): Promise<boolean> {
    setOccupe(true); setMessage(null);
    const fd = new FormData();
    fd.set("productId", productId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    try {
      const r = await action(fd);
      if (!r.ok) { setMessage({ ton: "erreur", texte: r.error ?? "La CTD initiale n'a pas été modifiée." }); return false; }
      if (r.message) setMessage({ ton: "ok", texte: r.message });
      rafraichir();
      return true;
    } catch {
      setMessage({ ton: "erreur", texte: actionFailureMessage("THROWN") });
      return false;
    } finally {
      setOccupe(false);
    }
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/[0.04]" data-testid="ctd-initiale">
      <button type="button" onClick={() => setOuvert(!ouvert)} className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left" aria-expanded={ouvert}>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Archive className="h-4 w-4 shrink-0 text-primary" /> {CTD_INITIALE_LIBELLE}</p>
          <p className="text-xs text-muted-foreground">
            dossier {reference}
            {vide ? " · aucune CTD déposée"
              : ` · ${s(resume.fichiers, "fichier")}${resume.dossiers > 0 ? ` · ${s(resume.dossiers, "dossier")}` : ""} · ${humanSize(resume.octets)}`}
          </p>
        </div>
        <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", ouvert && "rotate-180")} />
      </button>

      {ouvert && (
        <div className="space-y-3 border-t border-primary/30 px-3 py-3">
          {(depotEnCours || remplacementLance) && vide && (
            <p className="flex items-start gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs" role="status">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-info" />
              <span>
                <strong>Envoi de la {CTD_INITIALE_LIBELLE} en cours</strong> : il continue en arrière-plan, vous pouvez travailler ailleurs. La progression est dans la pastille en bas à droite ;
                si un fichier échoue, « Réessayer » y apparaît — et si vous quittez la page avant la fin, redéposez-la ici.
              </span>
            </p>
          )}

          {retiree && (
            <p className="flex items-start gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs" role="status">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                {retiree.remplacee ? "Une CTD précédente a été remplacée" : "Une CTD a été supprimée"} le {formatDate(retiree.quand)} ({s(retiree.fichiers, "fichier")}). Elle est à la{" "}
                <Link href="/admin/corbeille" className="underline">corbeille</Link> : le Super Admin peut la restaurer.
              </span>
            </p>
          )}

          {message && (
            <p className={cn("rounded-lg px-3 py-2 text-xs", message.ton === "ok" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")} role={message.ton === "ok" ? "status" : "alert"}>
              {message.texte}
            </p>
          )}

          {vide ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Déposez ici la <strong>CTD complète</strong> du dossier : un <strong>.zip</strong>, ou un <strong>dossier entier</strong> (l&apos;arborescence est conservée) — jusqu&apos;à 10 Go. Un .zip se parcourt sans le télécharger.
              </p>
              {canUpload ? (
                <DocumentUpload entityType={CTD_INITIALE_ENTITE} entityId={productId} stepKey={CTD_INITIALE_ETAPE} categories={[CTD_INITIALE_CATEGORIE]} ctd compact libelleEnvoi="Déposer la CTD" />
              ) : (
                <p className="text-xs text-muted-foreground">Vous n&apos;avez pas le droit de téléverser sur ce dossier.</p>
              )}
            </div>
          ) : (
            <>
              <ul className="max-h-[28rem] overflow-y-auto rounded-lg border border-border bg-background p-1" aria-label={`Contenu de la ${CTD_INITIALE_LIBELLE}`}>
                <Noeud
                  noeud={arbre} racine profondeur={0} productId={productId} path={path}
                  canManage={canManage} canUpload={canUpload} canDelete={canDelete} occupe={occupe}
                  renommer={(dossier, nouveauNom) => lancer(renommerDossierCtd, { dossier, nouveauNom })}
                />
              </ul>

              <div className="flex flex-wrap items-center gap-2">
                {canUpload && (
                  <Button type="button" size="sm" variant={panneau === "ajout" ? "primary" : "outline"} onClick={() => setPanneau(panneau === "ajout" ? null : "ajout")} aria-pressed={panneau === "ajout"}>
                    <FolderPlus className="h-4 w-4" /> Ajouter à la CTD
                  </Button>
                )}
                {canManage && (
                  <>
                    <Button type="button" size="sm" variant={panneau === "remplacement" ? "primary" : "outline"} onClick={() => setPanneau(panneau === "remplacement" ? null : "remplacement")} aria-pressed={panneau === "remplacement"}>
                      <Replace className="h-4 w-4" /> Remplacer la CTD
                    </Button>
                    <Button type="button" size="sm" variant={panneau === "suppression" ? "primary" : "outline"} className="text-destructive" onClick={() => setPanneau(panneau === "suppression" ? null : "suppression")} aria-pressed={panneau === "suppression"}>
                      <Trash2 className="h-4 w-4" /> Supprimer la CTD
                    </Button>
                  </>
                )}
              </div>

              {panneau === "ajout" && canUpload && (
                <div className="space-y-2 rounded-lg border border-border bg-background p-3">
                  <p className="text-xs font-medium">Où poser les fichiers dans la CTD ?</p>
                  <Select value={destination} onChange={(e) => setDestination(e.target.value)} className="text-sm" aria-label="Dossier de destination dans la CTD">
                    <option value="">À la racine de la CTD</option>
                    {dossiers.map((d) => <option key={d} value={d}>{d}</option>)}
                    <option value={NOUVEAU}>Nouveau sous-dossier…</option>
                  </Select>
                  {destination === NOUVEAU && (
                    <input
                      value={nouveauDossier} onChange={(e) => setNouveauDossier(e.target.value)} placeholder="Nom du sous-dossier (ex. Compléments/Module 3)"
                      aria-label="Nom du nouveau sous-dossier" className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-ring"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Les fichiers (ou le dossier) déposés iront dans <strong>{dossierBase ?? "la racine de la CTD"}</strong>.
                    {destination === NOUVEAU && !dossierBase && " Saisissez un nom, ou choisissez un dossier existant."}
                  </p>
                  <DocumentUpload
                    entityType={CTD_INITIALE_ENTITE} entityId={productId} stepKey={CTD_INITIALE_ETAPE} categories={[CTD_INITIALE_CATEGORIE]}
                    ctd compact dossierBase={dossierBase} libelleEnvoi="Ajouter à la CTD"
                    avantEnvoi={async () => {
                      if (destination === NOUVEAU && !dossierBase) { setMessage({ ton: "erreur", texte: "Nommez le nouveau sous-dossier, ou choisissez-en un existant." }); return false; }
                      return true;
                    }}
                  />
                </div>
              )}

              {panneau === "remplacement" && canManage && (
                <div className="space-y-2 rounded-lg border border-warning/50 bg-background p-3">
                  <p className="text-xs">
                    Choisissez la <strong>nouvelle CTD</strong> (un .zip ou un dossier). Au clic de confirmation, la CTD actuelle ({s(resume.fichiers, "fichier")}, {humanSize(resume.octets)}) part
                    <strong> à la corbeille</strong> — restaurable par le Super Admin — et la nouvelle prend sa place.
                  </p>
                  <DocumentUpload
                    entityType={CTD_INITIALE_ENTITE} entityId={productId} stepKey={CTD_INITIALE_ETAPE} categories={[CTD_INITIALE_CATEGORIE]}
                    ctd compact libelleEnvoi="Remplacer la CTD" confirmationEnvoi="remplacer la CTD (l'actuelle part à la corbeille)"
                    avantEnvoi={async () => { const ok = await lancer(remplacerCtdInitiale); if (ok) setRemplacementLance(true); return ok; }}
                  />
                </div>
              )}

              {panneau === "suppression" && canManage && (
                <div className="space-y-2 rounded-lg border border-destructive/40 bg-background p-3">
                  <p className="text-xs font-medium">Ce qui partira à la corbeille</p>
                  <p className="text-xs">
                    {s(resume.fichiers, "fichier")}{resume.dossiers > 0 ? `, ${s(resume.dossiers, "dossier")}` : ""}{resume.archives > 0 ? `, dont ${s(resume.archives, "archive")} .zip` : ""} — {humanSize(resume.octets)} au total.
                    Les fichiers restent stockés : le <strong>Super Admin</strong> peut restaurer la CTD tant qu&apos;elle n&apos;a pas été détruite.
                  </p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {docs.slice(0, 6).map((d) => <li key={d.id} className="truncate">{d.folder ? `${d.folder}/` : ""}{d.name}</li>)}
                    {docs.length > 6 && <li>… et {s(docs.length - 6, "autre")}</li>}
                  </ul>
                  <BoutonDecisif
                    type="button" size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" disabled={occupe}
                    confirmation={`supprimer la ${CTD_INITIALE_LIBELLE} (${s(resume.fichiers, "fichier")}, restaurable par le Super Admin)`}
                    onClick={async () => { if (await lancer(supprimerCtdInitiale)) setPanneau(null); }}
                  >
                    {occupe ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer la CTD
                  </BoutonDecisif>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Un dossier de la CTD (ou sa racine) : ses sous-dossiers et ses fichiers, dépliés à la demande. */
function Noeud({
  noeud, racine = false, profondeur, productId, path, canManage, canUpload, canDelete, occupe, renommer,
}: {
  noeud: NoeudCtd<DocItem>;
  racine?: boolean;
  profondeur: number;
  productId: string;
  path: string;
  canManage: boolean;
  canUpload: boolean;
  canDelete: boolean;
  occupe: boolean;
  renommer: (dossier: string, nouveauNom: string) => Promise<boolean>;
}) {
  const [ouvert, setOuvert] = React.useState(racine || profondeur <= 1);
  const [edition, setEdition] = React.useState(false);
  const [brouillon, setBrouillon] = React.useState(noeud.nom);

  const enfants = (
    <>
      {noeud.dossiers.map((d) => (
        <Noeud
          key={d.chemin} noeud={d} profondeur={profondeur + 1} productId={productId} path={path}
          canManage={canManage} canUpload={canUpload} canDelete={canDelete} occupe={occupe} renommer={renommer}
        />
      ))}
      {noeud.fichiers.map((f) => (
        <li key={f.id} className="flex items-center gap-2 py-1.5" style={{ paddingLeft: `${(profondeur + (racine ? 0 : 1)) * 14 + 8}px` }}>
          {/\.zip$/i.test(f.name) ? <FileArchive className="h-4 w-4 shrink-0 text-primary" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <DocumentPreview id={f.id} name={f.name} hasFile={f.hasFile} canDelete={canDelete} canRename={canUpload} path={path} />
            <p className="truncate text-[0.6875rem] text-muted-foreground">
              {[f.version > 1 ? `v${f.version}` : "", humanSize(f.sizeBytes ?? 0), formatDate(f.createdAt), f.uploadedBy ?? ""].filter(Boolean).join(" · ")}
            </p>
          </div>
        </li>
      ))}
    </>
  );

  if (racine) return enfants;

  return (
    <li>
      <div className="flex items-center gap-1.5 py-1.5" style={{ paddingLeft: `${profondeur * 14 + 4}px` }}>
        <button type="button" onClick={() => setOuvert(!ouvert)} aria-expanded={ouvert} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" disabled={edition}>
          {ouvert ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          {ouvert ? <FolderOpen className="h-4 w-4 shrink-0 text-primary" /> : <Folder className="h-4 w-4 shrink-0 text-primary" />}
          {edition ? null : (
            <>
              <span className="truncate text-[0.8125rem] font-medium" title={noeud.chemin}>{noeud.nom}</span>
              <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{s(noeud.nbFichiers, "fichier")} · {humanSize(noeud.octets)}</span>
            </>
          )}
        </button>
        {edition && (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <input
              autoFocus value={brouillon} onChange={(e) => setBrouillon(e.target.value)} aria-label={`Nouveau nom du dossier ${noeud.nom}`}
              onKeyDown={(e) => { if (e.key === "Escape") { setEdition(false); setBrouillon(noeud.nom); } }}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs focus-ring"
            />
            <button type="button" disabled={occupe} aria-label="Enregistrer le nom" className="rounded-md p-2 text-success hover:bg-success/10 sm:p-1"
              onClick={async () => { if (await renommer(noeud.chemin, brouillon)) setEdition(false); }}>
              {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button type="button" aria-label="Annuler" className="rounded-md p-2 text-muted-foreground hover:bg-secondary sm:p-1" onClick={() => { setEdition(false); setBrouillon(noeud.nom); }}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        {canManage && !edition && (
          <button type="button" aria-label={`Renommer le dossier ${noeud.nom}`} title="Renommer ce dossier" className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1"
            onClick={() => { setBrouillon(noeud.nom); setEdition(true); }}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {ouvert && <ul>{enfants}</ul>}
    </li>
  );
}
