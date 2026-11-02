import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { featureEnabled, FEATURES } from "@/lib/features";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";

// The middleware ensures authentication; route the index to the personal
// workspace — « Aujourd'hui » quand la nouveauté est active pour cette personne
// (elle répond directement à « que dois-je faire maintenant ? »), sinon
// « Mon espace », le point d'entrée historique.
export default async function RootPage() {
  const user = await requireUser();
  const today = await featureEnabled(FEATURES.HOME_TODAY.key, user.id).catch(sansBloquer("app-page.RootPage.featureEnabled", false));
  redirect(today ? "/aujourdhui" : "/mon-espace");
}
