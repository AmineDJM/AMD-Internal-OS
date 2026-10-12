import { requireUser } from "@/lib/session";
import { buildEditorSetup, EDITOR_REASON } from "@/lib/onlyoffice-config";
import { OfficeEditor } from "../../(app)/drive/[id]/edit/office-editor";

export const dynamic = "force-dynamic";

/**
 * L'ÉDITEUR SEUL, SANS LE CADRE DE L'APPLICATION.
 *
 * Le plan de travail multi-documents embarque un éditeur par onglet. L'embarquer depuis la page
 * d'édition normale afficherait le menu de gauche et la barre du haut À L'INTÉRIEUR de l'onglet —
 * une application dans l'application, avec deux barres de défilement. Cette route rend donc
 * l'éditeur nu.
 *
 * Elle vit HORS du groupe `(app)` : c'est ce qui la prive de la mise en page, et rien d'autre. Les
 * droits, eux, sont vérifiés exactement comme ailleurs — `buildEditorSetup` refuse sans accès
 * ÉDITEUR, quelle que soit la porte par laquelle on entre.
 */
export default async function OfficeEmbedPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const setup = await buildEditorSetup(user, params.id);
  if (!setup.ok) {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {EDITOR_REASON[setup.reason]}
      </div>
    );
  }
  const src = `/api/drive/${encodeURIComponent(params.id)}/raw`;
  return (
    <OfficeEditor
      apiJs={setup.apiJs} config={setup.config} name={setup.name}
      apercu={{ src, telechargement: `${src}?dl=1`, vierge: setup.vierge }}
      diagnostic={user.role === "SUPER_ADMIN"}
    />
  );
}
