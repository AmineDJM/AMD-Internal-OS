import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getUtilisateurReel } from "@/lib/session";
import { gestesAgirComme } from "@/lib/effets/agir-comme-liste";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { BackLink } from "@/components/shared/back-link";
import { ListeAgirComme } from "./liste-agir-comme";

export const dynamic = "force-dynamic";

/**
 * « AGIR COMME — VOS GESTES » (Direction, 16/11/2026) — ce que le Super Admin a fait dans la peau d'une personne, geste par
 * geste, et le bouton qui l'annule (ou tout ce qui a été fait pour une personne). Super Admin RÉEL seulement, hors de toute vue.
 */
export default async function AgirCommePage() {
  const u = await getUtilisateurReel();
  if (!u) redirect("/login");
  if (u.role !== "SUPER_ADMIN") redirect("/mon-espace");
  const gestes = await gestesAgirComme();
  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Retour à l’administration
      </BackLink>
      <PageHeader
        title="Agir comme — vos gestes"
        description="Tout ce qui a été fait avec « Agir comme cet utilisateur », du plus récent au plus ancien. Annuler remet la base comme avant le geste ; une notification déjà poussée sur un téléphone, elle, ne se reprend pas."
      />
      {u.visualise && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          Une vue est encore ouverte : quittez-la (bouton « Quitter » en haut à droite) avant d’annuler.
        </p>
      )}
      {gestes.length === 0 ? (
        <EmptyState title="Aucun geste en « Agir comme »" description="Ouvrez la fiche d’un utilisateur dans l’administration et cliquez « Agir comme cet utilisateur » : chaque geste fait dans sa peau apparaîtra ici." />
      ) : (
        <ListeAgirComme gestes={gestes} />
      )}
    </div>
  );
}
