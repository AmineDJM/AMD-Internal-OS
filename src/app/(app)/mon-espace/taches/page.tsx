import { requireModule } from "@/lib/session";
import { accessibleModules, userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { optionsFromMap } from "@/components/shared/form-fields";
import type { FieldDef } from "@/components/shared/create-record-button";
import { MODULE_LABELS, PRIORITY } from "@/lib/labels";
import { lireVue } from "@/lib/tasks/onglet-taches";
import { lireOngletTaches, ongletsEspace } from "@/lib/queries/mes-taches";
import { OngletTaches } from "./onglet-taches";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tâches — Mon espace" };

/**
 * MON ESPACE › TÂCHES (Direction, 07/10) — toutes les tâches au même endroit : à accepter, à faire,
 * demandées, partagées, terminées. La fiche `/mon-espace/taches/[id]` reste servie (notifications,
 * liens) ; ici, une ligne s'ouvre dans un panneau.
 */
export default async function TachesPage(
  props: { searchParams: Promise<{ vue?: string; page?: string; tache?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("WORKSPACE");
  const vue = lireVue(searchParams.vue);
  const data = await lireOngletTaches(user, vue, Number(searchParams.page ?? "1") || 1);
  const tabs = await ongletsEspace(user, data.compteOnglet);

  const personnes = data.personnes.map((p) => ({ value: p.id, label: p.name }));
  const moduleOptions = accessibleModules(user)
    .filter((m) => m !== "WORKSPACE")
    .map((m) => ({ value: m, label: MODULE_LABELS[m] ?? m }));
  // LE FORMULAIRE COMPLET — participants, lecteurs, pièces, lieu : ce que la ligne de création ne porte pas.
  const champsComplets: FieldDef[] = [
    { type: "text", name: "title", label: "Intitulé", required: true, full: true },
    { type: "textarea", name: "description", label: "Description" },
    { type: "select", name: "assignedToId", label: "Assignée à", options: [{ value: user.id, label: "Moi" }, ...personnes], defaultValue: user.id,
      hint: "Vous : une to-do. Quelqu'un d'autre : une demande, qu'il accepte ou refuse." },
    { type: "select", name: "priority", label: "Priorité", options: optionsFromMap(PRIORITY), defaultValue: "MEDIUM" },
    { type: "date", name: "dueDate", label: "Échéance" },
    { type: "select", name: "module", label: "Module concerné", options: moduleOptions, placeholder: "—" },
    { type: "multiselect", name: "participantIds", label: "Participants", options: personnes, hint: "Ils peuvent agir sur la tâche.", full: true },
    { type: "multiselect", name: "readerIds", label: "En lecture", options: personnes, hint: "Ils la voient sans pouvoir la modifier.", full: true },
    { type: "text", name: "address", label: "Adresse / lieu (course, livraison)", full: true, placeholder: "ex. PCH, Route de…, Alger" },
    { type: "number", name: "expectedMinutes", label: "Durée estimée (min)" },
    { type: "file", name: "files", label: "Pièces jointes (facultatif)", multiple: true, full: true },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Mon espace" />
      <ModuleTabs tabs={tabs} />
      <OngletTaches
        data={data}
        champsComplets={champsComplets}
        peutCreer={userCan(user, "WORKSPACE", "CREATE")}
        ouvrir={searchParams.tache ?? null}
      />
    </div>
  );
}
