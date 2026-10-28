import { requireModule } from "@/lib/session";
import { userCan, anyRoleFilter } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { clauseSponsoringsVisibles } from "@/lib/queries/visibilite-listes";
import { toNumber } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { createSponsoring } from "@/modules/ad-pro/actions-sponsoring";
import { getAdProCreateData } from "@/modules/ad-pro/api";
import { sponsoringCreateFields, AVAILABLE_PRODUCT_STATUSES } from "@/modules/ad-pro/partage";
import { EVENTS_TABS } from "@/lib/labels";
import { SponsoringTable, type SponsoringRow } from "./sponsoring-table";

export const dynamic = "force-dynamic";

export default async function SponsoringPage() {
  const user = await requireModule("SPONSORING");
  const canCreate = userCan(user, "SPONSORING", "CREATE");

  // ─── LES RÉFÉRENTIELS DU FORMULAIRE — UN SEUL CHARGEUR POUR LES DEUX PORTES ────────────
  //
  // Cet écran chargeait les siens à la main : produits et médecins, et RIEN d'autre. La Business
  // Unit — le champ qui dit quel budget Ad&Pro est engagé — n'était donc pas passée, donc le
  // champ DISPARAISSAIT ici (`businessUnits ?? []`, liste vide ⇒ champ retiré) alors qu'il est
  // obligatoire depuis le panneau commun d'Ad & Pro. Une demande créée par cette porte sortait
  // sans gamme, et sa dépense n'était rattachable à aucune équipe — en silence.
  //
  // Ajouter l'argument manquant aurait refermé CE trou et laissé le suivant s'ouvrir au prochain
  // champ ajouté. Les deux portes lisent donc le même chargeur, celui qui SAIT ce que le
  // formulaire réclame — spécialités et gamme déduite du demandeur comprises (§118.5).
  const data = await getAdProCreateData(user.id, ["SPONSORING"]);

  const fields = sponsoringCreateFields({
    products: data.products,
    doctors: data.doctors,
    businessUnits: data.businessUnits,
    businessUnitDeduite: data.businessUnitDeduite,
    specialties: data.specialties,
    specialtiesHeritees: data.specialtiesHeritees,
  });

  // Cloisonnement par entité : la vue « Adventum » ne montre que les demandes d'Adventum.
  const requests = await prisma.sponsoringRequest.findMany({
    where: await clauseSponsoringsVisibles(user),
    orderBy: { requestDate: "desc" },
    include: { requester: { select: { name: true } } },
  });

  const rows: SponsoringRow[] = requests.map((r) => ({
    id: r.id,
    reference: r.reference,
    requestDate: r.requestDate.toISOString(),
    institution: r.institution,
    doctor: r.doctor ?? "",
    type: r.type,
    city: r.city ?? "",
    amountRequested: r.amountRequested ? toNumber(r.amountRequested) : null,
    amountGranted: r.amountGranted ? toNumber(r.amountGranted) : null,
    strategicImportance: r.strategicImportance,
    status: r.status,
    requester: r.requester?.name ?? "",
  }));

  return (
    <div className="space-y-5">
      <PageHeader title="Sponsoring" description="Gestion des demandes de sponsoring et de leur validation.">
        {canCreate && (
          <CreateRecordButton
            autoOpenParam="new"
            label="Nouvelle demande"
            title="Nouvelle demande de sponsoring"
            // « Au-delà de 100 000 DZD, la demande est routée vers la Direction » : c'était la règle
            // d'un circuit disparu — le seuil vit dans les réglages (§118.132) et il ne route plus
            // rien vers la Direction. La phrase dit ce qui se passe AUJOURD'HUI (§118.151).
            description="Joignez dès maintenant la ou les demandes du médecin — c'est la pièce que tout le circuit va lire. Le sponsoring devient le premier poste de la demande ; une fois la tenue pré-validée par la Direction Marketing, les autres postes s'ajoutent, puis la validation finale clôture."
            action={createSponsoring}
            redirectBase="/sponsoring"
            fields={fields}
          />
        )}
      </PageHeader>
      <ModuleTabs tabs={EVENTS_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />

      <SponsoringTable rows={rows} />
    </div>
  );
}
