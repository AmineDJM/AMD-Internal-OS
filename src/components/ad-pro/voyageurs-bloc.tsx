"use client";

import * as React from "react";
import Link from "next/link";
import { Plane, Plus, Send, Loader2, ExternalLink, CheckCircle2, MoreHorizontal, Upload, FileCheck2, Trash2 } from "lucide-react";
import type { AdProTrajet, AdProTransport } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentPreview } from "@/components/documents/document-preview";
import {
  ajouterVoyageur, modifierVoyageur, retirerVoyageur, demanderReservation, retirerReservation,
  ajouterDevisVoyageur, validerDevisVoyageur, demanderBCBilletterie,
} from "@/lib/actions/ad-pro-item-actions";
import {
  manquesPourReserver, jourLisible, prochainGesteVoyageur, depassementDevisRetenus, nomComplet, separerNom, ETAPES_MAX,
  TRANSPORTS, TRANSPORT_LIBELLE, TRAJET_LIBELLE, TRAJETS, type EtapeTrajet,
} from "@/lib/ad-pro/voyageurs";

/** Un devis ou une pro forma déposé pour un voyageur (§118.205) — une pièce du poste, au registre Legal. */
export interface DevisVoyageurVue {
  /** L'identifiant de la pièce au registre (ce que `validerDevisVoyageur` reçoit). */
  id: string;
  titre: string;
  reference: string | null;
  montant: number | null;
  /** La proposition retenue par le demandeur — au plus une par voyageur. */
  retenu: boolean;
  annule: boolean;
  fichier: { id: string; name: string; hasFile: boolean } | null;
  /** La pièce dont celle-ci est une COPIE (le même fichier, déposé pour un autre voyageur) — comptée une fois. */
  copieDe?: string | null;
}

/** Un voyageur tel que l'écran le montre — les dates en AAAA-MM-JJ, prêtes pour un champ « date ». */
export interface VoyageurVue {
  id: string;
  /** Le nom de famille (celui d'avant la séparation porte ici son nom complet). */
  nom: string;
  prenom: string | null;
  /** Les étapes d'un trajet à plusieurs destinations — vide sinon. */
  segments: EtapeTrajet[];
  /** Les autres documents déposés pour lui (visa, assurance, justificatif…) — pièces du poste, `stepKey` = lui. */
  autresDocuments: { id: string; name: string; hasFile: boolean }[];
  villeDepart: string | null;
  villeArrivee: string | null;
  dateDepart: string | null;
  dateRetour: string | null;
  notes: string | null;
  trajet: AdProTrajet;
  transport: AdProTransport | null;
  /** Le ou les passeports déposés pour lui (pièces d'identité du poste dont `stepKey` est son identifiant). */
  passeports: { id: string; name: string; hasFile: boolean }[];
  devis: DevisVoyageurVue[];
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

const jour = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const dzd = (n: number) => `${n.toLocaleString("fr-FR")} DZD`;

/**
 * LES VOYAGEURS D'UN POSTE « BILLETTERIE » (§118.175, §118.205).
 *
 * « Ultra simple » (Direction, 04/10) : par voyageur, UNE ligne compacte — nom, trajet, dates, mode,
 * passeport — et UN seul bouton visible, celui de ce qui manque (passeport, puis devis de l'agence, puis
 * « valider ce devis » ; `prochainGesteVoyageur`). Le reste (modifier, autre devis, changer de devis,
 * remplacer le passeport, retirer) vit dans le menu « ⋯ ». Le BC du poste se demande d'ici dès qu'un devis
 * est retenu ; il suit ensuite la chaîne du poste jusqu'à la facture.
 *
 * Les noms proposés à la saisie sont ceux que la demande porte déjà — des suggestions, jamais un
 * rattachement deviné à une fiche de l'annuaire (§118.85).
 */
export function BlocVoyageurs({
  itemId, voyageurs, nomsSuggeres, reservation, peutEditer, peutReserver, busy, run,
  montantAccorde, bcPossible, assistantes,
}: {
  itemId: string;
  voyageurs: VoyageurVue[];
  nomsSuggeres: string[];
  /** Le sujet de réservation ; `refusRetrait` : la raison qui empêche de la retirer (`null` : elle se retire). */
  reservation: { id: string; reference: string; refusRetrait: string | null } | null;
  peutEditer: boolean;
  /** Le poste n'est pas refusé — l'action le revérifie. */
  peutReserver: boolean;
  /** Une action en cours, ou l'écran qui se met à jour : les formulaires ne s'ouvrent pas sur un état périmé (§118.172). */
  busy: string | null;
  run: Run;
  /** Le montant accordé par les deux temps de validation — la somme des devis retenus s'y compare, sans le changer. */
  montantAccorde: number | null;
  /** Le poste en est à demander son BC (accordé, budget choisi) — l'action le revérifie. */
  bcPossible: boolean;
  /** Les assistantes de direction actives : plusieurs ⇒ on choisit qui établit le BC (l'action l'exige). */
  assistantes: { id: string; name: string }[];
}) {
  const [ajout, setAjout] = React.useState(false);
  const [ouvert, setOuvert] = React.useState<{ id: string; quoi: "MENU" | "EDITER" | "PASSEPORT" | "DEVIS" | "CHOIX" } | null>(null);
  const [assistanteId, setAssistanteId] = React.useState("");
  // RETIRER LA DEMANDE DE RÉSERVATION (constat 37) — offert seulement si l'action l'accepte (§118.83).
  const [retrait, setRetrait] = React.useState(false);
  const [motifRetrait, setMotifRetrait] = React.useState("");
  const fermer = () => setOuvert(null);
  const basculer = (id: string, quoi: NonNullable<typeof ouvert>["quoi"]) =>
    setOuvert((o) => (o && o.id === id && o.quoi === quoi ? null : { id, quoi }));

  // UNE PIÈCE RETENUE POUR PLUSIEURS VOYAGEURS (la même pro forma) ne se compte qu'une fois.
  const retenus = [...new Map(voyageurs.flatMap((v) => v.devis.filter((d) => d.retenu && !d.annule)).map((d) => [d.copieDe ?? d.id, d])).values()];
  const depasse = depassementDevisRetenus(retenus.map((d) => d.montant), montantAccorde);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Plane className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Voyageurs ({voyageurs.length})</span>
        {reservation && (
          <Link href={`/dossiers/${reservation.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
            Réservation : sujet {reservation.reference} <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
      {reservation?.refusRetrait && peutEditer && (
        <p className="text-muted-foreground">{reservation.refusRetrait}</p>
      )}
      {retrait && reservation && !reservation.refusRetrait && (
        <form
          className="space-y-2 rounded-lg border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData();
            fd.set("id", itemId);
            fd.set("motif", motifRetrait);
            void run(`resa-retrait:${itemId}`, () => retirerReservation(fd), "Demande de réservation retirée.").then(() => { setRetrait(false); setMotifRetrait(""); });
          }}
        >
          <label className="block font-medium" htmlFor={`motif-resa-${itemId}`}>Pourquoi retirer la demande de réservation ?</label>
          <textarea
            id={`motif-resa-${itemId}`} value={motifRetrait} onChange={(e) => setMotifRetrait(e.target.value)} rows={2}
            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="submit" size="sm" variant="destructive" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy !== null || motifRetrait.trim() === ""}>
              {busy === `resa-retrait:${itemId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Retirer la demande
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-10 w-full sm:h-8 sm:w-auto" disabled={busy !== null} onClick={() => setRetrait(false)}>Annuler</Button>
          </div>
        </form>
      )}

      {voyageurs.length === 0 ? (
        <p className="text-muted-foreground">Aucun voyageur. Son nom suffit pour commencer — le reste (passeport, autres documents, dates) peut venir plus tard.</p>
      ) : (
        <ul className="divide-y divide-border">
          {voyageurs.map((v) => {
            const passeport = v.passeports.length > 0;
            const vivants = v.devis.filter((d) => !d.annule);
            const retenu = vivants.find((d) => d.retenu) ?? null;
            const geste = prochainGesteVoyageur({ passeport, devis: v.devis.map((d) => ({ montant: d.montant, retenu: d.retenu, annule: d.annule })) }, peutEditer);
            const manque = manquesPourReserver({
              nom: v.nom, prenom: v.prenom, segments: v.segments, villeDepart: v.villeDepart, villeArrivee: v.villeArrivee, dateDepart: jour(v.dateDepart),
              dateRetour: jour(v.dateRetour), passeport, notes: v.notes, trajet: v.trajet, transport: v.transport,
            }).filter((m) => m !== "passeport");
            const mode = ouvert?.id === v.id ? ouvert.quoi : null;
            const multi = v.trajet === "MULTI_DESTINATIONS";
            const dates = v.trajet === "ALLER_SIMPLE"
              ? jourLisible(jour(v.dateDepart))
              : `${jourLisible(jour(v.dateDepart))} → ${jourLisible(jour(v.dateRetour))}`;
            return (
              <li key={v.id} className="space-y-1.5 py-2" data-voyageur={nomComplet(v)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">{nomComplet(v)}</span>
                  <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                    {TRAJET_LIBELLE[v.trajet]}
                    {!multi && (v.villeDepart || v.villeArrivee) ? ` · ${v.villeDepart ?? "?"} → ${v.villeArrivee ?? "?"}` : ""}
                    {multi ? ` · ${v.segments.length} étape${v.segments.length > 1 ? "s" : ""}` : ` · ${dates}`}
                    {` · ${v.transport ? TRANSPORT_LIBELLE[v.transport] : "mode à préciser"}`}
                  </span>
                  {passeport
                    ? <span className="inline-flex items-center gap-0.5 text-success"><CheckCircle2 className="h-3 w-3" /> passeport</span>
                    : <span className="text-warning">passeport manquant</span>}
                  {retenu && (
                    <span className="inline-flex items-center gap-0.5 text-success">
                      <FileCheck2 className="h-3 w-3" /> devis retenu{retenu.montant != null ? ` (${dzd(retenu.montant)})` : ""}
                    </span>
                  )}
                  {peutEditer && (
                    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1">
                      {geste === "PASSEPORT" && (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => basculer(v.id, "PASSEPORT")}>
                          <Upload className="h-3.5 w-3.5" /> Joindre le passeport
                        </Button>
                      )}
                      {geste === "DEVIS" && (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => basculer(v.id, "DEVIS")}>
                          <Upload className="h-3.5 w-3.5" /> Joindre le devis de l&apos;agence
                        </Button>
                      )}
                      {geste === "VALIDER" && vivants.length === 1 && (
                        <Button
                          size="sm" disabled={busy !== null}
                          onClick={() => void run(`vdv:${v.id}`, () => validerDevisVoyageur(fdVoyageur(v.id, { devisId: vivants[0]!.id })), "Devis retenu.")}
                        >
                          {busy === `vdv:${v.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Valider ce devis
                        </Button>
                      )}
                      {geste === "VALIDER" && vivants.length > 1 && (
                        <Button size="sm" disabled={busy !== null} onClick={() => basculer(v.id, "CHOIX")}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Choisir le devis ({vivants.length})
                        </Button>
                      )}
                      <button
                        type="button" onClick={() => basculer(v.id, "MENU")} disabled={busy !== null}
                        className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-secondary sm:h-auto sm:w-auto sm:px-1.5 sm:py-1"
                        aria-label={`Autres actions pour ${nomComplet(v)}`} aria-expanded={mode === "MENU"}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
                {multi && v.segments.length > 0 && (
                  <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
                    {v.segments.map((e, i) => (
                      <li key={i}>{e.de ?? "?"} → {e.vers ?? "?"} · {e.date ? jourLisible(jour(e.date)) : "date à confirmer"}</li>
                    ))}
                  </ol>
                )}
                {manque.length > 0 && <p className="text-[0.6875rem] text-muted-foreground">À préciser pour réserver : {manque.join(", ")}.</p>}
                {v.notes && <p className="text-muted-foreground">{v.notes}</p>}

                {mode === "MENU" && peutEditer && (
                  <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-secondary/30 p-1.5" role="menu">
                    <MenuItem onClick={() => basculer(v.id, "EDITER")}>Modifier</MenuItem>
                    <MenuItem onClick={() => basculer(v.id, "PASSEPORT")}>Documents (passeport, autres)</MenuItem>
                    <MenuItem onClick={() => basculer(v.id, "DEVIS")}>{vivants.length > 0 ? "Joindre un autre devis" : "Joindre le devis"}</MenuItem>
                    {vivants.length > 1 && <MenuItem onClick={() => basculer(v.id, "CHOIX")}>{retenu ? "Changer de devis" : "Choisir le devis"}</MenuItem>}
                    <MenuItem
                      danger
                      onClick={() => {
                        if (!window.confirm(`Retirer ${nomComplet(v)} des voyageurs ?`)) return;
                        void run(`vdel:${v.id}`, () => retirerVoyageur(fdVoyageur(v.id, {}, "id")), "Voyageur retiré.").then(fermer);
                      }}
                    >
                      Retirer
                    </MenuItem>
                  </div>
                )}

                {/* LES DOCUMENTS D'UN VOYAGEUR : le passeport (pièce d'identité) et tout autre document — visa, assurance,
                    justificatif —, des pièces du POSTE désignées par le voyageur (`stepKey`). Remplacer = joindre le nouveau
                    puis retirer l'ancien depuis son aperçu (rien ne s'efface en silence). */}
                {((passeport || v.autresDocuments.length > 0) && (mode === "PASSEPORT" || mode === "MENU")) && (
                  <div className="space-y-0.5">
                    {v.passeports.map((p) => (
                      <div key={p.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-[0.6875rem] text-muted-foreground">Passeport</span>
                        <DocumentPreview id={p.id} name={p.name} hasFile={p.hasFile} canDelete={peutEditer} />
                      </div>
                    ))}
                    {v.autresDocuments.map((p) => <DocumentPreview key={p.id} id={p.id} name={p.name} hasFile={p.hasFile} canDelete={peutEditer} />)}
                  </div>
                )}
                {mode === "PASSEPORT" && peutEditer && (
                  <div className="rounded-lg border border-border p-2">
                    <p className="mb-1 text-[0.6875rem] text-muted-foreground">
                      Documents de {nomComplet(v)} — choisissez « Pièce d&apos;identité » pour le passeport, « Autre » pour le reste
                      {passeport ? " (pour remplacer le passeport : joignez le nouveau, puis retirez l'ancien ci-dessus)" : ""}
                    </p>
                    <DocumentUpload entityType="AD_PRO_ITEM" entityId={itemId} categories={["ID_DOCUMENT", "SUPPORTING_DOC", "OTHER"]} stepKey={v.id} compact />
                    <button type="button" onClick={fermer} className="mt-1 min-h-9 px-1 text-[0.6875rem] text-muted-foreground hover:text-foreground sm:min-h-0 sm:px-0">Fermer</button>
                  </div>
                )}

                {/* LES PROPOSITIONS DE L'AGENCE pour ce voyageur — une ligne chacune, la retenue en tête de lecture. */}
                {v.devis.length > 0 && (mode === "CHOIX" || mode === "MENU" || !retenu) && (
                  <ul className="space-y-1 pl-2">
                    {v.devis.map((d) => (
                      <li key={d.id} className={`flex flex-wrap items-center gap-2 ${d.annule || (retenu && !d.retenu) ? "text-muted-foreground" : ""}`}>
                        {d.fichier
                          ? <DocumentPreview id={d.fichier.id} name={d.reference ?? d.titre} hasFile={d.fichier.hasFile} />
                          : <span className="min-w-0 [overflow-wrap:anywhere]">{d.reference ?? d.titre}</span>}
                        {d.montant != null && <span>{dzd(d.montant)}</span>}
                        {d.annule ? <span>annulé</span> : d.retenu ? <span className="text-success">retenu</span> : retenu ? <span>écarté</span> : null}
                        {peutEditer && !d.annule && !d.retenu && (mode === "CHOIX") && (
                          <Button
                            size="sm" variant="outline" disabled={busy !== null}
                            onClick={() => void run(`vdv:${v.id}`, () => validerDevisVoyageur(fdVoyageur(v.id, { devisId: d.id })), "Devis retenu.").then(fermer)}
                          >
                            Retenir celui-ci
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {mode === "DEVIS" && peutEditer && (
                  <FormulaireDevis
                    nom={nomComplet(v)} busy={busy === `vdev:${v.id}`} onCancel={fermer}
                    onSubmit={(fd) => {
                      fd.set("voyageurId", v.id);
                      void run(`vdev:${v.id}`, () => ajouterDevisVoyageur(undefined, fd), "Devis déposé.").then(fermer);
                    }}
                  />
                )}
                {mode === "EDITER" && peutEditer && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-2">
                    <FormulaireVoyageur
                      suggestions={nomsSuggeres}
                      defaut={v}
                      busy={busy === `vmod:${v.id}`}
                      libelle="Enregistrer"
                      onSubmit={(fd) => {
                        fd.set("id", v.id);
                        void run(`vmod:${v.id}`, () => modifierVoyageur(undefined, fd), "Voyageur modifié.").then(fermer);
                      }}
                      onCancel={fermer}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {depasse && <p className="rounded-md bg-warning/10 px-2 py-1 text-warning" role="status">{depasse}</p>}

      {peutEditer && (
        ajout ? (
          <div className="rounded-lg border border-border p-2">
            <FormulaireVoyageur
              suggestions={nomsSuggeres}
              busy={busy === `vadd:${itemId}`}
              libelle="Ajouter le voyageur"
              onSubmit={(fd) => {
                fd.set("itemId", itemId);
                // Le voyageur créé SANS passeport : on ouvre tout de suite SES documents, le passeport se joint dans la foulée.
                const avecPasseport = fd.getAll("passeport").some((v) => v instanceof File && v.size > 0);
                let cree: string | undefined;
                void run(`vadd:${itemId}`, async () => {
                  const r = await ajouterVoyageur(undefined, fd);
                  if (r.ok) cree = r.id;
                  return r;
                }, "Voyageur ajouté.").then(() => {
                  setAjout(false);
                  if (cree && !avecPasseport) setOuvert({ id: cree, quoi: "PASSEPORT" });
                });
              }}
              onCancel={() => setAjout(false)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" onClick={() => setAjout(true)} disabled={busy !== null}>
              <Plus className="h-4 w-4" /> Ajouter un voyageur
            </Button>
            {voyageurs.length > 0 && peutReserver && (
              <Button
                size="sm" variant="outline" className="w-full sm:w-auto" disabled={busy !== null}
                onClick={() => {
                  const fd = new FormData();
                  fd.set("id", itemId);
                  void run(`resa:${itemId}`, () => demanderReservation(fd), "Demande de réservation envoyée.");
                }}
              >
                {busy === `resa:${itemId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {reservation ? "Mettre à jour la réservation" : "Demander la réservation"}
              </Button>
            )}
            {reservation && peutEditer && !reservation.refusRetrait && !retrait && (
              <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={busy !== null} onClick={() => setRetrait(true)}>
                Retirer la demande de réservation
              </Button>
            )}
            {bcPossible && retenus.length > 0 && (
              <>
                {assistantes.length > 1 && (
                  <select
                    value={assistanteId} onChange={(e) => setAssistanteId(e.target.value)}
                    aria-label="Assistante qui établira le bon de commande"
                    className="w-full rounded-lg border border-border bg-background px-2 py-2 text-xs sm:w-auto sm:py-1"
                  >
                    <option value="">Assistante qui établit le BC…</option>
                    {assistantes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
                <Button
                  size="sm" className="w-full sm:w-auto" disabled={busy !== null || (assistantes.length > 1 && !assistanteId)}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("id", itemId);
                    if (assistanteId) fd.set("assistantId", assistanteId);
                    void run(`vbc:${itemId}`, () => demanderBCBilletterie(fd), "Bon de commande demandé.");
                  }}
                >
                  {busy === `vbc:${itemId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Demander le BC ({retenus.length} devis retenu{retenus.length > 1 ? "s" : ""})
                </Button>
              </>
            )}
          </div>
        )
      )}
      {peutEditer && bcPossible && retenus.length === 0 && voyageurs.length > 0 && (
        <p className="text-[0.6875rem] text-muted-foreground">Validez le devis d&apos;au moins un voyageur : le bon de commande s&apos;établit d&apos;après les devis retenus.</p>
      )}
    </div>
  );
}

function fdVoyageur(voyageurId: string, extra: Record<string, string>, cle = "voyageurId"): FormData {
  const fd = new FormData();
  fd.set(cle, voyageurId);
  for (const [k, val] of Object.entries(extra)) fd.set(k, val);
  return fd;
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button" role="menuitem" onClick={onClick}
      className={`min-h-9 rounded px-3 py-2 text-[0.6875rem] font-medium hover:bg-secondary sm:min-h-0 sm:px-2 sm:py-1 ${danger ? "text-destructive" : "text-foreground"}`}
    >
      {children}
    </button>
  );
}

const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

/** LE DEVIS DE L'AGENCE POUR UN VOYAGEUR — le fichier (exigé), son montant, et s'il s'agit d'une pro forma. */
function FormulaireDevis({ nom, busy, onSubmit, onCancel }: { nom: string; busy: boolean; onSubmit: (fd: FormData) => void; onCancel: () => void }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }} className="space-y-2 rounded-lg border border-border p-2">
      <p className="text-[0.6875rem] text-muted-foreground">Devis ou pro forma de l&apos;agence pour {nom}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">
          Fichier (PDF, Word ou scan)
          <input name="attachment" type="file" required className={champ} />
        </label>
        <label className="text-xs">
          Montant (DZD)
          <input name="montant" type="number" inputMode="decimal" min="0" step="0.01" className={champ} />
        </label>
        <label className="flex min-h-9 items-center gap-2 self-end pb-1.5 text-xs">
          <input name="proforma" type="checkbox" className="shrink-0 max-sm:h-5 max-sm:w-5" /> C&apos;est une facture pro forma
        </label>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" type="submit" disabled={busy} className="h-10 w-full sm:h-8 sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Déposer
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel} className="h-10 w-full sm:h-8 sm:w-auto">Annuler</Button>
      </div>
    </form>
  );
}

/** Le trajet, tel qu'on le choisit (Direction, 06/10) : « Aller », « Aller-Retour » ou « Multi-destinations ». */
const TRAJETS_CHOIX: { t: AdProTrajet; libelle: string }[] = [
  { t: "ALLER_SIMPLE", libelle: "Aller" }, { t: "ALLER_RETOUR", libelle: "Aller-Retour" }, { t: "MULTI_DESTINATIONS", libelle: "Multi-destinations" },
];

type Etape = { de: string; vers: string; date: string };

/**
 * LE FORMULAIRE D'UN VOYAGEUR — nom et prénom (séparés), trajet, mode, étapes, et à la création ses documents.
 *
 * Plus dynamique (Direction, 06/10) : le trajet se choisit d'un geste (Aller / Aller-Retour / Multi-destinations) ;
 * chaque étape A → B porte un « + » qui insère la destination suivante juste après elle — sur un aller, le « + » fait
 * passer en multi-destinations sans rien retaper. Le passeport et les autres documents se joignent DÈS la création.
 * Seul le nom de famille est exigé : le reste peut venir plus tard.
 */
function FormulaireVoyageur({ suggestions, defaut, busy, libelle, onSubmit, onCancel }: {
  suggestions: string[];
  defaut?: VoyageurVue;
  busy: boolean;
  libelle: string;
  onSubmit: (fd: FormData) => void;
  onCancel: () => void;
}) {
  const [trajet, setTrajet] = React.useState<AdProTrajet>(defaut?.trajet ?? "ALLER_RETOUR");
  // Un voyageur d'avant la séparation porte son nom complet dans `nom` : on PROPOSE la coupe, la personne la corrige.
  const initial = defaut && !defaut.prenom ? separerNom(defaut.nom) : { prenom: defaut?.prenom ?? "", nom: defaut?.nom ?? "" };
  const [prenom, setPrenom] = React.useState(initial.prenom);
  const [nom, setNom] = React.useState(initial.nom);
  const [etapes, setEtapes] = React.useState<Etape[]>(() =>
    defaut && defaut.segments.length > 0
      ? defaut.segments.map((e) => ({ de: e.de ?? "", vers: e.vers ?? "", date: e.date ?? "" }))
      : [{ de: defaut?.villeDepart ?? "Alger", vers: defaut?.villeArrivee ?? "", date: defaut?.dateDepart ?? "" }],
  );
  const [dateRetour, setDateRetour] = React.useState(defaut?.dateRetour ?? "");
  const [passeport, setPasseport] = React.useState<File | null>(null);
  const [documents, setDocuments] = React.useState<File[]>([]);
  const multi = trajet === "MULTI_DESTINATIONS";
  const majEtape = (i: number, cle: keyof Etape, valeur: string) => setEtapes((l) => l.map((e, k) => (k === i ? { ...e, [cle]: valeur } : e)));
  // LE « + » D'UNE ÉTAPE : la destination suivante s'insère juste après, et part d'où celle-ci arrive.
  const insererApres = (i: number) => {
    setEtapes((l) => (l.length >= ETAPES_MAX ? l : [...l.slice(0, i + 1), { de: l[i]?.vers ?? "", vers: "", date: "" }, ...l.slice(i + 1)]));
    if (!multi) setTrajet("MULTI_DESTINATIONS");
  };
  const retirerEtape = (i: number) => setEtapes((l) => (l.length <= 1 ? l : l.filter((_, k) => k !== i)));
  const choisirTrajet = (t: AdProTrajet) => {
    // Revenir à un aller (simple ou retour) garde la PREMIÈRE étape : rien de ce qui a été tapé n'est perdu en route.
    if (t !== "MULTI_DESTINATIONS" && etapes.length > 1) setEtapes((l) => [{ ...l[0], vers: l[l.length - 1]?.vers || l[0].vers }]);
    setTrajet(t);
  };
  const premiere = etapes[0] ?? { de: "", vers: "", date: "" };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (passeport) fd.set("passeport", passeport);
        for (const d of documents) fd.append("documents", d);
        onSubmit(fd);
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.length > 0 && (
          <label className="text-xs sm:col-span-2">
            Personne de la demande
            <select
              defaultValue="" className={champ} aria-label="Choisir une personne de la demande"
              onChange={(e) => { if (e.target.value) { const c = separerNom(e.target.value); setPrenom(c.prenom); setNom(c.nom); } }}
            >
              <option value="">— Saisir à la main —</option>
              {suggestions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs">
          Prénom
          <input name="prenom" value={prenom} onChange={(e) => setPrenom(e.target.value)} placeholder="Amel" className={champ} />
        </label>
        <label className="text-xs">
          Nom
          <input name="nom" required value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Haddad" className={champ} />
        </label>
        <label className="text-xs sm:col-span-2">
          Mode de transport
          <select name="transport" defaultValue={defaut ? (defaut.transport ?? "") : "AVION"} className={champ}>
            {defaut && !defaut.transport && <option value="">À préciser</option>}
            {TRANSPORTS.map((m) => <option key={m} value={m}>{TRANSPORT_LIBELLE[m]}</option>)}
          </select>
        </label>
      </div>

      {/* LE TRAJET, d'un geste. */}
      <div className="space-y-2">
        <input type="hidden" name="trajet" value={trajet} />
        <div className="inline-flex flex-wrap rounded-lg bg-muted p-1 text-xs" role="radiogroup" aria-label="Trajet">
          {TRAJETS_CHOIX.map(({ t, libelle: l }) => (
            <button
              key={t} type="button" role="radio" aria-checked={trajet === t} onClick={() => choisirTrajet(t)}
              className={`min-h-9 rounded-md px-3 py-1.5 font-medium transition-colors sm:min-h-0 ${trajet === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {l}
            </button>
          ))}
        </div>

        {multi && <input type="hidden" name="segments" value={JSON.stringify(etapes)} />}
        {!multi && (
          <>
            <input type="hidden" name="villeDepart" value={premiere.de} />
            <input type="hidden" name="villeArrivee" value={premiere.vers} />
            <input type="hidden" name="dateDepart" value={premiere.date} />
            {trajet === "ALLER_RETOUR" && <input type="hidden" name="dateRetour" value={dateRetour} />}
          </>
        )}
        <ol className="space-y-1.5">
          {(multi ? etapes : [premiere]).map((e, i) => (
            <li key={i} className="rounded-lg border border-border bg-background p-2">
              <div className="mb-1 flex items-center gap-2 text-[0.6875rem] font-medium text-muted-foreground">
                <span className="flex-1">{multi ? `Étape ${i + 1}` : trajet === "ALLER_RETOUR" ? "Aller (le retour suit le même chemin)" : "Aller"}</span>
                {multi && etapes.length > 1 && (
                  <button type="button" onClick={() => retirerEtape(i)} aria-label={`Retirer l'étape ${i + 1}`} className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-secondary sm:h-auto sm:w-auto sm:p-1">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto_1fr_9rem]">
                <label className="text-xs">
                  Point A — départ
                  <input value={e.de} onChange={(ev) => majEtape(i, "de", ev.target.value)} aria-label={`Étape ${i + 1} — départ`} placeholder="Alger" className={champ} />
                </label>
                <span className="hidden pb-2 text-muted-foreground sm:block">→</span>
                <label className="text-xs">
                  Point B — arrivée
                  <input value={e.vers} onChange={(ev) => majEtape(i, "vers", ev.target.value)} aria-label={`Étape ${i + 1} — arrivée`} placeholder="Paris" className={champ} />
                </label>
                <label className="text-xs">
                  Date
                  <input type="date" value={e.date} onChange={(ev) => majEtape(i, "date", ev.target.value)} aria-label={`Étape ${i + 1} — date`} className={champ} />
                </label>
              </div>
              {!multi && trajet === "ALLER_RETOUR" && (
                <label className="mt-2 block text-xs sm:w-56">
                  Date de retour ({e.vers || "B"} → {e.de || "A"})
                  <input type="date" value={dateRetour} onChange={(ev) => setDateRetour(ev.target.value)} className={champ} />
                </label>
              )}
              <button
                type="button" onClick={() => insererApres(i)} disabled={etapes.length >= ETAPES_MAX}
                className="mt-2 inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-md border border-dashed border-primary/40 px-3 text-xs font-medium text-primary hover:underline disabled:opacity-40 sm:mt-1.5 sm:min-h-0 sm:w-auto sm:justify-start sm:border-0 sm:px-0"
                aria-label={`Ajouter une destination après ${e.vers || `l'étape ${i + 1}`}`}
              >
                <Plus className="h-3.5 w-3.5" /> Destination suivante{e.vers ? ` depuis ${e.vers}` : ""}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {defaut && (
        <label className="block text-xs">
          Précisions
          <input name="notes" defaultValue={defaut.notes ?? ""} placeholder="Classe, horaires souhaités…" className={champ} />
        </label>
      )}

      {/* LES DOCUMENTS DÈS LA CRÉATION (Direction, 06/10) : le passeport, et ce qu'il faut d'autre. */}
      {!defaut && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Passeport (scan ou photo)
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" onChange={(e) => setPasseport(e.target.files?.[0] ?? null)} className={champ} aria-label="Passeport" />
          </label>
          <label className="text-xs">
            Autres documents (visa, invitation…)
            <input type="file" multiple onChange={(e) => setDocuments(Array.from(e.target.files ?? []))} className={champ} aria-label="Autres documents" />
          </label>
        </div>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        Seul le nom est exigé : le prénom, les dates, le trajet et les documents peuvent venir plus tard.
        {defaut && !defaut.prenom ? " Le nom complet a été proposé coupé en prénom et nom : corrigez si besoin." : ""}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" type="submit" disabled={busy} className="h-10 w-full sm:h-8 sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {libelle}
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel} className="h-10 w-full sm:h-8 sm:w-auto">Annuler</Button>
      </div>
    </form>
  );
}