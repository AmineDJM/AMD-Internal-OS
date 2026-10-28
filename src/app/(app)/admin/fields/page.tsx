import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { CUSTOM_ENTITY_TYPES } from "@/lib/custom-fields";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { PageHeader } from "@/components/shared/page-header";
import { FieldsManager, type FieldDefDTO } from "./fields-manager";
import { BackLink } from "@/components/shared/back-link";

export default async function CustomFieldsPage() {
  await requireModule("ADMIN", "UPDATE");
  const defs = await prisma.customFieldDef.findMany({ orderBy: [{ entityType: "asc" }, { order: "asc" }] });

  const rows: FieldDefDTO[] = defs.map((d) => ({
    id: d.id, entityType: d.entityType, key: d.key, label: d.label,
    type: d.type, options: d.options, order: d.order, required: d.required,
  }));
  const entityTypes = CUSTOM_ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_TYPE_LABELS[t] ?? t }));

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Retour à l’administration
      </BackLink>
      <PageHeader
        title="Champs personnalisés"
        description="Ajoutez des colonnes/champs à n’importe quel module. Ils deviennent éditables sur chaque fiche."
      />
      <FieldsManager entityTypes={entityTypes} defs={rows} />
    </div>
  );
}
