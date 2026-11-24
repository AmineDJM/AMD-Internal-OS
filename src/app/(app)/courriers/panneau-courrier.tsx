"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { editMailEntry } from "@/lib/actions/mail-register-actions";

/**
 * LE PANNEAU D'UN COURRIER — la fiche, ouverte par-dessus le registre (plein écran au téléphone).
 *
 * Le contenu est rendu au SERVEUR (`fiche-courrier.tsx`) et arrive en `children` ; ce composant ne
 * tient que l'enveloppe : fermer (l'adresse perd `?courrier=`), basculer en « Modifier » (le
 * formulaire du courrier, dans le panneau même) et ranger les gestes secondaires sous « ⋯ ».
 *
 * L'identifiant est LIÉ à l'action de correction ici, jamais posé dans un champ caché : un champ
 * caché se réécrit dans le navigateur. Le serveur revérifie de toute façon droit et périmètre.
 * La page le monte avec `key={id}` : un autre courrier ouvert repart en lecture.
 */
export function PanneauCourrier({ id, titre, fermerHref, champs, champsReplies, menu, children }: {
  id: string;
  titre: string;
  /** Le registre sans le panneau — le dossier ouvert derrière reste ouvert. */
  fermerHref: string;
  /** Les champs de correction ; `null` = pas le droit de modifier. */
  champs: FieldDef[] | null;
  champsReplies: readonly string[];
  /** Les gestes secondaires (partager, classer, supprimer), déjà filtrés par droit au serveur. */
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [edition, setEdition] = React.useState(false);
  const action = React.useMemo(() => editMailEntry.bind(null, id), [id]);
  // `replace` : refermer ne doit pas laisser dans l'historique un « retour » qui rouvrirait le pli.
  const fermer = React.useCallback(() => router.replace(fermerHref, { scroll: false }), [router, fermerHref]);

  return (
    <Sheet open onClose={fermer} title={edition ? "Modifier le courrier" : titre} width="lg" pleinEcranMobile>
      {edition && champs ? (
        <RecordForm
          fields={champs}
          action={action}
          champsReplies={champsReplies}
          onDone={() => setEdition(false)}
          onCancel={() => setEdition(false)}
          submitLabel="Enregistrer les corrections"
        />
      ) : (
        <div className="space-y-4">
          {(champs || menu) && (
            <div className="flex items-center gap-2">
              {champs && (
                <Button variant="outline" size="sm" onClick={() => setEdition(true)}>
                  <Pencil className="h-4 w-4" /> Modifier
                </Button>
              )}
              {menu && <div className="ml-auto"><MenuDossier>{menu}</MenuDossier></div>}
            </div>
          )}
          {children}
        </div>
      )}
    </Sheet>
  );
}
