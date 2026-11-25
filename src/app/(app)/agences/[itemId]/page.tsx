import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { CHEMIN_AGENCES, LIBELLE_AGENCES } from "@/lib/chemins/ad-pro";
import { contextePostes, loadAdProItems, posteDeLAssistante } from "@/modules/ad-pro/api";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Poste en prospection — AMD Internal OS" };

/**
 * LE POSTE CONFIÉ À L'ASSISTANTE (Direction, 15/11/2026) — CE poste seul, sans le reste de la demande : son cahier des
 * charges, ses devis (dépôt, lignes), son bon de commande (composeur), l'e-mail aux agences, la discussion du poste, et le
 * geste suivant. La même carte que partout. Son retour mène à « Prospection d'agences », la file d'où on l'ouvre.
 */
export default async function PosteAgencePage(props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  const user = await requireUser();
  const poste = await posteDeLAssistante(user, itemId);
  if (!poste) notFound();
  const [items, contexte] = await Promise.all([loadAdProItems(poste.owner.parent, poste.owner.id), contextePostes(user, poste.owner.parent, poste.owner.id)]);
  const item = items.find((i) => i.id === itemId);
  if (!item) notFound();
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <BackLink href={CHEMIN_AGENCES}>{LIBELLE_AGENCES}</BackLink>
      <PageHeader title={item.label} description={`${poste.ref} — poste payé par une agence. Votre prochain geste est en tête de la carte ; les devis, le bon de commande et la discussion du poste, dessous.`} />
      <AdProItemsPanel
        parent={poste.owner.parent} parentId={poste.owner.id} items={[item]} amountGranted={null} decided
        canEdit={false} canAllocate={false} promoOptions={[]} budgetOptions={[]}
        materiel={{ magasin: [], peutConfirmer: false }} contexte={contexte} resume={false}
      />
    </div>
  );
}
