import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { hasRole } from "@/lib/rbac";
import { CHEMIN_BUREAU } from "@/lib/chemins/ad-pro";
import { PageHeader } from "@/components/shared/page-header";
import { fileAgences } from "@/modules/ad-pro/api";
import { ListeAgences } from "./liste-agences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suivi des agences — AMD Internal OS" };

/**
 * SUIVI DES AGENCES (ex-« Prospection d'agences ») — la vue de suivi du parcours agence pour la Direction Marketing et le
 * Super Admin : chaque poste payé par une agence, ce qui est à eux d'abord, puis chez qui en est le reste.
 *
 * L'ASSISTANTE DE DIRECTION n'y travaille plus (Super Admin, 24/11/2026) : ses postes sont des lignes de son bureau
 * (« Prospection d'agence », « Bon de commande »), et chaque ligne ouvre la page du poste (`/agences/<id>`), qui reste. Elle
 * arrive donc sur le bureau — l'ancre d'un ancien lien (« #poste-<id> ») y est relue.
 */
export default async function AgencesPage() {
  const user = await requireUser();
  if (hasRole(user, "DIRECTION_ASSISTANT") && !hasRole(user, "PRODUCT_MANAGER") && !hasRole(user, "SUPER_ADMIN")) redirect(CHEMIN_BUREAU);
  const lignes = await fileAgences(user);
  if (!lignes) notFound();
  return (
    <div className="space-y-5">
      <PageHeader title="Suivi des agences" />
      <ListeAgences
        lignes={lignes} vide="Aucun poste en prospection pour l'instant." action="Ouvrir"
        aides={{ aMoi: "Un geste par poste : ouvrez-le pour le faire.", autres: "Rien à faire pour vous : chaque ligne dit chez qui en est le poste." }}
      />
    </div>
  );
}
