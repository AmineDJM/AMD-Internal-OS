import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { fileAgences } from "@/modules/ad-pro/api";
import { ListeAgences } from "./liste-agences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Prospection d'agences — AMD Internal OS" };

/**
 * PROSPECTION D'AGENCES (Direction, 15/11/2026) — la file de l'assistante de direction : les postes qu'on lui a confiés,
 * avec ce qu'il faut y faire (déposer les devis, finaliser le BC). La Direction Marketing y voit tout le parcours.
 */
export default async function AgencesPage() {
  const user = await requireUser();
  const lignes = await fileAgences(user);
  if (!lignes) notFound();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Prospection d'agences"
        description="Les postes Ad & Pro qui passent par une agence : devis à déposer, bon de commande à finaliser, et où en est chacun."
      />
      <ListeAgences lignes={lignes} vide="Aucun poste en prospection pour l'instant." action="Ouvrir" />
    </div>
  );
}
