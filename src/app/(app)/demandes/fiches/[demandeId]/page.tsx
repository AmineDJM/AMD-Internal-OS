import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { ficheDuBureau, voitBureauAdPro } from "@/lib/queries/reservations-fiches";
import { BackLink } from "@/components/shared/back-link";
import { PanneauFiche } from "@/components/reservation-fiche/panneau-fiche";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fiche de voyage — AMD Internal OS" };

/**
 * LA FICHE D'UN BILLET OU D'UN HÔTEL (Super Admin, 24/11/2026) — une ligne « Billet » / « Hôtel » du bureau du
 * secrétariat ouvre CETTE page : un lien qu'on partage, qu'une notification rouvre. Qui la lit : la même clause que
 * la ligne du tableau (`clauseFichesVisibles`) — hors d'elle, 404. Qui y agit : la règle des gestes (`voitBureauAdPro`).
 */
export default async function FicheVoyagePage(props: { params: Promise<{ demandeId: string }> }) {
  const { demandeId } = await props.params;
  const user = await requireModule("ADMIN_REQUESTS");
  const lue = await ficheDuBureau(user, demandeId);
  if (!lue) notFound();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <BackLink href="/demandes"><ArrowLeft className="h-4 w-4" /> Bureau du secrétariat</BackLink>
      <PanneauFiche l={lue.ligne} freres={lue.freres} fil={lue.fil} gere={voitBureauAdPro(user)} />
    </div>
  );
}
