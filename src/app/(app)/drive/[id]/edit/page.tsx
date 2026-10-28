import { redirect } from "next/navigation";

/**
 * ANCIENNE ADRESSE D'ÉDITION. Ouvrir un fichier, c'est désormais être dans l'éditeur (`/drive/<id>` : édition si
 * l'on a le droit, lecture sinon) — il n'y a plus de page « Éditer dans Office » à part. L'adresse reste
 * valable pour les liens déjà envoyés et les favoris.
 */
export default async function DriveEditPage(props: { params: Promise<{ id: string }> }) {
 const params = await props.params;
 redirect(`/drive/${encodeURIComponent(params.id)}`);
}
