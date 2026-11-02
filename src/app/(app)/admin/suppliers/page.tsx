import { redirect } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { createSupplier, createSupplierUser } from "@/lib/actions/supplier-actions";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateRecordButton } from "@/components/shared/create-record-button";
import { formatDateTime } from "@/lib/utils";
import { ActiveToggle } from "./active-toggle";
import { BackLink } from "@/components/shared/back-link";

export default async function AdminSuppliersPage() {
  const user = await requireModule("ADMIN");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const suppliers = await prisma.supplier.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      users: { orderBy: { createdAt: "asc" } },
      _count: { select: { products: true } },
    },
  });

  const supplierOptions = suppliers.map((s) => ({ value: s.id, label: s.name }));
  const totalUsers = suppliers.reduce((a, s) => a + s.users.length, 0);

  return (
    <div className="space-y-5">
      <BackLink href="/admin">
        <ArrowLeft className="h-4 w-4" /> Administration
      </BackLink>
      <PageHeader title="Fournisseurs & portail externe" description="Comptes externes isolés. Un fournisseur ne voit que ses propres produits, et uniquement la vue externe partagée par l'équipe Regulatory.">
        <a href="/portail/login" target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-secondary">
          <ExternalLink className="h-4 w-4" /> Ouvrir le portail
        </a>
        <CreateRecordButton
          label="Nouveau fournisseur"
          title="Nouveau fournisseur"
          width="md"
          action={createSupplier}
          fields={[
            { type: "text", name: "name", label: "Nom du fournisseur", required: true, full: true },
            { type: "text", name: "country", label: "Pays" },
            { type: "text", name: "contactEmail", label: "Email de contact" },
            { type: "textarea", name: "notes", label: "Notes internes" },
          ]}
        />
        {suppliers.length > 0 && (
          <CreateRecordButton
            label="Nouveau compte"
            title="Créer un compte d'accès portail"
            description="Le fournisseur se connectera au portail externe avec cet email."
            width="md"
            action={createSupplierUser}
            fields={[
              { type: "select", name: "supplierId", label: "Fournisseur", options: supplierOptions, required: true, full: true },
              { type: "text", name: "name", label: "Nom du contact", required: true, full: true },
              { type: "text", name: "email", label: "Email", required: true, inputMode: "email", autoComplete: "off" },
              { type: "text", name: "password", label: "Mot de passe (min. 8)", required: true },
            ]}
          />
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiCard label="Fournisseurs" value={suppliers.length} icon="Factory" />
        <KpiCard label="Comptes d'accès" value={totalUsers} icon="KeyRound" />
        <KpiCard label="Actifs" value={suppliers.filter((s) => s.active).length} icon="Power" tone="success" />
      </div>

      {suppliers.length === 0 ? (
        <EmptyState icon="Factory" title="Aucun fournisseur" description="Créez un fournisseur, puis un compte d'accès au portail." />
      ) : (
        <div className="space-y-3">
          {suppliers.map((s) => (
            <Card key={s.id}>
              <CardHeader className="flex-row items-center justify-between">
                <div className="min-w-0">
                  <CardTitle className="flex flex-wrap items-center gap-2">{s.name} <ActiveToggle kind="supplier" id={s.id} active={s.active} /></CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {[s.country, s.contactEmail].filter(Boolean).join(" · ")} · {s._count.products} produit{s._count.products > 1 ? "s" : ""} associé{s._count.products > 1 ? "s" : ""}
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                {s.users.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucun compte d'accès. Créez-en un avec « Nouveau compte ».</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {s.users.map((u) => (
                      <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium">{u.name}</p>
                          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.email} · {u.lastLoginAt ? `dernière connexion ${formatDateTime(u.lastLoginAt)}` : "jamais connecté"}</p>
                        </div>
                        <ActiveToggle kind="user" id={u.id} active={u.active} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
