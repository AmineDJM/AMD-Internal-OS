import { redirect } from "next/navigation";
import { lienCourrier } from "@/lib/chemins/courriers";

export const dynamic = "force-dynamic";

/**
 * PAGE D'ESCALE — un courrier n'a plus de page à lui : il s'ouvre dans le panneau du registre
 * (`/courriers?courrier=<id>`). L'adresse reste pour les liens déjà partagés, les notifications
 * déjà écrites et les favoris. Aucun droit ne se décide ici : le registre applique au panneau la
 * même clause de visibilité qu'à sa liste, et un pli hors périmètre ne s'y ouvre pas.
 */
export default async function AncienneFicheCourrier(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(lienCourrier(id));
}
