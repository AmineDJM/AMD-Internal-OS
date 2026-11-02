"use client";

import * as React from "react";
import Link from "next/link";

import { Paperclip, Plus, Pencil, Trash2, Loader2, ExternalLink, UserRound, HardDrive } from "lucide-react";
import { addMailPiece, updateMailPiece, deleteMailPiece } from "@/lib/actions/mail-piece-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DrivePickerField } from "@/components/drive/drive-picker";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

export interface PieceRow {
  id: string;
  label: string;
  recipient: string | null;
  notes: string | null;
  documentId: string | null;
  driveNodeId: string | null;
  driveName: string | null;
}

/**
 * LES PIÈCES D'UN PLI, CHACUNE AVEC SON DESTINATAIRE.
 *
 * Un courrier porte souvent plusieurs pièces qui ne vont pas au même endroit : le contrat signé
 * pour le fournisseur, la copie pour les finances, l'attestation pour l'ANPP. Avec un seul
 * destinataire au niveau du pli, il fallait créer trois courriers pour un seul envoi — et la
 * trace de ce qui est parti à qui se perdait.
 *
 * Une pièce vient d'un téléversement OU du Drive, où elle n'est pas recopiée mais référencée :
 * deux copies auraient divergé dès la première correction, et plus personne n'aurait su laquelle
 * fait foi.
 */
export function MailPieces({ entryId, pieces, canEdit }: { entryId: string; pieces: PieceRow[]; canEdit: boolean }) {
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<PieceRow | null>(null);
  const formulaire = useAction();
  // L'icône « retirer » n'a pas de place pour parler : un refus part en avis flottant.
  const ligne = useAction({ signalerErreurs: true });
  const busy = formulaire.busy || ligne.busy;
  const { err, setErr } = formulaire;

  const remove = async (p: PieceRow) => {
    const fd = new FormData(); fd.set("id", p.id);
    await ligne.run(() => deleteMailPiece(fd), undefined, {
      confirmer: `Retirer la pièce « ${p.label} » de ce courrier ?\n\nLe fichier lui-même est conservé.`,
    });
  };

  return (
    <section className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Paperclip className="h-4 w-4 text-primary" /> Pièces et destinataires
          {pieces.length > 0 && <span className="text-xs font-normal text-muted-foreground">({pieces.length})</span>}
        </h2>
        {canEdit && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setErr(null); setAdding(true); }}>
            <Plus className="h-4 w-4" /> Ajouter une pièce
          </Button>
        )}
      </div>

      {pieces.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Aucune pièce nominative. {canEdit && "Ajoutez-en une par destinataire quand un même pli part à plusieurs endroits — le contrat au fournisseur, la copie aux finances."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {pieces.map((p) => (
            <li key={p.id} className="group flex flex-wrap items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  {p.driveNodeId ? <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{p.label}</span>
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UserRound className="h-3 w-3 shrink-0" />
                  {p.recipient || <span className="italic">sans destinataire</span>}
                </p>
                {p.notes && <p className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-none sm:truncate">{p.notes}</p>}
              </div>

              {/* Le lien mène au FICHIER EXACT — la page du nœud, pas la racine du Drive. */}
              {p.driveNodeId && (
                <Link href={`/drive/${p.driveNodeId}`} className="inline-flex min-h-9 shrink-0 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
                  Ouvrir <ExternalLink className="h-3 w-3" />
                </Link>
              )}

              {canEdit && (
                <span className="inline-flex shrink-0 items-center gap-0.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:inline-flex">
                  <button type="button" title="Modifier" onClick={() => { setErr(null); setEditing(p); }} aria-label="Modifier" className="rounded p-2 text-muted-foreground hover:text-foreground sm:p-0.5">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="Retirer" disabled={busy} onClick={() => void remove(p)} aria-label="Retirer" className="rounded p-2 text-muted-foreground hover:text-destructive sm:p-0.5">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <Sheet open onClose={() => !busy && setAdding(false)} width="md" title="Ajouter une pièce"
          description="Téléversez un ou plusieurs fichiers, ou désignez une pièce du Drive — elle y reste, elle n'est pas recopiée.">
          <form
            action={async (fd) => {
              fd.set("entryId", entryId);
              await formulaire.run(() => addMailPiece(fd), () => setAdding(false));
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="mp-recipient">Destinataire de cette pièce</Label>
              <Input id="mp-recipient" name="recipient" placeholder="Le fournisseur, les finances, l'ANPP…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-label">Nom de la pièce (facultatif)</Label>
              <Input id="mp-label" name="label" placeholder="À défaut, le nom du fichier" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-file">Fichier(s)</Label>
              <input
                id="mp-file" name="attachment" type="file" multiple
                className="block w-full rounded-lg border border-input px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-sm"
              />
            </div>
            <DrivePickerField name="driveNodeId" label="…ou une pièce déjà dans le Drive" hint="Le fichier RESTE dans le Drive : le courrier le référence, il ne le duplique pas." />
            <div className="space-y-1.5">
              <Label htmlFor="mp-notes">Note (facultative)</Label>
              <Textarea id="mp-notes" name="notes" rows={2} />
            </div>
            <Retour ton="erreur">{err}</Retour>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)} disabled={busy}>Annuler</Button>
              <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Ajouter</Button>
            </div>
          </form>
        </Sheet>
      )}

      {editing && (
        <Sheet open onClose={() => !busy && setEditing(null)} width="md" title={`Pièce — ${editing.label}`}
          description="Le fichier ne change pas : on corrige son nom, son destinataire et sa note.">
          <form
            action={async (fd) => {
              fd.set("id", editing.id);
              await formulaire.run(() => updateMailPiece(fd), () => setEditing(null));
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="mpe-label">Nom de la pièce</Label>
              <Input id="mpe-label" name="label" defaultValue={editing.label} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mpe-recipient">Destinataire</Label>
              <Input id="mpe-recipient" name="recipient" defaultValue={editing.recipient ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mpe-notes">Note</Label>
              <Textarea id="mpe-notes" name="notes" rows={2} defaultValue={editing.notes ?? ""} />
            </div>
            <Retour ton="erreur">{err}</Retour>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={busy}>Annuler</Button>
              <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
            </div>
          </form>
        </Sheet>
      )}
    </section>
  );
}
