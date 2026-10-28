import Link from "next/link";
import { notFound } from "next/navigation";
import { FileArchive, ShieldCheck, FolderOpen, Info } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { Card, CardContent } from "@/components/ui/card";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { RegScopeCard } from "../scope-gate";
import { LiveAnalysisBadge } from "./live-badge";
import { listDossiers } from "@/lib/regulatory/intelligence/queries";
import {
  PROCEDURE_TYPE_LABELS, DOSSIER_STATUS_LABELS, DOSSIER_STATUS_TONE, humanBytes,
} from "@/lib/regulatory/intelligence/labels";
import { NewDossier } from "./new-dossier";

export const metadata = { title: "Analyse CTD — Regulatory Intelligence" };
export const dynamic = "force-dynamic";

const fmtDate = (d: Date) => new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });

export default async function AnalyseWorkspacePage() {
  const user = await requireModule("REGULATORY");
  if (!regCan(user, "regulatory.workspace.view")) notFound();

  const companyId = await resolveRegCompanyIdFor(user.id);
  const canCreate = regCan(user, "regulatory.dossier.create");

  // Les deux écrans qui portent la MÉMOIRE du module ne s'affichent que pour qui peut les
  // utiliser : la bibliothèque des réserves (ce que l'ANPP nous a déjà reproché) et le corpus
  // (les textes sur lesquels l'analyse s'appuie).
  // L'analyse CTD est un MODULE À PART : ses onglets sont les siens, pas ceux du suivi des
  // dossiers (qui se rejoint par le menu, comme n'importe quel autre module).
  const tabs = [
    { label: "Référentiel ANPP", href: "/regulatory/enregistrement" },
    { label: "Analyse CTD", href: "/regulatory/enregistrement/analyse" },
    ...(regCan(user, "regulatory.reserve.manage") ? [{ label: "Réserves ANPP", href: "/regulatory/enregistrement/reserves" }] : []),
    // Corpus et Entraînement sont des actes d'ADMINISTRATION (ce qui fait foi et ce que l'IA
    // apprend valent pour toutes les analyses) : onglets Super Admin uniquement.
    ...(user.role === "SUPER_ADMIN"
      ? [
          { label: "Corpus", href: "/regulatory/enregistrement/corpus" },
          { label: "Entraînement IA", href: "/regulatory/enregistrement/entrainement" },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analyse intelligente des dossiers CTD"
        description="Réception d'un dossier CTD (ZIP) → décompression sécurisée → lecture, classement et analyse fond/forme au regard de la réglementation. Outil d'aide : la validation finale revient au pharmacien directeur technique."
      />
      <ModuleTabs tabs={tabs} />

      <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Toute conclusion produite par l'assistance est un <strong>PROJET — REVUE RÉGLEMENTAIRE HUMAINE REQUISE</strong> :
          rien n'est soumis à l'ANPP sans validation explicite du responsable. L'archive originale reçue est conservée <strong>intacte et immuable</strong>.
        </p>
      </div>

      {!companyId ? (
        <RegScopeCard userId={user.id} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <ShieldCheck className="mr-1 inline h-4 w-4 text-success" />
              Ingestion sécurisée (anti-archive piégée, exécutables refusés, chemins vérifiés).
            </p>
            {canCreate && <NewDossier />}
          </div>

          <DossierList companyId={companyId} />
        </>
      )}
    </div>
  );
}

async function DossierList({ companyId }: { companyId: string }) {
  const dossiers = await listDossiers(companyId);

  if (dossiers.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <FolderOpen className="h-8 w-8 text-muted-foreground/60" />
          <p>Aucun dossier pour le moment. Créez un dossier CTD puis téléversez son archive ZIP.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      {dossiers.map((d) => {
        const v = d.versions[0];
        return (
          <Link key={d.id} href={`/regulatory/enregistrement/analyse/${d.id}`}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors sm:p-4 hover:border-primary/40 hover:bg-accent/30">
            <FileArchive className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium">{d.title}</p>
                <LiveAnalysisBadge versionId={v?.id ?? null} status={d.status} label={DOSSIER_STATUS_LABELS[d.status]} tone={DOSSIER_STATUS_TONE[d.status]} />
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {d.reference} · {PROCEDURE_TYPE_LABELS[d.procedureType]} · maj {fmtDate(d.updatedAt)}
              </p>
            </div>
            <div className="shrink-0 text-right text-xs text-muted-foreground">
              {v ? (
                <>
                  <p className="font-medium text-foreground">v{v.versionNo} · {v.fileCount} fichier·s</p>
                  <p>{humanBytes(v.totalBytes)}</p>
                </>
              ) : (
                <p className="italic">aucune archive</p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
