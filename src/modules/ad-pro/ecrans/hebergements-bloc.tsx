"use client";

import * as React from "react";
import { BedDouble, Plus, CheckCircle2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { champ, IdentiteDeLaFiche, MenuItem, PiedDeFiche } from "./fiches-communes";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentPreview } from "@/components/documents/document-preview";
import { ChoixFichiers } from "@/components/shared/choix-fichiers";
import { ajouterHebergement, modifierHebergement, retirerHebergement } from "../actions-postes-voyageurs";
import { jourLisible, nomComplet } from "../domaine/voyageurs";
import { nuitsLisibles, TYPES_CHAMBRE } from "../domaine/hebergements";
import { EnvoiFiche, BandeauEnvois } from "@/components/reservation-fiche/envoi-fiche";
import type { EnvoiVue } from "@/lib/reservation-fiche/etat";
import { useConfirmer } from "@/components/ui/dialogue";

/** Une fiche hôtellerie telle que l'écran la montre — les dates en AAAA-MM-JJ, prêtes pour un champ « date ». */
export interface HebergementVue {
  id: string;
  nom: string;
  prenom: string | null;
  hotel: string | null;
  ville: string | null;
  dateArrivee: string | null;
  dateDepart: string | null;
  typeChambre: string | null;
  notes: string | null;
  /** La ou les pièces d'identité déposées (documents du poste dont `stepKey` est la fiche). */
  piecesIdentite: { id: string; name: string; hasFile: boolean }[];
  /** Les autres documents (réservation, confirmation de l'hôtel…). */
  autresDocuments: { id: string; name: string; hasFile: boolean }[];
}

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

const jour = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);

/**
 * LES FICHES HÔTELLERIE D'UN POSTE « HÔTELLERIE » (Direction, 06/10) — « une fiche hôtellerie pour
 * chaque personne ». Même forme que les voyageurs d'une billetterie : une ligne compacte par
 * personne (nom, hôtel, ville, dates, nuits, chambre, pièce d'identité), le reste dans le menu « ⋯ ».
 *
 * `obligatoire` : le poste ne se soumet pas sans au moins une fiche — sauf dans un sponsoring
 * indirect, où elles restent possibles mais facultatives (la règle est `refusFichesPersonnes`).
 */
export function BlocHebergements({ itemId, hebergements, nomsSuggeres, peutEditer, obligatoire, busy, run, envois }: {
  itemId: string;
  hebergements: HebergementVue[];
  nomsSuggeres: string[];
  peutEditer: boolean;
  /** Au moins une fiche est exigée avant de soumettre (hors sponsoring indirect). */
  obligatoire: boolean;
  busy: string | null;
  run: Run;
  /** L'ÉTAT DE CHAQUE FICHE chez l'assistante (`EnvoiVue`, par fiche) — chaque fiche s'envoie seule (14/10). */
  envois?: Record<string, EnvoiVue>;
}) {
  const confirmer = useConfirmer();
  const [ajout, setAjout] = React.useState(false);
  const [ouvert, setOuvert] = React.useState<{ id: string; quoi: "MENU" | "EDITER" | "DOCUMENTS" } | null>(null);
  const fermer = () => setOuvert(null);
  const basculer = (id: string, quoi: NonNullable<typeof ouvert>["quoi"]) =>
    setOuvert((o) => (o && o.id === id && o.quoi === quoi ? null : { id, quoi }));

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <BedDouble className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Fiches hôtellerie ({hebergements.length})</span>
        {!obligatoire && <span className="text-muted-foreground">· facultatives (sponsoring indirect)</span>}
      </div>
      <BandeauEnvois envois={hebergements.map((h) => envois?.[h.id])} lot={{ itemId }} peutEditer={peutEditer} busy={busy} run={run} />

      {hebergements.length === 0 ? (
        <p className="text-muted-foreground">
          Aucune fiche hôtellerie. Une par personne logée — son nom suffit pour commencer, le reste (hôtel, dates, pièce d&apos;identité) peut venir plus tard.
          {obligatoire ? " Au moins une fiche est nécessaire pour soumettre ce poste." : ""}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {hebergements.map((h) => {
            const piece = h.piecesIdentite.length > 0;
            const mode = ouvert?.id === h.id ? ouvert.quoi : null;
            const lieu = [h.hotel, h.ville].filter(Boolean).join(", ");
            return (
              <li key={h.id} className="space-y-1.5 py-2" data-hebergement={nomComplet(h)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">{nomComplet(h)}</span>
                  <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                    {lieu || "hôtel à préciser"}
                    {` · ${jourLisible(jour(h.dateArrivee))} → ${jourLisible(jour(h.dateDepart))}`}
                    {` · ${nuitsLisibles({ dateArrivee: jour(h.dateArrivee), dateDepart: jour(h.dateDepart) })}`}
                    {h.typeChambre ? ` · chambre ${h.typeChambre}` : ""}
                  </span>
                  {piece
                    ? <span className="inline-flex items-center gap-0.5 text-success"><CheckCircle2 className="h-3 w-3" /> pièce d&apos;identité</span>
                    : <span className="text-warning">pièce d&apos;identité manquante</span>}
                  {peutEditer && (
                    <span className="ml-auto inline-flex items-center gap-1">
                      <button
                        type="button" onClick={() => basculer(h.id, "MENU")} disabled={busy !== null}
                        className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-secondary sm:h-auto sm:w-auto sm:px-1.5 sm:py-1"
                        aria-label={`Autres actions pour ${nomComplet(h)}`} aria-expanded={mode === "MENU"}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
                {h.notes && <p className="text-muted-foreground">{h.notes}</p>}
                <EnvoiFiche envoi={envois?.[h.id]} peutEditer={peutEditer} busy={busy} run={run} />

                {mode === "MENU" && peutEditer && (
                  <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-secondary/30 p-1.5" role="menu">
                    <MenuItem onClick={() => basculer(h.id, "EDITER")}>Modifier</MenuItem>
                    <MenuItem onClick={() => basculer(h.id, "DOCUMENTS")}>Documents (pièce d&apos;identité, autres)</MenuItem>
                    <MenuItem
                      danger
                      onClick={async () => {
                        if (!(await confirmer(`Retirer la fiche hôtellerie de ${nomComplet(h)} ?`))) return;
                        const fd = new FormData();
                        fd.set("id", h.id);
                        void run(`hdel:${h.id}`, () => retirerHebergement(fd), "Fiche hôtellerie retirée.").then(fermer);
                      }}
                    >
                      Retirer
                    </MenuItem>
                  </div>
                )}

                {/* LES DOCUMENTS D'UNE FICHE : pièces du POSTE désignées par la fiche (`stepKey`) — rien ne s'efface en silence. */}
                {(piece || h.autresDocuments.length > 0) && (mode === "DOCUMENTS" || mode === "MENU") && (
                  <div className="space-y-0.5">
                    {h.piecesIdentite.map((p) => (
                      <div key={p.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-[0.6875rem] text-muted-foreground">Pièce d&apos;identité</span>
                        <DocumentPreview id={p.id} name={p.name} hasFile={p.hasFile} canDelete={peutEditer} />
                      </div>
                    ))}
                    {h.autresDocuments.map((p) => <DocumentPreview key={p.id} id={p.id} name={p.name} hasFile={p.hasFile} canDelete={peutEditer} />)}
                  </div>
                )}
                {mode === "DOCUMENTS" && peutEditer && (
                  <div className="rounded-lg border border-border p-2">
                    <p className="mb-1 text-[0.6875rem] text-muted-foreground">
                      Documents de {nomComplet(h)} — « Pièce d&apos;identité » pour le passeport ou la carte, « Autre » pour le reste
                    </p>
                    <DocumentUpload entityType="AD_PRO_ITEM" entityId={itemId} categories={["ID_DOCUMENT", "SUPPORTING_DOC", "OTHER"]} stepKey={h.id} compact />
                    <button type="button" onClick={fermer} className="mt-1 min-h-9 px-1 text-[0.6875rem] text-muted-foreground hover:text-foreground sm:min-h-0 sm:px-0">Fermer</button>
                  </div>
                )}
                {mode === "EDITER" && peutEditer && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-2">
                    <FormulaireHebergement
                      suggestions={nomsSuggeres} defaut={h} busy={busy === `hmod:${h.id}`} libelle="Enregistrer"
                      onSubmit={(fd) => {
                        fd.set("id", h.id);
                        void run(`hmod:${h.id}`, () => modifierHebergement(undefined, fd), "Fiche hôtellerie modifiée.").then(fermer);
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

      {peutEditer && (
        ajout ? (
          <div className="rounded-lg border border-border p-2">
            <FormulaireHebergement
              suggestions={nomsSuggeres} busy={busy === `hadd:${itemId}`} libelle="Ajouter la fiche"
              onSubmit={(fd) => {
                fd.set("itemId", itemId);
                void run(`hadd:${itemId}`, () => ajouterHebergement(undefined, fd), "Fiche hôtellerie ajoutée.").then(() => setAjout(false));
              }}
              onCancel={() => setAjout(false)}
            />
          </div>
        ) : (
          <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" onClick={() => setAjout(true)} disabled={busy !== null}>
            <Plus className="h-4 w-4" /> Ajouter une fiche hôtellerie
          </Button>
        )
      )}
    </div>
  );
}



/**
 * LE FORMULAIRE D'UNE FICHE HÔTELLERIE — nom et prénom, hôtel, ville, arrivée, départ, chambre ; à la
 * création, la pièce d'identité et les autres documents. Seul le nom est exigé.
 */
function FormulaireHebergement({ suggestions, defaut, busy, libelle, onSubmit, onCancel }: {
  suggestions: string[];
  defaut?: HebergementVue;
  busy: boolean;
  libelle: string;
  onSubmit: (fd: FormData) => void;
  onCancel: () => void;
}) {
  const [pieces, setPieces] = React.useState<File[]>([]);
  const [documents, setDocuments] = React.useState<File[]>([]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        for (const p of pieces) fd.append("pieceIdentite", p);
        for (const d of documents) fd.append("documents", d);
        onSubmit(fd);
      }}
      className="space-y-3"
    >
      <ChampsHebergement
        suggestions={suggestions} defaut={defaut}
        pieces={pieces} setPieces={setPieces} documents={documents} setDocuments={setDocuments}
      />
      <PiedDeFiche busy={busy} libelle={libelle} onCancel={onCancel} />
    </form>
  );
}

/**
 * LES CHAMPS D'UNE FICHE HÔTELLERIE — sans formulaire autour, pour servir DEUX formulaires : celui d'une fiche
 * (préfixe vide) et celui de l'ajout d'un poste « hôtellerie », qui en porte plusieurs (`lib/ad-pro/fiches-saisie`).
 * Les fichiers choisis remontent au formulaire, qui les joint sous `<préfixe>pieceIdentite` et `<préfixe>documents`.
 */
export function ChampsHebergement({ prefixe = "", suggestions, defaut, pieces, setPieces, documents, setDocuments }: {
  prefixe?: string;
  suggestions: string[];
  defaut?: HebergementVue;
  pieces: File[];
  setPieces: (f: File[]) => void;
  documents: File[];
  setDocuments: (f: File[]) => void;
}) {
  const n = (cle: string) => `${prefixe}${cle}`;
  const [prenom, setPrenom] = React.useState(defaut?.prenom ?? "");
  const [nom, setNom] = React.useState(defaut?.nom ?? "");
  const [arrivee, setArrivee] = React.useState(defaut?.dateArrivee ?? "");
  const [depart, setDepart] = React.useState(defaut?.dateDepart ?? "");
  const listeChambres = `chambres-${defaut?.id ?? prefixe ?? "nouvelle"}`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <IdentiteDeLaFiche n={n} suggestions={suggestions} prenom={prenom} setPrenom={setPrenom} nom={nom} setNom={setNom} />
        <label className="text-xs">
          Hôtel
          <input name={n("hotel")} defaultValue={defaut?.hotel ?? ""} placeholder="Sheraton" className={champ} />
        </label>
        <label className="text-xs">
          Ville
          <input name={n("ville")} defaultValue={defaut?.ville ?? ""} placeholder="Oran" className={champ} />
        </label>
        <label className="text-xs">
          Arrivée
          <input name={n("dateArrivee")} type="date" value={arrivee} onChange={(e) => setArrivee(e.target.value)} className={champ} />
        </label>
        <label className="text-xs">
          Départ
          <input name={n("dateDepart")} type="date" value={depart} min={arrivee || undefined} onChange={(e) => setDepart(e.target.value)} className={champ} />
        </label>
        <label className="text-xs">
          Type de chambre
          <input name={n("typeChambre")} list={listeChambres} defaultValue={defaut?.typeChambre ?? ""} placeholder="Single" className={champ} />
          <datalist id={listeChambres}>
            {TYPES_CHAMBRE.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <p className="self-end pb-1.5 text-xs text-muted-foreground">
          {nuitsLisibles({ dateArrivee: jour(arrivee || null), dateDepart: jour(depart || null) })}
        </p>
        <label className="text-xs sm:col-span-2">
          Précisions
          <input name={n("notes")} defaultValue={defaut?.notes ?? ""} placeholder="Petit-déjeuner, lit bébé, arrivée tardive…" className={champ} />
        </label>
      </div>

      {/* LES DOCUMENTS DÈS LA CRÉATION, comme pour un voyageur — plusieurs fichiers par rubrique. */}
      {!defaut && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="min-w-0 space-y-1 text-xs">
            <p>Pièce d&apos;identité (scans ou photos — recto, verso)</p>
            <ChoixFichiers
              fichiers={pieces} onChange={setPieces} libelle="Joindre la pièce d'identité" ariaLabel="Pièce d'identité"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,application/pdf,image/*"
            />
          </div>
          <div className="min-w-0 space-y-1 text-xs">
            <p>Autres documents (réservation, confirmation…)</p>
            <ChoixFichiers fichiers={documents} onChange={setDocuments} libelle="Joindre des documents" ariaLabel="Autres documents" />
          </div>
        </div>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">Seul le nom est exigé : l&apos;hôtel, les dates et les documents peuvent venir plus tard.</p>
    </div>
  );
}
