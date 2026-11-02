import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { fileBonsDeCommande, peutSignerBC, REFUS_SIGNATURE_BC } from "@/lib/queries/bons-de-commande";
import { FileBonsDeCommande } from "./file-bc";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bons de commande à signer — AMD Internal OS" };

/**
 * BONS DE COMMANDE — ce qu'il faut SIGNER (§118.149), module À PART (§118.176).
 *
 * « Mets un espace en dessous de Finances, un sous-module spécial : Bons de commande — les bons de
 * commande à signer de leur part. Si un BC se retrouve là-bas, c'est qu'il doit être signé. » Puis
 * (01/10/2026) : « le module bon de commande doit être à part et le super admin donne les accès à
 * qui il veut ». La porte est donc le module `PURCHASE_ORDERS` — « Voir » ouvre cet écran,
 * « Modifier » est le droit de signer —, et non plus le droit des Finances.
 *
 * La file ne contient donc QUE des BC « à signer » : validés par leur centre de validation, ou
 * sous le seuil réglé depuis le centre Ad & Pro. Un BC qui attend encore un centre n'y est pas —
 * il n'est pas à signer, il est à valider —, mais il est COMPTÉ : les Finances savent ce qui
 * arrive. L'étape se lit à UN endroit (`etatsDesBC`) : la file, l'action de signature et la fiche
 * Legal ne peuvent pas diverger sur « prêt à signer ».
 *
 * On ne COMPOSE plus de bon de commande ici (Direction, 10/2026) : cet écran est celui de la SIGNATURE. Un BC se compose
 * dans Legal, ou depuis « Demandes de validations » pour le faire pré-valider.
 */
export default async function BonsDeCommandePage(props: { searchParams: Promise<{ bc?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PURCHASE_ORDERS");
  const file = await fileBonsDeCommande(user);
  if (!file) notFound();
  const peutSigner = peutSignerBC(user);
  const montantASigner = file.aSigner.reduce((t, l) => t + (l.montant ?? 0), 0);
  const sansMontant = file.aSigner.filter((l) => l.montant == null || l.montant <= 0).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bons de commande à signer"
        description="Les bons de commande qui attendent leur signature : validés par leur centre de validation, ou sous le seuil de validation. Un bon de commande ne part chez le fournisseur qu'une fois signé."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="À signer" value={String(file.aSigner.length)} icon="FilePen" tone={file.aSigner.length > 0 ? "warning" : "default"} />
        <KpiCard
          label="Montant à signer"
          value={`${montantASigner.toLocaleString("fr-FR")} DZD`}
          icon="Coins"
          /* Le nombre de BC SANS montant voyage avec le total : sans lui, la somme se lirait comme
             exhaustive alors qu'elle ne porte que les montants connus (§118.60). */
          hint={sansMontant > 0 ? `${sansMontant} BC sans montant renseigné — non compté(s).` : undefined}
        />
        <KpiCard
          label="Encore au centre de validation"
          value={String(file.enValidation)}
          icon="Scale"
          hint="Ils arriveront ici une fois validés — ils ne sont pas encore à signer."
        />
        <KpiCard
          label="Seuils de validation"
          value={`${file.seuilCentre > 0 ? `${file.seuilCentre.toLocaleString("fr-FR")} DZD` : "Aucun"} · ${file.seuil > 0 ? `${file.seuil.toLocaleString("fr-FR")} DZD` : "Aucun"}`}
          icon="SlidersHorizontal"
          hint="Centre de validations (BC hors Ad & Pro) · centre Ad & Pro. Au-dessus du seuil de son centre, un BC est d'abord validé ; en deçà, il arrive directement ici. Chaque centre règle le sien."
        />
      </div>

      <FileBonsDeCommande
        aSigner={file.aSigner}
        renvoyes={file.renvoyes}
        signes={file.signes}
        peutSigner={peutSigner}
        refus={peutSigner ? null : REFUS_SIGNATURE_BC}
        tronquee={file.tronquee}
        bcAOuvrir={searchParams.bc ?? null}
      />
    </div>
  );
}
