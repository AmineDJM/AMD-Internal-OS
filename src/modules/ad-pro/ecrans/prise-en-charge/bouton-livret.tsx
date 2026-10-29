import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * « LIVRET » — génère le livret de séjour en PDF (`/api/prises-en-charge/livret`), le range dans les pièces de la
 * demande et l'ouvre dans un nouvel onglet. Sans `personne`, le livret général de la délégation. Un simple formulaire :
 * utilisable d'une page serveur comme d'une fiche (composant client).
 */
export function BoutonLivret({ scope, requestId, personneId, libelle }: {
  scope: "NATIONAL" | "INTERNATIONAL";
  requestId: string;
  personneId?: string | null;
  libelle: string;
}) {
  return (
    <form method="post" action="/api/prises-en-charge/livret" target="_blank" className="inline-flex">
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="id" value={requestId} />
      {personneId && <input type="hidden" name="personne" value={personneId} />}
      <Button type="submit" size="sm" variant="outline" title="Livret de séjour en PDF — rangé dans les pièces de la demande">
        <BookOpen className="h-4 w-4" /> {libelle}
      </Button>
    </form>
  );
}
